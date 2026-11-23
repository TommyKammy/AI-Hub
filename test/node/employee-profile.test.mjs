import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connections } from "../../src/models/catalog.mjs";
import { employeePreferences, saveEmployeePreference, writeProfileFiles } from "../../src/workspace/employee-profile.mjs";
import { listenGateway } from "../../src/hermes/gateway.mjs";
import { createWorker, openHub } from "../../src/jobs/hub.mjs";
import { personalWork } from "../../src/workspace/personal-work.mjs";
import { seedLegacyWorkspace } from "../support/legacy-workspace-fixture.mjs";

test("本人記憶の変更・削除・案件範囲を、再起動後も通常の依頼に反映する", async t => {
  const dir=await mkdtemp(join(tmpdir(),"aihub-profile-"));
  const dataDir=process.env.DATA_DIR;
  process.env.DATA_DIR=dir;
  t.after(async()=>{
    if (dataDir===undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR=dataDir;
    await rm(dir,{recursive:true,force:true});
  });
  const path=join(dir,"hub.sqlite");
  const legacyId=seedLegacyWorkspace(path);
  const oldNative="システム指示。\n\nUSER PROFILE (who the user is) [old]\n════\n- 結論を先に。\n\nMEMORY (agent knowledge) [old]\n════\n- 旧版の案件の前提。";
  const emptyNative="システム指示。";
  const requests=[];
  const provider=createServer(async (req,res)=>{
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    const request=JSON.parse(Buffer.concat(chunks));
    const message=request.messages.find(item=>item.role==="system").content;
    requests.push(message);
    const result=message.includes("結論を先に") ? "結論：確認を済ませました。" : "確認を済ませました。";
    res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({model:"fixture-model",choices:[{message:{content:result}}]}));
  }).listen(0,"127.0.0.1");
  await once(provider,"listening");
  const address=server=>"http://127.0.0.1:"+server.address().port;
  const original=connections["local-a"].url;
  connections["local-a"].url=address(provider);
  t.after(()=>{connections["local-a"].url=original;provider.close();});
  let hub, personal, gate;
  async function open() {
    hub=openHub(path);
    personal=personalWork(hub);
    gate={sato:listenGateway(hub.db,"sato","127.0.0.1",0),tanaka:listenGateway(hub.db,"tanaka","127.0.0.1",0)};
    await Promise.all(Object.values(gate).map(server=>once(server,"listening")));
  }
  async function close() {
    await Promise.all(Object.values(gate).map(server=>new Promise(resolve=>server.close(resolve))));
    hub.db.close();
    hub=null;
  }
  t.after(()=>hub && close());
  async function infer(actor, ask, system, input={}, remainder=[]) {
    const id=hub.create(actor,{kind:"assistant",company:actor==="sato" ? "A社" : "B社",ask,...input},randomUUID());
    await createWorker(hub.db,async()=>({run_id:randomUUID()}))();
    const route=hub.db.prepare("SELECT route_key FROM attempts WHERE job_id=?").get(id).route_key;
    const response=await fetch(address(gate[actor])+"/v1/chat/completions",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
        messages:[{role:"system",content:system},{role:"user",content:"AI_HUB_ROUTE "+route+"\n"+ask},...remainder],
      }),
    });
    assert.equal(response.status,200,await response.clone().text());
    hub.db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(id);
    return {id,text:(await response.json()).choices[0].message.content};
  }
  await open();
  if (legacyId) assert.equal(hub.get("sato",legacyId).skill_version,1);
  const native=[{role:"assistant",tool_calls:[{id:"native",function:{name:"memory",
    arguments:JSON.stringify({target:"user",operations:[{action:"add",content:"結論を先に書く。"}]})}}]},
  {role:"tool",tool_call_id:"native",content:'{"success":true,"done":true,"target":"user"}'}];
  await infer("sato","次回の会議について今回は結論を先に書いてください。",emptyNative,{},native);
  await infer("sato","次回は北社の見積について結論を先に書いて。",emptyNative,{},native);
  await infer("sato","今後は北社の見積について箇条書きで回答してください。",emptyNative,{},native);
  assert.deepEqual(employeePreferences(hub.db,"sato"),[]);
  const origin=await infer("sato","次回から結論を先に書いてください。",emptyNative,{},native);
  const [saved]=employeePreferences(hub.db,"sato");
  assert.equal(saved.source_job,origin.id);
  assert.deepEqual(employeePreferences(hub.db,"tanaka"),[]);
  const project=personal.fileInProject("sato",origin.id,{name:"合成の月次案件"});
  saveEmployeePreference(hub.db,"sato",{content:"案件の前提：定例会議は午前中。",project:project.id});
  assert.throws(()=>saveEmployeePreference(hub.db,"tanaka",{content:"漏えい試験",project:project.id}),{status:404});

  await close();
  await open();
  const ordinary=await infer("sato","結果を報告してください。",oldNative);
  assert.match(ordinary.text,/^結論/);
  assert.doesNotMatch(requests.at(-1),/定例会議|旧版の案件/);
  const peer=await infer("tanaka","結果を報告してください。",emptyNative);
  assert.doesNotMatch(peer.text,/^結論/);
  assert.doesNotMatch(requests.at(-1),/定例会議/);
  await infer("sato","案件の要点をまとめて。",oldNative,{profile_project:project.id});
  assert.match(requests.at(-1),/定例会議は午前中/);
  const skipped=await infer("sato","結果を報告してください。",oldNative,{skip_profile:true,profile_project:project.id});
  assert.doesNotMatch(skipped.text,/^結論/);
  assert.doesNotMatch(requests.at(-1),/定例会議|旧版の案件/);
  const updated=saveEmployeePreference(hub.db,"sato",{id:saved.id,revision:saved.revision,content:"要点を三つにまとめる。"});
  assert.throws(()=>saveEmployeePreference(hub.db,"sato",{id:saved.id,revision:saved.revision,deleted:true}),{status:409});
  saveEmployeePreference(hub.db,"sato",{id:saved.id,revision:updated.revision,deleted:true});
  writeProfileFiles(hub.db,"sato",dir);
  assert.equal(await readFile(join(dir,"employee-profiles","sato","USER.md"),"utf8"),"");

  await close();
  await open();
  const forgotten=await infer("sato","結果を報告してください。",oldNative);
  assert.doesNotMatch(forgotten.text,/^結論/);
  assert.doesNotMatch(requests.at(-1),/結論を先に|要点を三つ|旧版の案件|定例会議/);
  assert.throws(()=>saveEmployeePreference(hub.db,"sato",{source_job:origin.id,content:saved.content}),{status:409});
  const explicit=await infer("sato","結論を先に書く好みを覚えてください。",emptyNative,{},native);
  assert.equal(employeePreferences(hub.db,"sato").find(item=>item.content===saved.content)?.source_job,explicit.id);
});

