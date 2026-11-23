import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHub, createWorker } from "../../src/jobs/hub.mjs";
import { personalWork } from "../../src/workspace/personal-work.mjs";
import { parseReservation, reservationPlans } from "../../src/jobs/reservation-plan.mjs";
import { groupWork } from "../../src/jobs/work-split.mjs";
import { measuredSend, modelForVersion } from "../../src/operations.mjs";
import { listLibraries } from "../../src/documents/libraries.mjs";
import { seedLegacyWorkspace } from "../support/legacy-workspace-fixture.mjs";

const date=value=>Date.parse(value+"+09:00");
function workspace(t) {
  const dir = process.env.AIHUB_VERIFY_LEGACY==="1" ? mkdtempSync(join(tmpdir(),"aihub-planning-legacy-")) : null;
  const path = dir ? join(dir,"hub.sqlite") : ":memory:";
  const legacy = dir && seedLegacyWorkspace(path);
  const hub = openHub(path);
  t.after(()=>{
    hub.close();
    if (dir) rmSync(dir,{recursive:true,force:true});
  });
  if (legacy) assert.equal(hub.get("sato",legacy).skill_version,1);
  return hub;
}
test("予約文の日本時間を確定し、同じ枠を二つの起動元で処理しても受付は1件",async t=>{
  const now=date("2028-02-25T17:03:00"),hub=workspace(t),{db}=hub;
  const personal=personalWork(hub), plans=reservationPlans(hub,personal);
  const examples=[
    ["明日午前9時に資料を整理する","2028-02-26T09:00:00","once"],
    ["平日17:00に資料を整理する","2028-02-28T17:00:00","weekdays"],
    ["毎週金曜日午後5時に週報を作る","2028-03-03T17:00:00","weekly"],
    ["月末18時半に月報を作る","2028-02-29T18:30:00","monthly"],
  ];
  for (const [text,expected,frequency] of examples) {
    const plan=plans.preview("sato",{text},now);
    assert.equal(plan.nextRun,date(expected));
    assert.equal(plan.frequency,frequency);
    assert.equal(plan.timezone,"Asia/Tokyo");
    const saved=plans.confirm("sato",{text,token:plan.token},now);
    assert.equal(saved.nextRun,plan.nextRun);
    assert.deepEqual(plans.confirm("sato",{text,token:plan.token},now),saved);
    if (saved.job) {
      assert.equal(hub.get("sato",saved.job).scheduled_at,date(expected));
      hub.cancel("sato",saved.job);
      await createWorker(db,assert.fail)();
      assert.equal(db.prepare("SELECT count(*) n FROM attempts WHERE job_id=?").get(saved.job).n,0);
    } else assert.equal(db.prepare("SELECT next_run FROM weekly_schedules WHERE id=?").get(saved.schedule).next_run,date(expected));
  }
  assert.throws(()=>parseReservation("毎週金曜の夕方に週報を作る",now),{code:"schedule_time_required"});
  assert.throws(()=>parseReservation("2028-02-30 17:00に資料を整理する",now),{status:400});
  const late=date("2028-03-09T16:00:00");
  personal.runDue(late); personalWork(hub).runDue(late);
  const rows=db.prepare("SELECT due FROM scheduled_jobs ORDER BY due").all();
  assert.deepEqual(rows.map(row=>row.due),[date("2028-02-29T18:30:00"),date("2028-03-03T17:00:00"),date("2028-03-08T17:00:00")]);
});

