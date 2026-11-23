import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openHub,createWorker} from "../hub.mjs";
import {answerInquiry,availableDesks,postInquiryFollowup,receivedInquiries,readInquiry,registerInquiry,resolveInquiry} from "../inquiries.mjs";
import {transfer} from "../memberships.mjs";

const payload={version:1,desk:"operations",recipient:"tanaka",subject:"電子領収書",body:"提出方法を確認したいです。",attachments:[1]};
function completed(hub) {
  const id=hub.create("sato",{company:"A社",kind:"general",ask:"必要資料を整理",minutes:"個人用の控え",
    contract:{name:"提出手順.md",text:"領収書を添付してください。"}},randomUUID());
  hub.db.prepare("UPDATE jobs SET status='done',memo=? WHERE id=?").run("手続きの詳細は要確認。[1]",id);
  return id;
}
async function processDraft(hub,answer,frames) {
  const work=createWorker(hub.db,async(actor,path,options)=>{
    if (options) {frames.push(JSON.parse(options.body).input); return {run_id:randomUUID()};}
    return {status:"completed",output:JSON.stringify(answer)};
  });
  await work(); await work();
}

test("選択した版の起票案だけを生成し、確定の再送・再起動でも受付は1件",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"hub-inquiry-")),file=join(dir,"hub.sqlite");
  let hub=openHub(file);t.after(()=>{hub.close();rmSync(dir,{recursive:true,force:true});});
  const id=completed(hub), frames=[];
  const memo=hub.get("sato",id).memo;
  hub.db.prepare("INSERT INTO memo_versions(job_id,version,memo) VALUES(?,?,?)").run(id,1,memo);
  hub.db.prepare("INSERT INTO memo_versions(job_id,version,memo) VALUES(?,?,?)").run(id,2,"第2版だけの指示");
  hub.db.prepare("UPDATE jobs SET memo=? WHERE id=?").run("第2版だけの指示",id);
  assert.throws(()=>registerInquiry(hub,"sato",id,payload),{status:409});
  hub.prepareInquiry("sato",id,1,randomUUID());hub.prepareInquiry("sato",id,1,randomUUID());
  await processDraft(hub,payload,frames);
  assert.equal(frames.length,1);assert.match(frames[0],/手続きの詳細は要確認/);assert.doesNotMatch(frames[0],/第2版だけの指示|個人用の控え/);
  assert.deepEqual(receivedInquiries(hub.db,"tanaka"),[]);
  assert.throws(()=>registerInquiry(hub,"tanaka",id,payload),{status:404});
  assert.throws(()=>registerInquiry(hub,"sato",id,{...payload,recipient:"sato"}),{status:409});
  assert.throws(()=>registerInquiry(hub,"sato",id,{...payload,attachments:[99]}),{status:400});
  const receipt=registerInquiry(hub,"sato",id,payload);
  hub.close();hub=openHub(file);
  assert.deepEqual(registerInquiry(hub,"sato",id,payload),receipt);
  assert.throws(()=>registerInquiry(hub,"sato",id,{...payload,attachments:[]}),{status:409});
  hub.prepareInquiry("sato",id,1,randomUUID());
  assert.equal(hub.get("sato",id).memo,"第2版だけの指示");assert.equal(hub.get("sato",id).status,"done");
  assert.equal(hub.db.prepare("SELECT count(*) n FROM attempts WHERE job_id=?").get(id).n,1);
  assert.equal(receivedInquiries(hub.db,"tanaka").length,1);
  const visible=readInquiry(hub.db,"tanaka",receipt.id);
  assert.equal(visible.job,undefined); assert.equal(visible.attachments.length,1);
  assert.equal(visible.attachments[0].text,"領収書を添付してください。");
  assert.doesNotMatch(JSON.stringify(visible),/個人用の控え/);
  transfer(hub.db,"tanaka",{base:1,team:"別部門",reason:"異動"},"aoki");
  assert.ok(!availableDesks(hub.db).some(d=>d.id==="operations"));
  assert.deepEqual(receivedInquiries(hub.db,"tanaka"),[]);
  assert.throws(()=>readInquiry(hub.db,"tanaka",receipt.id),{status:404});
  assert.equal(readInquiry(hub.db,"sato",receipt.id).job,id);
});

