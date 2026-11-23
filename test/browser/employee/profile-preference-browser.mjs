// Exercises the real Hub, model gateway, browser UI and disposable employee workspaces.
// The runtime below substitutes deterministic Hermes transport and model responses.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {once} from "node:events";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {chromium, expect} from "@playwright/test";
import {listenGateway} from "../../../src/hermes/gateway.mjs";
import {openHub} from "../../../src/jobs/hub.mjs";
import {connections} from "../../../src/models/catalog.mjs";
import {changeUsagePolicy, usagePolicy} from "../../../src/models/usage-policy.mjs";

const actors=["sato","tanaka"];
const dir=await mkdtemp(join(tmpdir(),"aihub-answer-preference-"));
const servers=[];
const address=server=>"http://127.0.0.1:"+server.address().port;
const close=server=>new Promise(resolve=>server.close(resolve));
const json=(res,data,status=200)=>res.writeHead(status,{"Content-Type":"application/json"}).end(JSON.stringify(data));
const body=async req=>{
  const chunks=[];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks));
};
async function server(listener) {
  const instance=createServer(async(req,res)=>{
    try {await listener(req,res);}
    catch(error) {console.error(error); json(res,{error:error.message},500);}
  }).listen(0,"127.0.0.1");
  servers.push(instance);
  await once(instance,"listening");
  return instance;
}
async function post(url,data) {
  const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
  assert.ok(response.ok,url+" "+response.status+" "+await response.clone().text());
  return response.json();
}
const original="次回の会議について今回は結論を先に書いてください。";
const revision="今回限り、冒頭に青葉支店を記載してください。";
const preference="結論を先に書く。";
const edited="箇条書きで書く。";
const requests=new Map();
let hub, child, browser;
try {
  const provider=await server(async(req,res)=>{
    const {messages,tools}=await body(req);
    const system=messages.find(item=>item.role==="system").content;
    const context=JSON.parse(messages.find(item=>item.role==="user").content.split("\n")[1]);
    const prefix=system.includes(edited) ? "・" : system.includes(preference) ? "結論："
      : context.phase==="revise" ? "青葉支店：" : "";
    requests.set(req.headers["x-hub-job"]+"/"+context.phase,{system,context,tools});
    json(res,{model:"fixture-model",choices:[{message:{content:prefix+"確認しました。 [1]"}}]});
  });
  connections["local-a"].url=address(provider);
  hub=openHub(join(dir,"hub.sqlite"));
  const gateways={};
  for (const actor of actors) {
    const gateway=listenGateway(hub.db,actor,"127.0.0.1",0);
    servers.push(gateway);
    await once(gateway,"listening");
    gateways[actor]=address(gateway);
  }
  const hash=createHash("sha256").update(await readFile(new URL("../../../skills/source-answer/SKILL.md",import.meta.url))).digest("hex");
  const runs=new Map();
  const runtime=await server(async(req,res)=>{
    if (req.method==="POST" && req.url==="/v1/runs") {
      const {input,instructions}=await body(req);
      const id=randomUUID();
      const actor=req.headers.authorization?.replace("Bearer ","");
      assert.ok(actors.includes(actor));
      runs.set(id,{actor,input,instructions});
      return json(res,{run_id:id},202);
    }
    const run=runs.get(req.url.split("/").at(-1));
    if (!run) return json(res,{},404);
    if (run.output) return json(res,{status:"completed",output:run.output});
    const {input,instructions,actor}=run;
    const context=JSON.parse(input.split("\n")[2]);
    const messages=[{role:"system",content:instructions},{role:"user",content:input}];
    const result=await post(gateways[actor]+"/v1/chat/completions",{messages,tools:[{function:{name:"memory"}}]});
    if (context.phase==="compose" && context.kind==="assistant") {
      const work=async result=>post(gateways[actor]+"/work-tool",{ticket:context.work,result});
      await work({tool:"load_workflow",name:"source-answer",title:"資料に基づく回答",hash});
      // Hermes normally delegates this to its work tool. Keep Hub's real validation of the passage.
      await work({tool:"read_passages",memo:"根拠 [1]",conditions:[],evidence:[context.passages[0]]});
    }
    run.output=result.choices[0].message.content;
    json(res,{status:"completed",output:run.output});
  });
  const addresses={}, ports={};
  const holders=await Promise.all([...actors,"admin"].map(async actor=>{
    const holder=await server((_req,res)=>res.end());
    addresses[actor]=address(holder);
    ports[actor]=String(holder.address().port);
    return holder;
  }));
  await Promise.all(holders.map(close));
  const admins=join(dir,"admins");
  await mkdir(admins);
  await writeFile(join(admins,"aoki"),randomUUID(),{mode:0o600});
  child=spawn(process.execPath,["server.mjs"],{env:{...process.env,DATA_DIR:dir,LISTEN_ADDR:"127.0.0.1",
    ADMIN_ACCOUNTS_DIR:admins,SATO_PORT:ports.sato,TANAKA_PORT:ports.tanaka,ADMIN_PORT:ports.admin,
    SATO_URL:address(runtime),TANAKA_URL:address(runtime),SATO_KEY:"sato",TANAKA_KEY:"tanaka"},stdio:["ignore","ignore","inherit"]});
  const deadline=Date.now()+10000;
  while (true) {
    try {if ((await fetch(addresses.sato+"/api/workspace")).ok) break;} catch {}
    assert.ok(child.exitCode===null && Date.now()<deadline,"Hub did not start");
    await delay(100);
  }

  browser=await chromium.launch({channel:"chrome"});
  const owner=await browser.newPage();
  const peer=await browser.newPage({viewport:{width:390,height:844}});
  for (const page of [owner,peer]) {
    page.on("pageerror",error=>console.error(error));
    page.setDefaultTimeout(12000);
  }
  async function read(actor,path) {
    const response=await fetch(addresses[actor]+path);
    assert.ok(response.ok,path+" "+response.status);
    return response.json();
  }
  async function send(actor,path,data,key=randomUUID()) {
    return fetch(addresses[actor]+path,{method:"POST",headers:{Origin:addresses[actor],"Idempotency-Key":key,
      "Content-Type":"application/json"},body:JSON.stringify(data)});
  }
  async function submit(page,actor,ask,{skip=false}={}) {
    await page.goto(addresses[actor]+"/");
    const form=page.locator("#request");
    await form.getByLabel("依頼内容").fill(ask);
    if (skip) {
      await page.getByRole("button",{name:"依頼の設定"}).click();
      await form.getByLabel("今回は記憶を使わない").check();
    }
    await form.getByRole("button",{name:"送信",exact:true}).click();
    await page.waitForURL("**/#job/*");
    const id=page.url().split("#job/")[1];
    const memo=page.locator("#memoText");
    try {await memo.waitFor();}
    catch(error) {throw new Error("回答が表示されません: "+id+" "+await page.locator(".toast").textContent(),{cause:error});}
    return {id,output:await memo.innerText(),...requests.get(id+"/compose")};
  }
  const start=await submit(owner,"sato",original);
  assert.equal(start.context.may_save_preference,undefined);
  assert.deepEqual(start.tools,[]);
  const remember=owner.getByRole("button",{name:"今後も使う",exact:true});
  const dialog=owner.getByRole("dialog");
  const confirmation=owner.locator("#saveAnswerPreference");
  const field=confirmation.getByLabel("覚えておく内容");
  await remember.click();
  await expect(dialog).toHaveAccessibleName("この回答の好みを今後も使う");
  await expect(confirmation).toContainText("第1版");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("");
  await field.fill("取り消した記憶");
  await owner.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(remember).toBeFocused();
  assert.deepEqual((await read("sato","/api/profile")).preferences,[]);

  const revise=owner.locator("#revise");
  await revise.getByLabel("修正内容").fill(revision);
  await revise.getByRole("button",{name:"修正を依頼する"}).click();
  await expect(owner.locator("#memoVersion option[value='2']")).toHaveCount(1);
  await owner.locator("#memoVersion").selectOption("2");
  await expect(owner.locator("#memoText")).toContainText("青葉支店");
  assert.deepEqual((await read("sato","/api/profile")).preferences,[]);
  await remember.click();
  await expect(confirmation).toContainText("第2版");
  await expect(field).toHaveValue("");
  await field.fill(preference);
  const [captured]=await Promise.all([
    owner.waitForRequest(req=>req.method()==="POST" && new URL(req.url()).pathname==="/api/profile"),
    confirmation.getByRole("button",{name:"記憶を保存"}).click(),
  ]);
  assert.deepEqual(captured.postDataJSON(),{content:preference,source_job:start.id,source_version:2});
  await expect(dialog).toHaveAccessibleName("好みを保存しました");
  const key=await captured.headerValue("idempotency-key");
  assert.equal((await send("sato","/api/profile",captured.postDataJSON(),key)).status,200);
  const [saved]= (await read("sato","/api/profile")).preferences;
  assert.equal(saved.content,preference);
  assert.equal(saved.source_version,2);
  assert.equal((await read("sato","/api/profile")).preferences.length,1);
  assert.equal((await send("tanaka","/api/profile",captured.postDataJSON(),key)).status,404);
  assert.equal((await send("sato","/api/profile",{...captured.postDataJSON(),source_version:99})).status,404);
  await dialog.getByRole("link",{name:"Hermesの記憶を開く"}).click();
  const entry=owner.locator("#workMemory .preference-entry");
  await expect(entry.getByLabel("本人の好み")).toHaveValue(preference);
  await entry.getByRole("button",{name:"記憶の元の仕事"}).click();
  await owner.waitForURL(url=>url.hash==="#job/"+start.id+"/version/2");
  await expect(owner.locator("#memoVersion")).toHaveValue("2");

  const nextAsk="確認結果を知らせてください。";
  async function verifyNext(page,actor,wanted,prefix,options) {
    const next=await submit(page,actor,nextAsk,options);
    assert.equal(next.context.ask,nextAsk);
    for (const text of [preference,edited,revision,original,"取り消した記憶"])
      assert.equal(next.system.includes(text),text===wanted,text);
    assert.ok(next.output.startsWith(prefix),next.output);
  }
  await verifyNext(owner,"sato",preference,"結論：");
  await verifyNext(peer,"tanaka",null,"確認しました。");
  await verifyNext(owner,"sato",null,"確認しました。",{skip:true});

  await owner.goto(addresses.sato+"/#work/memory");
  await entry.getByLabel("本人の好み").fill(edited);
  await entry.getByRole("button",{name:"変更を保存"}).click();
  await expect(owner.locator("#workMemory")).toHaveAttribute("data-snapshot",/箇条書きで書く/);
  await verifyNext(owner,"sato",edited,"・");
  const policy=usagePolicy(hub.db);
  changeUsagePolicy(hub.db,{base:policy.version,settings:{...policy.settings,memory:false},reason:"記憶の停止を検証"},"publish","aoki",["local-a","local-b"]);
  await owner.goto(addresses.sato+"/#job/"+start.id+"/version/2");
  await expect(owner.locator("#memoText")).toBeVisible();
  await expect(remember).toHaveCount(0);
  assert.equal((await send("sato","/api/profile",captured.postDataJSON())).status,403);
  await verifyNext(owner,"sato",null,"確認しました。");

  await owner.goto(addresses.sato+"/#work/memory");
  await entry.getByRole("button",{name:"忘れる"}).click();
  await expect(entry).toHaveCount(0);
  const disabled=usagePolicy(hub.db);
  changeUsagePolicy(hub.db,{base:disabled.version,settings:{...disabled.settings,memory:true},reason:"記憶の再開を検証"},"publish","aoki",["local-a","local-b"]);
  await verifyNext(owner,"sato",null,"確認しました。");
  assert.equal((await send("sato","/api/profile",captured.postDataJSON(),key)).status,409);
  await owner.goto(addresses.sato+"/#job/"+start.id+"/version/2");
  await remember.click();
  await field.fill(preference);
  await confirmation.getByRole("button",{name:"記憶を保存"}).click();
  await expect(dialog).toHaveAccessibleName("好みを保存しました");
  assert.notEqual((await read("sato","/api/profile")).preferences[0].id,saved.id);
  await owner.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(remember).toBeFocused();
  assert.equal((await send("sato","/api/jobs/delete",{ids:[start.id]})).status,200);
  await owner.goto(addresses.sato+"/#work/memory");
  await expect(entry.getByRole("button",{name:"記憶の元の仕事"})).toHaveCount(0);
  await entry.getByLabel("本人の好み").fill(edited);
  await entry.getByRole("button",{name:"変更を保存"}).click();
  await expect(owner.locator("#workMemory")).toHaveAttribute("data-snapshot",/箇条書きで書く/);
  await verifyNext(owner,"sato",edited,"・");
  console.log("PASS answer preference confirmation, source version, model input and output, employee isolation, edit, delete, per-request opt-out and usage policy");
} finally {
  await browser?.close();
  if (child?.exitCode===null && child.kill()) await once(child,"exit");
  await Promise.all(servers.filter(server=>server.listening).map(close));
  hub?.close();
  await rm(dir,{recursive:true,force:true});
}
