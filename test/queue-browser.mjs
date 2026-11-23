// Two simultaneous ordinary requests by one user make the later one observable in the queue.
import {createRequire} from "node:module";
import assert from "node:assert/strict";
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const origin="http://127.0.0.1:18832";
const browser=await chromium.launch({channel:"chrome"});
try {
  const pages=await Promise.all([browser.newPage(),browser.newPage()]);
  await Promise.all(pages.map(async(p,i)=>{
    await p.goto(origin);
    await p.getByLabel("依頼の種類").selectOption("weekly");
    await p.getByLabel("依頼内容").fill("南支店の検品完了と次回研修を週報にしてください（受付確認" + (i+1) + "）");
  }));
  await Promise.all(pages.map(p=>p.getByRole("button",{name:"送信",exact:true}).click()));
  await Promise.all(pages.map(p=>p.waitForURL(/#job\//)));
  const jobs=await Promise.all(pages.map(async p=>(await (await p.request.get(origin+"/api/jobs/"+p.url().split("#job/")[1])).json())));
  const i=jobs[0].created>jobs[1].created?0:1;
  const page=pages[i];
  await page.getByRole("button",{name:"依頼を取り消す"}).click();
  await page.getByRole("heading",{name:"依頼を取り消しました"}).waitFor();
  const cancelled=await (await page.request.get(origin+"/api/jobs/"+jobs[i].id)).json();
  assert.equal(cancelled.status,"cancelled");
  await pages[1-i].locator("#memoText").waitFor({timeout:180000});
  console.log("cancelled",jobs[i].id,"completed",jobs[1-i].id);
} finally {await browser.close();}
