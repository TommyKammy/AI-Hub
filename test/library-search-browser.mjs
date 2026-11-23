import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const base="http://127.0.0.1:18831";
assert.match(execFileSync("docker",["--context","colima-mac-studio-solo","port","ai-hub-daily-work-hub-1","18831/tcp"],{encoding:"utf8"}),/127\.0\.0\.1:18831/);
const browser=await chromium.launch({channel:"chrome"});
try {
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  const scenarios=[
    {folders:["社内規程","申請案内"],ask:"出張取消料の精算に必要な添付資料と申請先・申請期限を教えてください。"},
    {folders:["社内規程"],ask:"出張取消料の精算に必要な添付資料を教えてください。"},
    {folders:["社内規程","申請案内"],ask:"量子コンピュータの冷却温度は？",missing:true},
  ];
  for(const sc of process.argv.includes("--cross-only") ? scenarios.slice(0,1) : scenarios){
    await page.goto(base);
    const form=page.locator("#request");
    assert.equal(await form.locator("[name=kind]").inputValue(),"assistant");
    await form.getByLabel("依頼内容").fill(sc.ask);
    await form.getByText("社内の資料置き場を選ぶ",{exact:true}).click();
    for(const f of sc.folders)await form.getByRole("checkbox",{name:new RegExp(f)}).check();
    await form.getByText("今回使う資料を確認",{exact:true}).click();
    for(const f of sc.folders)assert.ok((await form.locator("[data-library-preview]").innerText()).includes(f));
    await form.getByRole("button",{name:"送信",exact:true}).click();
    await page.waitForURL("**/#job/*");
    const id=page.url().split("#job/")[1];console.log("依頼",id);
    const detail=async()=>await (await page.request.get(base+"/api/jobs/"+id)).json();
    for(let i=0;i<180;i++){
      const j=await detail();
      if(j.status==="done")break;
      assert.ok(["queued","dispatching","running"].includes(j.status),j.status+" "+id);
      await page.waitForTimeout(1000);
    }
    await page.reload();
    const memo=await page.locator("#memoText").innerText(), j=await detail();
    assert.ok(j.run_id);
    if(sc.missing)assert.ok(["search_libraries","read_passages"].includes(j.work_tool.tool));
    else assert.equal(j.work_tool.tool,"read_passages");
    assert.equal((await page.request.get("http://127.0.0.1:18832/api/jobs/"+id)).status(),404);
    if(sc.missing){
      assert.match(memo,/見つかりません/);
      assert.equal(j.work_tool.evidence.length,0);
    } else {
      assert.match(memo,/領収書/); assert.match(memo,/所属長/);
      for(const citation of await page.locator("#memoText .citation").all()){
        await citation.click();
        assert.ok(await page.locator("#dialog mark").count());
        await page.locator("#dialog").getByRole("button",{name:"閉じる",exact:true}).click();
      }
      await page.getByText("回答の根拠原文",{exact:true}).click();
      const originals=[];
      for(const b of await page.getByRole("button",{name:"根拠の原文を開く"}).all()){
        await b.click(); originals.push(await page.locator("#dialog mark").innerText());
        assert.ok((await page.locator("#dialog").innerText()).includes("検索時の版"));
        await page.locator("#dialog").getByRole("button",{name:"閉じる",exact:true}).click();
      }
      assert.ok(originals.some(t=>t.startsWith("第8条")));
      if(sc.folders.length===2){
        assert.match(memo,/経費ポータル/); assert.match(memo,/5営業日/);
        assert.ok(originals.some(t=>t.startsWith("第2項")));
        if(process.env.CAPTURE_WORK)await page.locator("#memoPanel").screenshot({path:"evidence/library-search.png"});
      } else {
        assert.ok(!memo.includes("経費ポータル"));
        assert.ok(j.sources.every(s=>s.library_name==="社内規程"));
      }
    }
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    console.log(j.model.model_id,id,sc.folders,sc.missing ? "該当なし" : "原文確認");
  }
} finally {await browser.close();}
