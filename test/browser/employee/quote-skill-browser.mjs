import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
const {chromium}=createRequire(new URL("../../", import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const port=Number(process.env.QUOTE_CHECK_PORT || 18841);
const project=process.env.QUOTE_CHECK_PROJECT || "ai-hub-memory-check";
const actor=process.env.QUOTE_CHECK_ACTOR || "sato";
const otherActor=actor==="sato" ? "tanaka" : "sato";
assert.ok(["sato","tanaka"].includes(actor));
assert.notEqual(project,"ai-hub-hermes-local");
const docker=(...args)=>execFileSync("docker",["--context","colima-mac-studio-solo",...args],{encoding:"utf8"}).trim();
assert.equal(docker("port",project+"-hub-1",port+"/tcp"),"127.0.0.1:"+port);
const base="http://127.0.0.1:"+port, other="http://127.0.0.1:"+(port+(actor==="sato" ? 1 : -1));
const file=(name,text)=>({name,mimeType:"text/plain",buffer:Buffer.from(text)});
const first=[file("旧北社.txt","金額は120,000円。\n納期は12営業日。\n保守費は月額3,000円。"),
  file("旧南社.txt","金額は110,000円。\n納期は10営業日。")];
const next=[file("若葉商事.txt","納期は4営業日。\n金額は81,000円。"),
  file("青空産業.txt","保守費の初回登録は5,000円。\n金額は93,000円。\n納期は2営業日。\n保守費は月額900円。")];
const browser=await chromium.launch({channel:"chrome"});
const page=await browser.newPage({viewport:{width:1280,height:900}});
async function completed(id,phase) {
  const end=Date.now()+180000;
  while(Date.now()<end) {
    const job=await(await page.request.get(base+"/api/jobs/"+id)).json();
    if (job.phase.startsWith(phase)) {
      assert.ok(!["unknown","failed","held","membership_blocked"].includes(job.status),JSON.stringify({id,phase:job.phase,status:job.status}));
      if(job.status==="done") return job;
    }
    await page.waitForTimeout(800);
  }
  throw Error("Timed out: "+phase+" "+id);
}
async function capture(tag,locator) {
  if (process.env.CAPTURE_WORK) {
    await locator.scrollIntoViewIfNeeded();
    await page.screenshot({path:"evidence/quote-skill-"+tag+".png"});
  }
}
try {
  await page.goto(base);
  const form=page.locator("#request");
  await form.getByLabel("依頼内容").fill("2社の見積を金額と納期の2項目で比較してください。");
  const legacyAttachment=form.locator("summary",{hasText:"自分の資料を使う"});
  if (await legacyAttachment.isVisible()) await legacyAttachment.click();
  await form.locator("[type=file]").setInputFiles(first);
  await form.getByText(/旧南社.txt を読み込みました/).waitFor();
  await form.getByRole("button",{name:"送信",exact:true}).click();
  await page.waitForURL("**/#job/*");
  const id=page.url().split("#job/")[1];
  const initial=await completed(id,"compose");
  console.log("original",id,initial.model.model_id);
  assert.equal(initial.work_tool.table.rows.length,2);
  const edit=page.locator("#revise");
  await edit.getByLabel("修正内容").fill("比較項目を金額、納期、保守費の順にしてください。保守費は月額の記載を優先してください。保守費が見積にない場合は要確認と明記してください。");
  await edit.getByRole("button",{name:"修正を依頼する"}).click();
  await completed(id,"revise-");
  await page.reload();
  await page.locator("#memoVersion").selectOption("2");
  assert.match(await page.locator("#memoText").innerText(),/保守費/);
  await page.getByRole("button",{name:"この版を採用して個人スキルに保存"}).click();
  await completed(id,"learn-quote-");
  await page.reload();
  const ws=await(await page.request.get(base+"/api/workspace")).json();
  const skill=ws.quote_skills.find(s=>s.job===id && s.version===2);
  assert.ok(skill);
  assert.equal(skill.criteria.length,3);
  assert.match(skill.criteria[2],/保守/);
  assert.match(skill.rules.join(" "),/月額.*優先/);
  const skillPath="/opt/data/skills/hub-quote-"+skill.id+"/SKILL.md";
  const stored=docker("exec",project+"-"+actor+"-1","cat",skillPath);
  assert.deepEqual([...stored.matchAll(/^- (.+)$/gm)].map(m=>m[1]),skill.criteria);
  assert.doesNotMatch(stored,/旧北|旧南|120,000|3,000|12営業日/);
  assert.match(stored,/月額.*優先/);
  assert.equal((await(await page.request.get(other+"/api/workspace")).json()).quote_skills.some(s=>s.id===skill.id),false);
  const denied=await page.request.post(other+"/api/jobs",{headers:{Origin:other,"Idempotency-Key":crypto.randomUUID()},data:{
    company:otherActor==="sato" ? "A社" : "B社",kind:"assistant",ask:"今回の見積を比較してください。",quote_skill_id:skill.id,
    contract:{name:"見積A.txt",text:"金額100円"},second_attachment:{name:"見積B.txt",text:"金額200円"}}});
  assert.equal(denied.status(),404);
  docker("exec",project+"-"+otherActor+"-1","test","!","-e",skillPath);
  const open=page.getByRole("button",{name:"新しい見積2件で使う",exact:true});
  await page.getByText("SKILL.md に保存した判断ルール",{exact:true}).click();
  await capture("saved",open);
  await open.click();
  assert.ok((await page.locator("#quoteRun").innerText()).includes(skill.rules.find(rule=>rule.includes("月額"))));
  await page.locator("#dialog").getByRole("button",{name:"閉じる",exact:true}).click();
  await page.goto(base);
  await page.getByRole("button",{name:"前回の比較基準で見積を比較",exact:true}).click();
  const reuse=page.locator("#quoteRun");
  await reuse.getByLabel("1社目の新しい見積").setInputFiles(next[0]);
  await reuse.getByLabel("2社目の新しい見積").setInputFiles(next[1]);
  await reuse.getByRole("button",{name:"この2件で比較する"}).click();
  await page.waitForURL(url=>url.hash.startsWith("#job/") && !url.hash.includes(id));
  const newId=page.url().split("#job/")[1];
  const result=await completed(newId,"compose");
  await page.reload();
  const table=page.locator("#memoText table");
  assert.deepEqual(await table.locator("tbody th").allTextContents(),skill.criteria);
  assert.deepEqual(result.sources.map(s=>s.title),next.map(s=>s.name));
  assert.equal(result.work_tool.workflow.title,"自分用の見積比較");
  await capture("comparison",table);
  const rows=table.locator("tbody tr");
  const cells=[["金額は81,000円。","金額は93,000円。"],["納期は4営業日。","納期は2営業日。"],[null,"保守費は月額900円。"]];
  for(let i=0;i<3;i++) for(let k=0;k<2;k++) {
    const cell=rows.nth(i).locator("td").nth(k);
    const value=cells[i][k];
    if(!value) {assert.match(await cell.innerText(),/要確認/);assert.equal(await cell.getByRole("button").count(),0);continue;}
    await cell.getByRole("button").click();
    const dialog=page.locator("#dialog");
    await dialog.waitFor({state:"visible"});
    assert.equal(await dialog.locator("mark").innerText(),value);
    assert.ok((await dialog.innerText()).includes(next[k].name));
    if(i===2) await capture("source",dialog);
    await dialog.getByRole("button",{name:"閉じる",exact:true}).click();
  }
  console.log(result.model.model_id,{id,newId,skill:skill.id,criteria:skill.criteria});
} finally {await browser.close();}
