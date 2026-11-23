import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openHub,createWorker} from "../hub.mjs";
import {personalWork} from "../personal-work.mjs";

function setup(t) {
  const hub=openHub(":memory:"); t.after(()=>hub.close());
  return {hub,work:personalWork(hub)};
}
function completed(hub,kind,text,actor="sato") {
  const id=hub.create(actor,{company:actor==="sato"?"A社":"B社",kind,minutes:text,ask:text.slice(0,80)},randomUUID());
  hub.db.prepare("UPDATE jobs SET status='done',memo=? WHERE id=?").run(text,id);
  return id;
}
function worker(hub,output,posts=[]) {
  return createWorker(hub.db,async(actor,path,options)=>{
    if(options){posts.push(options.headers["Idempotency-Key"]); return {run_id:"run-"+posts.length};}
    return {status:"completed",output};
  });
}
test("宿題候補を版に固定し、引用を検証して選択分を原子的に登録する",async t=>{
  const {hub,work}=setup(t),quote="宿題は田中が見積を提出する。",id=completed(hub,"meeting",quote);
  const key=randomUUID(),posts=[];
  hub.extractActions("sato",id,1,key); hub.extractActions("sato",id,1,randomUUID());
  const tick=worker(hub,JSON.stringify([{line:1,source:1,quote,assignee:"田中",due:"2026-12-01"}]),posts);
  await tick();await tick();
  assert.equal(hub.get("sato",id).candidate_sets[0].items[0].due_text,"");
  hub.extractActions("sato",id,1,randomUUID());await tick();assert.equal(posts.length,1);
  const input={version:1,items:[{index:0,assignee:"田中",due:""}]};
  assert.throws(()=>work.registerCandidates("sato",id,{...input,items:[...input.items,{index:8}]}),{status:400});
  assert.equal(work.overview("sato").actions.length,0);
  work.registerCandidates("sato",id,input);work.registerCandidates("sato",id,input);
  assert.equal(work.overview("sato").actions.length,1);
  assert.throws(()=>work.registerCandidates("tanaka",id,input),{status:404});
  const other=completed(hub,"meeting","別の会議");hub.extractActions("sato",other,1,randomUUID());await tick();await tick();
  assert.equal(hub.get("sato",other).status,"failed");assert.deepEqual(hub.get("sato",other).candidate_sets,[]);
});
test("案件に登録した仕事・資料・未完了の宿題だけを本人の所属内で表示する",t=>{
  const {hub,work}=setup(t),id=completed(hub,"meeting","決定事項\n9月8日と決定。\n見積を提出する。");
  const p=work.fileInProject("sato",id,{name:"青葉"});
  work.fileInProject("sato",id,{project:p.id});work.trackAction("sato",id,{line:"見積を提出する。",version:1,assignee:"佐藤",due:"2026-12-01"});
  const view=work.project("sato",p.id);assert.equal(view.jobs.length,1);assert.equal(view.actions.length,1);
  assert.ok(view.jobs[0].sources.length);
  const foreign=completed(hub,"weekly","別社員の報告","tanaka");
  assert.throws(()=>work.fileInProject("tanaka",foreign,{project:p.id}),{status:404});
  assert.throws(()=>work.project("tanaka",p.id),{status:404});
  work.completeAction("sato",view.actions[0].id,true);assert.equal(work.project("sato",p.id).actions.length,0);
});
test("次回の除外と移動を再起動後も守り、翌週は元の日時と資料条件を使う",t=>{
  const dir=mkdtempSync(join(tmpdir(),"hub-next-slot-")),file=join(dir,"hub.sqlite");
  let hub=openHub(file),work=personalWork(hub);t.after(()=>{hub.close();rmSync(dir,{recursive:true,force:true});});
  const now=Date.parse("2026-11-23T09:00+09:00"),day=86400000;
  const s=work.schedule("sato",{name:"金曜",ask:"週報",weekday:5,time:"09:00"},now);
  const keep=completed(hub,"meeting","青葉の見積を確認"),exclude=completed(hub,"meeting","赤坂の作業を確認");
  const original=work.previewOccurrence("sato",s.id);
  const move={action:"change",slot:original.slot,revision:0,run_at:original.slot+day,excluded:[exclude]};
  // Both original and following weekly source windows can contain these jobs when their completion timestamps differ.
  hub.db.prepare("UPDATE job_notifications SET created=?").run(original.slot-1000);
  work.editOccurrence("sato",s.id,move,now);
  assert.throws(()=>work.editOccurrence("sato",s.id,move,now),{status:409});
  assert.throws(()=>work.previewOccurrence("tanaka",s.id),{status:404});
  hub.close();hub=openHub(file);work=personalWork(hub);
  work.runDue(original.slot);assert.equal(work.overview("sato").schedules[0].last_job,null);
  work.runDue(move.run_at);work.runDue(move.run_at);
  const j=hub.get("sato",work.overview("sato").schedules[0].last_job);
  assert.match(j.sources[0].text,/青葉/);assert.doesNotMatch(j.sources[0].text,/赤坂/);
  const normal=work.previewOccurrence("sato",s.id);assert.equal(normal.slot,original.slot+7*day);assert.deepEqual(normal.excluded,[]);
  hub.db.prepare("UPDATE job_notifications SET created=? WHERE job IN (?,?)").run(normal.slot-1000,keep,exclude);
  work.runDue(normal.slot);
  assert.match(hub.get("sato",work.overview("sato").schedules[0].last_job).sources[0].text,/赤坂/);
  const third=work.previewOccurrence("sato",s.id);work.editOccurrence("sato",s.id,{...third,action:"skip"},normal.slot);
  work.runDue(third.slot);assert.equal(hub.db.prepare("SELECT count(*) n FROM scheduled_jobs").get().n,2);
});
test("部分修正は重複段落の選択位置だけを更新する。別の出典を返した場合は元版を保つ",async t=>{
  const {hub}=setup(t),original="初日 [1]\n\n連絡する [1]\n連絡する [1]";
  const id=completed(hub,"meeting",original), edit={base:1,latest:1,line_index:3,instruction:"丁寧に"};
  const key=randomUUID();hub.revise("sato",id,edit,key);
  assert.throws(()=>hub.revise("sato",id,{...edit,line_index:2},key),{status:409});
  const tick=worker(hub,"ご連絡します");await tick();await tick();
  const j=hub.get("sato",id);assert.equal(j.adopted_version,1);
  assert.equal(j.memo,"初日 [1]\n\n連絡する [1]\nご連絡します [1]");
  hub.revise("sato",id,{...edit,latest:2},randomUUID());const invalid=worker(hub,"出典を変更 [2]");await invalid();await invalid();
  assert.equal(hub.get("sato",id).versions.length,2);
});
test("前回比較は前回・今回の選択版を固定し他人の報告を拒否する",t=>{
  const {hub}=setup(t),first=completed(hub,"weekly","前回"),second=completed(hub,"weekly","今回"),key=randomUUID();
  const job={kind:"weekly",company:"A社",ask:"報告の変化",report_diff:true,work_refs:[first,second].map(job=>({job,version:1}))};
  const id=hub.create("sato",job,key);
  assert.deepEqual(hub.get("sato",id).sources.map(s=>[s.period,s.job,s.text]),[["前回",first,"前回"],["今回",second,"今回"]]);
  assert.throws(()=>hub.create("sato",{...job,report_diff:false},key),{status:409});
  const foreign=completed(hub,"weekly","別社員","tanaka");
  assert.throws(()=>hub.create("sato",{...job,work_refs:[job.work_refs[0],{job:foreign,version:1}]},randomUUID()),{status:404});
});
