import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";

const {chromium}=createRequire(new URL("../../",import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const ownerHost="http://127.0.0.1:18831",deskHost="http://127.0.0.1:18832",id=Number(process.argv[2]);
assert.ok(Number.isSafeInteger(id) && id>0,"回答済み受付番号を指定してください");
for (const port of [18831,18832]) {
  assert.equal(execFileSync("docker",["--context","colima-mac-studio-solo","port","ai-hub-daily-work-hub-1",port+"/tcp"],{encoding:"utf8"}).trim(),"127.0.0.1:"+port);
}
const browser=await chromium.launch({channel:"chrome"});
try {
  const owner=await browser.newPage({viewport:{width:1200,height:920}});
  const desk=await browser.newPage({viewport:{width:390,height:844}});
  const ticket=await(await owner.request.get(ownerHost+"/api/inquiries/"+id)).json();
  assert.ok(ticket.answer && ticket.job && !ticket.followups.some(t=>!t.answer));
  const jobUrl=ownerHost+"/api/jobs/"+ticket.job,jobPage=ownerHost+"/#job/"+ticket.job;
  const before=await(await owner.request.get(jobUrl)).json(),round=ticket.followups.length+1;
  const question="電子領収書のPDFが複数ある場合、1ファイルにまとめる必要はありますか？";
  const response="PDFは領収書ごとに分けて、同じ精算申請に添付してください。";
  const historyName="受付票 #"+id+" への回答",history=owner.getByRole("region",{name:historyName});
  await desk.goto(deskHost+"/#work/actions");
  const deskLink=desk.getByRole("link",{name:"#"+id+" "+ticket.subject,exact:true});
  await deskLink.waitFor();
  await owner.goto(jobPage);
  if (before.adopted_version && before.adopted_version!==ticket.version)
    await owner.getByRole("link",{name:"受付票 #"+id+" のやり取り・追加質問"}).click();
  await history.getByRole("button",{name:"同じ受付票に追加質問"}).click();
  await owner.getByLabel("窓口への追加質問").fill(question);
  await owner.getByRole("button",{name:"追加質問を送信"}).click();
  await history.getByText("窓口の再回答待ち",{exact:true}).waitFor();
  await owner.goto(ownerHost+"/#jobs");await owner.locator("#notifications").click();
  await deskLink.locator("..").filter({hasText:"追加質問あり"}).waitFor();
  await deskLink.click();
  const deskHistory=desk.getByRole("region",{name:historyName});
  await deskHistory.getByText(question,{exact:true}).last().waitFor();
  await deskHistory.getByText(ticket.answer.body,{exact:true}).waitFor();
  await deskHistory.getByRole("button",{name:"追加質問に回答"}).click();
  await desk.getByLabel("依頼者への回答").fill(response);
  await desk.getByRole("button",{name:"回答を送信"}).click();
  await deskHistory.getByText(response,{exact:true}).last().waitFor();
  assert.equal((await desk.request.get(deskHost+"/api/jobs/"+ticket.job)).status(),404);
  assert.ok(await desk.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const label="受付票 #"+id+" の追加質問（"+round+"回目）に再回答が届きました";
  await owner.locator("#eventList").getByRole("button",{name:new RegExp(label+"（未読）")}).click();
  await owner.waitForURL(jobPage+"/reply/"+id+"/round/"+round);
  await history.getByText(response,{exact:true}).last().waitFor();
  const text=await history.innerText();
  assert.ok(text.includes(ticket.body) && text.indexOf(ticket.body)<text.indexOf(ticket.answer.body));
  assert.ok(text.indexOf(ticket.answer.body)<text.lastIndexOf(question) && text.lastIndexOf(question)<text.lastIndexOf(response));
  assert.equal(await owner.evaluate(()=>document.activeElement.id),"inquiry-answer-"+id+"-"+round);
  if (before.versions.length>1) assert.equal(Number(await owner.locator("#memoVersion").inputValue()),ticket.version);
  await history.getByRole("button",{name:"同じ受付票に追加質問"}).waitFor();
  if (process.env.CAPTURE_FOLLOWUP) await history.screenshot({path:"evidence/inquiry-followup-history.png"});
  await owner.reload();await history.getByText(response,{exact:true}).last().waitFor();
  const after=await(await owner.request.get(jobUrl)).json();
  assert.deepEqual(after.versions,before.versions);assert.equal(after.adopted_version,before.adopted_version);
  assert.equal(after.status,before.status);assert.equal(after.run_id,before.run_id);
  await owner.locator("#notifications").click();
  const seen=owner.locator("#eventList").getByRole("button",{name:new RegExp(label)});
  await seen.waitFor();assert.doesNotMatch(await seen.innerText(),/未読/);
  console.log(before.model.model_id,"受付票",id,"追加質問・担当者の再回答・通知から元の仕事の履歴・既読を確認",jobPage+"/reply/"+id+"/round/"+round);
} finally {await browser.close();}