test("分担を上限内で独立実行し、部分集約と子作業だけの再実行を永続化する",async t=>{
  const hub=workspace(t),{db}=hub;
  const origin=hub.create("sato",{kind:"general",company:"A社",ask:"規程を照合する",
    contract:{name:"規程1.txt",text:"第1条。棚卸しは12月4日。"},minutes:"第2条。受付は17時まで。"},randomUUID());
  db.prepare("UPDATE jobs SET memo='規程の事実 [1] [2]',status='done' WHERE id=?").run(origin);
  const group=groupWork(hub), key=randomUUID();
  const config={origin,ask:"規程の結果をまとめる",maxParallel:2,maxRuns:3,maxCalls:12,
    parts:[{name:"第1条",instructions:"棚卸しの日付を調査",sourceIds:[1]},{name:"第2条",instructions:"受付の締切を点検",sourceIds:[2]}]};
  const {id}=group.create("sato",config,key);
  assert.equal(group.create("sato",config,key).id,id);
  assert.throws(()=>group.create("sato",{...config,maxCalls:13},key),{status:409});
  assert.throws(()=>group.create("tanaka",config,randomUUID()),{status:404});
  group.pump(); group.pump();
  const [one,two]=group.summary("sato",id).parts;
  const receipts=[], sends=new Map(), dispatchReads=new Map();
  const worker=createWorker(db,async(_actor,path,options)=>{
    if (!options) {
      const run=path.split("/").at(-1), sent=sends.get(run);
      const times=dispatchReads.get(run) ?? 0;
      dispatchReads.set(run,times+1);
      if (sent===one.current_job && times===0) return {status:"running"};
      if (sent===two.current_job) return {status:"completed",output:"無効な出典 [999]"};
      const job=hub.get("sato",sent);
      return {status:"completed",output:job.sources.map(source=>source.text+" ["+source.id+"]").join("\n")};
    }
    const phaseKey=options.headers["Idempotency-Key"], job=phaseKey.slice(0,-"-compose".length);
    const run=randomUUID();
    receipts.push(job);
    sends.set(run,job);
    return {run_id:run};
  });
  await worker();
  assert.deepEqual(receipts,[one.current_job,two.current_job]);
  assert.deepEqual(group.summary("sato",id).parts.map(row=>row.status),["running","running"]);
  await worker();
  assert.deepEqual(group.summary("sato",id).parts.map(row=>row.status),["running","failed"]);
  await worker();
  assert.equal(group.summary("sato",id).parts[0].status,"done");
  assert.deepEqual(hub.get("sato",one.current_job).sources.map(source=>source.text),["第1条。棚卸しは12月4日。"]);
  group.acceptPartial("sato",id);
  await worker(); await worker();
  assert.equal(hub.get("sato",id).status,"done");
  assert.equal(group.summary("sato",id).aggregate,"partial");
  assert.equal(hub.get("sato",id).sources[0].job,one.current_job);
  group.retry("sato",id,2,1);
  assert.throws(()=>group.retry("sato",id,2,1),{status:409});
  group.pump();
  const retry=group.summary("sato",id).parts[1].current_job;
  assert.notEqual(retry,two.current_job);
  await worker(); await worker();
  assert.deepEqual(receipts,[one.current_job,two.current_job,id,retry]);
  assert.equal(group.summary("sato",id).parts[1].status,"done");
  assert.equal(group.create("sato",config,key).id,id);
  assert.throws(()=>hub.get("tanaka",retry),{status:404});
});

