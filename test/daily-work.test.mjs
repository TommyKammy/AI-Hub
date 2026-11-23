import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHub, createWorker } from "../hub.mjs";
import { personalWork } from "../personal-work.mjs";
import { transfer } from "../memberships.mjs";

function setup(t) {
  const hub = openHub(":memory:");
  t.after(() => hub.close());
  return {hub,personal:personalWork(hub)};
}
const work = {company:"A社",kind:"meeting",ask:"会議の決定事項",minutes:"8月1日納品。"};
const jobKey = () => randomUUID();
test("2件目の見積と資料順を保持し、同一キーでの差し替えを拒否する",t=>{
  const {hub}=setup(t), key=jobKey();
  const input={company:"A社",kind:"assistant",ask:"比較して",contract:{name:"甲",text:"税抜10円"},
    second_attachment:{name:"乙",text:"税込11円"},minutes:"見積有効期限も比較"};
  const id=hub.create("sato",input,key);
  assert.deepEqual(hub.get("sato",id).sources.map(s=>[s.id,s.text]),[[1,"税抜10円"],[2,"税込11円"],[3,"見積有効期限も比較"]]);
  assert.equal(hub.create("sato",input,key),id);
  assert.throws(()=>hub.create("sato",{...input,second_attachment:undefined},key),{status:409});
  assert.throws(()=>hub.create("sato",{...input,second_attachment:{name:"乙",text:"税込12円"}},key),{status:409});
  assert.throws(()=>hub.create("sato",{...input,kind:"meeting"},jobKey()),{status:400});
});
function finish(hub,input=work,actor="sato") {
  const id = hub.create(actor,input,jobKey());
  hub.db.prepare("UPDATE jobs SET status='done',memo=? WHERE id=?").run(input.minutes + " [1]",id);
  return id;
}
test("予約キーの再送は日時変更後も同一の仕事。競合・開始前・異動後の送信を防ぐ",async t=>{
  const {hub} = setup(t), due = Date.now()+60000, key=jobKey(), payload={...work,scheduled_at:due};
  const id=hub.create("sato",payload,key), change={previous_at:due,scheduled_at:due+60000};
  assert.throws(()=>hub.reschedule("tanaka",id,change),{status:404});
  hub.reschedule("sato",id,change); hub.reschedule("sato",id,change);
  assert.throws(()=>hub.reschedule("sato",id,{...change,scheduled_at:due+90000}),{status:409});
  assert.equal(hub.create("sato",payload,key),id);
  assert.throws(()=>hub.create("sato",{...payload,scheduled_at:due+1},key),{status:409});
  assert.throws(()=>hub.create("sato",{...work,scheduled_at:Date.now()-1},jobKey()),{status:400});
  const tick=createWorker(hub.db,()=>assert.fail("early dispatch")); await tick();
  assert.equal(hub.get("sato",id).status,"scheduled");
  transfer(hub.db,"sato",{base:1,team:"営業二部",reason:"異動"},"aoki"); await tick();
  assert.equal(hub.get("sato",id).status,"membership_blocked");
  assert.equal(hub.db.prepare("SELECT count(*) n FROM attempts").get().n,0);
});
test("Hub停止中に時刻を過ぎた予約は、同じ仕事を一度だけ開始し受付後の再起動で結果を取得する",async t => {
  const now = Date.now(), when = now+60000;
  t.mock.timers.enable({apis:["Date"],now});
  const dir = mkdtempSync(join(tmpdir(),"hub-reservation-")), file = join(dir,"hub.sqlite");
  let hub = openHub(file);
  t.after(() => { hub.close(); rmSync(dir,{recursive:true,force:true}); });
  const input = {...work,scheduled_at:when}, key = jobKey(), id = hub.create("sato",input,key);
  hub.close();
  t.mock.timers.setTime(when+90000);
  hub = openHub(file);
  assert.equal(hub.create("sato",input,key),id);
  const sends = [];
  const call = async (actor,path,options) => {
    if (options?.method === "POST") { sends.push(options.headers["Idempotency-Key"]); return {run_id:"reserved-run"}; }
    assert.ok(path.endsWith("reserved-run"));
    return {status:"completed",output:"納品日は8月1日。 [1]"};
  };
  await createWorker(hub.db,call)();
  hub.close(); hub=openHub(file);
  const tick = createWorker(hub.db,call);
  await Promise.all([tick(),tick()]);
  await tick();
  assert.deepEqual(sends,[id+"-compose"]);
  assert.equal(hub.get("sato",id).sources[0].text,work.minutes);
  assert.equal(hub.get("sato",id).status,"done");
  assert.equal(hub.notifications("sato").length,1);
});
test("同時に編集した下書きと二重送信。確定時だけ依頼を作る",t=>{
  const {hub,personal}=setup(t),id=jobKey(),content={ask:"",minutes:"議事録だけ",kind:"meeting"};
  const saved=personal.saveDraft("sato",id,{revision:0,content});
  assert.deepEqual(personal.saveDraft("sato",id,{revision:0,content}),saved);
  assert.equal(hub.list("sato").length,0);
  assert.throws(()=>personal.readDraft("tanaka",id),{status:404});
  personal.saveDraft("sato",id,{revision:1,content:{...content,ask:"追記"}});
  assert.throws(()=>personal.saveDraft("sato",id,{revision:1,content}),{status:409});
  assert.throws(()=>personal.submitDraft("sato",{...work,draft_id:id,draft_revision:1}),{status:409});
  const input={...work,draft_id:id,draft_revision:2};
  const job=personal.submitDraft("sato",input);
  assert.equal(personal.submitDraft("sato",input),job);
  assert.equal(personal.overview("sato").drafts.length,0);
  assert.equal(hub.list("sato").length,1);
});
test("完了版の出典、閲覧済み、宿題は元の仕事と版に対応する",t=>{
  const {hub,personal}=setup(t), first=finish(hub), second=finish(hub,{...work,minutes:"提出期限は7月3日。"});
  const foreign=finish(hub,{...work,company:"B社"},"tanaka");
  const refs=[first,second].map(job=>({job,version:1}));
  const input={kind:"general",company:"A社",ask:"合算",work_refs:refs},key=jobKey();
  const id=hub.create("sato",input,key);
  assert.equal(hub.create("sato",input,key),id);
  assert.deepEqual(hub.get("sato",id).sources.map(s=>s.job),[first,second]);
  assert.throws(()=>hub.create("sato",{...input,work_refs:[{job:foreign,version:1}]},jobKey()),{status:404});
  const original=hub.list("sato").find(j=>j.id===first);
  assert.ok(original.done_seq>original.viewed_seq);
  hub.viewed("sato",first,original.done_seq);
  assert.equal(hub.list("sato").find(j=>j.id===first).viewed_seq,original.done_seq);
  const args={version:1,line:work.minutes+" [1]",assignee:"田中",due:"2028-02-29"};
  assert.throws(()=>personal.trackAction("sato",first,{...args,due:"2027-02-29"}),{status:400});
  personal.trackAction("sato",first,args); personal.trackAction("sato",first,args);
  const actions=personal.overview("sato").actions;
  assert.equal(actions.length,1);
  assert.throws(()=>personal.completeAction("tanaka",actions[0].id,true),{status:404});
  personal.completeAction("sato",actions[0].id,true);
  assert.equal(personal.overview("sato").actions[0].done,1);
});
test("再通知は指定時刻に1回。先に回答した質問は通知しない",t=>{
  const {hub}=setup(t), due=Date.now()+60000;
  const waiting=()=>{ const id=hub.create("sato",{company:"A社",ask:"更新日"},jobKey());
    hub.db.prepare("UPDATE jobs SET status='waiting',question='いつ？' WHERE id=?").run(id); return id; };
  const first=waiting(), answered=waiting();
  for(const id of [first,answered]) hub.remind("sato",id,due);
  hub.answer("sato",answered,{answer:"確認済み"});
  hub.sendReminders(due-1); assert.equal(hub.notifications("sato").filter(n=>n.status==="reminder").length,0);
  hub.sendReminders(due); hub.sendReminders(due+1);
  assert.deepEqual(hub.notifications("sato").filter(n=>n.status==="reminder").map(n=>n.job),[first]);
});
test("月末の個人手順は対象期間・種類に一致する本人の記録だけで期限超過を1回処理",t=>{
  const {hub,personal}=setup(t);
  const time=s=>Date.parse(s+"+09:00");
  const template=personal.saveTemplate("sato",{name:"月末レビュー",kind:"general",ask:"決定を振り返る",output_format:"箇条書き"});
  const cfg={name:"月末",template_id:template.id,weekday:0,time:"16:00",frequency:"monthly",month_day:0,window_days:30,source_kind:"meeting"};
  assert.throws(()=>personal.schedule("tanaka",cfg),{status:404});
  personal.schedule("sato",cfg,time("2028-01-01T12:00"));
  for(const [text,kind,date] of [["今月の決定","meeting","2028-02-15T15:30"],["過去分","meeting","2027-12-01T15:30"],["除外対象","weekly","2028-02-14T15:00"]]){
    const id=finish(hub,{...work,minutes:text,kind});
    hub.db.prepare("UPDATE job_notifications SET created=? WHERE job=?").run(time(date),id);
  }
  const now=time("2028-03-03T16:00"); personal.runDue(now); personal.runDue(now);
  const schedule=personal.overview("sato").schedules[0], j=hub.get("sato",schedule.last_job);
  assert.equal(j.kind,"general");assert.equal(j.output_format,"箇条書き");
  assert.match(j.sources[0].text,/今月の決定/);assert.doesNotMatch(j.sources[0].text,/過去分|除外対象/);
  assert.equal(schedule.next_run,time("2028-03-31T16:00"));
  assert.equal(hub.db.prepare("SELECT due FROM scheduled_jobs").get().due,time("2028-02-29T16:00"));
});
