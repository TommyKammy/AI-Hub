import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const base="http://127.0.0.1:18831",idTag=randomUUID().slice(0,8);
const container="ai-hub-daily-work-hub-1",docker=(...args)=>execFileSync("docker",["--context","colima-mac-studio-solo",...args],{encoding:"utf8"});
assert.match(docker("port",container,"18831/tcp"),/127\.0\.0\.1:18831/);
const browser=await chromium.launch({channel:"chrome"}),page=await browser.newPage({viewport:{width:390,height:844}});
page.setDefaultTimeout(18000);
const dlg=page.locator("#dialog"),memo=page.locator("#memoText");
const button=(s,root=page)=>root.getByRole("button",{name:s,exact:true});
const click=(s,root)=>button(s,root).click();
const get=async path=>(await (await page.request.get(base+"/api/"+path)).json());
const jst=(stamp=Date.now())=>new Date(stamp+9*3600000).toISOString().slice(0,16);
const today=jst().slice(0,10),yesterday=jst(Date.now()-86400000).slice(0,10);
const counts=id=>Number(docker("exec",container,"node","--input-type=module","-e",
  "import {DatabaseSync} from 'node:sqlite'; console.log(new DatabaseSync('/data/hub.sqlite',{readOnly:true}).prepare('SELECT count(*) n FROM attempts WHERE job_id=?').get(process.argv[1]).n)",id));
const hermesRuns=id=>Number(docker("exec","ai-hub-daily-work-sato-1","python","-c",
  "import sqlite3,sys; print(sqlite3.connect('file:/opt/data/runs_idempotency.db?mode=ro',uri=True).execute('select count(*) from run_idempotency where idempotency_key like ?',(sys.argv[1]+'-%',)).fetchone()[0])",id));
