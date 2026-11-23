import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { connections } from "../../src/models/catalog.mjs";
import { listenGateway } from "../../src/hermes/gateway.mjs";
import { createWorker, openHub } from "../../src/jobs/hub.mjs";
import { setMemberActive } from "../../src/identity/memberships.mjs";
import { personalWork } from "../../src/workspace/personal-work.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = server => "http://127.0.0.1:" + server.address().port;

test("Gatewayは実行ごとに公開モデル、手順、出典、本人の資格を検証する", async t => {
  const {db,create} = openHub(":memory:");
  t.after(() => db.close());
  const id = create("sato", {
    company:"A社",kind:"assistant",ask:"添付した規程の取消手続を確認してください。",
    contract:{name:"規程.md",text:"第8条　領収書を提出する。"},
  }, "test-workflow-001");
  const worker = createWorker(db, async () => ({run_id:"fixture-run"}));
  await worker();
  const {route_key:route} = db.prepare("SELECT route_key FROM attempts WHERE job_id=?").get(id);
  const {ticket} = db.prepare("SELECT ticket FROM work_tool_results WHERE job=?").get(id);

  const sent = [];
  const model = createServer(async (req,res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    sent.push(JSON.parse(Buffer.concat(chunks)));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({model:"fixture-model",choices:[{message:{content:"領収書を提出します。 [1]"}}]}));
  }).listen(0,"127.0.0.1");
  t.after(() => model.close());
  await once(model, "listening");
  const originalUrl = connections["local-a"].url;
  connections["local-a"].url = base(model);
  t.after(() => { connections["local-a"].url = originalUrl; });

  const owner = listenGateway(db, "sato", "127.0.0.1", 0);
  const peer = listenGateway(db, "tanaka", "127.0.0.1", 0);
  t.after(() => { owner.close(); peer.close(); });
  await Promise.all([once(owner, "listening"), once(peer, "listening")]);
  const post = async (server, path, payload) => {
    const response = await fetch(base(server) + path,{method:"POST",body:JSON.stringify(payload)});
    const text = await response.text();
    return {status:response.status,result:text && JSON.parse(text)};
  };
  const tools = ["load_workflow","aggregate_csv","read_passages"].map(name => ({
    type:"function",function:{name:"mcp__work__"+name},
  }));
  const infer = server => post(server,"/v1/chat/completions",{
    model:"model-from-request",
    messages:[{role:"user",content:"AI_HUB_ROUTE "+route+"\n今回の質問"}],
    tools,tool_choice:{type:"function",function:{name:"mcp__work__aggregate_csv"}},
  });
  const work = (server,result) => post(server,"/work-tool",{ticket,result});

  assert.equal((await infer(peer)).status,403);
  assert.equal((await work(peer)).status,403);
  assert.equal(sent.length,0);
  assert.equal((await infer(owner)).status,200);
  assert.equal(sent[0].model,"fixture-model");
  assert.equal(sent[0].messages[0].content,"今回の質問");
  assert.deepEqual(sent[0].tools.map(t=>t.function.name),["mcp__work__load_workflow"]);
  assert.equal(sent[0].tool_choice,undefined);

  const hash = createHash("sha256").update(readFileSync(new URL("../../skills/source-answer/SKILL.md",import.meta.url))).digest("hex");
  const load = {tool:"load_workflow",name:"source-answer",title:"規程の質問",hash};
  assert.equal((await work(owner,{...load,hash:"0".repeat(64)})).status,400);
  assert.equal((await work(owner,load)).status,200);
  assert.equal((await infer(owner)).status,200);
  assert.deepEqual(sent[1].tools.map(t=>t.function.name),["mcp__work__read_passages"]);
  const {result:{passages:[passage]}} = await work(owner);
  const output = {tool:"read_passages",memo:"領収書を提出します。 [1]",evidence:[passage]};
  assert.equal((await work(owner,{...output,tool:"aggregate_csv"})).status,409);
  assert.equal((await work(owner,{...output,evidence:[{...passage,source:2}]})).status,400);
  assert.equal(db.prepare("SELECT result FROM work_tool_results WHERE job=?").get(id).result,null);
  assert.equal((await work(owner,output)).status,200);

  setMemberActive(db,"sato",{active:false,base:1,reason:"契約検査の利用停止"},"aoki");
  assert.equal((await infer(owner)).status,403);
  assert.equal((await work(owner)).status,403);
  assert.equal(sent.length,2);
});

test("定期下書きは受付後に出典の閲覧が失効すると業務ツールと推論の転送を拒否する",async t=>{
  const hub=openHub(":memory:"), {db}=hub, personal=personalWork(hub);
  const dir=mkdtempSync(join(tmpdir(),"aihub-recurring-gateway-")), originalRoot=process.env.LIBRARY_ROOT;
  const library="shared/定期確認", folder=join(dir,library), title="出張規程.txt";
  process.env.LIBRARY_ROOT=dir;
  mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,title),"出張の申請期限は前日です。");
  writeFileSync(join(folder,"その他.txt"),"食堂についての資料。");
  const owner=listenGateway(db,"sato","127.0.0.1",0);
  t.after(()=>{
    owner.close();
    hub.close();
    rmSync(dir,{recursive:true,force:true});
    if (originalRoot===undefined) delete process.env.LIBRARY_ROOT;
    else process.env.LIBRARY_ROOT=originalRoot;
  });
  await once(owner,"listening");
  const {id:template}=personal.saveTemplate("sato",{kind:"assistant",name:"出張規程の確認",ask:"出張の申請期限を調べて。"});
  const input={origin:{template},name:"定期確認",frequency:"weekly",weekday:5,time:"15:00",libraries:[library]};
  const now=Date.parse("2027-03-01T10:00:00+09:00");
  const plan=personal.previewDraftSchedule("sato",input,now);
  const {id:schedule}=personal.confirmDraftSchedule("sato",{...input,token:plan.token},now);
  personal.runDue(plan.nextRun);
  const {last_job:id}=db.prepare("SELECT last_job FROM weekly_schedules WHERE id=?").get(schedule);
  const worker=createWorker(db,async (_actor,_path,options)=>options ?
    {run_id:"recurring-gateway-fixture"} : {status:"completed",output:"申請期限は前日です。 [1]"});
  await worker();
  const {route_key:route}=db.prepare("SELECT route_key FROM attempts WHERE job_id=?").get(id);
  const {ticket}=db.prepare("SELECT ticket FROM work_tool_results WHERE job=?").get(id);
  const post=(path,payload)=>fetch(base(owner)+path,{method:"POST",body:JSON.stringify(payload)});
  const work=result=>post("/work-tool",{ticket,result});
  const hash=createHash("sha256").update(readFileSync(new URL("../../skills/source-answer/SKILL.md",import.meta.url))).digest("hex");
  assert.equal((await work({tool:"load_workflow",name:"source-answer",title:"出張規程",hash})).status,200);
  assert.equal((await work({tool:"search_libraries",query:"出張"})).status,200);
  assert.equal((await work(null)).status,200);
  rmSync(join(folder,title));
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"running");
  assert.equal((await work(null)).status,403);
  assert.equal((await post("/v1/chat/completions",{messages:[{role:"user",content:"AI_HUB_ROUTE "+route+"\n資料について回答してください。"}]})).status,403);
  assert.equal(db.prepare("SELECT count(*) AS n FROM model_calls WHERE job=?").get(id).n,0);
  assert.throws(()=>hub.get("sato",id),{status:403});
  await worker();
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"source_blocked");
});
