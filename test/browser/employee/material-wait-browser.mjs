import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir, rename, rm, symlink, writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {dirname,join,relative} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import {adminHeader} from "../../support/admin-credentials.mjs";

const {chromium}=createRequire(new URL("../../", import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const project="ai-hub-tom-113", context="colima-mac-studio-solo";
const sato="http://127.0.0.1:18971", tanaka="http://127.0.0.1:18972", admin="http://127.0.0.1:18973";
const library=fileURLToPath(new URL("../../../.runtime/tom-113-library/",import.meta.url));
const evidence=fileURLToPath(new URL("../../../evidence/",import.meta.url));
const docker=(...args)=>execFileSync("rtk",["proxy","docker","--context",context,...args],{encoding:"utf8"});
assert.match(docker("port",project+"-hub-1","18971/tcp"),/^127\.0\.0\.1:18971\s*$/);
assert.equal(JSON.parse(docker("inspect","--format","{{json .Mounts}}",project+"-hub-1"))
  .find(m=>m.Destination==="/app/library-data")?.Source,library.replace(/\/$/,""));

const run=randomUUID().slice(0,8);
const capture=process.env.CAPTURE_WORK==="1";
const modelName=process.argv.includes("--fixture") ? "fixture-model" : "qwen3.8-flash-next";
const a={name:"北山商事_見積.txt",text:"金額は120,000円（税抜）。\n納期は発注後10営業日。\n支払条件は月末締め翌月末払い。"};
const b={name:"南川産業_見積.txt",text:"金額は128,700円（税込）。\n納期は発注後7営業日。"};
const ask="北山商事と南川産業の見積を購買向けに比較してください。金額、納期、支払条件で比較し、記載がなければ要確認にしてください。";
const outputs={model:modelName,started:new Date().toISOString()};

async function api(origin,path,{data,key,expected}={}){
  const headers={Origin:origin};
  if(origin===admin) headers.Authorization=adminHeader(origin);
  if(data!==undefined) Object.assign(headers,{"Content-Type":"application/json","Idempotency-Key":key || randomUUID()});
  const res=await fetch(origin+"/api/"+path,{headers,method:data===undefined?"GET":"POST",body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(150000)});
  const result=await res.json();
  assert.ok(expected===undefined?res.ok:res.status===expected,`${path} ${res.status} ${result.error || ""}`);
  return result;
}
const detail=id=>api(sato,"jobs/"+id);
async function waitFor(fn,{timeout=15000}={}){
  const then=Date.now()+timeout;
  while(Date.now()<then){
    const value=await fn();
    if(value)return value;
    await delay(250);
  }
  throw Error("条件を確認できませんでした");
}
async function status(id,expected,timeout){
  return waitFor(async()=>{
    const j=await detail(id);
    if([expected].flat().includes(j.status))return j;
    assert.ok(["source_waiting","scheduled","queued","dispatching","running"].includes(j.status),JSON.stringify({id,expected,actual:j.status,arrival:j.arrival_wait,error:j.error}));
  },{timeout});
}
async function selectModel(){
  const path="admin/models", catalog=await api(admin,path);
  const model=catalog.models.find(m=>m.model_id===modelName) || await api(admin,path,{
    data:{name:"TOM-113 ローカル推論",connection:"local-mlx",model_id:modelName,data_class:"合成資料"},
  });
  if(catalog.current.model===model.id) return;
  assert.equal((await api(admin,path+"/"+model.id+"/test",{data:{}})).state,"passed");
  await api(admin,path+"/"+model.id+"/publish",{data:{base:catalog.current.version,reason:"TOM-113 の隔離受け入れ検証"}});
}
function acceptance(id){
  const hubSql="SELECT count(*) count FROM attempts WHERE job_id=?";
  const hub=Number(docker("exec",project+"-hub-1","node","--input-type=module","-e",
    "import {DatabaseSync} from 'node:sqlite'; console.log(new DatabaseSync('/data/hub.sqlite',{readOnly:true}).prepare(process.argv[1]).get(process.argv[2]).count)",hubSql,id));
  const hermes=JSON.parse(docker("exec",project+"-sato-1","python","-c",
    "import json, sqlite3, sys; print(json.dumps(sqlite3.connect('file:/opt/data/runs_idempotency.db?mode=ro',uri=True).execute('SELECT idempotency_key,run_id FROM run_idempotency WHERE idempotency_key LIKE ?', (sys.argv[1]+'-%',)).fetchall()))",id));
  return {hub,hermes};
}
function assertNoRun(id){
  assert.deepEqual(acceptance(id),{hub:0,hermes:[]});
}
async function folder(scope,id){
  const name="見積受取-"+id+"-"+run;
  const target={name,id:scope+"/"+name,dir:join(library,scope,name)};
  await mkdir(target.dir,{recursive:true});
  return target;
}
async function deliver(target){
  const path=join(target.dir,b.name), staging=join(target.dir,".delivery");
  await writeFile(staging,b.text);
  await rename(staging,path);
}
async function submitWaiting(target,suffix,deadline){
  const data={kind:"assistant",company:"A社",ask:ask+" "+suffix+" "+run,
    contract:a,arrival_wait:{library_id:target.id,name:b.name,deadline}};
  const key=randomUUID(), reply=await api(sato,"jobs",{data,key});
  assert.equal((await api(sato,"jobs",{data,key})).id,reply.id);
  assert.equal((await detail(reply.id)).status,"source_waiting");
  assertNoRun(reply.id);
  return reply.id;
}
async function restartHub(){
  docker("restart",project+"-hub-1");
  await waitFor(()=>api(sato,"workspace").catch(()=>null));
}

const browser=await chromium.launch({channel:"chrome"});
const page=await browser.newPage({viewport:{width:1200,height:900},timezoneId:"Asia/Tokyo"});
page.setDefaultTimeout(12000);
const jsErrors=[];
page.on("pageerror",error=>jsErrors.push(error.message));
try {
  const target=await folder("users/sato","通常");
  await selectModel();
  await page.goto(sato);
  const form=page.locator("#request");
  const subject=ask+" "+run;
  await form.getByLabel("依頼内容",{exact:true}).fill(subject);
  await form.getByText("自分の資料を使う",{exact:true}).click();
  await form.locator("[type=file]").first().setInputFiles({name:a.name,mimeType:"text/plain",buffer:Buffer.from(a.text)});
  await form.getByText(a.name+" を読み込みました。",{exact:true}).waitFor();
  await form.locator("[name=timing]").selectOption({label:"後から届く見積で比較"});
  await form.getByLabel("到着先の資料置き場").selectOption(target.id);
  await form.getByLabel("到着予定のファイル名").fill(b.name);
  const localDeadline=new Date(Date.now()+9*3600000+900000).toISOString().slice(0,16);
  await form.getByLabel("待機期限").fill(localDeadline);
  await form.getByRole("button",{name:/^(送信|資料待ちを登録|資料が揃ったら依頼する)$/}).click();
  await page.waitForURL("**/#job/*");
  const id=new URL(page.url()).hash.slice("#job/".length);
  const pending=await detail(id);
  assert.equal(pending.status,"source_waiting");
  assert.equal(pending.arrival_wait.deadline,Date.parse(localDeadline+"+09:00"));
  assert.deepEqual(pending.sources.map(s=>[s.title,s.text]),[[a.name,a.text]]);
  assertNoRun(id);
  await page.reload();
  await page.locator('#workspaceNav a[href="#jobs"]').click();
  await page.waitForURL("**/#jobs");
  await page.getByText("資料待ち",{exact:true}).first().waitFor();
  await page.getByText(subject,{exact:true}).last().click();
  await page.waitForURL("**/#job/"+id);
  await page.getByText(b.name,{exact:false}).first().waitFor();
  if(capture) await page.screenshot({path:join(evidence,"tom-113-material-wait.png")});
  await restartHub();
  assert.equal((await detail(id)).status,"source_waiting");
  await api(tanaka,"jobs/"+id,{expected:404});
  assertNoRun(id);

  await deliver(target);
  const result=await status(id,"done",180000);
  assert.equal(result.id,id);
  assert.equal(result.ask,subject);
  assert.equal(result.model.model_id,modelName);
  assert.deepEqual(result.sources.map(s=>[s.title,s.text]),[[a.name,a.text],[b.name,b.text]]);
  await deliver(target);
  await restartHub();
  await delay(1300);
  const record=acceptance(id);
  assert.equal(record.hub,1);
  assert.deepEqual(record.hermes,[[id+"-compose",result.run_id]]);
  const calls=(await api(admin,"admin/models/usage?job="+id)).rows;
  assert.ok(calls.length && calls.every(c=>c.served===modelName && c.outcome==="ok"),JSON.stringify(calls));
  assert.equal((await api(sato,"workspace")).jobs.filter(j=>j.ask===subject).length,1);
  await page.reload();
  const table=page.getByRole("region",{name:"見積比較表"});
  await table.waitFor();
  assert.match(await table.innerText(),/要確認/);
  assert.equal(await table.locator("tbody tr").count(),3);
  if(capture) await table.screenshot({path:join(evidence,"tom-113-material-comparison.png")});
  const originals=[];
  const amount=table.locator("tbody tr").filter({hasText:/金額|価格|総額/});
  for(const [i,source] of [a,b].entries()){
    await amount.locator("td").nth(i).getByRole("button").click();
    const dlg=page.locator("#dialog");
    assert.match(await dlg.innerText(),new RegExp(source.name.replace(".","\\.")));
    assert.equal(await dlg.locator("mark").innerText(),source.text.split("\n")[0]);
    if(capture) await dlg.screenshot({path:join(evidence,`tom-113-source-${i+1}.png`)});
    originals.push(await dlg.locator("mark").innerText());
    await dlg.getByRole("button",{name:"閉じる",exact:true}).click();
  }
  outputs.completed={id,runId:result.run_id,originals,acceptance:record,modelCalls:calls.length};
  console.log("資料待ちを一覧と再起動から復元し、到着と再到着後も1回だけ。同じ相談の比較で2原文を確認。",JSON.stringify(outputs.completed));

  const aTarget=await folder("shared","添付権限");
  const aBlocked=await submitWaiting(aTarget,"Aの権限失効",Date.now()+120000);
  const membership=async()=>(await api(admin,"admin/memberships")).find(m=>m.actor==="sato");
  const transfer=async team=>api(admin,"admin/memberships/sato",{data:{base:(await membership()).revision,team,reason:"TOM-113 添付資料権限の検証"}});
  const before=(await membership()).team;
  await transfer("資料受入検証部");
  let blockedA;
  try {
    await deliver(aTarget);
    blockedA=await status(aBlocked,["source_blocked","membership_blocked"]);
    assert.equal(blockedA.arrival_wait.reason,"attachment_access");
    assert.deepEqual(blockedA.sources,[]);
    assert.ok(!JSON.stringify(blockedA).includes(a.name));
    assert.ok(!JSON.stringify(blockedA).includes(a.text.split("\n")[0]));
    await page.goto(sato+"/#job/"+aBlocked);
    await page.reload();
    await page.getByText("現在の所属または利用状態では、先に添付した見積を参照できません。",{exact:true}).waitFor();
    const deniedPage=await page.locator("body").innerText();
    assert.ok(!deniedPage.includes(a.name));
    assert.ok(!deniedPage.includes(a.text.split("\n")[0]));
    assertNoRun(aBlocked);
  } finally { await transfer(before); }

  const bTarget=await folder("shared","到着先権限");
  const bBlocked=await submitWaiting(bTarget,"Bの権限失効",Date.now()+120000);
  const privateTarget=await folder("users/tanaka","閲覧不可");
  await deliver(privateTarget);
  await rm(bTarget.dir,{recursive:true});
  await symlink(relative(dirname(bTarget.dir),privateTarget.dir),bTarget.dir,"dir");
  const denied=await status(bBlocked,"source_blocked");
  assert.ok(denied.arrival_wait.reason);
  assert.ok(!denied.sources.some(s=>s.title===b.name));
  assertNoRun(bBlocked);
  outputs.blocked={attachment:{id:aBlocked,reason:blockedA.arrival_wait.reason,acceptance:acceptance(aBlocked)},
    arrival:{id:bBlocked,reason:denied.arrival_wait.reason,acceptance:acceptance(bBlocked)}};
  console.log("添付資料と到着先の権限失効で実行0件。",JSON.stringify(outputs.blocked));

  const late=await folder("shared","期限超過");
  const expiry=await submitWaiting(late,"期限超過",Date.now()+3500);
  await status(expiry,"source_expired");
  assertNoRun(expiry);
  const deadlineEvents=async()=>(await api(sato,"notifications")).filter(n=>n.job===expiry && n.status==="source_deadline");
  assert.equal((await deadlineEvents()).length,1);
  const [notice]=await deadlineEvents();
  await page.goto(sato);
  await page.locator("#notifications").click();
  const noticeButton=page.locator(`#dialog [data-op="event/${notice.seq}"]`);
  assert.match(await noticeButton.innerText(),/期限/);
  if(capture) await page.locator("#dialog").screenshot({path:join(evidence,"tom-113-deadline-notification.png")});
  await noticeButton.click();
  await page.waitForURL("**/#job/"+expiry);
  await deliver(late);
  await restartHub();
  await delay(1300);
  assert.equal((await detail(expiry)).status,"source_expired");
  assertNoRun(expiry);
  assert.equal((await deadlineEvents()).length,1);
  assert.ok(!(await api(tanaka,"notifications")).some(n=>n.job===expiry));
  outputs.expired={id:expiry,notification:{count:(await deadlineEvents()).length,seq:notice.seq},lateAcceptance:acceptance(expiry)};
  console.log("期限通知は1件で元の相談を開く。期限後の到着と再起動でも実行0件。",JSON.stringify(outputs.expired));

  await page.setViewportSize({width:390,height:844});
  await page.goto(sato+"/#job/"+id);
  await table.waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(jsErrors,[]);
  if(capture) await writeFile(join(evidence,"tom-113-material-wait.json"),JSON.stringify(outputs,null,2)+"\n");
} catch(error){
  console.error(page.url(),(await page.locator("body").innerText()).slice(-1800),jsErrors);
  throw error;
} finally {
  await browser.close();
}
