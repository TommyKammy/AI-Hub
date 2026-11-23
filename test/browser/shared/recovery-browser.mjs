// Run against a fresh disposable hermes-recovery-verify stack using test/integration/compose/compose.recovery.yaml.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { adminCredentials } from "../../support/admin-credentials.mjs";
const {chromium} = createRequire(new URL("../../", import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const employee = "http://127.0.0.1:18831", admin = "http://127.0.0.1:18833";
const docker = (...args) => execFileSync("docker", ["--context",process.env.AI_HUB_DOCKER_CONTEXT || "colima-mac-studio-solo",...args], {encoding:"utf8"});
const proxy = "hermes-recovery-verify-recovery-proxy-1";
const lostAcceptance = process.argv.includes("--lost-acceptance");
const unmatched = process.argv.includes("--unmatched-meeting");
function storedIds(id) {
  const js = `const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("/data/hub.sqlite",{readOnly:true});
    console.log(JSON.stringify(db.prepare("SELECT j.run_id,a.hermes_run_id FROM jobs j JOIN attempts a ON a.job_id=j.id AND a.phase=j.phase WHERE j.id=?").get(process.argv[1])))`;
  return JSON.parse(docker("exec","hermes-recovery-verify-hub-1","node","-e",js,id));
}
assert.equal(docker("inspect","-f","{{.State.Running}}",proxy).trim(),"true");
const minutes = "東支店で棚卸しを12月4日に実施すると決定した。\n宿題は山田が12月1日までに手順書を提出すること。";
const weeklyNotes = "東支店の在庫確認が完了した。\n課題は台帳の不足。\n来週は台帳を補充する。";
const browser = await chromium.launch({channel:"chrome"});
async function submit(page, kind, label, text, ask) {
  await page.goto(employee);
  await page.getByLabel("依頼の種類").selectOption(kind);
  await page.getByText("自分の資料を使う",{exact:true}).click();
  await page.getByLabel(label,{exact:true}).fill(text);
  await page.getByLabel("依頼内容",{exact:true}).fill(ask);
  await page.getByRole("button",{name:"送信",exact:true}).click();
  await page.waitForURL(/#job\//);
  return page.url().split("#job/")[1];
}
async function until(read,ms=120000) {
  const end=Date.now()+ms;
  while (Date.now()<end) {
    const value=await read();
    if (value) return value;
    await delay(500);
  }
  assert.fail("条件が期限内に成立しませんでした: "+String(read));
}

async function verifyClosure({meeting,manager,id,week,real,jobUrl,hidden,history,restartHub}) {
  const nextPage=await browser.newPage();
  const next=await submit(nextPage,"meeting","会議の記録","西支店で12月10日に研修を行うと決定した。","決定事項を整理して。");
  await nextPage.getByRole("heading",{name:"受付済み"}).waitFor();
  const path="/api/admin/recoveries/"+id+"/close";
  const reason="受付記録を3回照合しても元の実行を特定できなかったため、依頼者と確認して対応を終了しました。";
  const request=(page,origin,data)=>page.request.post(origin+path,{headers:{Origin:origin},data});
  assert.equal((await request(manager,admin,{reason})).status(),409);
  const auditor=await browser.newPage({httpCredentials:adminCredentials(admin,"mori")});
  assert.equal((await request(auditor,admin,{reason})).status(),403);
  assert.equal((await request(meeting,employee,{reason})).status(),403);
  await until(()=>history().length===3);
  await manager.reload();
  const other=await browser.newPage({httpCredentials:adminCredentials(admin)});
  await other.goto(admin+"/admin.html#recoveries");
  const forms=[manager,other].map(page=>page.locator('form[data-close="'+id+'"]'));
  const submitButton=form=>form.getByRole("button",{name:"結果未確認で対応終了"});
  await submitButton(forms[0]).click();
  assert.equal(await forms[0].locator("input:invalid").count(),1);
  assert.equal((await request(manager,admin,{reason:"   "})).status(),400);
  for (const form of forms) await form.getByLabel(/終了理由/).fill(reason);
  const capture=async(locator,name)=>{
    if (process.env.RECOVERY_SCREENSHOTS) await locator.screenshot({path:process.env.RECOVERY_SCREENSHOTS+"/closure-"+name+".png"});
  };
  await capture(manager.locator("#recoveries"),"admin");
  const replies=[manager,other].map(page=>page.waitForResponse(r=>r.url()===admin+path && r.request().method()==="POST"));
  await Promise.all(forms.map(form=>submitButton(form).evaluate(b=>{b.click();b.click();})));
  for (const res of await Promise.all(replies)) assert.equal(res.status(),200);
  const closedHeading=meeting.getByRole("heading",{name:"結果未確認で対応終了"});
  await closedHeading.waitFor();
  assert.equal(meeting.url(),jobUrl);
  await meeting.getByText(reason,{exact:true}).waitFor();
  await until(()=>docker("logs",proxy).includes("holding completed "));
  const nextIds=storedIds(next);
  assert.ok(nextIds.run_id);
  // The original receipt is readable again, including after a Hub restart.
  docker("exec",proxy,"rm",hidden);
  await restartHub();
  const probe=`import {receiptClient} from "./src/jobs/hub.mjs"; import {DatabaseSync} from "node:sqlite";
    const db=new DatabaseSync("/data/hub.sqlite",{readOnly:true}), id=process.argv[1];
    const {route_key}=db.prepare("SELECT route_key FROM attempts WHERE job_id=? AND phase='compose'").get(id);
    console.log(JSON.stringify(await receiptClient()("sato",id,"compose",route_key)));`;
  const receipt=JSON.parse(docker("exec","hermes-recovery-verify-hub-1","node","--input-type=module","-e",probe,id));
  assert.equal(receipt.result,"matched"); assert.equal(receipt.run_id,real);
  assert.equal((await request(manager,admin,{reason})).status(),200);
  assert.equal((await request(manager,admin,{reason:"書き換え"})).status(),409);
  assert.equal((await manager.request.post(admin+"/api/admin/recoveries/"+id,{headers:{Origin:admin},data:{phase:"compose",run_id:null,lookup:"receipt"}})).status(),409);
  docker("exec",proxy,"touch","/tmp/release-weekly-result");
  await nextPage.reload();
  await nextPage.locator("#memoText").waitFor();
  assert.match(await nextPage.locator("#memoText").innerText(),/12月10日/);
  await capture(nextPage,"next");
  await meeting.reload();
  await closedHeading.waitFor();
  await meeting.getByText(reason,{exact:true}).waitFor();
  assert.equal(await meeting.locator("#memoText").count(),0);
  await capture(meeting,"employee");
  assert.deepEqual(storedIds(id),{run_id:null,hermes_run_id:null});
  assert.deepEqual(history(),["missing","missing","missing"]);
  assert.deepEqual(storedIds(next),nextIds);
  const posts=docker("logs",proxy).split("\n").filter(x=>x.startsWith("POST /v1/runs "));
  for (const job of [id,week,next]) assert.equal(posts.filter(x=>x.includes(job+"-compose")).length,1);
  const audit=JSON.parse(docker("exec","hermes-recovery-verify-hub-1","node","-e",`
    const db=new(require("node:sqlite").DatabaseSync)("/data/hub.sqlite",{readOnly:true});
    console.log(JSON.stringify(db.prepare("SELECT operator,reason FROM meeting_closures WHERE meeting=?").all(process.argv[1])));`,id));
  assert.deepEqual(audit,[{operator:"aoki",reason}]);
  console.log(JSON.stringify({meeting:id,meetingRun:real,week,next,nextRun:nextIds.run_id,closureRecords:audit.length}));
}

async function verifyDelayed(exhaust,closing=false) {
  const meeting=await browser.newPage(),weekly=await browser.newPage();
  const manager=await browser.newPage({httpCredentials:adminCredentials(admin)});
  const id=await submit(meeting,"meeting","会議の記録",minutes,"決定事項と担当者の宿題に整理して。");
  const jobUrl=meeting.url();
  await meeting.getByRole("heading",{name:"結果を確認中"}).waitFor();
  // Wait for the genuine model output before making this receipt temporarily invisible.
  const store="import sqlite3,sys; db=sqlite3.connect('file:/opt/data/runs_idempotency.db?mode=ro',uri=True); print(db.execute(\"SELECT run_id FROM run_idempotency WHERE idempotency_key=? AND json_extract(status_json,'$.status')='completed'\",(sys.argv[1],)).fetchone() or '')";
  const real=await until(()=>docker("exec","hermes-recovery-verify-sato-1","python","-c",store,id+"-compose").match(/run_[0-9a-f]{32}/)?.[0]);
  const hidden="/tmp/hide-"+id+"-compose";
  docker("exec",proxy,"touch",hidden);
  const week=await submit(weekly,"weekly","週の進捗記録",weeklyNotes,"今週の完了・課題・来週の予定を週報にして。");
  await manager.goto(admin+"/admin.html#recoveries");
  const row=manager.locator("#recoveryRows article").filter({hasText:id});
  const check=row.getByRole("button",{name:"受付記録を照合"});
  await check.click();
  await row.locator('[data-weekly="'+week+'"]').click();
  const hubContainer="hermes-recovery-verify-hub-1";
  const history=()=>JSON.parse(docker("exec",hubContainer,"node","-e",`
    const db=new(require("node:sqlite").DatabaseSync)("/data/hub.sqlite",{readOnly:true});
    console.log(JSON.stringify(db.prepare("SELECT outcome FROM receipt_checks WHERE job=? AND operator='system:auto-receipt' ORDER BY seq").all(process.argv[1]).map(x=>x.outcome)));`,id));
  await weekly.locator("#memoText").waitFor({timeout:150000});
  assert.match(await weekly.locator("#memoText").innerText(),/台帳/);
  await until(()=>history().length===1);
  assert.deepEqual(storedIds(id),{run_id:null,hermes_run_id:null});
  const weeklyIds=storedIds(week);
  assert.ok(weeklyIds.run_id && weeklyIds.hermes_run_id===weeklyIds.run_id);
  const restartHub=async()=>{
    docker("restart",hubContainer);
    await until(async()=>(await manager.request.get(admin+"/api/admin/recoveries",{timeout:2000}).catch(()=>null))?.ok());
  };
  await restartHub();
  if (closing) return verifyClosure({meeting,manager,id,week,real,jobUrl,hidden,history,restartHub});
  const snapshot=async(page,name)=>{
    if(process.env.RECOVERY_SCREENSHOTS) await page.screenshot({path:process.env.RECOVERY_SCREENSHOTS+"/auto-receipt-"+name+".png"});
  };
  if(exhaust) {
    await until(()=>history().length===3);
    await manager.reload();
    await row.getByText(/自動照合は上限の3回に達しました/).waitFor();
    await check.waitFor();
    await meeting.reload();
    await meeting.getByRole("heading",{name:"結果を確認中"}).waitFor();
    assert.deepEqual(storedIds(id),{run_id:null,hermes_run_id:null});
    await snapshot(manager.locator("#recoveries"),"limit");
    // The manual action still works after the automatic budget is spent.
    docker("exec",proxy,"rm",hidden);
    await restartHub();
    await delay(2500);
    assert.deepEqual(history(),["missing","missing","missing"]);
    assert.deepEqual(storedIds(id),{run_id:null,hermes_run_id:null});
    await manager.reload();
    await check.click();
  } else {
    docker("exec",proxy,"rm",hidden);
  }
  await meeting.locator("#memoText").waitFor({timeout:120000});
  assert.equal(meeting.url(),jobUrl);
  assert.match(await meeting.locator("#memoText").innerText(),/12月4日/);
  await meeting.locator("#memoText").getByRole("button",{name:"出典1を開く"}).first().click();
  assert.equal(await meeting.locator("#dlgbody .note").textContent(),minutes);
  if(!exhaust) await snapshot(meeting,"source");
  const outcomes=history();
  assert.deepEqual(outcomes,exhaust ? ["missing","missing","missing"] : ["missing","matched"]);
  assert.deepEqual(storedIds(id),{run_id:real,hermes_run_id:real});
  assert.deepEqual(storedIds(week),weeklyIds);
  const posts=docker("logs",proxy).split("\n").filter(x=>x.startsWith("POST /v1/runs "));
  for(const key of [id,week]) assert.equal(posts.filter(x=>x.includes(key+"-compose")).length,1);
  console.log(JSON.stringify({exhaust,meeting:id,meetingRun:real,weekly:week,weeklyRun:weeklyIds.run_id,outcomes}));
  await Promise.all([meeting.close(),weekly.close(),manager.close()]);
}
async function verifyWeeklyStart({meeting,weekly,manager,auditor,id,week,row,check}) {
  const checkReceipt = async () => {
    await check.click();
    await manager.getByText("受付記録が見つかりません。 保留を継続します。",{exact:true}).waitFor();
  };
  const capture = async (page,name) => {
    if (process.env.RECOVERY_SCREENSHOTS) await page.screenshot({path:process.env.RECOVERY_SCREENSHOTS+"/weekly-start-"+name+".png"});
  };
  const start = row.locator('[data-weekly="'+week+'"]');
  const path = "/api/admin/recoveries/"+id+"/weekly/"+week;
  const waiting = await browser.newPage();
  const unselected = await submit(waiting,"weekly","週の進捗記録","来週は西支店の予定を確認する。","西支店の週報を作成して。");
  assert.equal(await start.count(),0);
  await checkReceipt();
  await start.waitFor();
  await row.locator('[data-weekly="'+unselected+'"]').waitFor();
  for (const [page,origin] of [[meeting,employee],[auditor,admin]]) {
    const res = await page.request.post(origin+path,{headers:{Origin:origin},data:{}});
    assert.equal(res.status(),403);
  }
  const other = await browser.newPage({httpCredentials:adminCredentials(admin)});
  await other.goto(admin+"/admin.html#recoveries");
  const otherStart = other.locator('[data-weekly="'+week+'"]');
  await otherStart.waitFor();
  await capture(manager,"admin");
  const replies = [manager,other].map(p => p.waitForResponse(r=>r.url()===admin+path && r.request().method()==="POST"));
  await Promise.all([start,otherStart].map(b => b.evaluate(el=>{el.click();el.click();})));
  for (const reply of await Promise.all(replies)) assert.equal(reply.status(),200);
  const deadline = Date.now()+180000;
  while (!docker("logs",proxy).includes("holding completed ") && Date.now()<deadline) await delay(500);
  assert.ok(docker("logs",proxy).includes("holding completed "));
  const before = storedIds(week);
  assert.ok(before.run_id && before.hermes_run_id===before.run_id);
  docker("restart","hermes-recovery-verify-hub-1");
  const readyBy=Date.now()+30000;
  let online=false;
  while (!online && Date.now()<readyBy) {
    online=(await manager.request.get(admin+"/api/admin/recoveries",{timeout:2000}).catch(()=>null))?.ok();
    if (!online) await delay(250);
  }
  assert.ok(online,"再起動後の管理者APIが応答しませんでした");
  await manager.reload();
  await check.waitFor();
  const repeat = await manager.request.post(admin+path,{headers:{Origin:admin},data:{}});
  assert.equal((await repeat.json()).message,"この週報の開始は受付済みです。");
  docker("exec",proxy,"touch","/tmp/release-weekly-result");
  await weekly.reload();
  await weekly.locator("#memoText").waitFor({timeout:90000});
  assert.match(await weekly.locator("#memoText").innerText(),/台帳/);
  await weekly.locator("#memoText").getByRole("button",{name:"出典1を開く"}).first().click();
  assert.equal(await weekly.locator("#dlgbody .note").textContent(),weeklyNotes);
  await capture(weekly,"source");
  await meeting.reload();
  await meeting.getByRole("heading",{name:"結果を確認中"}).waitFor();
  await checkReceipt();
  await capture(manager,"recheck");
  assert.deepEqual(storedIds(id),{run_id:null,hermes_run_id:null});
  assert.deepEqual(storedIds(week),before);
  await waiting.reload();
  await waiting.getByRole("heading",{name:"受付済み"}).waitFor();
  const wire=docker("logs",proxy).split("\n");
  assert.equal(wire.filter(l=>l.includes(unselected+"-compose")).length,0);
  for (const job of [id,week]) assert.equal(wire.filter(l=>l==="POST /v1/runs "+job+"-compose 202").length,1);
  const job=await (await weekly.request.get(employee+"/api/jobs/"+week)).json();
  assert.equal(job.status,"done");
  console.log(JSON.stringify({meeting:id,weekly:week,weeklyRun:before.run_id,model:job.model.model_id,
    meetingPosts:1,weeklyPosts:1,unselected,source:weeklyNotes}));
}
async function verify() {
  const meeting = await browser.newPage(), weekly = await browser.newPage();
  const manager = await browser.newPage({httpCredentials:adminCredentials(admin)});
  const auditor = await browser.newPage({httpCredentials:adminCredentials(admin,"mori")});
  for (const p of [meeting,weekly,manager,auditor]) p.setDefaultTimeout(30000);
  const id = await submit(meeting,"meeting","会議の記録",minutes,"決定事項と担当者の宿題に整理して。");
  await meeting.getByRole("heading",{name:"結果を確認中"}).waitFor();
  const jobUrl = meeting.url();
  const week = await submit(weekly,"weekly","週の進捗記録",weeklyNotes,"今週の完了・課題・来週の予定を週報にして。");
  await weekly.getByRole("heading",{name:"受付済み"}).waitFor();
  await manager.goto(admin+"/admin.html");
  await manager.getByRole("link",{name:"Hermes 実行照合"}).click();
  const row = manager.locator("#recoveryRows article").filter({hasText:id});
  const check = row.getByRole("button",{name:lostAcceptance || unmatched ? "受付記録を照合" : "実行結果を照合"});
  await check.waitFor();
  if (unmatched) return verifyWeeklyStart({meeting,weekly,manager,auditor,id,week,row,check});
  let runId = await check.getAttribute("data-run");
  if (lostAcceptance) assert.deepEqual(storedIds(id),{run_id:null,hermes_run_id:null});
  const path = "/api/admin/recoveries/" + id;
  const payload = {phase:"compose",run_id:runId,...(lostAcceptance && {lookup:"receipt"})};
  for (const [page,origin] of [[meeting,employee],[auditor,admin]]) {
    const res = await page.request.post(origin+path,{headers:{Origin:origin},data:payload});
    assert.equal(res.status(),403);
  }
  const capture = async (page,name) => {
    if (process.env.RECOVERY_SCREENSHOTS) await page.screenshot({path:process.env.RECOVERY_SCREENSHOTS+"/"+(lostAcceptance ? "receipt-" : "")+name+".png"});
  };
  if (!lostAcceptance) {
    await check.click(); // the proxy returns its second 404
    await manager.getByText("実行が見つかりません。確認待ちを継続します。").waitFor();
  }
  await capture(manager,"recovery-admin");
  const readJob = async (page,job) => (await (await page.request.get(employee+"/api/jobs/"+job)).json());
  assert.equal((await readJob(weekly,week)).status,"queued");
  await check.click();
  await manager.locator("#recoveryRows article").filter({hasText:id}).waitFor({state:"detached"});
  await manager.locator("#recoveryResult").filter({hasText:/元の仕事に反映しました|同じ実行の進捗確認を再開しました/}).waitFor();
  await meeting.locator('#memoText, #main h2:text-is("要確認")').first().waitFor({timeout:180000});
  assert.equal(await meeting.locator("#memoText").count(),1,"復旧したメモが表示されませんでした");
  assert.equal(meeting.url(),jobUrl);
  assert.match(await meeting.locator("#memoText").innerText(),/12月4日/);
  await meeting.locator("#memoText").getByRole("button",{name:"出典1を開く"}).first().click();
  assert.equal(await meeting.locator("#dlgbody .note").textContent(),minutes);
  await capture(meeting,"recovery-meeting-source");
  await weekly.locator("#memoText").waitFor({timeout:180000});
  assert.match(await weekly.locator("#memoText").innerText(),/台帳/);
  await capture(weekly,"recovery-weekly");
  await weekly.locator("#memoText").getByRole("button",{name:"出典1を開く"}).first().click();
  assert.equal(await weekly.locator("#dlgbody .note").textContent(),weeklyNotes);
  if (lostAcceptance) runId = (await readJob(meeting,id)).run_id;
  assert.ok(runId);
  assert.deepEqual(storedIds(id),{run_id:runId,hermes_run_id:runId});
  assert.equal((await manager.request.post(admin+path,{headers:{Origin:admin},data:payload})).status(),409);
  const wire = docker("logs",proxy).trim().split("\n");
  for (const job of [id,week]) assert.equal(wire.filter(line=>line.startsWith("POST /v1/runs "+job+"-compose ")).length,1);
  if (lostAcceptance) {
    assert.equal(wire.filter(line=>line==="dropped acceptance "+id+"-compose").length,1);
    const missing = await submit(weekly,"meeting","会議の記録",minutes,"未受付時の照合を確認");
    await weekly.getByRole("heading",{name:"結果を確認中"}).waitFor();
    await manager.getByRole("button",{name:"照合待ちを更新"}).click();
    await manager.locator("#recoveryRows article").filter({hasText:missing}).getByRole("button",{name:"受付記録を照合"}).click();
    await manager.getByText("受付記録が見つかりません。 保留を継続します。",{exact:true}).waitFor();
    assert.equal((await readJob(weekly,missing)).status,"unknown");
    assert.deepEqual(storedIds(missing),{run_id:null,hermes_run_id:null});
    await capture(manager,"missing");
    console.log("missing receipt held",missing);
  } else assert.equal(wire.filter(line=>line==="interrupted /v1/runs/"+runId).length,2);
  console.log(JSON.stringify({meeting:id,meetingRun:runId,weekly:week,weeklyRun:(await readJob(weekly,week)).run_id,model:(await readJob(meeting,id)).model.model_id,meetingPosts:1,weeklyPosts:1}));
}
try {
  if(process.argv.includes("--close-unconfirmed")) {
    await verifyDelayed(true,true);
  } else if(process.argv.includes("--delayed-receipt")) {
    await verifyDelayed(false);
    await verifyDelayed(true);
  } else await verify();
} finally { await browser.close(); }