test("不正な添付候補は登録せず再生成でき、異動後は確認済みの案でも起票できない",async t=>{
  const hub=openHub(":memory:"),id=completed(hub); t.after(()=>hub.close());
  hub.prepareInquiry("sato",id,1,randomUUID());
  await processDraft(hub,{...payload,attachments:[9]},[]);
  assert.equal(hub.get("sato",id).status,"failed");
  assert.throws(()=>registerInquiry(hub,"sato",id,payload),{status:409});
  hub.prepareInquiry("sato",id,1,randomUUID());
  await processDraft(hub,{...payload,attachments:[]},[]);
  transfer(hub.db,"sato",{base:1,team:"別部門",reason:"異動"},"aoki");
  assert.throws(()=>registerInquiry(hub,"sato",id,payload),{status:403});
  assert.deepEqual(receivedInquiries(hub.db,"tanaka"),[]);
});

test("窓口の回答と元の版への通知は再起動や再送後も1件で、現在の所属でのみ開ける",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"hub-answer-")),file=join(dir,"hub.sqlite");
  let hub=openHub(file);t.after(()=>{hub.close();rmSync(dir,{recursive:true,force:true});});
  const job=completed(hub);
  hub.prepareInquiry("sato",job,1,randomUUID());
  await processDraft(hub,payload,[]);
  const {id}=registerInquiry(hub,"sato",job,payload), answer={body:"電子領収書は精算申請に添付してください。"};
  const baseline=hub.get("sato",job);
  assert.equal(readInquiry(hub.db,"tanaka",id).can_answer,true);
  assert.throws(()=>answerInquiry(hub.db,"sato",id,answer),{status:403});
  assert.throws(()=>answerInquiry(hub.db,"tanaka",id,{body:"  "}),{status:400});
  assert.deepEqual(answerInquiry(hub.db,"tanaka",id,answer),{id});
  hub.close();hub=openHub(file);
  assert.deepEqual(answerInquiry(hub.db,"tanaka",id,answer),{id});
  assert.throws(()=>answerInquiry(hub.db,"tanaka",id,{body:"別の回答"}),{status:409});
  const receipt=readInquiry(hub.db,"tanaka",id), updated=hub.get("sato",job);
  assert.equal(receipt.can_answer,false);assert.equal(receipt.answer.name,"田中 翔");
  assert.equal(receipt.answer.body,answer.body);assert.ok(receipt.answer.created);
  assert.deepEqual(updated.inquiries[0].answer,{...receipt.answer});
  assert.deepEqual(updated.versions,baseline.versions);assert.equal(updated.run_id,baseline.run_id);
  assert.equal(hub.db.prepare("SELECT count(*) n FROM attempts WHERE job_id=?").get(job).n,1);
  const events=()=>hub.notifications("sato").filter(e=>e.status==="inquiry_answered");
  const [event]=events();assert.equal(events().length,1);assert.equal(event.ask,payload.subject);assert.equal(event.seen,0);
  assert.throws(()=>hub.readNotification("tanaka",event.seq),{status:404});
  assert.deepEqual(hub.readNotification("sato",event.seq),{job,inquiry:id,version:1});assert.equal(events()[0].seen,1);
  transfer(hub.db,"tanaka",{base:1,team:"別部門",reason:"異動"},"aoki");
  assert.throws(()=>answerInquiry(hub.db,"tanaka",id,answer),{status:404});
  transfer(hub.db,"sato",{base:1,team:"別部門",reason:"異動"},"aoki");
  assert.equal(events().length,0);assert.throws(()=>hub.readNotification("sato",event.seq),{status:404});
  assert.deepEqual(hub.get("sato",job).inquiries,[]);
});

