import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { connections, publish, register } from "../catalog.mjs";
import { listenGateway } from "../gateway.mjs";
import { openHub } from "../hub.mjs";
import { changeUsagePolicy, usagePolicy } from "../usage-policy.mjs";
import { seedLegacyWorkspace, verifyLegacyWorkspace } from "./legacy-workspace-fixture.mjs";

const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const dir=await mkdtemp(join(tmpdir(),"aihub-model-groups-"));
const file=join(dir,"hub.sqlite"), accounts=join(dir,"accounts"), directory=join(dir,"directory.json");
const tenant=randomUUID(), employeeId=randomUUID(), peerId=randomUUID(), groupA=randomUUID(), groupB=randomUUID();
const password=randomBytes(24).toString("hex"), token=randomBytes(24).toString("hex");
const authorization="Basic "+Buffer.from("aoki:"+password).toString("base64");
const observed=[];
const runOutputs=new Map();
let child,browser,gateway,liveDb,fixtureError;
async function listen(server) {
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  return server.address().port;
}
const url=port=>"http://127.0.0.1:"+port;
async function json(request) {
  const chunks=[];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks));
}
const model=createServer(async(req,res)=>{
  const input=await json(req);
  observed.push([req.url,input.model]);
  res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({
    model:input.model,usage:{prompt_tokens:2,completion_tokens:2,total_tokens:4},
    choices:[{message:{content:"確認済み。 [1]"}}],
  }));
});
const runs=createServer(async(req,res)=>{
  if (req.headers.authorization!=="Bearer "+token) return res.writeHead(403).end();
  if (req.method==="POST" && req.url==="/v1/runs") {
    const runId=req.headers["idempotency-key"];
    try {
      const payload=await json(req);
      const reply=await fetch(url(gateway.address().port)+"/v1/chat/completions",{
        method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
          messages:[{role:"system",content:"合成資料の確認"},{role:"user",content:payload.input}],
        }),
      });
      assert.equal(reply.status,200,await reply.clone().text());
      runOutputs.set(runId,(await reply.json()).choices[0].message.content);
      return res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({run_id:runId}));
    } catch (error) {
      fixtureError=error;
      return res.writeHead(502).end();
    }
  }
  const output=runOutputs.get(decodeURIComponent(req.url.slice(9)));
  if (output) return res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({status:"completed",output}));
  res.writeHead(404).end();
});