const errors=[]; page.on("pageerror",e=>errors.push(e.message));
async function submit(kind,title,notes){
  await page.goto(base);
  await click("依頼の設定");
  await page.getByLabel("依頼の種類").selectOption(kind);
  await page.getByLabel("依頼内容",{exact:true}).fill(title);
  await page.getByText("資料の本文を貼り付ける",{exact:true}).click();
  await page.locator("#request [name=minutes]").fill(notes);
  await click("送信");
  await memo.waitFor({timeout:160000});
  return page.url().split("#job/")[1];
}
async function file(name,prior=false){
  await click("案件に整理");
  if(prior)await dlg.locator("select").selectOption({label:name}); else await dlg.getByLabel("新しい案件名").fill(name);
  await click("案件に追加",dlg);await dlg.waitFor({state:"hidden"});
}
let scheduleId;
try {
  const article="青葉"+idTag,projectName="案件 "+idTag;
  const text="会議で移行日を9月8日に決定。\n宿題は田中が"+yesterday+"までに"+article+"見積を提出する。\n宿題は佐藤が"+today+"までに"+article+"仕様を提出する。\n宿題は山田が"+article+"予算を提出する。";
  const meeting=await submit("meeting","会議 "+idTag,text);
  await file(projectName);
  await click("宿題を登録");const lines=await dlg.locator("option").allTextContents();
  await dlg.locator("[name=line]").selectOption({label:lines.find(s=>s.includes("見積"))});
  await dlg.locator("[name=due]").fill(yesterday);await dlg.locator("[name=assignee]").fill("田中");
  await click("宿題を保存",dlg);await dlg.waitFor({state:"hidden"});
  const before=counts(meeting), accepted=hermesRuns(meeting);assert.equal(accepted,1);await page.goto(base+"/#work/actions");
  const overdue=page.locator("section").filter({has:page.getByRole("heading",{name:"期限超過",exact:true})}).locator("article").filter({hasText:article+"見積"});
  await click("元の会議メモ",overdue);
  assert.ok((await memo.innerText()).includes(article+"見積"));
  await page.goto(base+"/#work/actions");await click("完了にする",overdue);await overdue.waitFor({state:"detached"});
  assert.equal(counts(meeting),before);assert.equal(hermesRuns(meeting),accepted);console.log("期限超過から元メモを確認・完了。追加送信0件",meeting);
  await page.goto(base+"/#job/"+meeting);await click("宿題候補を抽出");await page.locator('button:text-is("宿題候補を確認"),h2:text-is("宿題候補を抽出できませんでした")').first().waitFor({timeout:160000});
  assert.equal(await button("宿題候補を確認").count(),1,"候補の原文を検証できませんでした");
  await click("宿題候補を確認");const cards=dlg.locator("fieldset");
  const selected=cards.filter({hasText:article+"仕様"}), noDate=cards.filter({hasText:article+"予算"});
  assert.equal(await selected.locator("[name=due]").inputValue(),today);
  assert.equal(await selected.locator("[name=assignee]").inputValue(),"佐藤");
  assert.equal(await noDate.locator("[name=due]").inputValue(),"");
  await selected.getByRole("checkbox").check();await noDate.getByRole("checkbox").check();
  await click("選んだ宿題を登録",dlg);await dlg.waitFor({state:"hidden"});await page.goto(base+"/#work/actions");
  const todayRow=page.locator("section").filter({has:page.getByRole("heading",{name:"今日が期限",exact:true})}).locator("article").filter({hasText:article+"仕様"});
  await todayRow.waitFor();
  assert.ok((await get("workspace")).actions.some(a=>a.job===meeting && a.due==="" && a.line.includes("予算")));
  console.log("3候補から2件を登録、期限未定を保持");
  const previous=await submit("weekly","前週 "+idTag,"見積：未提出。\n納期：12月1日。\n仕様：確認待ち。");
  const current=await submit("weekly","今週 "+idTag,"見積：提出済み。\n納期：12月8日。\n仕様：確認待ち。");
  await file(projectName,true);await page.goto(base+"/#work/projects");await click(projectName);await dlg.getByRole("heading",{name:projectName,exact:true}).waitFor();
  assert.ok((await dlg.innerText()).includes("9月8日"));assert.ok((await dlg.innerText()).includes(article+"仕様"));
  await dlg.getByRole("button",{name:new RegExp("会議の記録.*"+idTag)}).click();
  await dlg.getByRole("heading",{name:"会議の記録",exact:true}).waitFor();
  assert.ok((await dlg.innerText()).includes(text));await click("閉じる",dlg);
  console.log("案件から決定・宿題・会議資料を確認");
  await page.goto(base+"/#jobs/reservations");await click("週報を設定");await dlg.locator("[name=name]").fill("翌週 "+idTag);
  await click("定期実行を登録",dlg);await dlg.waitFor({state:"hidden"});
  let s=(await get("workspace")).schedules.find(s=>s.name==="翌週 "+idTag);scheduleId=s.id;
  const sched=page.locator(".planning-schedule-row").filter({hasText:s.name});
  await click("次回分を確認",sched);const skipSource=dlg.locator('[value="'+previous+'"]');
  await skipSource.uncheck();const moved=s.next_run+86400000;
  await dlg.locator("input[type=datetime-local]").fill(jst(moved));await click("今回の変更を保存",dlg);await dlg.waitFor({state:"hidden"});
  const changed=await get("schedules/"+s.id+"/next");assert.equal(changed.run_at,moved);assert.deepEqual(changed.excluded,[previous]);
  await click("次回分を確認",sched);assert.equal(await skipSource.isChecked(),false);await click("今回は休む",dlg);await dlg.waitFor({state:"hidden"});
  assert.equal((await get("schedules/"+s.id+"/next")).slot,s.next_run+7*86400000);
  await click("一時停止",sched);await button("再開",sched).waitFor();console.log("次回のみ除外・移動・休止、翌週の曜日時刻を保持");
  await page.goto(base+"/#job/"+meeting);const original=(await get("jobs/"+meeting)).versions[0].memo,originalLines=original.split("\n");
  const target=originalLines.findIndex(l=>l.includes("予算"));assert.ok(target>=0);
  await page.locator("[name=lineIndex]").selectOption(String(target));
  await page.getByLabel("修正内容",{exact:true}).fill("顧客向けの丁寧な依頼文にしてください。");
  await click("修正を依頼する");
  await page.locator('#memoVersion, h2:text-is("修正版を作成できませんでした")').first().waitFor({timeout:150000});
  assert.equal(await page.locator("#memoVersion").count(),1,"部分修正が完了しませんでした");
  await page.locator("#memoVersion").selectOption("2");await page.getByRole("heading",{name:"修正後",exact:true}).waitFor();
  const rev=(await get("jobs/"+meeting)).versions.at(-1);const expected=[...originalLines];expected[target]=rev.replacement;
  assert.equal(expected.join("\n"),rev.memo);assert.notEqual(rev.replacement,originalLines[target]);
  await click("この版を採用");await button("この版を採用").waitFor({state:"detached"});assert.equal((await get("jobs/"+meeting)).adopted_version,2);
  console.log("段落修正・出典・採用版保持");
  await page.goto(base+"/#job/"+current);await click("前回の報告と比較");await dlg.locator("[name=previous]").selectOption(previous);await click("変化をまとめる",dlg);
  await page.waitForURL(url=>url.hash.startsWith("#job/")&&!url.hash.endsWith(current));await memo.waitFor({timeout:160000});
  const reportId=page.url().split("#job/")[1],report=await get("jobs/"+reportId),summary=report.memo;
  assert.deepEqual(report.sources.map(s=>s.job),[previous,current]);
  for(const term of ["提出済","12月1日","12月8日","確認待ち","[1]","[2]"]) assert.ok(summary.includes(term),summary);
  for(const [i,id] of [previous,current].entries()){
    await page.goto(base+"/#job/"+reportId);await memo.getByRole("button",{name:"出典"+(i+1)+"を開く",exact:true}).first().click();
    await click("元の仕事を開く",dlg);await page.waitForURL("**/#job/"+id);
  }
  await page.goto(base+"/#job/"+current);
  await page.getByRole("heading",{name:"前回からの変化",exact:true}).waitFor();
  assert.ok((await page.locator("#memoPanel section").filter({has:page.getByRole("heading",{name:"前回からの変化",exact:true})}).innerText()).includes("12月8日"));
  assert.deepEqual(errors,[]);console.log("報告本文に前回比較を表示・両期間の出典",reportId);
} catch(error){
  console.error(page.url(),(await page.locator("body").innerText()).slice(-1400),errors);
  throw error;
} finally {
  if(scheduleId)await page.request.post(base+"/api/schedules/"+scheduleId,{headers:{Origin:base},data:{enabled:false}});
  await browser.close();
}
