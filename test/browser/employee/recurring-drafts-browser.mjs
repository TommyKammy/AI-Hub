import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { listenGateway } from "../../../src/hermes/gateway.mjs";
import { openHub } from "../../../src/jobs/hub.mjs";
import { personalWork } from "../../../src/workspace/personal-work.mjs";

const dir=await mkdtemp(join(tmpdir(),"aihub-recurring-drafts-"));
const dbPath=join(dir,"hub.sqlite"), libraryRoot=join(dir,"library");
const library="shared/定期資料", title="進捗.txt", text="棚卸しは12月7日に完了しました。";
const file=join(libraryRoot,library,title), cron=join(dir,"cron-token"), token=randomUUID();
await mkdir(join(libraryRoot,library),{recursive:true});
await writeFile(file,text);
await writeFile(cron,token);
await mkdir(join(dir,"accounts"),{mode:0o700});
await writeFile(join(dir,"accounts","test-admin"),token,{mode:0o600});
process.env.LIBRARY_ROOT=libraryRoot;
const hub=openHub(dbPath), {db}=hub;
personalWork(hub);
const company="A社", actor="sato";
const origin=hub.create(actor,{company,kind:"weekly",ask:"採用済みの週報を使う",minutes:text},randomUUID());
db.prepare("UPDATE jobs SET status='done',memo=?,adopted_version=2,sources_json=? WHERE id=?")
  .run(text,JSON.stringify([{id:1,title,library,text,version:"検索時の版"}]),origin);
db.prepare("INSERT INTO memo_versions(job_id,version,memo,instruction) VALUES(?,?,?,?)").run(origin,1,"下書き [1]",null);
db.prepare("INSERT INTO memo_versions(job_id,version,memo,instruction) VALUES(?,?,?,?)").run(origin,2,"完了事項 [1]","完了・課題・予定の順に書く。");

const quoteOrigin=hub.create(actor,{company,kind:"assistant",ask:"前回の見積比較",contract:{name:"前回A.txt",text:"旧金額A。"},
  second_attachment:{name:"前回B.txt",text:"旧金額B。"}},randomUUID());
db.prepare("UPDATE jobs SET status='done',memo='採用した見積比較 [1] [2]',created=1 WHERE id=?").run(quoteOrigin);
db.prepare("UPDATE job_notifications SET created=1 WHERE job=?").run(quoteOrigin);
const skill=randomUUID(), criteria=["金額"], rules=[];
const hash=createHash("sha256").update("fixture quote skill: "+criteria.join("・")).digest("hex");
db.prepare(`INSERT INTO quote_skills(id,job,version,ticket,phase,criteria,rules,hash) VALUES(?,?,?,?,?,?,?,?)`)
  .run(skill,quoteOrigin,1,randomUUID(),"learn-quote-1",JSON.stringify(criteria),JSON.stringify(rules),hash);

