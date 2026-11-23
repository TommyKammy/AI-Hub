import test from "node:test";
import assert from "node:assert/strict";
import {openHub, createWorker, createReceiptRechecker, pendingRecoveries, reconcileRun, startPendingWeekly, closeUnconfirmedMeeting, meetingClosureAudit, HubError} from "../../src/jobs/hub.mjs";

async function interrupted(t, kind = "meeting") {
  const hub = openHub(":memory:");
  t.after(() => hub.close());
  const id = hub.create("sato",{kind,company:"A社",ask:"資料を整理",minutes:"棚卸しは12月4日。"},"recovery-test-key");
  const tick = createWorker(hub.db, async (_actor,_path,options) => {
    if (options) return {run_id:"run-original"};
    throw new HubError(404,"unavailable");
  });
  await tick();
  await tick();
  const [expected] = pendingRecoveries(hub.db);
  assert.equal(expected.id,id);
  assert.equal(expected.run_id,"run-original");
  const reconcile = call => reconcileRun(hub.db,call,id,expected,"aoki");
  return {hub,id,reconcile,expected};
}

async function heldWithWeekly(t) {
  const {hub,id} = await interrupted(t);
  const db = hub.db;
  db.prepare("UPDATE jobs SET run_id=NULL WHERE id=?").run(id);
  db.prepare("UPDATE attempts SET hermes_run_id=NULL WHERE job_id=?").run(id);
  const expected = {phase:"compose",run_id:null,lookup:"receipt"};
  await reconcileRun(db,assert.fail,id,expected,"aoki",async()=>({result:"missing"}));
  const createWeek = key => {
    const week = hub.create("sato",{kind:"weekly",company:"A社",ask:"週報を作成"},key);
    startPendingWeekly(db,id,week,"aoki");
    return week;
  };
  const week = createWeek("auto-week-first");
  const finish = weekly => db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(weekly);
  return {hub,db,id,week,createWeek,finish,expected};
}

test("対応終了の監査は既存の終了理由と同じ会議の自動照合記録だけを読み取る", async t => {
  const {db,id,week} = await heldWithWeekly(t);
  const check = db.prepare("INSERT INTO receipt_checks(job,phase,operator,time,outcome) VALUES(?,?,?,?,?)");
  const system = "system:auto-receipt";
  check.run(id,"compose",system,1000,"ambiguous");
  check.run(id,"compose","aoki",1100,"missing");
  check.run(week,"compose",system,1200,"missing");
  check.run(id,"revise-1",system,1300,"unavailable");
  check.run(id,"compose",system,2000,"expired");
  db.prepare("INSERT INTO meeting_receipt_retries(meeting,checks) VALUES(?,3)").run(id);
  closeUnconfirmedMeeting(db,id,{reason:"照合で元の実行を特定できなかったため"},"aoki");
  // One reservation has no result after interruption. Never reconstruct an event from the counter.
  db.exec("PRAGMA query_only=ON");
  const record = meetingClosureAudit(db," "+id.toUpperCase()+" ");
  assert.equal(record.id,id);
  assert.equal(record.reserved,3);
  assert.equal(record.operator,"aoki");
  assert.equal(record.reason,"照合で元の実行を特定できなかったため");
  assert.equal(record.time,db.prepare("SELECT time FROM meeting_closures WHERE meeting=?").get(id).time);
  assert.deepEqual(record.checks.map(c=>[c.time,c.outcome]),[[1000,"ambiguous"],[2000,"expired"]]);
  assert.throws(()=>meetingClosureAudit(db,week),{status:404});
  assert.throws(()=>meetingClosureAudit(db,"%"),{status:400});
});

