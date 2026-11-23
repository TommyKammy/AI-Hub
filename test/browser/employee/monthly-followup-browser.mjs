import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";
import {setTimeout as sleep} from "node:timers/promises";
const {chromium}=createRequire(new URL("../../", import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const base="http://127.0.0.1:18832",suffix=randomUUID().slice(0,8);
assert.match(execFileSync("docker",["--context","colima-mac-studio-solo","port","ai-hub-daily-work-hub-1","18832/tcp"],{encoding:"utf8"}),/127\.0\.0\.1:18832/);
const browser=await chromium.launch({channel:"chrome"}),page=await browser.newPage();
const get=async path=>(await(await page.request.get(base+"/api/"+path)).json());
async function post(path,body){
  const res=await page.request.post(base+"/api/"+path,{headers:{Origin:base,"Idempotency-Key":randomUUID()},data:body});
  const data=await res.json();assert.ok(res.ok(),data.error);return data;
}
async function waitFor(check){
  const end=Date.now()+135000;
  while(Date.now()<end){ const value=await check();if(value)return value; await sleep(600); }
  throw Error("予定時刻に結果を確認できませんでした。");
}
async function progress(title,minutes){
  const j=await post("jobs",{company:"B社",kind:"general",ask:title,minutes});
  await waitFor(async()=>(await get("jobs/"+j.id)).status==="done");
  return j.id;
}
const title="月別案件 "+suffix,btn=(name,root=page)=>root.getByRole("button",{name,exact:true});
let schedule;
try {
  const old=await progress("前期の資料 "+suffix,"見積"+suffix+"：未提出。");
  const template=await post("templates",{name:title,kind:"general",ask:"期間中の進捗を月報にして",output_format:"短い箇条書き"});
  schedule=(await post("schedules",{name:title,template_id:template.id,frequency:"monthly",month_day:0,weekday:0,time:"15:00",window_days:7,source_kind:"general"})).id;
  async function next(excluded,last){
    await page.goto(base+"/#skills");
    const row=page.locator("article").filter({has:btn("次回分を確認")}).filter({hasText:title});
    await btn("次回分を確認",row).click();
    const dlg=page.locator("#dialog"),when=new Date(Math.ceil((Date.now()+10000)/60000)*60000+9*3600000).toISOString().slice(0,16);
    const response=page.waitForResponse(r=>r.url().includes("/next?at="));
    await dlg.locator("[name=scheduledAt]").fill(when);await dlg.locator("[name=scheduledAt]").press("Tab");await response;
    if(excluded)await dlg.locator('input[value="'+excluded+'"]').uncheck();
    await btn("今回の変更を保存",dlg).click();await dlg.waitFor({state:"hidden"});
    const job=await waitFor(async()=>{const s=(await get("workspace")).schedules.find(s=>s.id===schedule);
      return s.last_job && s.last_job!==last && (await get("jobs/"+s.last_job)).status==="done" ? s.last_job : null;});
    return get("jobs/"+job);
  }
  const first=await next(null,null);assert.ok(first.sources[0].text.includes("前期の資料 "+suffix));console.log("前回の月報",first.id);
  await progress("当期の資料 "+suffix,"見積"+suffix+"：提出済み。");
  const second=await next(old,first.id);
  assert.ok(second.sources[0].text.includes("当期の資料 "+suffix));assert.ok(!second.sources[0].text.includes("前期の資料 "+suffix));
  const slot=await get("schedules/"+schedule+"/next");
  assert.equal(new Date(slot.run_at+9*3600000).getUTCHours(),15);
  await page.goto(base+"/#job/"+second.id);await btn("前回の報告と比較").click();
  const dlg=page.locator("#dialog");assert.equal(await dlg.locator("select").inputValue(),first.id);
  await btn("変化をまとめる",dlg).click();await page.waitForURL(url=>url.hash.startsWith("#job/")&&!url.hash.endsWith(second.id));
  await page.locator("#memoText").waitFor({timeout:120000});const comparison=page.url().split("#job/")[1];
  const j=await get("jobs/"+comparison);assert.deepEqual(j.sources.map(s=>s.job),[first.id,second.id]);
  await page.goto(base+"/#job/"+second.id);await page.getByRole("heading",{name:"前回からの変化",exact:true}).waitFor();
  console.log("今回の月報・除外・比較",second.id,comparison);
} finally {
  if(schedule)await post("schedules/"+schedule,{enabled:false});
  await browser.close();
}
