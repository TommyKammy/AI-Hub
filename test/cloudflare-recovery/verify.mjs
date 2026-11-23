import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const hub = "cf-hermes-22-lab-hub-1";
const docker = (...args) => execFileSync("docker",["--context","colima-mac-studio-solo",...args],{encoding:"utf8"}).trim();
const emp = "http://127.0.0.1:19432", admin = "http://127.0.0.1:19433";
const minutes = "東支店で棚卸しを12月4日に実施すると決定した。\n宿題は山田が12月1日までに手順書を提出すること。";
const progress = "東支店の在庫確認が完了した。\n課題は台帳の不足。\n来週は台帳を補充する。";
const vars = Object.fromEntries(readFileSync(".dev.vars","utf8").trim().split("\n").map(line=>line.split("=")));
const d1dir = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
const db = new DatabaseSync(d1dir+"/"+readdirSync(d1dir).find(f=>/^[0-9a-f]+\.sqlite$/.test(f)),{readOnly:true});
const booking = id => db.prepare("SELECT * FROM archive WHERE actor=? AND job_phase=?").get("tanaka",id+"-compose");
const save = (name,v) => writeFileSync("results/"+name,JSON.stringify(v,null,2));
const resources = () => docker("ps","--filter","name=workerd-cf-hermes-22-local-lab-Employee","--format","{{.Names}}").split("\n").filter(n => n && !n.endsWith("-proxy"));
const instance = () => resources().find(n=>docker("exec",n,"printenv","LAB_ACTOR")==="tanaka");
const browser = await chromium.launch({channel:"chrome"});
const page = await browser.newPage();
const job = async id => (await page.request.get(emp+"/api/jobs/"+id)).json();
async function until(check,timeout=60000,interval=300){
  const end=Date.now()+timeout;
  while(Date.now()<end){const v=await check();if(v)return v;await delay(interval);}
  throw Error("Condition timed out: "+String(check));
}
async function submit(target,kind,label,text,ask,origin=emp){
  await target.goto(origin);
  await target.getByLabel("依頼の種類").selectOption(kind);
  await target.getByText("自分の資料を使う",{exact:true}).click();
  await target.getByLabel(label,{exact:true}).fill(text);
  await target.getByLabel("依頼内容",{exact:true}).fill(ask);
  await target.getByRole("button",{name:"送信",exact:true}).click();
  await target.waitForURL(/#job\//);
  return target.url().split("#job/")[1];
}
async function checkSource(target,original,label){
  const memo=target.locator("#memoText");
  await memo.waitFor({timeout:90000});
  await memo.getByRole("button",{name:"出典1を開く"}).first().click();
  assert.equal(await target.locator("#dlgbody .note").innerText(),original);
  await target.screenshot({path:"results/"+label+".png"});
}
function hermesRecords(container,id) {
  const reader=`import sqlite3,json,sys
def rows(file,sql,key):
 with sqlite3.connect('file:/opt/data/'+file+'?mode=ro',uri=True) as db:return db.execute(sql,(key,)).fetchall()
k=sys.argv[1];print(json.dumps([rows('runs_idempotency.db','select run_id from run_idempotency where idempotency_key=?',k),rows('state.db','select request_id from session_admissions where target_session_id=?','hub-'+k)]))`;
  return JSON.parse(docker("exec",container,"python","-c",reader,id+"-compose"));
}
function worker(actor,path,options={}) {
  return fetch("http://127.0.0.1:19474"+path,{...options,headers:{Authorization:"Bearer "+vars[actor.toUpperCase()+"_KEY"],...options.headers}});
}
async function begin(longRun=false){
  // Only the isolated Hub owns this fault marker and volume.
  assert.equal(docker("port",hub,"19432/tcp"),"127.0.0.1:19432");
  if (longRun) {
    const health=await worker("tanaka","/health");
    assert.equal(health.status,200);
    const name=instance();
    docker("exec",name,"test","-f","/lab/slow-model.py");
    docker("exec",name,"touch","/tmp/lab-delay-next-model");
  }
  docker("exec",hub,"touch","/data/lab-drop-next");
  const id=await submit(page,"meeting","会議の記録",minutes,"受付復旧検証。決定事項と宿題を整理して。");
  await page.getByRole("heading",{name:"結果を確認中"}).waitFor();
  assert.equal((await job(id)).run_id,null);
  await page.screenshot({path:"results/held.png"});
  const next=await browser.newPage();
  const week=await submit(next,"weekly","週の進捗記録",progress,"今週の週報を作成して。");
  assert.equal((await job(week)).status,"queued");
  if (longRun) await observeLongRun(id,week);
  const record=await until(()=>booking(id)?.result && booking(id));
  assert.ok(record.confirmed && record.confirmed<=record.captured);
  const original=JSON.parse(record.result);
  assert.equal(original.status,"completed");
  assert.match(original.output,/12月4日/);
  const name=instance(), previous=docker("inspect","-f","{{.Id}}",name);
  const admissions=hermesRecords(name,id);
  assert.deepEqual(admissions,[[[record.run]],[[record.run]]]);
  await restartHub();
  assert.equal((await job(id)).run_id,null);
  assert.equal((await job(id)).status,"unknown");
  save("pending.json",{id,week,previous,run:record.run,source:minutes,confirmedAt:record.confirmed,capturedAt:record.captured,admissions});
  console.log("Archived terminal result; Hub restarted with no run ID.",id,week,record.run);
}
async function restartHub(){
  const oldBoot=docker("inspect","-f","{{.State.StartedAt}}",hub);
  docker("restart","-t","1",hub);
  await until(async()=>(await page.request.get(emp,{timeout:800}).catch(()=>null))?.ok());
  assert.notEqual(docker("inspect","-f","{{.State.StartedAt}}",hub),oldBoot);
}

async function observeLongRun(id,week){
  const row=await until(()=>booking(id)?.confirmed && booking(id));
  assert.equal(row.result,null);
  const name=instance();
  const container=docker("inspect","-f","{{.Id}}",name);
  const readTiming=()=>JSON.parse(docker("exec",name,"cat","/tmp/lab-model-timing.json"));
  await until(()=>docker("exec",name,"sh","-c","test -s /tmp/lab-model-timing.json && echo ready || true"));
  const started=readTiming().started*1000;
  save("long-start.json",{id,week,run:row.run,container,started,confirmed:row.confirmed});
  await restartDuringLongRun(id,week,container,row.run);
  console.log("Waiting for the real Hermes run",id,row.run);
  await until(()=>Date.now()-Math.max(row.confirmed,started)>603000,630000,1000);
  const checkpoint=Date.now();
  const probe=`import sqlite3,sys,json
with sqlite3.connect("file:/opt/data/runs_idempotency.db?mode=ro",uri=True) as db:
 value=db.execute("SELECT status_json FROM run_idempotency WHERE idempotency_key=?",(sys.argv[1],)).fetchone()
 obj=json.loads(value[0]);print(json.dumps({k:obj[k] for k in ("status","run_id","session_id")}))`;
  const status=JSON.parse(docker("exec",name,"python","-c",probe,id+"-compose"));
  assert.equal(status.run_id,row.run);
  assert.equal(status.session_id,"hub-"+id+"-compose");
  assert.ok(["running","in_progress"].includes(status.status),JSON.stringify(status));
  assert.equal(booking(id).result,null);
  assert.equal((await job(id)).status,"unknown");assert.equal((await job(week)).status,"queued");
  assert.equal(docker("inspect","-f","{{.Id}}",name),container);
  save("long-checkpoint.json",{id,run:row.run,checkpoint,ageSeconds:(checkpoint-row.confirmed)/1000,status});
  const record=await until(()=>booking(id)?.captured && booking(id),60000);
  const timing=readTiming();
  assert.ok(timing.released-timing.started>=610);
  assert.equal(record.run,row.run);
  assert.ok(record.captured>checkpoint);
  save("long-completed.json",{id,run:row.run,container,model:timing,confirmedAt:row.confirmed,
    capturedAt:record.captured,secondsAfterConfirmation:(record.captured-row.confirmed)/1000});
}
async function restartDuringLongRun(id,week,container,run){
  assert.equal(booking(id).result,null);
  await restartHub();
  assert.equal(booking(id).result,null);
  assert.equal(booking(id).run,run);
  assert.equal(docker("inspect","-f","{{.State.Running}}",container),"true");
  assert.equal((await job(id)).run_id,null);
  assert.equal((await job(id)).status,"unknown");
  assert.equal((await job(week)).status,"queued");
  save("long-restart.json",{id,run,container,restartedAt:Date.now(),hubState:"unknown",weeklyState:"queued"});
}
async function finish(){
  const {id,week,previous,run,capturedAt}=JSON.parse(readFileSync("results/pending.json","utf8"));
  assert.equal(instance(),undefined,"wait for the real idle stop before reconciliation");
  const stoppedAt=Date.now();
  const row=booking(id), key=id+"-compose", getReceipt=(actor,attempt)=>worker(actor,"/receipt/"+key,{headers:{"X-Hub-Attempt":attempt}});
  const own=await (await getReceipt("tanaka",row.attempt)).json();
  assert.deepEqual(own,{result:"matched",run_id:run,session_id:"hub-"+key});
  assert.equal((await (await getReceipt("tanaka",randomUUID())).json()).result,"mismatch");
  assert.equal((await (await getReceipt("sato",row.attempt)).json()).result,"missing");
  assert.equal((await worker("sato","/v1/runs/"+run)).status,404);
  assert.equal((await page.request.get("http://127.0.0.1:19431/api/jobs/"+id)).status(),404);
  const stored=JSON.parse(row.result);
  assert.deepEqual(await (await worker("tanaka","/v1/runs/"+run)).json(),stored);
  const duplicate={method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":key},
    body:JSON.stringify({input:"AI_HUB_ROUTE "+row.attempt+"\n重複送信の検証",session_id:"hub-"+key})};
  const repeat=await Promise.all([worker("tanaka","/v1/runs",duplicate),worker("tanaka","/v1/runs",duplicate)]);
  assert.deepEqual(repeat.map(r=>r.status),[409,409]);
  assert.equal(resources().length,0,"archive reads and repeat sends should not start a container");
  await page.goto(emp+"/#job/"+id);
  await page.getByRole("heading",{name:"結果を確認中"}).waitFor();
  const mgr=await browser.newPage({httpCredentials:{origin:admin,username:"aoki",password:readFileSync(process.env.LAB_ADMIN_FILE,"utf8").trim()}});
  await mgr.goto(admin+"/admin.html#recoveries");
  const item=mgr.locator("#recoveryRows article").filter({hasText:id});
  const reply=mgr.waitForResponse(r=>r.request().method()==="POST" && r.url().endsWith("/api/admin/recoveries/"+id));
  await item.getByRole("button",{name:"受付記録を照合"}).click();
  const outcome=await (await reply).json();assert.equal(outcome.status,"done");
  await mgr.getByText(outcome.message,{exact:true}).waitFor();
  await mgr.locator("#recoveries").screenshot({path:"results/admin-recovered.png"});
  await checkSource(page,minutes,"meeting-source");
  assert.equal(page.url(),emp+"/#job/"+id);
  const recovered=await job(id);
  assert.equal(recovered.run_id,run);assert.equal(recovered.memo,stored.output.trim());
  const repeated=await mgr.request.post(admin+"/api/admin/recoveries/"+id,{headers:{Origin:admin},
    data:{phase:"compose",run_id:null,lookup:"receipt"}});
  assert.equal(repeated.status(),409);
  const next=await browser.newPage();await next.goto(emp+"/#job/"+week);
  await checkSource(next,progress,"weekly-source");
  assert.equal((await job(week)).status,"done");
  const w=await until(()=>booking(week)?.result && booking(week));
  const newContainer=instance(), nextId=docker("inspect","-f","{{.Id}}",newContainer);
  assert.notEqual(nextId,previous);assert.deepEqual(hermesRecords(newContainer,week),[[[w.run]],[[w.run]]]);
  assert.deepEqual(hermesRecords(newContainer,id),[[],[]]);
  const wire=docker("exec",hub,"cat","/data/test-wire.ndjson").trim().split("\n").map(line=>JSON.parse(line));
  for(const j of [id,week])assert.equal(wire.filter(x=>x.type==="outbound-post"&&x.key===j+"-compose").length,1);
  assert.equal(wire.filter(x=>x.type==="drop-202"&&x.key===key).length,1);
  save("completed.json",{id,run,week,weeklyRun:w.run,stoppedAt,capturedAt,newContainer:nextId,archivedOutput:stored.output,
    admin:outcome,repeatAdminStatus:repeated.status(),memoMatchesArchive:true,duplicateStatuses:repeat.map(r=>r.status),wrongAttempt:"mismatch",otherEmployeeReceipt:"missing",otherEmployeeRun:404,
    otherEmployeeJob:404,coldReadsStartedContainers:0,originalReceiptInNewContainer:0,wire});
  console.log("Recovered source and queued weekly report.",id,week);
}
async function waitForStop(){
  const {previous,capturedAt}=JSON.parse(readFileSync("results/pending.json","utf8"));
  await until(()=>!docker("ps","--filter","id="+previous,"--format","{{.ID}}"),670000,1000);
  const now=Date.now();
  save("idle.json",{observedStopUTC:new Date(now).toISOString(),
    elapsedSecondsSinceD1Capture:(now-capturedAt)/1000,container:previous});
}

async function unfinished(){
  const owner="http://127.0.0.1:19431";
  assert.equal(docker("port",hub,"19431/tcp"),"127.0.0.1:19431");
  await (await worker("sato","/health")).text();
  docker("exec",hub,"touch","/data/lab-hold-sato","/data/lab-drop-next");
  try {
    const id=await submit(page,"meeting","会議の記録",minutes,"受付済みで結果未確定の検証。",owner);
    await page.getByRole("heading",{name:"結果を確認中"}).waitFor();
    const key=id+"-compose";
    const pending=()=>db.prepare("SELECT run,result,attempt FROM archive WHERE actor='sato' AND job_phase=?").get(key);
    const row=pending();assert.ok(row);assert.equal(row.result,null);
    const name=resources().find(n=>docker("exec",n,"printenv","LAB_ACTOR")==="sato");
    const records=await until(()=>{
      const [bookings,admissions]=hermesRecords(name,id);
      return bookings.length===1 && admissions.length===1 && bookings[0][0]===admissions[0][0] && {bookings,admissions};
    });
    await until(()=>pending().run===records.bookings[0][0]);
    const container=docker("inspect","-f","{{.Id}}",name);
    docker("kill",container);
    await until(()=>!resources().includes(name));
    const manager=await browser.newPage({httpCredentials:{origin:admin,username:"aoki",password:readFileSync(process.env.LAB_ADMIN_FILE,"utf8").trim()}});
    await manager.goto(admin+"/admin.html#recoveries");
    const reply=manager.waitForResponse(r=>r.request().method()==="POST" && r.url().endsWith("/api/admin/recoveries/"+id));
    await manager.locator("#recoveryRows article").filter({hasText:id}).getByRole("button",{name:"受付記録を照合"}).click();
    const outcome=await (await reply).json();assert.equal(outcome.status,"unknown");
    await manager.getByText(outcome.message,{exact:true}).waitFor();
    await manager.locator("#recoveries").screenshot({path:"results/unfinished.png"});
    await page.reload();await page.getByRole("heading",{name:"結果を確認中"}).waitFor();
    const last=await (await page.request.get(owner+"/api/jobs/"+id)).json();
    assert.equal(last.run_id,null);assert.equal(last.status,"unknown");assert.equal(pending().result,null);
    const wire=docker("exec",hub,"cat","/data/test-wire.ndjson").trim().split("\n").map(s=>JSON.parse(s)).filter(x=>x.key===key);
    assert.deepEqual(wire.map(x=>x.type),["outbound-post","drop-202"]);
    save("unfinished.json",{id,records,archivedReceipt:pending().run,archivedResult:null,hubRun:null,outcome,wire});
    console.log("Held without a terminal result.",id);
  } finally {docker("exec",hub,"rm","-f","/data/lab-hold-sato","/data/lab-drop-next");}
}

try {
  if (process.argv[2]==="begin") await begin();
  else if (process.argv[2]==="long") await begin(true);
  else if (process.argv[2]==="wait") await waitForStop();
  else if (process.argv[2]==="finish") await finish();
  else if (process.argv[2]==="unfinished") await unfinished();
  else throw Error("Use begin, long, unfinished, wait or finish");
} finally {await browser.close();db.close();}