test("一つの親に属する子作業でモデル呼び出し枠を共有する",async t=>{
  const hub=openHub(":memory:"),{db}=hub;
  t.after(()=>hub.close());
  const source=hub.create("sato",{kind:"general",company:"A社",ask:"例の資料"},randomUUID());
  db.prepare("UPDATE jobs SET status='done',memo='例の資料 [1]' WHERE id=?").run(source);
  const split=groupWork(hub);
  const parent=split.create("sato",{origin:source,ask:"資料をまとめる",maxParallel:2,maxRuns:2,maxCalls:3,
    parts:[{name:"確認",instructions:"期限を確認する"},{name:"点検",instructions:"不明点を確認する"}]},randomUUID()).id;
  split.pump();
  const [first,second]=split.summary("sato",parent).parts;
  const model=modelForVersion(db,1);
  let sent=0;
  const send=async()=>{
    sent++;
    return Response.json({model:model.model_id,usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
  };
  const context=id=>({job:id,actor:"sato",phase:"compose",version:1});
  for (const id of [first.current_job,second.current_job,first.current_job])
    await (await measuredSend(db,model,context(id),{},send)).text();
  await assert.rejects(measuredSend(db,model,context(second.current_job),{},assert.fail),{status:423});
  assert.equal(sent,3);
  const blocked=db.prepare("SELECT outcome,block_reason FROM model_calls ORDER BY seq DESC LIMIT 1").get();
  assert.equal(blocked.outcome,"blocked");
  assert.match(blocked.block_reason,/作業分担のモデル呼び出し上限/);
});

test("予約した月報は対象期間と元の仕事の採用版を記録する",t=>{
  const hub=openHub(":memory:"),{db}=hub;
  t.after(()=>hub.close());
  const personal=personalWork(hub), plans=reservationPlans(hub,personal);
  const now=date("2028-02-25T09:00:00"), text="月末17時に月報を作る";
  const preview=plans.preview("sato",{text},now);
  const move=hub.create("sato",{kind:"general",company:"A社",ask:"2月の状況を確認する"},randomUUID());
  db.prepare("UPDATE jobs SET created=?,memo='月内の状況 [1]',status='done',adopted_version=2 WHERE id=?")
    .run(date("2028-02-10T15:00:00"),move);
  db.prepare("UPDATE job_notifications SET created=? WHERE job=?").run(date("2028-02-10T15:05:00"),move);
  db.prepare("INSERT INTO memo_versions(job_id,version,memo) VALUES(?,1,'当初の状況 [1]'),(?,2,'採用済みの状況 [1]')")
    .run(move,move);
  const accepted=plans.confirm("sato",{text,token:preview.token},now);
  personal.runDue(preview.nextRun+500);
  const {last_job}=db.prepare("SELECT last_job FROM weekly_schedules WHERE id=?").get(accepted.schedule);
  const details=personal.reservationDetails(last_job);
  assert.equal(details.timezone,"Asia/Tokyo");
  assert.equal(details.period_to,preview.nextRun);
  assert.equal(details.period_from,preview.nextRun-30*86400000+1);
  const report=hub.get("sato",last_job);
  assert.deepEqual(report.sources.map(source=>[source.job,source.memo_version,source.text]),[[move,2,"採用済みの状況 [1]"]]);
});

test("同じ資料置き場で原文が個別失効すると分担・子成果物・部分集約・再実行を拒否する",async t=>{
  const root=mkdtempSync(join(tmpdir(),"aihub-split-source-")), folder=join(root,"shared","合成規程");
  const previous=process.env.LIBRARY_ROOT;
  process.env.LIBRARY_ROOT=root;
  t.after(()=>{
    if (previous===undefined) delete process.env.LIBRARY_ROOT;
    else process.env.LIBRARY_ROOT=previous;
    rmSync(root,{recursive:true,force:true});
  });
  mkdirSync(folder,{recursive:true});
  const primary=join(folder,"旧原文.txt"), remaining=join(folder,"別資料.txt");
  writeFileSync(primary,"失効する条文の本文。");
  writeFileSync(remaining,"公開中の別資料。");
  const hub=workspace(t),{db}=hub;
  const origin=hub.create("sato",{kind:"assistant",company:"A社",ask:"規程の調査",library_ids:["shared/合成規程"]},randomUUID());
  db.prepare("UPDATE jobs SET status='done',memo='表示可能な成果物 [1]',sources_json=? WHERE id=?").run(JSON.stringify([
    {id:1,title:"旧原文.txt",version:"検索時の版",text:"失効する条文の本文。",library:"shared/合成規程"},
  ]),origin);
  const group=groupWork(hub);
  const parent=group.create("sato",{origin,ask:"規程を分担する",maxParallel:2,maxRuns:3,maxCalls:9,
    parts:[{name:"調査",instructions:"条文を確認する"},{name:"点検",instructions:"未確認事項を挙げる"}]},randomUUID()).id;
  group.pump();
  const [completed,failed]=group.summary("sato",parent).parts;
  db.prepare("UPDATE jobs SET status='done',memo='失効する条文の要約 [1]' WHERE id=?").run(completed.current_job);
  db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(failed.current_job);
  assert.match(group.summary("sato",parent).parts[0].summary,/失効する条文/);
  assert.match(hub.get("sato",completed.current_job).sources[0].text,/失効する条文/);
  rmSync(primary);
  for (const afterReplacement of [false,true]) {
    if (afterReplacement) writeFileSync(primary,"別版に置き換えられた条文。");
    assert.equal(listLibraries({actor:"sato",team:"営業企画部"},{db})[0].id,"shared/合成規程");
    assert.throws(()=>group.summary("sato",parent),{status:404});
    assert.throws(()=>hub.get("sato",parent),{status:404});
    assert.throws(()=>hub.get("sato",completed.current_job),{status:404});
    assert.throws(()=>hub.get("sato",failed.current_job),{status:404});
    assert.throws(()=>group.acceptPartial("sato",parent),{status:404});
    assert.throws(()=>group.retry("sato",parent,2,1),{status:404});
    group.pump();
    await createWorker(db,assert.fail)();
  }
  assert.equal(db.prepare("SELECT count(*) n FROM attempts WHERE job_id IN (SELECT job FROM split_runs WHERE parent=?)").get(parent).n,0);
});
