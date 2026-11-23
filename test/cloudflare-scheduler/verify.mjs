import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { recentWeekday } from "../../reservation-plan.mjs";

const root=fileURLToPath(new URL("../../",import.meta.url));
const wrangler=process.env.WP06_WRANGLER_PATH ||
  fileURLToPath(new URL("../../node_modules/.bin/wrangler",import.meta.url));
const wranglerVersion=execFileSync(process.execPath,[wrangler,"--version"],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const directory=await mkdtemp(join(root,".runtime","wp06-cron-"));
const project=process.env.WP06_PROJECT || "ai-hub-wp06";
const adminPort=process.env.WP06_ADMIN_PORT || "19933";
const admin="http://127.0.0.1:"+adminPort;
const docker=(...args)=>execFileSync("docker",["--context","colima-mac-studio-solo",...args],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
const secret=randomBytes(32).toString("hex");
const composition=process.env.WP06_COMPOSE_ARGS ? JSON.parse(process.env.WP06_COMPOSE_ARGS) :
  ["compose","-p",project,"--env-file",".runtime/local.env","-f","compose.yaml","-f","test/compose.wp06.yaml"];
let worker, logs="", configured=false, peerEligibility;
function hub(statement,...args) {
  const code="const db=new(require('node:sqlite').DatabaseSync)('/data/hub.sqlite'); db.exec('PRAGMA busy_timeout=3000'); console.log(JSON.stringify(db.prepare(process.argv[1]).all(...process.argv.slice(2))));";
  return JSON.parse(docker("exec",project+"-hub-1","node","-e",code,statement,...args));
}
const post=(base,path,body)=>fetch(base+path,{
  method:"POST",headers:{Origin:base,"Idempotency-Key":randomUUID(),"Content-Type":"application/json"},body:JSON.stringify(body),
});
async function until(read,timeout=35000) {
  const end=Date.now()+timeout;
  while (Date.now()<end) {
    const result=await read();
    if (result) return result;
    await delay(150);
  }
  throw Error("ローカルCron検証の待機期限を超えました。");
}
function receipts(id) {
  return Number(docker("exec",project+"-sato-1","python","-c",
    "import sqlite3,sys; print(sqlite3.connect('file:/opt/data/runs_idempotency.db?mode=ro',uri=True).execute('select count(*) from run_idempotency where idempotency_key=?',(sys.argv[1],)).fetchone()[0])",
    id+"-compose"));
}
try {
  // This test is linked to the disposable WP06 project only.
  assert.equal(docker("port",project+"-hub-1",adminPort+"/tcp").trim(),"127.0.0.1:"+adminPort);
  const fixture=join(directory,"library","shared","予約先");
  await mkdir(fixture,{recursive:true});
  await writeFile(join(fixture,"資料.txt"),"予約の検証用資料です。");
  const tokenFile=join(directory,"cron.token"), overlay=join(directory,"hub-cron.json");
  await writeFile(tokenFile,secret,{mode:0o600});
  await writeFile(overlay,JSON.stringify({services:{hub:{
    environment:{AI_HUB_LOCAL_CRON_TOKEN_FILE:"/run/secrets/local-cron"},
    volumes:[{type:"bind",source:tokenFile,target:"/run/secrets/local-cron",read_only:true},
      {type:"bind",source:join(directory,"library"),target:"/app/library-data",read_only:true}],
  }}}));
  await Promise.all(["worker.mjs","wrangler.jsonc"].map(name=>copyFile(new URL(name,import.meta.url),join(directory,name))));
  await writeFile(join(directory,".dev.vars"),"HUB_ORIGIN="+admin+"\nCRON_TOKEN="+secret+"\n",{mode:0o600});
  const listener=createServer();
  listener.listen(0,"127.0.0.1");
  await once(listener,"listening");
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  worker=spawn(process.execPath,[wrangler,"dev","--local","--test-scheduled","--ip","127.0.0.1","--port",String(port),
    "--inspector-port","0","--show-interactive-dev-session=false","--types=false"],{
    cwd:directory,env:{PATH:process.env.PATH,CI:"1",WRANGLER_SEND_METRICS:"false"},stdio:["ignore","pipe","pipe"],
  });
  for (const pipe of [worker.stdout,worker.stderr]) pipe.on("data",chunk=>{logs+=chunk;});
  await until(()=>{
    if (worker.exitCode!==null || worker.signalCode!==null)
      throw Error("Wrangler stopped: "+logs.replaceAll(secret,"[redacted]"));
    return logs.includes("Ready on") || logs.includes("Listening on");
  });
  docker(...composition,"-f",overlay,"up","-d","--wait","hub");
  configured=true;
  const path="/internal/local-scheduler/tick";
  const employee="http://127.0.0.1:"+(process.env.WP06_EMPLOYEE_PORT || "19931");
  const peer="http://127.0.0.1:"+(process.env.WP06_PEER_PORT || "19932");
  assert.equal((await fetch(employee+path,{method:"POST",headers:{Authorization:"Bearer "+secret}})).status,404);
  assert.equal((await fetch(admin+path,{method:"POST"})).status,403);
  const names=["予約で開始する","資格停止予約","資料失効予約"];
  const now=new Date(Date.now()+9*3600000);
  const time=now.toISOString().slice(11,16);
  const due=recentWeekday(Date.now(),time);
  const clock=new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",hour12:false,hour:"2-digit",minute:"2-digit"});
  async function create(base,i,library) {
    const text="平日"+time+"に"+names[i]+" "+Date.now();
    const body={text,libraries:library ? ["shared/予約先"] : []};
    const preview=await post(base,"/api/reservation-plan/preview",body);
    assert.equal(preview.status,200);
    const result=await post(base,"/api/reservation-plan/confirm",{...body,token:(await preview.json()).token});
    assert.equal(result.status,201);
    return (await result.json()).schedule;
  }
  const ids=await Promise.all([create(employee,0,false),create(peer,1,false),create(employee,2,true)]);
  await rm(join(fixture,"資料.txt"));
  // Preserve the enabled legacy row deliberately, to prove the Cron authorization check handles it.
  peerEligibility=hub("SELECT active,manual_active FROM memberships WHERE actor='tanaka'")[0];
  hub("UPDATE memberships SET active=0,manual_active=0 WHERE actor='tanaka' RETURNING actor");
  hub("UPDATE weekly_schedules SET next_run=CAST(? AS INTEGER) WHERE id IN (?,?,?) RETURNING id",String(due),...ids);
  const scheduled="http://127.0.0.1:"+port+"/__scheduled?cron=*%20*%20*%20*%20*";
  const responses=await Promise.all([fetch(scheduled),fetch(scheduled)]);
  assert.deepEqual(responses.map(response=>response.status),[200,200]);
  const events=await until(()=>{
    const records=logs.split("\n").flatMap(line=>{
      const match=line.match(/\{"event":"local-scheduler-tick","created":\d+,"disabled":\d+\}/);
      return match ? [JSON.parse(match[0])] : [];
    });
    return records.length>=2 && records;
  });
  assert.deepEqual(events.map(event=>event.created).sort(),[0,1]);
  assert.deepEqual(events.map(event=>event.disabled).sort(),[0,2]);
  const joined=()=>hub("SELECT s.id,s.enabled,k.job,k.due FROM weekly_schedules s LEFT JOIN scheduled_jobs k ON k.schedule=s.id WHERE s.id IN (?,?,?)",...ids);
  const first=joined();
  const accepted=first.find(row=>row.id===ids[0]);
  assert.equal(accepted.due,due);
  assert.deepEqual(first.filter(row=>row.id!==ids[0]).map(row=>[row.enabled,row.job]),[[0,null],[0,null]]);
  await until(async()=> (await fetch(employee+"/api/jobs/"+accepted.job).then(response=>response.json())).status==="done");
  // The regular Hub timer ticks every 15s. Wait through a full timer interval on the same database.
  await delay(16000);
  assert.deepEqual(joined(),first);
  assert.equal(receipts(accepted.job),1);
  assert.equal(hub("SELECT count(*) n FROM attempts WHERE job_id=?",accepted.job)[0].n,1);
  console.log(JSON.stringify({wrangler:wranglerVersion,localCronEvents:events,slot:clock.format(due),
    job:accepted.job,hermesReceipts:1,unauthorizedReservations:2,unauthorizedReceipts:0,timerRechecked:true}));
} finally {
  if (worker?.exitCode===null && worker.signalCode===null) {
    const finished=once(worker,"exit");
    worker.kill();
    await finished;
  }
  try {
    if (peerEligibility)
      hub("UPDATE memberships SET active=CAST(? AS INTEGER),manual_active=CAST(? AS INTEGER) WHERE actor='tanaka' RETURNING actor",
        String(peerEligibility.active),String(peerEligibility.manual_active));
    if (configured) docker(...composition,"up","-d","--wait","hub");
  }
  finally { await rm(directory,{recursive:true,force:true}); }
}