test("上限に達した未確認の会議メモだけを理由付きで終了し、照合中の古い応答を反映しない", async t => {
  const {hub,db,id,week,finish,expected} = await heldWithWeekly(t);
  const close = (meeting,reason) => closeUnconfirmedMeeting(db,meeting,{reason},"aoki");
  const reason = "照合で特定できなかったため対応終了";
  assert.throws(()=>close(id,reason),{status:409});
  finish(week);
  const now = Date.now();
  const auto = createReceiptRechecker(db,assert.fail,async()=>({result:"ambiguous"}));
  await auto(now); await auto(now+30000);
  let release;
  const last = createReceiptRechecker(db,assert.fail,()=>new Promise(resolve=>{release=resolve;}))(now+90000);
  assert.throws(()=>close(id,reason),{status:409});
  release({result:"ambiguous"}); await last;
  assert.equal(pendingRecoveries(db)[0].can_close,true);
  for(const invalid of [null,"　","字".repeat(241)]) assert.throws(()=>close(id,invalid),{status:400});
  assert.throws(()=>close(week,reason),{status:409});
  const receipt = {result:"matched",run_id:"run_"+"e".repeat(32),session_id:"hub-"+id+"-compose"};
  const manual = reconcileRun(db,()=>new Promise(resolve=>{release=resolve;}),id,expected,"aoki",async()=>receipt);
  await Promise.resolve();
  close(id,reason); close(id,reason);
  assert.throws(()=>close(id,"変更"),{status:409});
  release({...receipt,status:"completed",output:"棚卸しは12月4日。 [1]"});
  await assert.rejects(manual,{status:409});
  await auto(now+999999);
  const job = hub.get("sato",id);
  assert.equal(job.status,"closed_unconfirmed"); assert.equal(job.closure_reason,reason);
  assert.equal(job.sources[0].text,"棚卸しは12月4日。"); assert.equal(job.memo,null);
  assert.throws(()=>hub.get("tanaka",id),{status:404});
  assert.equal(pendingRecoveries(db).length,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM meeting_closures WHERE meeting=?").get(id).n,1);
});

test("週報の初稿完了から自動照合を開始し、再起動・追加の週報でも期限と上限を共有する", async t => {
  const {db,id,week,createWeek,finish} = await heldWithWeekly(t);
  let calls=0;
  const worker=()=>createReceiptRechecker(db,assert.fail,async()=>{calls++; return {result:"ambiguous"};});
  await worker()(0);
  assert.equal(calls,0);
  finish(week);
  db.prepare("UPDATE memberships SET active=0 WHERE actor='sato'").run();
  await worker()(0);
  assert.equal(calls,0);
  db.prepare("UPDATE memberships SET active=1 WHERE actor='sato'").run();
  await Promise.all([worker()(0),worker()(0)]);
  await worker()(29999);
  assert.equal(calls,1);
  await worker()(30000);
  await worker()(89999);
  assert.equal(calls,2);
  await worker()(90000);
  finish(createWeek("auto-week-later"));
  await worker()(99999999);
  assert.equal(calls,3);
  const [held]=pendingRecoveries(db);
  assert.equal(held.id,id); assert.equal(held.can_lookup,true); assert.match(held.reason,/上限の3回/);
});

test("自動照合中に手動で復旧しても元の仕事は一度だけ完了する", async t => {
  const {db,id,week,finish,expected} = await heldWithWeekly(t);
  finish(week);
  const receipt={result:"matched",run_id:"run_"+"e".repeat(32),session_id:"hub-"+id+"-compose"};
  const run={...receipt,status:"completed",output:"棚卸しは12月4日。 [1]"};
  let resume;
  const auto=createReceiptRechecker(db,async()=>run,()=>new Promise(resolve=>{resume=resolve;}));
  const pending=auto(0);
  assert.equal(db.prepare("SELECT checks FROM meeting_receipt_retries WHERE meeting=?").get(id).checks,1);
  await reconcileRun(db,async()=>run,id,expected,"aoki",async()=>receipt);
  resume(receipt);
  await pending;
  await auto(999999);
  assert.equal(db.prepare("SELECT next_at FROM meeting_receipt_retries WHERE meeting=?").get(id).next_at,null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM job_notifications WHERE job=? AND status='done'").get(id).n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM run_reconciliations WHERE job=?").get(id).n,1);
});

test("未特定の会議を再照合可能なまま、指定した同じ社員の後続週報の初稿だけを一度送る", async t => {
  const hub=openHub(":memory:"), db=hub.db;
  t.after(()=>hub.close());
  const submit=(kind,key,actor="sato")=>hub.create(actor,{kind,company:actor==="sato"?"A社":"B社",ask:"整理してください",
    minutes:"東支店の棚卸しが完了。"},"weekly-start-"+key);
  const early=submit("weekly","early"), meeting=submit("meeting","original");
  db.prepare("UPDATE jobs SET status='held' WHERE id=?").run(early);
  const first=createWorker(db,async()=>{throw new Error("受付応答が消失");});
  await first();
  db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(early);
  const otherMeeting=submit("meeting","later"), firstWeek=submit("weekly","unselected"), week=submit("weekly","selected");
  const foreign=submit("weekly","elsewhere","tanaka");
  const start=id=>startPendingWeekly(db,meeting,id,"aoki");
  assert.throws(()=>start(week),{status:409});
  const expected={run_id:null,phase:"compose",lookup:"receipt"};
  await reconcileRun(db,()=>assert.fail(),meeting,expected,"aoki",async()=>({result:"ambiguous"}));
  for (const id of [foreign,early,otherMeeting]) assert.throws(()=>start(id),{status:409});
  assert.deepEqual(pendingRecoveries(db)[0].weeks.map(x=>x.id),[firstWeek,week]);
  start(week); start(week);
  db.prepare("UPDATE jobs SET status='held' WHERE id=?").run(foreign);
  const sent=[];
  const run="run_weekly";
  const hermes=async (actor,path,opts)=>{
    if (!opts) return {run_id:run,status:"completed",output:"棚卸しが完了。 [1]"};
    sent.push(opts.headers["Idempotency-Key"]);
    return {run_id:run};
  };
  db.prepare("UPDATE jobs SET status='unknown' WHERE id=?").run(otherMeeting);
  await createWorker(db,hermes)();
  assert.deepEqual(sent,[]);
  db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(otherMeeting);
  await createWorker(db,hermes)();
  start(week);
  await createWorker(db,hermes)();
  assert.deepEqual(sent,[week+"-compose"]);
  assert.equal(hub.get("sato",week).status,"done");
  for (const id of [otherMeeting,early,firstWeek]) assert.equal(hub.get("sato",id).status,"queued");
  assert.equal(hub.get("sato",meeting).status,"unknown");
  const audit=db.prepare("SELECT s.*,c.outcome FROM weekly_starts s JOIN receipt_checks c ON c.seq=s.receipt_check").all();
  assert.equal(audit.length,1); assert.equal(audit[0].operator,"aoki"); assert.equal(audit[0].outcome,"ambiguous");
  assert.equal(audit[0].meeting,meeting); assert.equal(audit[0].weekly,week);
  const receipt={result:"matched",run_id:"run_"+"b".repeat(32),session_id:"hub-"+meeting+"-compose"};
  await reconcileRun(db,async()=>({...receipt,status:"completed",output:"棚卸しが完了。 [1]"}),meeting,expected,"aoki",async()=>receipt);
  assert.equal(hub.get("sato",meeting).status,"done");
});

