import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { listenGateway } from "../../src/hermes/gateway.mjs";
import { createWorker, openHub } from "../../src/jobs/hub.mjs";
import { makeDraft } from "../../src/procedures/procedures.mjs";
import { currentStandardProcedure, saveStandardProcedure } from "../../src/procedures/standard-procedures.mjs";

const runPython=promisify(execFile);
const adapter=new URL("../../infra/work_tools.py",import.meta.url);
const toolCases=[
  ["csv-summary",{contract:{name:"売上.csv",text:"商品,金額\nA,100\nB,200"}}],
  ["quote-comparison",{contract:{name:"見積甲.txt",text:"月額100円。"},second_attachment:{name:"見積乙.txt",text:"月額110円。"}}],
  ["document-draft",{contract:{name:"案内.txt",text:"新しい申請は10月1日から提出する。"}}],
  ["source-answer",{contract:{name:"規程.txt",text:"第5条　請求書を提出する。"}}],
];
const reviseStandard=(db,id,text)=>{
  const old=currentStandardProcedure(db,id);
  return saveStandardProcedure(db,id,{...old,base:old.version,instruction:text,reason:"標準手順の実行確認"},"aoki");
};

test("受付に固定した4手順を業務ツールアダプターが読み、既存の利用範囲を守る", async t=>{
  const hub=openHub(":memory:");
  t.after(()=>hub.db.close());
  const {db}=hub;
  const jobs=[];
  for (const [id,attachments] of toolCases) {
    const request={company:"A社",kind:"assistant",ask:"提供した資料に沿って作業してください。",...attachments};
    const explicit={...request,standard_workflow:id};
    const old=hub.create("sato",explicit,`before-${id}`);
    const oldContent=readFileSync(new URL(`../../skills/${id}/SKILL.md`,import.meta.url),"utf8");
    const release=reviseStandard(db,id,`# ${id} 改訂版\n\n出典箇所を確認して進める。\n`);
    assert.equal(hub.create("sato",explicit,`before-${id}`),old);
    const fresh=hub.create("sato",explicit,`after-${id}`);
    const automatic=hub.create("sato",request,`auto-${id}`);
    reviseStandard(db,id,`# ${id} 次の改訂版\n\n別の時点の受付に適用する。\n`);
    jobs.push({id,old,oldContent,release,fresh,automatic});
  }
  const completed=new Set();
  const worker=createWorker(db,async (_actor,path,options)=> options ? {run_id:JSON.parse(options.body).session_id}
    : completed.has(path.split("/").at(-1)) ? {status:"completed",output:"検証用の回答。 [1]"} : {status:"running"});
  const gateway=listenGateway(db,"sato","127.0.0.1",0);
  const peer=listenGateway(db,"tanaka","127.0.0.1",0);
  t.after(()=>{gateway.close();peer.close();});
  await Promise.all([once(gateway,"listening"),once(peer,"listening")]);
  const url=server=>`http://127.0.0.1:${server.address().port}/work-tool`;
  const ticketFor=job=>db.prepare("SELECT ticket FROM work_tool_results WHERE job=?").get(job).ticket;
  const load=async (ticket,id)=>{
    const {stdout}=await runPython("python3",["-B","-c",`
import importlib.util, json, sys
from urllib.request import Request, urlopen
spec = importlib.util.spec_from_file_location("work_tools", sys.argv[1])
tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tools)
tools.urlopen = lambda req, timeout: urlopen(Request(sys.argv[2], data=req.data, headers=dict(req.headers)), timeout=timeout)
print(json.dumps(tools.load_workflow(sys.argv[3], sys.argv[4])))
`,fileURLToPath(adapter),url(gateway),ticket,id]);
    return JSON.parse(stdout);
  };
  for (let count=0;count<jobs.length*3;count++) {
    await worker();
    const running=db.prepare("SELECT id,run_id FROM jobs WHERE status='running'");
    if (!running.get()) await worker();
    const {id:job,run_id}=running.get();
    const {id,old,oldContent,release,fresh}=jobs.find(({old,fresh,automatic})=>[old,fresh,automatic].includes(job));
    const ticket=ticketFor(job);
    const work=(server,result)=>fetch(url(server),{method:"POST",body:JSON.stringify({ticket,result})});
    if (job===fresh) {
      const hash=createHash("sha256").update(oldContent).digest("hex");
      const result={tool:"load_workflow",name:id,title:"同梱手順",hash};
      assert.equal((await work(gateway,result)).status,409);
      assert.equal(db.prepare("SELECT workflow FROM work_tool_results WHERE job=?").get(job).workflow,null);
    }
    assert.equal(await load(ticket,id),job===old ? oldContent : release.instruction);
    assert.equal((await work(gateway,{tool:"unrelated_tool"})).status,409);
    assert.equal((await work(peer,{tool:"unrelated_tool"})).status,403);
    completed.add(run_id);
  }
  for (const {id,old,release,fresh,automatic} of jobs) {
    assert.equal(hub.get("sato",old).standard_procedure.version,1);
    assert.deepEqual(hub.get("sato",fresh).standard_procedure,{id,name:release.name,version:2,hash:release.hash});
    const workflow=job=>JSON.parse(db.prepare("SELECT workflow FROM work_tool_results WHERE job=?").get(job).workflow);
    assert.equal(workflow(automatic).hash,release.hash);
    assert.equal(workflow(fresh).hash,release.hash);
  }
});

test("更新商談の確認と回答後で同じ手順を送り、改訂後の仕事も公開草案にできる", async t=>{
  const hub=openHub(":memory:");
  t.after(()=>hub.db.close());
  const input={company:"A社",ask:"次回の更新商談に備えて論点を確認してください。"};
  const old=hub.create("sato",input,"renewal-before-edit");
  const phrase="固定した改訂版の更新商談手順を使用する。";
  const release=reviseStandard(hub.db,"renewal-brief",phrase);
  const fresh=hub.create("sato",input,"renewal-after-edit");
  const sent=new Map();
  const worker=createWorker(hub.db,async (_actor,path,options)=>{
    if (!options) return {status:"completed",output:path.endsWith("draft") ? "先方の意向を確認する。" : "更新日をどう扱いますか？"};
    const body=JSON.parse(options.body);
    sent.set(body.session_id,body.instructions);
    return {run_id:body.session_id};
  });
  for (let i=0;i<4;i++) await worker();
  reviseStandard(hub.db,"renewal-brief","2番目の改訂版の更新商談手順を使用する。");
  for (const job of [old,fresh]) hub.answer("sato",job,{answer:"先方の意向を確認する。"});
  for (let i=0;i<4;i++) await worker();
  for (const stage of ["review","draft"]) {
    assert.ok(sent.get(`hub-${fresh}-${stage}`).includes(phrase));
    assert.ok(!sent.get(`hub-${old}-${stage}`).includes(phrase));
  }
  assert.equal(hub.get("sato",old).skill_version,2);
  assert.equal(hub.get("sato",fresh).skill_version,release.version);
  assert.equal(hub.get("sato",fresh).status,"done");
  assert.match(makeDraft(hub.db,"sato",fresh,"contract").instruction,new RegExp(phrase,"u"));
});