const gateway=listenGateway(db,actor,"127.0.0.1",0);
if (!gateway.listening) await once(gateway,"listening");
const gatewayBase="http://127.0.0.1:"+gateway.address().port, calls=new Map(), outputs=new Map();
let fixtureError;
async function workTool(ticket,result) {
  const response=await fetch(gatewayBase+"/work-tool",{method:"POST",body:JSON.stringify({ticket,result})});
  assert.equal(response.status,200,await response.clone().text());
  return response.json();
}
const fixture=createServer(async (req,res)=>{
  try {
    if (req.method==="POST" && req.url==="/v1/runs") {
      const chunks=[];
      for await (const chunk of req) chunks.push(chunk);
      const {input,session_id}=JSON.parse(Buffer.concat(chunks));
      const id=session_id.slice(4,40), key=req.headers["idempotency-key"];
      const route=input.match(/^AI_HUB_ROUTE (.+)$/m)[1];
      const context=JSON.parse(input.match(/AI_HUB_INPUT\n([^\n]+)\nEND_AI_HUB_INPUT/)[1]);
      calls.set(id,{count:(calls.get(id)?.count || 0)+1,route,context});
      if (context.work && context.sources[0]?.title==="今回A.txt") {
        await workTool(context.work,{tool:"load_workflow",name:"quote-comparison",title:"見積比較",hash});
        const {sources,passages}=await workTool(context.work,null);
        const evidence=sources.map(source=>passages.find(passage=>passage.source===source.id));
        const cells=evidence.map(({source,text,ref,offset})=>({source,text,ref,offset}));
        await workTool(context.work,{tool:"compare_quotes",table:{columns:sources.map(source=>source.title),
          rows:[{label:"金額",cells}]},evidence,memo:"新しい見積を比較しました。 [1] [2]"});
      }
      outputs.set(key,{status:"completed",output:"確認用に作成した定期下書きです。 [1]"});
      res.end(JSON.stringify({run_id:key}));
      return;
    }
    const run=outputs.get(req.url.slice("/v1/runs/".length));
    res.writeHead(run ? 200 : 404).end(JSON.stringify(run || {}));
  } catch(error) {fixtureError=error;res.writeHead(500).end();}
});
async function listen(server) {
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  return server.address().port;
}
const fixturePort=await listen(fixture);
const sockets=Array.from({length:3},()=>createServer());
const ports=await Promise.all(sockets.map(listen));
await Promise.all(sockets.map(socket=>new Promise(resolve=>socket.close(resolve))));
const [base,peer,admin]=ports.map(port=>"http://127.0.0.1:"+port);
const workspace=async (host=base)=>(await fetch(host+"/api/workspace")).json();
let app, browser, stderr="";
async function until(check) {
  for (let i=0;i<120;i++) {
    if (fixtureError) throw fixtureError;
    const result=await check();
    if (result) return result;
    await delay(100);
  }
  throw Error("条件を確認できませんでした。"+stderr);
}
async function start() {
  app=spawn(process.execPath,["server.mjs"],{cwd:new URL("../../../",import.meta.url),env:{...process.env,
    DATA_DIR:dir,ADMIN_ACCOUNTS_DIR:join(dir,"accounts"),SATO_PORT:String(ports[0]),TANAKA_PORT:String(ports[1]),ADMIN_PORT:String(ports[2]),
    SATO_URL:"http://127.0.0.1:"+fixturePort,SATO_KEY:token,AI_HUB_LOCAL_CRON_TOKEN_FILE:cron},stdio:["ignore","ignore","pipe"]});
  app.stderr.on("data",buffer=>{stderr+=buffer;});
  await until(()=>fetch(base+"/api/workspace").then(response=>response.ok).catch(()=>false));
}
async function stop() {
  if (app && app.exitCode===null && app.signalCode===null) {
    app.kill();
    await once(app,"exit");
  }
}
const tick=async ()=>(await fetch(admin+"/internal/local-scheduler/tick",{method:"POST",headers:{Authorization:"Bearer "+token}})).json();
const due=id=>db.prepare("UPDATE weekly_schedules SET next_run=? WHERE id=?").run(Date.now()-1000,id);
const resultFor=id=>db.prepare("SELECT job FROM scheduled_jobs WHERE schedule=? ORDER BY due").all(id).map(row=>row.job);