test("並行した照合は同じGETを読み、完了・通知・照合記録は一度だけ確定する", async t => {
  const {hub,id,reconcile} = await interrupted(t);
  const reads = [];
  const call = (actor,path,options) => {
    assert.equal(actor,"sato"); assert.equal(path,"/v1/runs/run-original"); assert.equal(options,undefined);
    return new Promise(resolve => reads.push(resolve));
  };
  const results = Promise.allSettled([reconcile(call),reconcile(call)]);
  for (const finish of reads) finish({run_id:"run-original",status:"completed",output:"棚卸しは12月4日。 [1]"});
  const [first,second] = await results;
  assert.equal(first.value.status,"done"); assert.equal(second.reason.status,409);
  assert.equal(hub.notifications("sato").length,1);
  assert.equal(hub.db.prepare("SELECT count(*) n FROM attempts WHERE job_id=?").get(id).n,1);
  assert.equal(hub.db.prepare("SELECT count(*) n FROM run_reconciliations WHERE job=? AND operator='aoki'").get(id).n,1);
});

test("個別開始した週報の受付応答も消失した場合、再起動後はその週報の受付を照合して完了する", async t => {
  const hub=openHub(":memory:"), db=hub.db;
  t.after(()=>hub.close());
  const postKeys=[];
  const send=async (_actor,_path,opts)=>{
    postKeys.push(opts.headers["Idempotency-Key"]);
    throw new Error("応答が途切れました");
  };
  const meeting=hub.create("sato",{kind:"meeting",company:"A社",ask:"会議を整理"},"meeting-interrupted-key");
  const worker=createWorker(db,send);
  await worker();
  const weekly=hub.create("sato",{kind:"weekly",company:"A社",ask:"進捗から週報を作成"},"weekly-interrupted-key");
  const expected={phase:"compose",lookup:"receipt",run_id:null};
  await reconcileRun(db,()=>assert.fail(),meeting,expected,"aoki",async()=>({result:"missing"}));
  startPendingWeekly(db,meeting,weekly,"aoki");
  await createWorker(db,send)();
  assert.equal(hub.get("sato",weekly).status,"unknown");
  startPendingWeekly(db,meeting,weekly,"aoki");
  await createWorker(db,send)();
  assert.deepEqual(postKeys,[meeting+"-compose",weekly+"-compose"]);
  const receipt={result:"matched",run_id:"run_"+"c".repeat(32),session_id:"hub-"+weekly+"-compose"};
  await reconcileRun(db,async()=>({...receipt,status:"completed",output:"進捗を整理しました。 [1]"}),weekly,expected,"aoki",async()=>receipt);
  assert.equal(hub.get("sato",weekly).status,"done");
  assert.equal(hub.get("sato",meeting).status,"unknown");
});

test("参加者または段階の違う結果・未確定・消失は保留し、質問段階の完了は依頼者の確認に戻す", async t => {
  const {hub,id,reconcile} = await interrupted(t,"renewal");
  for (const response of [
    {status:"completed",output:"誰の質問？"},
    {run_id:"other",status:"completed",output:"別の仕事"},
    {run_id:"run-original",session_id:"wrong-phase",status:"completed",output:"別の段階"},
    {run_id:"run-original",status:"unknown"},
  ]) assert.equal((await reconcile(async()=>response)).status,"unknown");
  assert.equal((await reconcile(async()=>{throw new HubError(404,"missing");})).status,"unknown");
  assert.equal((await reconcile(async()=>({run_id:"run-original",status:"completed",output:"棚卸しはいつですか？"}))).status,"waiting");
  assert.equal(hub.get("sato",id).question,"棚卸しはいつですか？");
});

