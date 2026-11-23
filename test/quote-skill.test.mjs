import test from "node:test";
import assert from "node:assert/strict";
import {openHub} from "../hub.mjs";

test("見積スキルの保存は採用版ごとに1件。失敗を再試行しても同じSKILL.mdを使う",t=>{
  const hub=openHub(":memory:");
  t.after(()=>hub.close());
  const request={kind:"assistant",company:"A社",ask:"2社の見積を比較して",
    contract:{name:"一社.txt",text:"月額100円"},second_attachment:{name:"二社.txt",text:"月額200円"}};
  const id=hub.create("sato",request,"quote-skill-original");
  hub.db.prepare("UPDATE jobs SET memo=?,status='done' WHERE id=?").run("金額 [1] [2]",id);
  hub.db.prepare("INSERT INTO work_tool_results(job,ticket,result) VALUES(?,?,?)").run(id,"first",JSON.stringify({tool:"compare_quotes"}));
  hub.revise("sato",id,{base:1,instruction:"保守費を比べる"},"quote-skill-revise");
  hub.db.prepare("UPDATE memo_versions SET memo=? WHERE job_id=? AND version=2").run("保守費 [1] [2]",id);
  hub.db.prepare("UPDATE jobs SET memo=?,status='done' WHERE id=?").run("保守費 [1] [2]",id);

  const row=()=>hub.db.prepare("SELECT * FROM quote_skills WHERE job=?").get(id);
  assert.throws(()=>hub.adopt("sato",id,1,2,true),{status:409});
  hub.adopt("sato",id,2,2,true);
  const original=row();
  hub.adopt("sato",id,2,2,true);
  assert.deepEqual(row(),original);
  assert.throws(()=>hub.adopt("sato",id,1,2),{status:409});
  assert.deepEqual(hub.quoteSkills("sato"),[]);
  hub.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(id);
  hub.adopt("sato",id,2,2,true);
  assert.equal(row().id,original.id);
  assert.notEqual(row().ticket,original.ticket);
  hub.db.prepare("UPDATE quote_skills SET criteria=?,hash=? WHERE id=?").run('["保守費"]',"a".repeat(64),original.id);
  hub.db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(id);
  hub.adopt("sato",id,2,2,true);
  assert.equal(hub.get("sato",id).status,"done");
  assert.equal(hub.quoteSkills("sato").length,1);
  const next={...request,quote_skill_id:original.id,contract:{name:"見積A.txt",text:"新しい保守費 [A]"},
    second_attachment:{name:"見積B.txt",text:"新しい保守費 [B]"}};
  const nextId=hub.create("sato",next,"quote-skill-repeat");
  assert.equal(hub.create("sato",next,"quote-skill-repeat"),nextId);
  assert.deepEqual(hub.get("sato",nextId).sources.map(s=>s.title),["見積A.txt","見積B.txt"]);
  assert.throws(()=>hub.create("sato",{...next,second_attachment:undefined},"quote-skill-incomplete"),{status:400});
  assert.throws(()=>hub.create("tanaka",{...next,company:"B社"},"quote-skill-foreign"),{status:404});
});