try {
  await start();
  browser=await chromium.launch({channel:"chrome"});
  const page=await browser.newPage({viewport:{width:390,height:844},timezoneId:"America/Los_Angeles"});
  const dialog=page.getByRole("dialog");
  const openSchedule=async name=>{
    await dialog.getByRole("button",{name:"予約内容を確認する"}).click();
    await dialog.getByText(/次回.*日本時間/).waitFor();
    assert.match(await dialog.getByRole("status").innerText(),name);
    assert.match(await dialog.innerText(),/自分の依頼一覧（定期下書き）/);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await dialog.getByRole("button",{name:"定期実行を登録"}).click();
    await page.waitForURL("**/#jobs/reservations");
    await dialog.waitFor({state:"hidden"});
  };
  await page.goto(base+"/#job/"+origin);
  await page.getByRole("button",{name:"この版から定期下書きを予約"}).click();
  await openSchedule(/採用版・第2版/);
  const report=(await workspace()).schedules.find(item=>item.name==="採用済みの週報を使う");
  const reportRow=page.locator(".planning-schedule-row").filter({hasText:report.name});
  const changed=page.waitForResponse(response=>response.url().endsWith("/api/schedules/"+report.id));
  await reportRow.getByRole("button",{name:"一時停止"}).click();
  const paused=await changed;
  assert.equal(paused.status(),200,await paused.text());
  await reportRow.getByText("停止中",{exact:true}).waitFor();
  due(report.id);
  assert.equal((await tick()).created,0);
  await reportRow.getByRole("button",{name:"再開"}).click();
  await reportRow.getByRole("button",{name:"一時停止"}).waitFor();
  await stop();
  due(report.id);
  await start();
  const [draft]=resultFor(report.id);
  await until(()=>db.prepare("SELECT status FROM jobs WHERE id=?").get(draft)?.status==="done");
  assert.deepEqual(resultFor(report.id),[draft]);
  assert.equal((await tick()).created,0);
  assert.equal(calls.get(draft).count,1);
  await page.goto(base+"/#jobs");
  const draftRow=page.locator('[data-op="job/'+draft+'"]');
  await draftRow.getByText("定期下書き",{exact:true}).waitFor();
  await draftRow.click();
  await page.locator("#memoText").waitFor();
  assert.equal(await page.getByRole("heading",{name:"定期下書き",exact:true}).count(),1);
  assert.equal(await page.getByRole("button",{name:"同僚に共有"}).count(),0);
  assert.equal(await page.getByLabel("修正内容").count(),1);
  assert.equal((await fetch(peer+"/api/jobs/"+draft)).status,404);
  assert.equal((await workspace(peer)).jobs.some(item=>item.id===draft),false);
  assert.equal((await workspace(peer)).schedules.some(item=>item.id===report.id),false);
  const reportJob=await (await fetch(base+"/api/jobs/"+draft)).json();
  assert.equal(reportJob.sources[0].memo_version,2);
  assert.equal(reportJob.sources[0].job,origin);
  await rm(file);
  assert.equal((await fetch(base+"/api/jobs/"+draft)).status,403);
  due(report.id);
  await tick();
  assert.deepEqual(resultFor(report.id),[draft]);
  const blocked=(await workspace()).schedules.find(item=>item.id===report.id);
  assert.equal(blocked.enabled,0);
  assert.match(blocked.blocked_reason,/資料/);

  await page.goto(base+"/#catalog");
  await page.locator('[data-op="catalog/personal:'+skill+'"]').click();
  await dialog.getByRole("button",{name:"定期実行を設定"}).click();
  await openSchedule(/その回に登録した新しい見積書2件/);
  const comparison=(await workspace()).schedules.find(item=>item.source_kind==="quote");
  due(comparison.id);
  assert.equal((await tick()).created,0);
  assert.deepEqual(resultFor(comparison.id),[]);
  const comparisonRow=page.locator(".planning-schedule-row").filter({hasText:comparison.name});
  await comparisonRow.getByRole("button",{name:"次回分を確認"}).click();
  const now=Date.now(), upcomingMinute=Math.floor(now/60000)+2;
  await dialog.getByLabel("実行予定日時（日本時間）").fill(new Date(upcomingMinute*60000+9*3600000).toISOString().slice(0,16));
  for (const [index,name,value] of [[1,"今回A.txt","初期費用は11万円。"],[2,"今回B.txt","初期費用は20万円。"]])
    await dialog.getByLabel("この回の見積書"+index).setInputFiles({name,mimeType:"text/plain",buffer:Buffer.from(value)});
  await dialog.getByRole("button",{name:"今回の変更を保存"}).click();
  await dialog.waitFor({state:"hidden"});
  await stop();
  assert.equal(db.prepare("UPDATE schedule_occurrences SET run_at=? WHERE schedule=?").run(Date.now()-1000,comparison.id).changes,1);
  await start();
  const [compared]=resultFor(comparison.id);
  await until(()=>db.prepare("SELECT status FROM jobs WHERE id=?").get(compared)?.status==="done");
  assert.equal(calls.get(compared).count,1);
  assert.deepEqual(calls.get(compared).context.sources.map(source=>source.title),["今回A.txt","今回B.txt"]);
  assert.equal((await tick()).created,0);
  assert.deepEqual(resultFor(comparison.id),[compared]);
  due(comparison.id);
  assert.equal((await tick()).created,0);
  assert.deepEqual(resultFor(comparison.id),[compared]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM scheduled_jobs JOIN shared_memos ON job=job_id").get().n,0);
  console.log("TOM-137 Chrome 390px JST確認、週報採用版の予約・一時停止・再開・本人の定期下書き・資料失効、見積未登録の枠・新規2件・再起動・重複なし");
} finally {
  await browser?.close();
  await stop();
  await Promise.all([fixture,gateway].map(server=>new Promise(resolve=>server.close(resolve))));
  hub.close();
  await rm(dir,{recursive:true,force:true});
}
