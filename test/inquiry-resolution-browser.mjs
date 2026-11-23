import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const ownerHost="http://127.0.0.1:18831",deskHost="http://127.0.0.1:18832",id=Number(process.argv[2]);
assert.ok(Number.isSafeInteger(id) && id>0,"再回答を反映した採用版がある受付番号を指定してください");
const docker=["--context","colima-mac-studio-solo"],container="ai-hub-daily-work-hub-1";
for (const port of [18831,18832])
  assert.equal(execFileSync("docker",[...docker,"port",container,port+"/tcp"],{encoding:"utf8"}).trim(),"127.0.0.1:"+port);
function attempts(job) {
  return Number(execFileSync("docker",[...docker,"exec",container,"python3","-c",
    "import sqlite3,sys;print(sqlite3.connect('file:/data/hub.sqlite?mode=ro',uri=True).execute('SELECT count(*) FROM attempts WHERE job_id=?',(sys.argv[1],)).fetchone()[0])",job],{encoding:"utf8"}).trim());
}
const browser=await chromium.launch({channel:"chrome"});
try {
  const owner=await browser.newPage({viewport:{width:1200,height:920}}),desk=await browser.newPage({viewport:{width:390,height:844}});
  const ticketUrl="/api/inquiries/"+id, ticket=await(await owner.request.get(ownerHost+ticketUrl)).json();
  const jobUrl=ownerHost+"/api/jobs/"+ticket.job,jobPage=ownerHost+"/#job/"+ticket.job;
  const before=await(await owner.request.get(jobUrl)).json(),count=attempts(ticket.job);
  const candidate=before.inquiries.find(t=>t.id===id)?.resolution_candidate;
  assert.equal(candidate?.version,before.adopted_version,"解決前の採用版が必要です");
  const resolveName="受付票 #"+id+" を解決済みにする",root=desk.locator("#main");
  await desk.goto(deskHost+"/#jobs");
  const listing=root.getByRole("link",{name:"#"+id+" "+ticket.subject,exact:true});
  await listing.waitFor();assert.doesNotMatch(await listing.locator("..").innerText(),/解決済み/);
  await owner.goto(jobPage);
  assert.equal((await desk.request.post(deskHost+ticketUrl+"/resolve",{headers:{Origin:deskHost},data:{version:candidate.version}})).status(),403);
  await owner.getByRole("button",{name:resolveName}).click();
  await owner.locator("#receiptSources").getByText("解決済み",{exact:true}).waitFor();
  assert.equal(await owner.locator("#memoVersion").inputValue(),String(candidate.version));
  const resolved=await(await owner.request.get(ownerHost+ticketUrl)).json();
  assert.equal(resolved.resolution.round,candidate.round);assert.equal(resolved.resolution.version,candidate.version);
  assert.equal(resolved.resolution.name,ticket.requester);assert.ok(resolved.resolution.created);
  assert.deepEqual(resolved.followups,ticket.followups);
  const retried=await owner.request.post(ownerHost+ticketUrl+"/resolve",{headers:{Origin:ownerHost},data:{version:candidate.version}});
  assert.deepEqual(await retried.json(),resolved.resolution);
  await listing.locator("..").filter({hasText:"解決済み"}).waitFor();
  await listing.click();await root.locator(".heading .status").filter({hasText:"解決済み"}).waitFor();
  await owner.getByRole("link",{name:"受付票 #"+id+" のやり取りを確認",exact:true}).click();
  await owner.waitForURL(jobPage+"/reply/"+id);
  const region="受付票 #"+id+" への回答";
  async function checkHistory(page) {
    const history=page.getByRole("region",{name:region,exact:true});
    await history.getByText("解決済み",{exact:true}).waitFor();
    await page.locator("#main").getByText(ticket.body,{exact:true}).waitFor();
    await history.getByText(ticket.answer.body,{exact:true}).waitFor();
    for (const t of ticket.followups) {
      const turn=history.getByRole("region",{name:"追加質問（"+t.number+"回目）",exact:true});
      await turn.getByText(t.question,{exact:true}).waitFor();
      if (t.answer) await turn.getByText(t.answer,{exact:true}).waitFor();
    }
    assert.ok((await history.innerText()).includes("第"+candidate.version+"版を採用（再回答"+candidate.round+"回目）"));
    assert.equal(await history.getByRole("button",{name:"同じ受付票に追加質問"}).count(),0);
    assert.equal(await history.getByRole("button",{name:"追加質問に回答"}).count(),0);
  }
  await Promise.all([checkHistory(owner),checkHistory(desk)]);
  assert.equal(await root.getByRole("button",{name:resolveName}).count(),0);
  assert.equal((await desk.request.get(deskHost+"/api/jobs/"+ticket.job)).status(),404);
  assert.ok(await desk.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if (process.env.CAPTURE_RESOLUTION) {
    await owner.getByRole("region",{name:region,exact:true}).screenshot({path:"evidence/inquiry-resolved-requester.png"});
    const bounds=await root.boundingBox();
    await desk.setViewportSize({width:390,height:Math.ceil(bounds.height)+240});
    await root.screenshot({path:"evidence/inquiry-resolved-desk.png"});
  }
  await Promise.all([owner.reload(),desk.reload()]);await Promise.all([checkHistory(owner),checkHistory(desk)]);
  const after=await(await owner.request.get(jobUrl)).json();
  assert.deepEqual(after.versions,before.versions);assert.equal(after.adopted_version,before.adopted_version);
  assert.equal(after.run_id,before.run_id);assert.equal(count,attempts(ticket.job));
  console.log(before.model.model_id,"受付票",id,"採用版",candidate.version,"再回答",candidate.round,"履歴",ticket.followups.length,"往復・解決済み・追加実行0件を両画面で確認",jobPage+"/reply/"+id);
} finally {await browser.close();}
