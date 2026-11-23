import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const docker=(...args)=>execFileSync("docker",["--context","colima-mac-studio-solo",...args],{encoding:"utf8"});
const name=process.env.WP06_PROJECT || "ai-hub-wp06";
const employeePort=Number(process.env.WP06_EMPLOYEE_PORT || 19931);
const peerPort=Number(process.env.WP06_PEER_PORT || 19932);
const base="http://127.0.0.1:"+employeePort, peer="http://127.0.0.1:"+peerPort;
assert.equal(docker("port",name+"-hub-1",employeePort+"/tcp").trim(),"127.0.0.1:"+employeePort);
const browser=await chromium.launch({channel:"chrome"});
const tag=String(Date.now());
const screenshots=process.env.WP06_SCREENSHOT_DIR;
const japan=milliseconds=>new Date(milliseconds+9*3600000).toISOString().slice(0,16).replace("T"," ");
function post(path,input) {
  return fetch(base+path,{method:"POST",headers:{Origin:base,"Content-Type":"application/json","Idempotency-Key":randomUUID()},
    body:JSON.stringify(input)});
}
async function job(id) {
  const result=await fetch(base+"/api/jobs/"+id);
  assert.equal(result.status,200);
  return result.json();
}
async function until(check,timeout=100000) {
  const end=Date.now()+timeout;
  while (Date.now()<end) {
    const result=await check();
    if (result) return result;
    await delay(250);
  }
  throw Error("条件を確認できませんでした。");
}
function admitted(id,phase="compose") {
  return Number(docker("exec",name+"-sato-1","python","-c",
    "import sqlite3,sys; print(sqlite3.connect('file:/opt/data/runs_idempotency.db?mode=ro',uri=True).execute('select count(*) from run_idempotency where idempotency_key=?',(sys.argv[1],)).fetchone()[0])",
    id+"-"+phase));
}
function hubRows(sql,...args) {
  return JSON.parse(docker("exec",name+"-hub-1","node","-e",
    "const db=new(require('node:sqlite').DatabaseSync)('/data/hub.sqlite',{readOnly:true}); console.log(JSON.stringify(db.prepare(process.argv[1]).all(...process.argv.slice(2))));",
    sql,...args));
}