test("同一受付票の追質問と再回答は順番と権限を守り、再起動・再送後も各回の通知と出典を保持する",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"hub-followup-")),file=join(dir,"hub.sqlite");
  let hub=openHub(file);t.after(()=>{hub.close();rmSync(dir,{recursive:true,force:true});});
  const job=completed(hub);
  hub.prepareInquiry("sato",job,1,randomUUID());await processDraft(hub,payload,[]);
  const {id}=registerInquiry(hub,"sato",job,payload);
  const send=(actor,round,reply,body)=>postInquiryFollowup(hub.db,actor,id,round,reply,{body});
  assert.throws(()=>send("sato",1,false,"再確認"),{status:409});
  answerInquiry(hub.db,"tanaka",id,{body:"初回の回答"});
  assert.throws(()=>send("tanaka",1,false,"追加質問"),{status:403});
  assert.throws(()=>send("sato",1,true,"本人の回答"),{status:403});
  assert.throws(()=>send("sato",1,false,"  "),{status:400});
  assert.throws(()=>send("tanaka",1,true,"該当質問なし"),{status:409});
  assert.deepEqual(send("sato",1,false,"追加質問1"),{id,number:1});
  assert.equal(receivedInquiries(hub.db,"tanaka")[0].pending_followup,1);
  assert.throws(()=>send("sato",2,false,"未回答のうちに送信"),{status:409});
  hub.close();hub=openHub(file);
  send("sato",1,false,"追加質問1");send("tanaka",1,true,"再回答1");
  send("sato",2,false,"追加質問2");send("tanaka",2,true,"再回答2");
  hub.close();hub=openHub(file);
  send("tanaka",1,true,"再回答1");assert.throws(()=>send("tanaka",1,true,"変更"),{status:409});
  assert.throws(()=>send("sato",1,false,"変更"),{status:409});
  const ticket=readInquiry(hub.db,"sato",id);
  assert.equal(ticket.answer.body,"初回の回答");
  assert.deepEqual(ticket.followups.map(f=>[f.question,f.answer]),[["追加質問1","再回答1"],["追加質問2","再回答2"]]);
  assert.deepEqual(ticket.followups,hub.get("sato",job).inquiries[0].followups);
  const events=hub.notifications("sato").filter(e=>e.inquiry===id);
  assert.deepEqual(events.map(e=>e.round),[2,1,null]);
  assert.throws(()=>hub.readNotification("tanaka",events[1].seq),{status:404});
  assert.deepEqual(hub.readNotification("sato",events[1].seq),{job,version:1,inquiry:id,round:1});
  assert.equal(hub.notifications("sato").find(e=>e.seq===events[0].seq).seen,0);
  assert.equal(hub.db.prepare("SELECT count(*) n FROM attempts WHERE job_id=?").get(job).n,1);
  send("sato",3,false,"追加質問3");
  transfer(hub.db,"tanaka",{base:1,team:"別部門",reason:"異動"},"aoki");
  assert.throws(()=>send("tanaka",3,true,"異動後の回答"),{status:404});
  transfer(hub.db,"sato",{base:1,team:"別部門",reason:"異動"},"aoki");
  assert.throws(()=>send("sato",4,false,"異動後の質問"),{status:404});
  assert.throws(()=>hub.readNotification("sato",events[0].seq),{status:404});
  assert.ok(!hub.notifications("sato").some(e=>e.inquiry===id));
});

test("本人が起票時の版に窓口回答を反映し、有効な受付票出典を持つ版だけを採用できる",async t=>{
  const hub=openHub(":memory:"),job=completed(hub);
  t.after(()=>hub.close());
  hub.prepareInquiry("sato",job,1,randomUUID());
  await processDraft(hub,payload,[]);
  const {id}=registerInquiry(hub,"sato",job,payload);
  const input={base:1,answer_inquiry:id};
  const reflect=(actor="sato",changes={})=>hub.revise(actor,job,{...input,...changes},randomUUID());
  assert.throws(()=>reflect(),{status:409});
  answerInquiry(hub.db,"tanaka",id,{body:"領収書のPDFを添付します。"});
  assert.throws(()=>reflect("tanaka"),{status:404});
  assert.throws(()=>reflect("sato",{base:2}),{status:409});
  assert.throws(()=>reflect("sato",{answer_inquiry:id+1}),{status:409});
  const original=hub.get("sato",job).memo;
  const source=hub.get("sato",job).inquiries[0].source_id;
  let output="回答の出典がない [1]",calls=0;
  const work=createWorker(hub.db,async(actor,path,options)=>{
    if (!options) return {status:"completed",output};
    assert.equal(actor,"sato"); const frame=JSON.parse(options.body).input;
    assert.ok(frame.includes("領収書のPDFを添付します。"));
    calls++;return {run_id:randomUUID()};
  });
  assert.equal(reflect().version,2);assert.equal(reflect().version,2);
  await work();await work();
  assert.equal(calls,1);assert.equal(hub.get("sato",job).status,"failed");
  assert.equal(hub.get("sato",job).memo,original);assert.throws(()=>hub.adopt("sato",job,2),{status:409});
  output="領収書のPDFを添付します。 ["+source+"]";
  assert.equal(reflect().version,3);
  await work();await work();
  const candidate=hub.get("sato",job);
  assert.equal(candidate.versions.at(-1).memo,output);assert.equal(candidate.adopted_version,1);
  assert.equal(reflect().version,3);assert.equal(calls,2);
  hub.adopt("sato",job,3);assert.equal(hub.get("sato",job).adopted_version,3);
  hub.revise("sato",job,{base:3,instruction:"上司向けに短く"},randomUUID());
  await work();await work();assert.equal(hub.get("sato",job).versions.at(-1).version,4);
  transfer(hub.db,"sato",{base:1,team:"別部門",reason:"異動"},"aoki");
  assert.throws(()=>hub.get("sato",job),{status:404});
  assert.deepEqual(hub.search("sato","領収書のPDF"),[]);
  assert.ok(!hub.notifications("sato").some(event=>event.job===job));
  assert.ok(!hub.list("sato").some(j=>j.id===job));
});

