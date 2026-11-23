import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
const {chromium}=createRequire(new URL("../../", import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const port=Number(process.env.CSV_CHECK_PORT || 18831), project=process.env.CSV_CHECK_PROJECT || "ai-hub-daily-work";
const actor=process.env.CSV_CHECK_ACTOR || "sato", peer=actor==="sato" ? "tanaka" : "sato";
assert.ok(["sato","tanaka"].includes(actor));
assert.notEqual(project,"ai-hub-hermes-local");
const base="http://127.0.0.1:"+port, other="http://127.0.0.1:"+(port+(actor==="sato" ? 1 : -1));
const docker=(...args)=>execFileSync("docker",["--context","colima-mac-studio-solo",...args],{encoding:"utf8"});
assert.equal(docker("port",project+"-hub-1",port+"/tcp").trim(),base.slice(7));
let original=process.argv.slice(2).find(arg=>!arg.startsWith("--"));
const browser=await chromium.launch({channel:"chrome"});
try {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const name="商品別売上 "+Date.now(), csv="売上金額,区分,商品,原価\n85,売上,封筒,30\n90,返品,封筒,40\n150,売上,用紙,70\n15,売上,封筒,7";
  const file={name:"翌月売上.csv",mimeType:"text/csv",buffer:Buffer.from(csv)};
  const openSkills=async()=>{await page.goto(base+"/#skills");await page.locator("#catalogResults button").filter({hasText:name}).waitFor();};
  const state=async()=>(await page.request.get(base+"/api/workspace")).json();
  const result=async id=>{
    for(let i=0;i<120;i++){
      const j=await(await page.request.get(base+"/api/jobs/"+id)).json();
      if(j.status==="done")return j;
      assert.ok(["running","dispatching","queued"].includes(j.status),id+" "+j.status);
      await page.waitForTimeout(1000);
    }
    assert.fail("集計の完了を確認できません "+id);
  };
  if (!original) {
    const initial=await page.request.post(base+"/api/jobs",{headers:{Origin:base,"Idempotency-Key":randomUUID()},data:{
      company:actor==="sato" ? "A社" : "B社",kind:"assistant",ask:"返品を除いて商品別の売上を集計してください。",
      contract:{name:"前月売上.csv",text:"売上金額,区分,商品,原価\n999,売上,前月の紙,310\n202,返品,前月の紙,80"},
    }});
    assert.equal(initial.status(),201,await initial.text());
    original=(await initial.json()).id;
    await result(original);
  }
  await page.goto(base+"/#job/"+original);
  await page.locator("#jobRecord summary").click();
  await page.getByRole("button",{name:"集計条件を自分用に保存"}).click();
  assert.match(await page.locator("#dlgbody").innerText(),/返品.*除外/s);
  await page.getByLabel("手順名").fill(name);
  await page.getByRole("button",{name:"自分用に保存",exact:true}).click();
  await page.locator("#dialog").waitFor({state:"hidden"});
  await openSkills();
  await page.locator("#catalogResults button").filter({hasText:name}).click();
  await page.getByRole("button",{name:"新しいCSVで使う"}).click();
  await page.getByLabel("今回のCSV").setInputFiles({...file,buffer:Buffer.from("商品,区分\n封筒,売上")});
  await page.getByRole("button",{name:"このCSVで集計する"}).click();
  await page.getByText(/必要な列名は「売上金額」/).waitFor();
  await page.getByLabel("今回のCSV").setInputFiles(file);
  await page.getByRole("button",{name:"このCSVで集計する"}).click();
  await page.waitForURL("**/#job/*");
  const id=page.url().split("#job/")[1], job=await result(id);
  await page.reload();
  assert.match(await page.locator("#memoText").innerText(),/封筒　100.*用紙　150.*合計　250/s);
  await page.getByText("集計条件と元の行",{exact:true}).click();
  assert.match(await page.locator("details[open]").first().innerText(),/除外 ・ 3行目.*90,返品,封筒,40/s);
  assert.equal(job.sources.length,1);
  assert.equal(job.sources[0].text,csv);
  assert.equal(job.work_tool.workflow.name,"csv-summary");
  assert.ok(job.run_id);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const otherState=await(await page.request.get(other+"/api/workspace")).json();
  assert.ok(!otherState.templates.some(t=>t.id===job.csv_skill.id));
  assert.equal((await page.request.get(other+"/api/jobs/"+id)).status(),404);
  if (process.env.CSV_CHECK_PROJECT) {
    const release=job.csv_skill.release;
    const path="/opt/data/skills/hub-csv-"+job.csv_skill.id+"-v"+release.version+"/SKILL.md";
    const content=docker("exec",project+"-"+actor+"-1","cat",path);
    assert.equal(createHash("sha256").update(content).digest("hex"),release.hash);
    assert.match(content,/返品.*除外/);
    assert.doesNotMatch(content,/前月の紙|999|202/);
    docker("exec",project+"-"+peer+"-1","test","!","-e",path);
    console.log("Hermes SKILL.md",path,"sha256",release.hash,"所有社員",actor);
  }
  console.log(job.model.model_id,"再実行",id,"手順",job.csv_skill.id);
  if(process.env.CAPTURE_WORK)await page.locator("#memoPanel").screenshot({path:"evidence/personal-csv-skill.png"});
  if(process.argv.includes("--schedule")){
    await openSkills();
    await page.locator("#catalogResults button").filter({hasText:name}).click();
    await page.getByRole("button",{name:"定期実行を設定"}).click();
    await page.getByLabel("繰り返し").selectOption("monthly");
    await page.getByRole("button",{name:"予約内容を確認する"}).click();
    await page.getByRole("button",{name:"定期実行を登録"}).click();
    await page.locator("#dialog").waitFor({state:"hidden"});
    await page.goto(base+"/#jobs/reservations");
    const scheduled=page.locator(".planning-schedule-row").filter({hasText:name});
    await scheduled.getByRole("button",{name:"次回分を確認"}).click();
    const due=Math.ceil((Date.now()+15000)/60000)*60000;
    await page.locator("[name=scheduledAt]").fill(new Date(due+9*3600000).toISOString().slice(0,16));
    await page.getByLabel("この回のCSV").setInputFiles({...file,name:"予約分.csv"});
    await page.getByRole("button",{name:"今回の変更を保存"}).click();
    await page.locator("#dialog").waitFor({state:"hidden"});
    await scheduled.getByRole("button",{name:"次回分を確認"}).click();
    await page.getByText("登録済み　予約分.csv").waitFor();
    await page.getByRole("button",{name:"閉じる",exact:true}).click();
    let next;
    for(let i=0;i<120 && !next;i++){
      next=(await state()).schedules.find(s=>s.name===name)?.last_job;
      if(!next)await page.waitForTimeout(1000);
    }
    assert.ok(next); const recurring=await result(next);
    assert.equal(recurring.csv_skill.id,job.csv_skill.id);
    assert.equal(recurring.sources[0].title,"予約分.csv");
    await page.goto(base+"/#job/"+next);
    assert.match(await page.locator("#memoText").innerText(),/合計　250/);
    await page.goto(base+"/#jobs/reservations"); await scheduled.getByRole("button",{name:"一時停止"}).click();
    await scheduled.getByRole("button",{name:"再開"}).waitFor();
    console.log("月次予約",next);
  }
} finally {await browser.close();}
