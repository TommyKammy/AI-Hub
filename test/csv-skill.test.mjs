import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {openHub} from "../hub.mjs";
import {personalWork} from "../personal-work.mjs";
import {transfer} from "../memberships.mjs";
import {checkCsvColumns} from "../csv-skill.mjs";

const input={company:"A社",kind:"assistant",ask:"商品別の売上",contract:{name:"初月.csv",text:"商品,売上金額,区分\n旧商品,410,売上"}};
function setup(t) {
  const hub=openHub(":memory:"), personal=personalWork(hub);
  t.after(()=>hub.close());
  const source=hub.create("sato",input,randomUUID());
  hub.db.prepare("UPDATE jobs SET status='done',memo='合計410 [1]' WHERE id=?").run(source);
  const result={tool:"aggregate_csv",workflow:{name:"csv-summary"},conditions:["金額列　売上金額","グループ　商品","区分 が「返品」の行を除外"],evidence:[{source:1}]};
  hub.db.prepare("INSERT INTO work_tool_results(job,ticket,result) VALUES(?,?,?)").run(source,randomUUID(),JSON.stringify(result));
  const save={source_job:source,name:"集計"}, {id}=personal.saveTemplate("sato",save);
  assert.equal(personal.saveTemplate("sato",save).id,id);
  const payload={...input,csv_template_id:id,contract:{name:"次月.csv",text:"区分,売上金額,商品\n返品,50,新商品"}};
  return {hub,personal,id,source,payload};
}

test("既存の集計から条件のみ保存し、予約・再送・所属と所有者の境界を維持する",t=>{
  const {hub,personal,id,source,payload}=setup(t);
  const [template]=personal.overview("sato").templates;
  assert.equal(template.recipe.exclude_value,"返品");
  assert.ok(!JSON.stringify(template).includes("旧商品"));
  assert.throws(()=>personal.saveTemplate("tanaka",{source_job:source,name:"複製"}),{status:404});
  assert.throws(()=>hub.create("tanaka",{...payload,company:"B社"},randomUUID()),{status:404});
  assert.throws(()=>hub.create("sato",{...payload,contract:{name:"売上.csv",text:"商品,売上金額\n鉛筆,10"}},randomUUID()),/区分/);
  const key=randomUUID(), once={...payload,scheduled_at:Date.now()+3600000}, job=hub.create("sato",once,key);
  assert.equal(hub.get("sato",job).status,"scheduled");
  assert.equal(hub.get("sato",job).csv_skill.id,id);
  assert.equal(hub.create("sato",once,key),job);
  assert.throws(()=>hub.create("sato",{...once,csv_template_id:undefined},key),{status:409});
  transfer(hub.db,"sato",{base:1,team:"経理部",reason:"異動"},"aoki");
  assert.deepEqual(personal.overview("sato").templates,[]);
  assert.throws(()=>hub.get("sato",job),{status:404});
  assert.throws(()=>hub.create("sato",once,key),{status:404});
});

test("定期集計はその回の新規CSVだけを使い、期限の再チェックと翌月の未登録枠で再実行しない",t=>{
  const {hub,personal,id,payload}=setup(t);
  const schedule=personal.schedule("sato",{name:"月末集計",template_id:id,frequency:"monthly",weekday:0,time:"16:00"}).id;
  const next=personal.previewOccurrence("sato",schedule);
  assert.equal(next.csv,true);
  const change={slot:next.slot,revision:next.revision,action:"change",run_at:next.run_at,excluded:[],contract:payload.contract};
  personal.editOccurrence("sato",schedule,change);
  assert.throws(()=>personal.editOccurrence("sato",schedule,change),{status:409});
  personal.runDue(next.run_at); personal.runDue(next.run_at);
  const row=personal.overview("sato").schedules[0], job=hub.get("sato",row.last_job);
  assert.equal(job.sources[0].text,payload.contract.text);
  assert.equal(job.csv_skill.id,id);
  assert.equal(personal.previewOccurrence("sato",schedule).file,undefined);
  personal.runDue(row.next_run);
  assert.equal(hub.db.prepare("SELECT count(*) n FROM scheduled_jobs WHERE schedule=?").get(schedule).n,1);
});

test("列順・引用符・カンマを含む見出しを元の列名で照合する",()=>{
  assert.doesNotThrow(()=>checkCsvColumns('\uFEFF"区,分","金""額",商品\r\n販売,10,紙',{amount_column:'金"額',group_column:"商品",filter_column:"区,分"}));
  assert.throws(()=>checkCsvColumns("商品,商品,金額\n",{}),/重複/);
});