try {
  const legacyId=seedLegacyWorkspace(file);
  const hub=openHub(file);
  const second=register(hub.db,{name:"公開モデル B",connection:"local-b",model_id:"fixture-model-b",data_class:"合成資料"},"fixture");
  hub.db.prepare("UPDATE models SET probe='passed' WHERE id=?").run(second);
  publish(hub.db,second,1,"fixture","二つの承認済み候補を用意");
  const policy=usagePolicy(hub.db);
  changeUsagePolicy(hub.db,{base:policy.version,reason:"B は合成資料にだけ許可",settings:{...policy.settings,
    restricted:{enabled:true,models:["legacy"],destinations:["local-a"]}}},"publish","fixture",Object.keys(connections));
  hub.close();
  await mkdir(accounts,{mode:0o700});
  await writeFile(join(accounts,"aoki"),password,{mode:0o600});
  await writeFile(join(accounts,"mori"),password,{mode:0o600});
  await writeFile(join(accounts,".roles.json"),'{"aoki":"manager","mori":"auditor"}',{mode:0o600});
  await writeFile(directory,JSON.stringify({tenant,groups:[
    {id:groupA,name:"基幹グループ",models:[{connection:"local-a",modelId:"fixture-model"}]},
    {id:groupB,name:"試行グループ",models:[{connection:"local-b",modelId:"fixture-model-b"}]},
  ],bindings:[{actor:"sato",objectId:employeeId,groups:[groupA,groupB]},{actor:"tanaka",objectId:peerId,groups:[groupA]}]}),{mode:0o600});
  const modelUrl=url(await listen(model)), fixture=url(await listen(runs));
  connections["local-a"].url=modelUrl+"/a";
  connections["local-b"].url=modelUrl+"/b";
  const sockets=Array.from({length:3},()=>createServer());
  const ports=await Promise.all(sockets.map(listen));
  await Promise.all(sockets.map(socket=>new Promise(resolve=>socket.close(resolve))));
  const [sato,tanaka,admin]=ports.map(url);
  child=spawn(process.execPath,["server.mjs"],{
    cwd:new URL("../",import.meta.url),stdio:["ignore","pipe","inherit"],
    env:{PATH:process.env.PATH,DATA_DIR:dir,ADMIN_ACCOUNTS_DIR:accounts,AI_HUB_LOCAL_DIRECTORY_FILE:directory,
      SATO_PORT:String(ports[0]),TANAKA_PORT:String(ports[1]),ADMIN_PORT:String(ports[2]),SATO_URL:fixture,SATO_KEY:token},
  });
  child.stdout.resume();
  for (let i=0;i<100;i++) {
    if ((await fetch(sato).catch(()=>null))?.ok) break;
    if (child.exitCode!==null || i===99) throw Error("Hub did not start");
    await delay(50);
  }
  await verifyLegacyWorkspace(sato,legacyId);
  liveDb=new DatabaseSync(file);
  gateway=listenGateway(liveDb,"sato","127.0.0.1",0);
  await once(gateway,"listening");
  browser=await chromium.launch({channel:"chrome"});
  const employee=await browser.newPage({viewport:{width:390,height:844}});
  const manager=await browser.newPage({httpCredentials:{username:"aoki",password}});
  const post=(host,path,data,headers={})=>fetch(host+path,{method:"POST",
    headers:{Origin:host,"Idempotency-Key":randomUUID(),"Content-Type":"application/json",...headers},body:JSON.stringify(data)});
  const workspace=host=>fetch(host+"/api/workspace").then(res=>res.json());
  const awaitMemo=async()=>{
    try {await employee.locator("#memoText").waitFor({timeout:9000});}
    catch (error) {throw fixtureError || error;}
    const id=employee.url().split("#job/").at(-1);
    return fetch(sato+"/api/jobs/"+id).then(res=>res.json());
  };
  assert.deepEqual((await workspace(sato)).model_choices.general.map(item=>item.release),[2,1]);
  assert.deepEqual((await workspace(sato)).model_choices.restricted.map(item=>item.release),[1]);
  assert.deepEqual((await workspace(tanaka)).model_choices.general.map(item=>item.release),[1]);
  await employee.goto(sato);
  await employee.getByRole("button",{name:"依頼の設定"}).click();
  await employee.getByLabel("資料区分").selectOption("general");
  await employee.getByLabel("依頼の種類").selectOption("general");
  await employee.getByLabel("実行モデル").selectOption("1");
  await employee.getByLabel("依頼内容",{exact:true}).fill("部門の所属前にモデル A を明示して利用");
  await employee.getByRole("button",{name:"送信",exact:true}).click();
  const old=await awaitMemo();
  assert.equal(old.model_version,1);
  assert.equal(old.model.model_id,"fixture-model");
  const next={company:"A社",kind:"general",ask:"同じ社員の候補を検査",data_class:"合成資料"};
  const queued=await post(sato,"/api/jobs",{...next,model_release:1,scheduled_at:Date.now()+60000});
  assert.equal(queued.status,201);
  const queuedId=(await queued.json()).id;

  await manager.goto(admin+"/admin.html#local-directory");
  await manager.locator("#local-directory").waitFor();
  const sync=manager.locator("#localSync");
  await sync.getByLabel("同期する社員").selectOption(employeeId);
  assert.equal(await sync.getByRole("checkbox",{name:"基幹グループ"}).isChecked(),true);
  await sync.getByRole("checkbox",{name:"基幹グループ"}).uncheck();
  await sync.getByRole("button",{name:"差分を確認する"}).click();
  await sync.locator("#syncResult").filter({hasText:/適用後.*モデル 公開モデル B.*限定合成資料 なし/}).waitFor();
  await sync.getByLabel("同期理由（必須）").fill("基幹グループの解除を確認");
  await sync.getByRole("button",{name:"確認した差分を適用する"}).click();
  await manager.locator("#directoryRows").getByText("理由　基幹グループの解除を確認").waitFor();
  const history=liveDb.prepare("SELECT before_data,after_data FROM enterprise_sync_history WHERE actor='sato'").get();
  assert.deepEqual(JSON.parse(history.before_data).groups.sort(),[groupA,groupB].sort());
  assert.deepEqual(JSON.parse(history.after_data).groups,[groupB]);
  assert.deepEqual((await workspace(sato)).model_choices.general.map(item=>item.release),[2]);
  assert.deepEqual((await workspace(sato)).model_choices.restricted,[]);
  assert.deepEqual((await workspace(tanaka)).model_choices.general.map(item=>item.release),[1]);

  assert.equal((await post(sato,"/api/jobs",{...next,model_release:1})).status,403);
  assert.equal((await post(tanaka,"/api/jobs",{...next,company:"B社",model_release:2})).status,403);
  assert.equal((await post(sato,"/api/jobs",{...next,model_release:2,contract:{name:"限定.txt",text:"限定資料"}})).status,403);
  assert.equal((await post(sato,"/api/jobs",{...next,model_release:2,data_class:"限定合成資料",contract:{name:"限定.txt",text:"限定資料"}})).status,403);
  liveDb.prepare("UPDATE jobs SET scheduled_at=? WHERE id=?").run(Date.now()-1000,queuedId);
  for (let i=0;i<24;i++) {
    if (liveDb.prepare("SELECT status FROM jobs WHERE id=?").get(queuedId).status==="membership_blocked") break;
    await delay(150);
  }
  assert.equal(liveDb.prepare("SELECT count(*) count FROM attempts WHERE job_id=?").get(queuedId).count,0);
  assert.equal(liveDb.prepare("SELECT status FROM jobs WHERE id=?").get(queuedId).status,"membership_blocked");
  await employee.goto(sato);
  await employee.getByRole("button",{name:"依頼の設定"}).click();
  await employee.getByLabel("資料区分").selectOption("general");
  await employee.getByLabel("実行モデル").selectOption("2");
  await employee.getByLabel("依頼の種類").selectOption("general");
  await employee.getByLabel("依頼内容",{exact:true}).fill("所属更新後にモデル B を明示して利用");
  await employee.getByRole("button",{name:"送信",exact:true}).click();
  const latest=await awaitMemo();
  assert.equal(latest.model_version,2);
  assert.equal(latest.model.model_id,"fixture-model-b");
  assert.deepEqual(observed,[["/a/chat/completions","fixture-model"],["/b/chat/completions","fixture-model-b"]]);
  assert.equal((await (await fetch(sato+"/api/jobs/"+old.id)).json()).model_version,1);

  await manager.goto(admin+"/admin.html#groups");
  await manager.getByRole("button",{name:"グループを作成"}).click();
  const editor=manager.locator("#localGroupEditor");
  await editor.getByLabel("グループ名").fill("基幹業務");
  await editor.getByRole("checkbox",{name:/田中/}).check();
  await editor.getByRole("button",{name:"適用結果を確認"}).click();
  await editor.getByText("確認対象 1 人").waitFor();
  await editor.getByLabel("変更理由").fill("手動メンバーを保持する試験");
  await editor.getByRole("button",{name:"グループを保存"}).click();
  const localGroup=manager.locator("#adminGroupSummary article").filter({hasText:"基幹業務"});
  await localGroup.getByText(/メンバー 1 人/).waitFor();
  const localId=liveDb.prepare("SELECT id FROM local_model_groups WHERE name=?").get("基幹業務").id;
  const groupSync=manager.locator("#directoryGroupSync");
  await groupSync.getByLabel("Entra グループ",{exact:true}).selectOption(groupA);
  await groupSync.getByLabel("対応する AI Hub グループ",{exact:true}).selectOption(localId);
  await groupSync.getByRole("checkbox",{name:/佐藤/}).check();
  await groupSync.getByRole("checkbox",{name:/田中/}).uncheck();
  await groupSync.getByRole("button",{name:"グループの差分を確認"}).click();
  await groupSync.getByText("同期メンバー追加",{exact:true}).waitFor();
  assert.equal(liveDb.prepare("SELECT count(*) n FROM directory_group_links").get().n,0);
  await groupSync.getByLabel("グループの同期理由").fill("基幹グループの配信を適用");
  await groupSync.getByRole("button",{name:"確認したグループ差分を適用"}).click();
  await groupSync.getByText("確認したグループ差分を適用しました。",{exact:true}).waitFor();
  await localGroup.getByText(/メンバー 2 人/).waitFor();
  assert.deepEqual(JSON.parse(liveDb.prepare("SELECT members FROM local_model_groups WHERE id=?").get(localId).members),["tanaka"]);
  assert.equal(liveDb.prepare("SELECT target FROM directory_group_links WHERE source=?").get(groupA).target,localId);
  await manager.reload();
  await groupSync.getByLabel("Entra グループ",{exact:true}).selectOption(groupA);
  assert.equal(await groupSync.getByLabel("対応する AI Hub グループ").inputValue(),localId);
  assert.equal(await groupSync.getByLabel("対応する AI Hub グループ").isDisabled(),true);
  await groupSync.getByRole("button",{name:"グループの差分を確認"}).click();
  await groupSync.getByText("適用するグループ差分はありません。",{exact:true}).waitFor();
  assert.deepEqual((await workspace(tanaka)).model_choices.general,[]);

  async function companyPolicy(mode,reason) {
    await manager.getByRole("button",{name:"全社方針を設定"}).click();
    const form=manager.locator("#companyModelSelection");
    await form.getByLabel("新しい依頼に使うモデル").selectOption(mode);
    if (mode==="approved") await form.getByRole("checkbox",{name:/合成モデル A/}).check();
    await form.getByLabel("変更理由").fill(reason);
    await form.getByRole("button",{name:"公開方針を保存"}).click();
    await manager.getByText("全社のモデル選択方針を保存しました。",{exact:true}).waitFor();
  }
  await companyPolicy("fixed","全社固定の確認");
  assert.deepEqual((await workspace(sato)).model_choices.general.map(item=>item.release),[2]);
  await companyPolicy("approved","全社の承認済み候補を公開");
  assert.deepEqual((await workspace(sato)).model_choices.general.map(item=>item.release),[2,1]);
  assert.deepEqual((await workspace(sato)).model_choices.restricted.map(item=>item.release),[1]);
  assert.deepEqual((await workspace(tanaka)).model_choices.general,[]);
  const auditor={Authorization:"Basic "+Buffer.from("mori:"+password).toString("base64")};
  assert.equal((await post(admin,"/api/admin/groups/company",{},auditor)).status,403);
  assert.equal((await post(admin,"/api/admin/local-directory/group/apply",{},auditor)).status,403);
  const audit=await (await fetch(admin+"/api/admin/audit",{headers:auditor})).json();
  assert.match(JSON.stringify(audit),/基幹グループの配信を適用/);
  assert.match(JSON.stringify(audit),/全社の承認済み候補を公開/);

  console.log(JSON.stringify({chrome:browser.version(),groupsBefore:2,groupsAfter:1,generalBefore:[2,1],
    generalAfter:[2],restrictedAfter:[],unauthorizedPosts:4,queuedDispatches:0,pinnedBefore:old.id,pinnedAfter:latest.id,providerCalls:observed,
    linkedGroup:localId,manualMembersRetained:true,companyFixed:[2],companyApproved:[2,1],auditorDenied:true},null,2));
} finally {
  await browser?.close();
  if (child?.exitCode===null && child.signalCode===null) {
    const exited=once(child,"exit");
    child.kill();
    await exited;
  }
  gateway?.close();
  liveDb?.close();
  model.close();
  runs.close();
  await rm(dir,{recursive:true,force:true});
}
