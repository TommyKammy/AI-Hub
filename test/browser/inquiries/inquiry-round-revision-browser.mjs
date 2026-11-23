import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";

const {chromium}=createRequire(new URL("../../",import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const ownerHost="http://127.0.0.1:18831",deskHost="http://127.0.0.1:18832",id=Number(process.argv[2]);
for (const port of [18831,18832]) assert.equal(execFileSync("docker",["--context","colima-mac-studio-solo","port","ai-hub-daily-work-hub-1",port+"/tcp"],{encoding:"utf8"}).trim(),"127.0.0.1:"+port);
const browser=await chromium.launch({channel:"chrome"});
try {
  const p=await browser.newPage({viewport:{width:1200,height:920}}),desk=await browser.newPage({viewport:{width:390,height:844}});
  const ticket=await(await p.request.get(ownerHost+"/api/inquiries/"+id)).json();
  const jobUrl=ownerHost+"/api/jobs/"+ticket.job,jobPage=ownerHost+"/#job/"+ticket.job;
  if (process.env.ADD_UNADOPTED) {
    const before=await(await p.request.get(jobUrl)).json();
    assert.equal(before.model.model_id,"fixture-model");
    await p.goto(jobPage);await p.locator("#revise [name=instruction]").fill("3行で要約してください。");
    await p.getByRole("button",{name:"修正を依頼する"}).click();
    await p.waitForFunction(previous=>Number(document.querySelector("#memoVersion option")?.value)>previous,before.versions.at(-1).version,{timeout:120000});
  }
  const original=await(await p.request.get(jobUrl)).json(),base=original.adopted_version;
  const selected=ticket.followups.find(t=>t.answer && t.question.includes("複数") && !original.versions.some(v=>v.answer_inquiry===id && v.answer_round===t.number));
  assert.ok(base && selected,"test/browser/inquiries/inquiry-thread-browser.mjs で準備した、PDFを複数添付する場合の未反映の再回答が必要です");
  await p.goto(jobPage+"/reply/"+id+"/round/"+selected.number);
  const history=p.getByRole("region",{name:"受付票 #"+id+" への回答"});
  if (!ticket.followups.some(t=>t.answer && t.number>selected.number)) {
    await history.getByRole("button",{name:"同じ受付票に追加質問"}).click();
    await p.getByLabel("窓口への追加質問").fill("海外経費の通貨はどの欄に記入しますか？");
    await p.getByRole("button",{name:"追加質問を送信"}).click();await history.getByText("窓口の再回答待ち").waitFor();
    await desk.goto(deskHost+"/#inquiry/"+id);await desk.getByRole("button",{name:"追加質問に回答"}).click();
    await desk.getByLabel("依頼者への回答").fill("海外経費の通貨は外貨区分欄に記入します。");
    await desk.getByRole("button",{name:"回答を送信"}).click();await desk.getByText("海外経費の通貨は外貨区分欄に記入します。",{exact:true}).waitFor();
    await p.reload();
  }
  const turnTitle="追加質問（"+selected.number+"回目）";
  const turn=history.getByRole("region",{name:turnTitle,exact:true});
  await turn.getByText(selected.answer,{exact:true}).waitFor();
  await turn.getByRole("button",{name:"この再回答を第"+base+"版に反映するようHermesに依頼"}).click();
  await p.waitForURL(/\/version\/\d+$/);const version=Number(p.url().split("/").at(-1));
  const citation=p.locator("#memoText").getByRole("link",{name:new RegExp("受付票 #"+id+" 再回答（"+selected.number+"回目）$")}).first();
  await citation.waitFor({timeout:150000});
  const resolve=p.locator("#receiptSources").getByRole("button",{name:"受付票 #"+id+" を解決済みにする"});
  assert.equal(await resolve.count(),0);
  assert.ok(version>original.versions.at(-1).version);
  const candidate=await(await p.request.get(jobUrl)).json(),row=candidate.versions.at(-1);
  assert.equal(candidate.adopted_version,base);assert.equal(row.base,base);assert.equal(row.answer_round,selected.number);
  assert.equal(row.answer_inquiry,id);assert.equal(row.version,version);assert.ok(candidate.run_id && candidate.run_id!==original.run_id);
  assert.ok(row.memo.includes("["+row.answer_source+"]"));assert.doesNotMatch(row.memo,/外貨区分欄/);
  assert.match(row.memo,/領収書ごと|個別|分け/);
  await citation.focus();await p.keyboard.press("Enter");
  await p.waitForURL(ownerHost+"/#inquiry/"+id+"/round/"+selected.number+"?from="+version);
  const source=p.getByRole("region",{name:turnTitle,exact:true});
  await source.getByText(selected.question,{exact:true}).waitFor();
  await source.getByText(selected.answer,{exact:true}).waitFor();
  assert.equal(await p.evaluate(()=>document.activeElement.id),"inquiry-question-"+id+"-"+selected.number);
  if (process.env.CAPTURE_ROUND) await source.screenshot({path:"evidence/inquiry-round-source.png"});
  await p.getByRole("link",{name:"修正版（第"+version+"版）に戻る"}).click();await citation.waitFor();
  const compare=p.locator(".previous-memo");
  await compare.getByText("現在の採用版（第"+base+"版）と見比べる",{exact:true}).click();
  const oldMemo=await compare.locator("section").first().locator(".note").innerText();
  assert.ok(oldMemo.includes(original.versions.find(v=>v.version===base).memo.split("\n")[0]));
  assert.doesNotMatch(oldMemo,new RegExp("再回答（"+selected.number+"回目）"));
  if (process.env.CAPTURE_ROUND) {
    await p.locator("#memoText").scrollIntoViewIfNeeded();
    await p.screenshot({path:"evidence/inquiry-round-comparison.png"});
  }
  await p.getByRole("button",{name:"この版を採用"}).click();
  await p.waitForFunction(v=>document.querySelector("#memoVersion option:checked")?.value===String(v) &&
    document.querySelector("#memoVersion option:checked").textContent.includes("採用版"),version);
  await p.goto(jobPage);await p.reload();await citation.waitFor();assert.equal(await p.locator("#memoVersion").inputValue(),String(version));
  await resolve.waitFor();
  const final=await(await p.request.get(jobUrl)).json();
  assert.deepEqual(final.versions.slice(0,-1),original.versions);assert.equal(final.adopted_version,version);
  console.log(final.model.model_id,"受付票",id,"選択した回答回",selected.number,"元の採用版",base,"修正版",version,"出典",row.answer_source,"実行",final.run_id,jobPage+"/version/"+version);
} finally {await browser.close();}