test("再回答の修正は選んだ回と採用版に固定し、別の回の出典や古い比較からの採用を拒む",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"hub-round-version-")),file=join(dir,"hub.sqlite");
  let hub=openHub(file);t.after(()=>{hub.close();rmSync(dir,{recursive:true,force:true});});
  const job=completed(hub);
  hub.prepareInquiry("sato",job,1,randomUUID());await processDraft(hub,payload,[]);
  const {id}=registerInquiry(hub,"sato",job,payload);
  answerInquiry(hub.db,"tanaka",id,{body:"初回回答"});
  const post=(n,body,reply)=>postInquiryFollowup(hub.db,reply ? "tanaka" : "sato",id,n,reply,{body});
  post(1,"複数ある場合は？",false);
  const revise=(n,base,latest)=>hub.revise("sato",job,{answer_inquiry:id,answer_round:n,base,latest},randomUUID());
  assert.throws(()=>revise(1,1,1),{status:409});
  post(1,"一件ずつ添付",true);post(2,"別の質問",false);post(2,"回答二",true);
  const runs=[];
  let wrong=false;
  async function processRevision() {
    let output;
    const worker=createWorker(hub.db,async(actor,path,options)=>{
      if (!options) return {status:"completed",output};
      assert.equal(actor,"sato");
      const context=JSON.parse(JSON.parse(options.body).input.split("AI_HUB_INPUT\n")[1].split("\nEND_AI_HUB_INPUT")[0]);
      runs.push(context);
      const s=context.sources.find(s=>s.id===context.answer_source);
      output=s.text+" ["+(wrong ? runs[0].answer_source : s.id)+"]";
      return {run_id:randomUUID()};
    });
    await worker();await worker();
  }
  hub.revise("sato",job,{base:1,answer_inquiry:id},randomUUID());await processRevision();hub.adopt("sato",job,2);
  assert.throws(()=>revise(1,1,2),{status:409});
  assert.throws(()=>hub.revise("tanaka",job,{base:2,answer_inquiry:id,answer_round:1},randomUUID()),{status:404});
  wrong=true;assert.equal(revise(1,2,2).version,3);await processRevision();
  assert.equal(hub.get("sato",job).status,"failed");assert.throws(()=>hub.adopt("sato",job,3),{status:409});
  wrong=false;assert.equal(revise(1,2,2).version,4);
  hub.close();hub=openHub(file);
  assert.equal(revise(1,2,2).version,4);await processRevision();
  const frame=runs.at(-1),source=frame.sources.find(s=>s.id===frame.answer_source);
  assert.equal(source.question,"複数ある場合は？");assert.equal(source.text,"一件ずつ添付");
  assert.doesNotMatch(JSON.stringify(frame),/別の質問|回答二/);assert.notEqual(frame.answer_source,runs[0].answer_source);
  const candidate=hub.get("sato",job);
  assert.equal(candidate.adopted_version,2);assert.equal(candidate.versions.at(-1).answer_round,1);
  assert.equal(candidate.versions.at(-1).answer_source,source.id);
  assert.equal(revise(2,2,4).version,5);await processRevision();
  assert.notEqual(runs.at(-1).answer_source,source.id);
  hub.adopt("sato",job,5,2);
  assert.throws(()=>hub.adopt("sato",job,4,2),{status:409});
  assert.equal(hub.get("sato",job).adopted_version,5);
  hub.adopt("sato",job,4,5);assert.equal(hub.get("sato",job).adopted_version,4);
});

