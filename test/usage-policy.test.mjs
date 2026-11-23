import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { connections } from "../catalog.mjs";
import { listenGateway } from "../gateway.mjs";
import { openHub, createWorker } from "../hub.mjs";
import { measuredSend, modelForVersion, readLog, setStopped } from "../operations.mjs";
import { changeUsagePolicy, generalSynthetic, restrictedSynthetic, usagePolicy, usageSnapshot } from "../usage-policy.mjs";

test("許可された合成推論だけを予算に予約し、送信結果と使用量を照合する", async t => {
  const hub=openHub(":memory:"), {db}=hub;
  t.after(()=>hub.close());
  const model=modelForVersion(db,1), reason="合成環境の利用上限を検証";
  const settings={...usagePolicy(db).settings,models:[model.id],destinations:["local-a"],inquiry:false,memory:false,
    budget:{limit:150,threshold:50},rates:[{model:model.id,input:2,output:3,reserve:80}]};
  const change=(base,action,params={})=>changeUsagePolicy(db,{base,reason,...params},action,"aoki",["local-a","local-b"]);
  assert.throws(()=>change(1,"publish",{settings:{...settings,classification:"社外秘"}}),{status:400});
  assert.equal(change(1,"publish",{settings}).version,2);
  assert.throws(()=>change(1,"stop"),{status:409});
  const request={company:"A社",ask:"本文はモデル利用ログへ記録しない",kind:"assistant"};
  const job=hub.create("sato",request,randomUUID());
  const target={actor:"sato",job,phase:"compose",version:1};
  let sent=0, release;
  const pending=measuredSend(db,model,target,{messages:[{role:"user",content:request.ask}]},async(_model,_payload,headers)=>{
    sent++;
    assert.equal(headers["X-Hub-Job"],job);
    assert.match(headers["X-Hub-Call"],/^[a-z0-9-]{36}$/);
    await new Promise(resolve=>{release=resolve;});
    return Response.json({model:model.model_id,usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}});
  });
  const reserved=usageSnapshot(db);
  assert.deepEqual([reserved.requests,reserved.pending,reserved.settled,reserved.pending_calls,reserved.alerts.length],[1,80,0,1,1]);
  await assert.rejects(measuredSend(db,model,target,{},assert.fail),{status:423});
  release();
  const response=await pending;
  await response.text();
  const unknown=await measuredSend(db,model,target,{},async()=>{
    sent++;
    return Response.json({model:model.model_id,choices:[{message:{content:"成果物本文"}}]});
  });
  await unknown.text();
  const totals=usageSnapshot(db);
  assert.deepEqual([totals.requests,totals.pending,totals.settled,totals.pending_calls,totals.alerts.length],[1,80,12,1,1]);
  assert.deepEqual(totals.byModel.map(m=>[m.requests,m.calls,m.blocked,m.unreported]),[[1,2,1,1]]);
  const logs=readLog(db,"usage",new URLSearchParams({job})).rows;
  const success=logs.find(entry=>entry.total_tokens===5);
  assert.equal(success.served,model.model_id);
  assert.equal(success.policy_version,2);
  assert.ok(success.call_id);
  assert.doesNotMatch(JSON.stringify(logs),/本文はモデル利用ログへ記録しない|成果物本文/u);
  change(2,"stop");
  assert.throws(()=>hub.create("sato",request,randomUUID()),{status:423});
  await createWorker(db,assert.fail)();
  assert.equal(hub.get("sato",job).status,"held");
  change(3,"restore",{version:2});
  assert.equal(usagePolicy(db).settings.stopped,false);
  const setting=modelForVersion(db,1);
  setStopped(db,setting.id,{generation:setting.generation,reason},true,"aoki");
  await assert.rejects(measuredSend(db,model,target,{},assert.fail),{status:423});
  assert.equal(sent,2);
});

test("依頼の資料から機密区分を固定し、ゲートウェイは限定合成資料だけを停止する", async t=>{
  const hub=openHub(":memory:"), {db}=hub;
  t.after(()=>hub.close());
  const seen=[];
  const provider=createServer(async(req,res)=>{
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({payload:JSON.parse(Buffer.concat(chunks)),call:req.headers["x-hub-call"]});
    res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({
      model:"fixture-model",choices:[{message:{content:"固定応答"}}],usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3},
    }));
  });
  provider.listen(0,"127.0.0.1");
  await once(provider,"listening");
  t.after(()=>new Promise(resolve=>provider.close(resolve)));
  const original=connections["local-a"].url;
  connections["local-a"].url="http://127.0.0.1:"+provider.address().port+"/v1";
  t.after(()=>{ connections["local-a"].url=original; });
  const regular={kind:"assistant",company:"A社",ask:"文章を整える",data_class:generalSynthetic};
  const attached={kind:"assistant",company:"B社",ask:"資料をまとめる",contract:{name:"試験.txt",text:"限定される資料の本文です。"}};
  assert.throws(()=>hub.create("tanaka",{...attached,data_class:generalSynthetic},randomUUID()),{status:403});
  const normal=hub.create("sato",regular,randomUUID()), limited=hub.create("tanaka",attached,randomUUID());
  assert.equal(hub.get("sato",normal).data_class,generalSynthetic);
  assert.equal(hub.get("tanaka",limited).data_class,restrictedSynthetic);
  const run=createWorker(db,async()=>({run_id:randomUUID()}));
  await run();
  const settings=usagePolicy(db).settings;
  changeUsagePolicy(db,{ base:1,reason:"限定資料の許可先を設定",settings:{...settings,memory:false,
    restricted:{enabled:true,models:null,destinations:["local-b"]}} },"publish","aoki",Object.keys(connections));
  assert.throws(()=>hub.create("tanaka",attached,randomUUID()),{status:423});
  const gateways=[listenGateway(db,"sato","127.0.0.1",0),listenGateway(db,"tanaka","127.0.0.1",0)];
  await Promise.all(gateways.map(server=>once(server,"listening")));
  t.after(()=>Promise.all(gateways.map(server=>new Promise(resolve=>server.close(resolve)))));
  for (const [index,job] of [normal,limited].entries()) {
    const {route_key}=db.prepare("SELECT route_key FROM attempts WHERE job_id=?").get(job);
    const response=await fetch("http://127.0.0.1:"+gateways[index].address().port+"/v1/chat/completions",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({data_class:generalSynthetic,messages:[
        {role:"system",content:"依頼の指示\nUSER PROFILE (who the user is) [profile]\n════\n限定された好み"},
        {role:"user",content:"AI_HUB_ROUTE "+route_key+"\n検証する依頼"},
      ]}),
    });
    assert.equal(response.status,index===0 ? 200 : 423);
    await response.text();
  }
  assert.equal(seen.length,1);
  assert.equal(seen[0].payload.messages[0].content,"依頼の指示");
  assert.equal(seen[0].payload.messages[1].content,"検証する依頼");
  const logs=readLog(db,"usage",new URLSearchParams()).rows;
  assert.deepEqual(logs.map(row=>[row.data_class,row.outcome,row.total_tokens]),[[restrictedSynthetic,"blocked",null],[generalSynthetic,"ok",3]]);
  assert.equal(logs[1].call_id,seen[0].call);
  assert.equal(logs[1].served,"fixture-model");
});
