import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const base="http://127.0.0.1:18831";
assert.match(execFileSync("docker",["--context","colima-mac-studio-solo","port","ai-hub-daily-work-hub-1","18831/tcp"],{encoding:"utf8"}),/127\.0\.0\.1:18831/);
const quotes=[
  {name:"北山商事_見積.txt",lines:["金額は120,000円（税抜）。","納期は発注後10営業日。","支払条件は月末締め翌月末払い。"]},
  {name:"南川産業_見積.txt",lines:["金額は128,700円（税込）。","納期は発注後7営業日。"]},
];
const ask="2社の見積を購買向けに比較してください。比較項目は金額、納期、支払条件の3つ。記載がない条件は要確認にしてください。";
const browser=await chromium.launch({channel:"chrome"});
try {
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  await page.goto(base);
  const form=page.locator("#request");
  assert.equal(await form.locator("[name=kind]").inputValue(),"assistant");
  await form.getByLabel("依頼内容").fill(ask);
  await form.locator("summary",{hasText:"自分の資料を使う"}).click();
  await form.locator("[type=file]").setInputFiles(quotes.map(q=>({name:q.name,mimeType:"text/plain",buffer:Buffer.from(q.lines.join("\n"))})));
  await form.getByText(/見積.txt を読み込みました/).waitFor();
  await form.locator("summary",{hasText:"今回使う資料を確認"}).click();
  for(const q of quotes) assert.ok((await form.locator(".source-preview").innerText()).includes(q.lines[0]));
  await form.getByRole("button",{name:"下書きを保存"}).click();
  await page.waitForURL("**/#jobs");
  await page.getByRole("button",{name:ask,exact:true}).last().click();
  const draft=page.locator("#repeat");
  await draft.locator("summary",{hasText:"今回使う資料を確認"}).click();
  assert.ok((await draft.locator(".source-preview").innerText()).includes(quotes[1].name));
  await draft.getByRole("button",{name:"新しい仕事として依頼"}).click();
  await page.waitForURL("**/#job/*");
  const id=page.url().split("#job/")[1];
  console.log("見積依頼",id);
  const table=page.locator("#memoText table");
  for(let i=0;i<160 && !(await table.count());i++){
    const j=await (await page.request.get(base+"/api/jobs/"+id)).json();
    assert.ok(!["unknown","failed","held","done"].includes(j.status) || j.work_tool?.table,JSON.stringify({status:j.status,tool:j.work_tool?.tool}));
    await page.waitForTimeout(1000);
  }
  await table.waitFor({timeout:5000});
  await page.reload();
  await table.waitFor();
  const rows=table.locator("tbody tr");
  assert.equal(await rows.count(),3);
  const expected={};
  for(const row of await rows.all()){
    const label=await row.locator("th").innerText();
    const index=/金額|価格|総額/.test(label)?0:/納期/.test(label)?1:/支払/.test(label)?2:-1;
    assert.notEqual(index,-1,label);
    expected[label]=[];
    for(let n=0;n<2;n++){
      const cell=row.locator("td").nth(n), value=quotes[n].lines[index] || "要確認（記載なし）";
      assert.ok((await cell.innerText()).includes(value),value);
      expected[label].push(value);
      if(value.startsWith("要確認")){assert.equal(await cell.getByRole("button").count(),0);continue;}
      await cell.getByRole("button").click();
      assert.equal(await page.locator("#dialog mark").innerText(),value);
      assert.ok((await page.locator("#dialog").innerText()).includes(quotes[n].name));
      await page.locator("#dialog").getByRole("button",{name:"閉じる",exact:true}).click();
    }
  }
  assert.equal(Object.keys(expected).length,3);
  const downloadLink=page.getByRole("link",{name:"比較表をCSVで保存"});
  const [download]=await Promise.all([page.waitForEvent("download"),downloadLink.click()]);
  const bytes=await readFile(await download.path());
  assert.equal(bytes.subarray(0,3).toString("hex"),"efbbbf");
  const csv=JSON.parse(execFileSync("python3",["-c","import csv,io,json,sys; print(json.dumps(list(csv.reader(io.StringIO(sys.stdin.buffer.read().decode('utf-8-sig'))))))"],{input:bytes}));
  assert.deepEqual(csv[0],["比較項目",quotes[0].name,"出典 [1]",quotes[1].name,"出典 [2]"]);
  assert.equal(csv.length,4);
  for(const [label,left,leftRef,right,rightRef] of csv.slice(1)){
    assert.deepEqual([left,right],expected[label]);
    assert.ok(leftRef.startsWith(quotes[0].name+" ・ 1."));
    assert.ok(rightRef.startsWith(quotes[1].name+" ・ "+(right.startsWith("要確認")?"記載なし":"2.")));
  }
  assert.equal((await page.request.get("http://127.0.0.1:18832"+await downloadLink.getAttribute("href"))).status(),404);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.CAPTURE_WORK) {
    await page.setViewportSize({width:1200,height:900});
    await table.screenshot({path:"evidence/quote-comparison.png"});
  }
  const job=await (await page.request.get(base+"/api/jobs/"+id)).json();
  assert.equal(job.work_tool.workflow.name,"quote-comparison");
  console.log(job.model.model_id,id,"3項目・5箇所の原文・未記載1件・CSV一致・他社員404");
} finally { await browser.close(); }
