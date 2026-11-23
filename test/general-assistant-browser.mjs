import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const base="http://127.0.0.1:"+ (process.env.TEST_EMPLOYEE==="tanaka" ? "18832" : "18831");
const other=base.endsWith("18832")?"18831":"18832";
assert.match(execFileSync("docker",["--context","colima-mac-studio-solo","port","ai-hub-daily-work-hub-1","18831/tcp"],{encoding:"utf8"}),/127\.0\.0\.1:18831/);
const cases=[
  {name:"sales",file:"四半期売上.csv",ask:"返品を除いて、商品別に売上金額を合計してください。全体の合計もください。",body:'伝票,商品,区分,売上金額\nS01,鉛筆,売上,1200\nS02,用紙,売上,"2,400"\nS03,鉛筆,返品,300\nS04,鉛筆,売上,850',tool:"aggregate_csv",detail:"集計条件と元の行",memo:["2,050","2,400","4,450"],original:["除外 ・ 4行目","S03,鉛筆,返品,300","S04,鉛筆,売上,850"]},
  {name:"policy",file:"旅費規程.txt",ask:"出張を取り消したとき、取消料の精算には何が必要ですか？",body:"第3条　出発前に出張申請書を提出する。\n第8条　出張取消時の取消料を精算するには、取消料の領収書と所属長の承認が必要である。\n第11条　宿泊費は一泊12,000円を上限とする。",tool:"read_passages",detail:"回答の根拠原文",memo:["領収書","所属長"],original:["第8条　出張取消時の取消料を精算するには"]},
  {name:"notice",file:"制度変更.txt",ask:"この変更を対象者に知らせる社内案内にしてください。開始日と必要な行動を明記してください。",body:"対象者は国内営業部の正社員です。\n新制度は2027年4月1日に開始します。\n対象者は3月25日までに経費ポータルで口座情報を登録してください。",tool:"draft_document",detail:"案内に使った原文",memo:["国内営業部","2027年4月1日","口座情報"],original:["対象者","開始日","必要な行動","3月25日までに経費ポータルで口座情報を登録"]},
];
const browser=await chromium.launch({channel:"chrome"});
try {
 for(const item of cases.filter(c=>!process.argv[2] || c.name===process.argv[2])){
  const page=await browser.newPage({viewport:{width:item.name==="policy"?390:1200,height:900}});
  await page.goto(base);
  const form=page.locator("#request");
  assert.equal(await form.locator("[name=kind]").inputValue(),"assistant");
  await form.getByLabel("依頼内容").fill(item.ask);
  await form.locator("summary",{hasText:"自分の資料を使う"}).click();
  await form.locator("[type=file]").setInputFiles({name:item.file,mimeType:"text/plain",buffer:Buffer.from(item.body)});
  await form.getByText(item.file+" を読み込みました。").waitFor();
  await form.getByRole("button",{name:"送信",exact:true}).click();
  await page.waitForURL("**/#job/*");
  const id=page.url().split("#job/")[1]; console.log(item.name,id);
  const memo=page.locator("#memoText");
  for(let i=0;i<120 && !(await memo.count());i++){
    const j=await (await page.request.get(base+"/api/jobs/"+id)).json();
    assert.ok(!["unknown","failed","held","cancelled"].includes(j.status),JSON.stringify({status:j.status,tool:j.work_tool?.tool,id}));
    await page.waitForTimeout(1000);
  }
  await memo.waitFor({timeout:3000});
  await page.reload();
  for(const value of item.memo)assert.ok((await memo.innerText()).includes(value),value+" "+(await memo.innerText()));
  await page.getByText(item.detail,{exact:true}).click();
  const evidence=page.locator("details[open]").filter({has:page.getByText(item.detail,{exact:true})});
  for(const value of item.original)assert.ok((await evidence.innerText()).includes(value),value);
  const j=await(await page.request.get(base+"/api/jobs/"+id)).json();
  assert.equal(j.work_tool.tool,item.tool);
  const workflow={sales:"csv-summary",policy:"source-answer",notice:"document-draft"}[item.name];
  assert.equal(j.work_tool.workflow.name,workflow);
  assert.ok((await evidence.innerText()).includes(j.work_tool.workflow.title));
  if(item.name==="notice"){
    assert.ok(j.work_tool.evidence.slice(0,3).every(p=>p.source===1));
    assert.ok(item.body.split("\n").every(line=>j.memo.includes(line)));
    assert.doesNotMatch(j.memo,/2027年3月25日|精算に影響/);
  }
  assert.ok(j.run_id);
  assert.equal((await page.request.get("http://127.0.0.1:"+other+"/api/jobs/"+id)).status(),404);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.CAPTURE_WORK)await evidence.screenshot({path:"evidence/general-"+item.name+".png"});
  await page.locator('[data-op="source/1"]').first().click();
  assert.ok((await page.locator("#dlgbody").innerText()).includes(item.body.split("\n").at(-1)));
  console.log(j.model.model_id,item.tool,"完了・元資料・本人のみ",id);
  await page.close();
 }
}finally{await browser.close();}