test("版を指定した好みは案件の前提と共存し、削除後の再確認だけを新規に保存できる", t=>{
  const hub=openHub(":memory:");
  t.after(()=>hub.close());
  const job=hub.create("sato",{kind:"assistant",company:"A社",ask:"会議の結果をまとめて。"},randomUUID());
  const project=personalWork(hub).fileInProject("sato",job,{name:"案件資料"});
  const scoped=saveEmployeePreference(hub.db,"sato",{project:project.id,source_job:job,content:"会議の前提を保持する。"});
  const input={source_job:job,source_version:1,content:"結論を先に書く。"};
  const key=randomUUID();
  const saved=saveEmployeePreference(hub.db,"sato",input,key);
  assert.deepEqual(saveEmployeePreference(hub.db,"sato",input,key),{...saved});
  assert.throws(()=>saveEmployeePreference(hub.db,"sato",{...input,content:"書式を変える。"},key),{status:409});
  assert.throws(()=>saveEmployeePreference(hub.db,"tanaka",input,key),{status:404});
  assert.deepEqual(new Set(employeePreferences(hub.db,"sato").map(item=>item.id)),new Set([scoped.id,saved.id]));
  saveEmployeePreference(hub.db,"sato",{...saved,deleted:true});
  assert.throws(()=>saveEmployeePreference(hub.db,"sato",input,key),{status:409});
  const replacement=saveEmployeePreference(hub.db,"sato",input,randomUUID());
  assert.notEqual(replacement.id,saved.id);
});