test("保存IDなし・矛盾したIDでは照会しない。試行に残ったIDで実行中の監視を戻せる", async t => {
  const {hub,id,reconcile} = await interrupted(t);
  hub.db.prepare("UPDATE attempts SET hermes_run_id=NULL WHERE job_id=?").run(id);
  hub.db.prepare("UPDATE jobs SET run_id=NULL WHERE id=?").run(id);
  assert.equal(pendingRecoveries(hub.db)[0].run_id,null);
  const unexpected = () => assert.fail("保存IDのない照会");
  await assert.rejects(reconcile(unexpected),{status:409});
  hub.db.prepare("UPDATE attempts SET hermes_run_id='run-original' WHERE job_id=?").run(id);
  hub.db.prepare("UPDATE jobs SET run_id='other' WHERE id=?").run(id);
  await assert.rejects(reconcile(unexpected),{status:409});
  hub.db.prepare("UPDATE jobs SET run_id=NULL WHERE id=?").run(id);
  assert.equal((await reconcile(async()=>({run_id:"run-original",status:"running"}))).status,"running");
  const tick = createWorker(hub.db, async (_actor,path,options) => {
    assert.equal(options,undefined); assert.equal(path,"/v1/runs/run-original");
    return {status:"completed",output:"棚卸しは12月4日。 [1]"};
  });
  await tick();
  assert.equal(hub.get("sato",id).status,"done");
});

test("照合中の社員状態の変更を再確認し、出典のない完了結果を成果物にしない", async t => {
  const {hub,id,reconcile} = await interrupted(t);
  const response = {run_id:"run-original",status:"completed",output:"出典なし"};
  await assert.rejects(reconcile(async () => {
    hub.db.prepare("UPDATE memberships SET revision=revision+1 WHERE actor='sato'").run();
    return response;
  }),{status:409});
  assert.equal(hub.get("sato",id).status,"unknown");
  assert.equal((await reconcile(async()=>response)).status,"failed");
  assert.equal(hub.get("sato",id).memo,null);
});

test("受付照合は元の送信試行と実行セッションを検証し、並行しても一度だけIDと成果物を保存する", async t => {
  const {hub,id} = await interrupted(t);
  hub.db.prepare("UPDATE jobs SET run_id=NULL WHERE id=?").run(id);
  hub.db.prepare("UPDATE attempts SET hermes_run_id=NULL WHERE job_id=?").run(id);
  const expected = {phase:"compose", run_id:null, lookup:"receipt"};
  const key = hub.db.prepare("SELECT route_key FROM attempts WHERE job_id=?").get(id).route_key;
  const runId = "run_"+"a".repeat(32), session = "hub-"+id+"-compose";
  async function receipt(actor, job, phase, attempt) {
    assert.deepEqual([actor,job,phase,attempt],["sato",id,"compose",key]);
    return {result:"matched",run_id:runId,session_id:session};
  }
  const read = async (actor,path,options) => {
    assert.equal(actor,"sato"); assert.equal(path,"/v1/runs/"+runId); assert.equal(options,undefined);
    return {run_id:runId,session_id:session,status:"completed",output:"棚卸しは12月4日。 [1]"};
  };
  for (const result of ["missing","ambiguous","expired","mismatch","unavailable"]) {
    let called = false;
    const res = await reconcileRun(hub.db,async()=>{called=true;},id,expected,"aoki",async()=>({result}));
    assert.equal(called,false); assert.equal(res.status,"unknown");
  }
  const wrongSession = await reconcileRun(hub.db,async()=>({run_id:runId,status:"completed",session_id:"other"}),
    id,expected,"aoki",receipt);
  assert.equal(wrongSession.status,"unknown");
  assert.equal(hub.get("sato",id).run_id,null);
  assert.equal(hub.db.prepare("SELECT hermes_run_id FROM attempts WHERE job_id=?").get(id).hermes_run_id,null);
  const results = await Promise.allSettled([1,2].map(()=>reconcileRun(hub.db,read,id,expected,"aoki",receipt)));
  assert.deepEqual(results.map(x=>x.value?.status || x.reason.status),["done",409]);
  assert.equal(hub.notifications("sato").length,1); assert.equal(hub.get("sato",id).run_id,runId);
  assert.equal(hub.db.prepare("SELECT hermes_run_id FROM attempts WHERE job_id=?").get(id).hermes_run_id,runId);
});