test("再回答を引用した採用版でのみ依頼者が同じ受付票を解決でき、履歴と解決時の版を保持する",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"hub-inquiry-resolution-")),file=join(dir,"hub.sqlite");
  let hub=openHub(file);t.after(()=>{hub.close();rmSync(dir,{recursive:true,force:true});});
  const job=completed(hub);
  hub.prepareInquiry("sato",job,1,randomUUID());await processDraft(hub,payload,[]);
  const {id}=registerInquiry(hub,"sato",job,payload);
  answerInquiry(hub.db,"tanaka",id,{body:"初回回答"});
  const post=(number,body,reply)=>postInquiryFollowup(hub.db,reply ? "tanaka" : "sato",id,number,reply,{body});
  post(1,"複数ある場合は？",false);post(1,"一件ずつ添付",true);
  hub.revise("sato",job,{base:1,answer_inquiry:id,answer_round:1},randomUUID());
  let output;
  const work=createWorker(hub.db,async(actor,path,options)=>{
    if (!options) return {status:"completed",output};
    const ctx=JSON.parse(JSON.parse(options.body).input.split("AI_HUB_INPUT\n")[1].split("\nEND_AI_HUB_INPUT")[0]);
    output="領収書は一件ずつ添付 ["+ctx.answer_source+"]";return {run_id:randomUUID()};
  });
  await work();await work();
  const close=(version,extra={})=>resolveInquiry(hub,"sato",id,{version,...extra});
  assert.throws(()=>close(2),{status:409});
  assert.throws(()=>close(1),{status:409});
  hub.adopt("sato",job,2);
  assert.throws(()=>resolveInquiry(hub,"tanaka",id,{version:2}),{status:403});
  const adopted=hub.get("sato",job);assert.deepEqual(adopted.inquiries[0].resolution_candidate,{version:2,round:1});
  // A later revision that drops the round's citation cannot close the receipt.
  hub.db.prepare("INSERT INTO memo_versions(job_id,version,base,memo) VALUES(?,?,?,?)").run(job,3,2,"元の資料だけ [1]");
  hub.adopt("sato",job,3);assert.throws(()=>close(2),{status:409});assert.throws(()=>close(3),{status:409});
  hub.db.prepare("INSERT INTO memo_versions(job_id,version,base,memo) VALUES(?,?,?,?)").run(job,4,2,output);
  hub.adopt("sato",job,4);
  post(2,"念のための追加質問",false);
  assert.throws(()=>close(4,{last_round:1,last_answered:adopted.inquiries[0].followups[0].answered}),{status:409});
  const before=hub.get("sato",job),deskBefore=readInquiry(hub.db,"tanaka",id);
  const record=close(4,{last_round:2,last_answered:null});
  assert.equal(record.version,4);assert.equal(record.round,1);assert.equal(record.name,"佐藤 由衣");
  assert.deepEqual(record,close(4));assert.equal(hub.get("sato",job).run_id,before.run_id);
  assert.deepEqual(hub.get("sato",job).versions,before.versions);
  assert.throws(()=>post(2,"締め後の回答",true),{status:409});
  assert.throws(()=>post(3,"締め後の質問",false),{status:409});
  hub.adopt("sato",job,1);
  hub.close();hub=openHub(file);
  assert.deepEqual(close(4),record);assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM inquiry_resolutions WHERE inquiry=?").get(id).n,1);
  const desk=readInquiry(hub.db,"tanaka",id);assert.equal(desk.can_reanswer,false);assert.equal(desk.job,undefined);
  assert.deepEqual(desk.resolution,record);assert.deepEqual(desk.followups,deskBefore.followups);assert.deepEqual(desk.answer,deskBefore.answer);
  assert.equal(receivedInquiries(hub.db,"tanaka")[0].resolved_at,record.created);
  assert.deepEqual(hub.get("sato",job).inquiries[0].resolution,record);
  transfer(hub.db,"sato",{base:1,team:"別部門",reason:"異動"},"aoki");
  assert.throws(()=>close(4),{status:404});
});