try {
  let page=await browser.newPage({viewport:{width:390,height:844},timezoneId:"America/Los_Angeles"});
  await page.goto(base+"/#planning");
  await page.getByRole("heading",{name:"実行を予約する"}).waitFor();
  const reservation=page.locator("#reservationPlanner"), scheduleField=reservation.getByLabel("実行日時と依頼内容");
  await scheduleField.fill("毎週金曜の夕方に週報を作る");
  await reservation.getByRole("button",{name:"予約内容を確認する"}).click();
  await reservation.getByText(/何日の何時に実行しますか/).waitFor();
  async function planOnce(at,summary) {
    await page.goto(base+"/#planning");
    await scheduleField.fill(japan(at)+"に"+summary);
    const checked=page.waitForResponse(response=>response.url().endsWith("/api/reservation-plan/preview"));
    await reservation.getByRole("button",{name:"予約内容を確認する"}).click();
    const plan=await (await checked).json();
    assert.equal(plan.nextRun,Math.floor(at/60000)*60000);
    await reservation.getByText(plan.display+"（日本時間）",{exact:false}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if (screenshots) await page.screenshot({path:screenshots+"/reservation-mobile.png"});
    await reservation.getByRole("button",{name:"この内容で予約する"}).click();
    await page.waitForURL(/#job\/[0-9a-f-]{36}$/);
    const id=page.url().split("#job/")[1];
    assert.equal((await job(id)).scheduled_at,plan.nextRun);
    return id;
  }
  const cancelled=await planOnce(Date.now()+180000,"取消確認 "+tag);
  await page.getByRole("button",{name:"依頼を取り消す"}).click();
  await page.getByRole("heading",{name:"依頼を取り消しました"}).waitFor();
  const scheduled=await planOnce(Date.now()+70000,"棚卸し結果を整理する "+tag);
  await page.context().close();
  docker("restart",name+"-hub-1");
  await until(()=>fetch(base+"/api/workspace").then(response=>response.ok).catch(()=>false),30000);
  console.log("TOM-109 390px・ブラウザ時差ありでJSTの予約前プレビューと保存スロットが一致。あいまい時刻を拒否。");

  const rawA="第1条。出張申請は7日前。", rawB="第2条。精算期限は翌月10日。";
  const created=await post("/api/jobs",{company:"A社",kind:"general",ask:"旅費規程の確認 "+tag,
    contract:{name:"出張申請.txt",text:rawA},minutes:rawB});
  assert.equal(created.status,201);
  const origin=(await created.json()).id;
  await until(async()=> (await job(origin)).status==="done");
  page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.goto(base+"/#planning");
  const form=page.getByRole("form",{name:"作業を分担する"});
  await form.getByLabel("資料のある元の仕事").selectOption(origin);
  await form.getByLabel("まとめる内容").fill("旅費規程の申請と精算をまとめる "+tag);
  await form.getByLabel("作業1の名前").fill("申請期限の調査");
  await form.getByLabel("作業1の指示").fill("第1条の申請期限を調べ、出典を付ける。WP06順序試験 "+tag);
  await form.getByLabel("作業2の名前").fill("精算期限の点検");
  await form.getByLabel("作業2の指示").fill("第2条の精算期限を点検する。WP06失敗試験 "+tag);
  await form.getByRole("group",{name:"作業1の資料"}).getByLabel(/貼り付け|原文/).last().uncheck();
  await form.getByRole("group",{name:"作業2の資料"}).getByLabel(/出張申請.txt/).uncheck();
  await form.getByRole("button",{name:"この分担で依頼する"}).click();
  await page.waitForURL(/#job\/[0-9a-f-]{36}$/);
  const parent=page.url().split("#job/")[1];
  const first=await until(async()=>{
    const state=(await job(parent)).distribution;
    return state?.parts.every(part=>["done","failed"].includes(part.status)) && state;
  });
  assert.deepEqual(first.parts.map(part=>[part.name,part.status]),[["申請期限の調査","done"],["精算期限の点検","failed"]]);
  const [a,b]=first.parts.map(part=>part.current_job);
  assert.deepEqual((await job(a)).sources.map(source=>source.text),[rawA]);
  assert.deepEqual((await job(b)).sources.map(source=>source.text),[rawB]);
  const dispatch=hubRows("SELECT job_id,dispatch_time FROM attempts WHERE job_id IN (?,?) ORDER BY dispatch_time",a,b);
  assert.equal(dispatch.length,2);
  const finish=hubRows("SELECT job,max(finished) AS finished FROM model_calls WHERE job IN (?,?) GROUP BY job ORDER BY finished",a,b);
  assert.deepEqual(finish.map(row=>row.job),[b,a]);
  assert.ok(dispatch[1].dispatch_time<finish[0].finished);
  await page.getByRole("button",{name:"完了済みの結果を集約する"}).click();
  await page.locator("#memoText").waitFor({timeout:60000});
  await page.getByText("一部の結果で集約しています。各作業の結果は下に表示されます。",{exact:true}).waitFor();
  if (screenshots) await page.screenshot({path:screenshots+"/partial-desktop.png"});
  assert.equal((await job(parent)).sources[0].job,a);
  await page.getByRole("button",{name:"この作業だけ再実行する"}).click();
  const after=await until(async()=>{
    const state=(await job(parent)).distribution;
    return state.parts[1].generation===2 && state.parts[1].status==="done" && state;
  });
  const retry=after.parts[1].current_job;
  for (const id of [origin,parent,a,b,retry]) assert.equal(admitted(id),1);
  assert.equal((await fetch(peer+"/api/jobs/"+parent)).status,404);
  await page.reload();
  await page.getByRole("link",{name:"「精算期限の点検」の仕事と出典を開く"}).click();
  await page.locator("#memoText .citation").first().click();
  await page.getByRole("dialog").getByText(rawB,{exact:true}).waitFor();
  console.log("TOM-111 実Hermes・固定応答モデルで子2件の同時受付、逆順完了、部分集約、失敗した子だけの再実行、原文と受付件数を確認。");

  const done=await until(async()=>{const result=await job(scheduled);return result.status==="done" && result;},95000);
  assert.equal(admitted(scheduled),1);
  assert.equal(admitted(cancelled),0);
  assert.equal(hubRows("SELECT count(*) n FROM job_notifications WHERE job=? AND status='done'",scheduled)[0].n,1);
  console.log("TOM-110 ブラウザを閉じてHubを再起動後、予定枠から仕事1件、Hermes受付1件、完了通知1件。取消済み受付0件。");
  for (const id of [origin,scheduled,parent]) {
    const revised=await post("/api/jobs/"+id+"/revise",{base:1,instruction:"箇条書きで整理してください。"});
    assert.equal(revised.status,200);
    await until(async()=> (await job(id)).versions.some(version=>version.version===2));
    await page.goto(base+"/#job/"+id);
    await page.getByRole("button",{name:"この版を採用",exact:true}).click();
    await until(async()=> (await job(id)).adopted_version===2);
    await page.reload();
    await page.locator("#memoVersion").waitFor();
    assert.match(await page.locator('#memoVersion option[value="2"]').textContent(),/第2版.*採用版/);
    await page.locator("#jobRecord > summary").click();
    await page.getByRole("button",{name:"自分用の手順に保存",exact:true}).click();
    const save=page.getByRole("dialog");
    const templateName="WP06の採用手順 "+id.slice(0,8);
    await save.getByLabel("手順名",{exact:true}).fill(templateName);
    await save.getByRole("button",{name:"自分用に保存",exact:true}).click();
    await save.waitFor({state:"hidden"});
    const workspace=await fetch(base+"/api/workspace").then(response=>response.json());
    assert.match(workspace.templates.find(template=>template.name===templateName).output_format,/箇条書き/);
  }
  assert.ok(done.versions[0].memo);
  const variant=await post("/api/work-split",{origin,ask:"期限案内を比較する "+tag,maxParallel:2,maxRuns:3,maxCalls:18,
    parts:[{name:"短文案",instructions:"WP06短文案を作る",sourceIds:[1]},
      {name:"丁寧案",instructions:"WP06丁寧案を作る",sourceIds:[1]},
      {name:"未確認事項",instructions:"WP06未確認事項を点検する",sourceIds:[2]}]});
  assert.equal(variant.status,201);
  const bundle=(await variant.json()).id;
  const full=await until(async()=>{const result=await job(bundle);return result.status==="done" && result;});
  assert.equal(full.distribution.aggregate,"complete");
  assert.deepEqual(full.distribution.parts.map(part=>part.name),["短文案","丁寧案","未確認事項"]);
  await page.goto(base+"/#job/"+bundle);
  for (const line of ["短文案　申請期限を確認してください。","丁寧案　お手数ですが、申請期限をご確認いただけますでしょうか。","点検　例外の対象者と承認者は要確認です。"])
    await page.getByText(line,{exact:false}).first().waitFor();
  if (screenshots) await page.screenshot({path:screenshots+"/variants-desktop.png"});
  assert.deepEqual(full.sources.map(source=>source.title),["短文案","丁寧案","未確認事項"]);
  console.log(JSON.stringify({issue:"TOM-112",scheduled,parent,children:[a,b,retry],adoptedVersion:2,
    variants:bundle,chrome:browser.version(),hermesAdmissions:[1,1,1],model:"fixture-model"}));
} finally {await browser.close();}
