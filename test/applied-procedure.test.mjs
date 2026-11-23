import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createWorker, openHub } from "../hub.mjs";
import { personalWork } from "../personal-work.mjs";
import { requireRevisionProcedure } from "../applied-procedure.mjs";

function completed(hub,actor,company) {
  const id=hub.create(actor,{kind:"assistant",company,ask:"見積を確認して",
    contract:{name:"甲.txt",text:"料金は100円。"},second_attachment:{name:"乙.txt",text:"料金は200円。"}},randomUUID());
  hub.db.prepare("UPDATE jobs SET status='done',memo=? WHERE id=?").run("料金を確認しました。 [1] [2]",id);
  return id;
}

test("本人用の手順を元の版に適用し、同じ受付キーで版を増やさない", async t=>{
  const hub=openHub(":memory:");
  t.after(()=>hub.close());
  const personal=personalWork(hub);
  const template=personal.saveTemplate("sato",{name:"比較の書き方",kind:"assistant",ask:"料金を先に比べる",output_format:"結論を短く"});
  const job=completed(hub,"sato","A社"), other=completed(hub,"tanaka","B社");
  const catalog_procedure={key:"personal:"+template.id,version:template.version};
  const input={base:1,latest:1,instruction:"同じ見積の要点を整理する",catalog_procedure};
  const key=randomUUID();
  assert.throws(()=>hub.revise("tanaka",other,input,randomUUID()),{status:404});
  assert.deepEqual(hub.revise("sato",job,input,key),{version:2});
  assert.deepEqual(hub.revise("sato",job,input,key),{version:2});
  assert.throws(()=>hub.revise("sato",job,{...input,standard_workflow:"quote-comparison",catalog_procedure:undefined},key),{status:409});
  assert.equal(requireRevisionProcedure(hub.db,"sato",job,"revise-2").output,"結論を短く");

  const worker=createWorker(hub.db,async (_actor,path,params)=>{
    if (path==="/v1/runs") {
      const sent=JSON.parse(params.body);
      assert.match(sent.input,/料金を先に比べる/);
      assert.match(sent.input,/結論を短く/);
      return {run_id:"fixture"};
    }
    return {status:"completed",output:"甲は100円です。 [1] 乙は200円です。 [2]"};
  });
  await worker();
  await worker();
  const revised=hub.get("sato",job);
  assert.equal(revised.status,"done");
  assert.deepEqual(revised.versions.map(item=>item.version),[1,2]);
  assert.equal(revised.versions[1].applied_procedure.key,catalog_procedure.key);
  assert.deepEqual(revised.sources.map(source=>source.title),["甲.txt","乙.txt"]);
});

test("共有手順の版を固定し、公開停止後は受付済みでも実行しない", async t=>{
  const hub=openHub(":memory:");
  t.after(()=>hub.close());
  const origin=completed(hub,"sato","A社"), job=completed(hub,"tanaka","B社");
  const id=randomUUID(), name="見積の料金を比べる", scope="営業企画部", layout="quote-comparison";
  const instruction=JSON.stringify({criteria:["料金"],rules:[]});
  const hash=createHash("sha256").update(JSON.stringify([name,scope,1,layout,instruction])).digest("hex");
  hub.db.prepare(`INSERT INTO procedures(id,source_job,author,scope,name,version,layout,instruction,hash,state)
    VALUES(?,?,'sato',?,?,1,?,?,?,'published')`).run(id,origin,scope,name,layout,instruction,hash);
  const procedure={key:"team:"+id,version:1};
  const input={base:1,latest:1,instruction:"公開版の条件で照合する",catalog_procedure:procedure};
  assert.throws(()=>hub.revise("tanaka",job,{...input,catalog_procedure:{...procedure,version:2}},randomUUID()),{status:409});
  assert.deepEqual(hub.revise("tanaka",job,input,randomUUID()),{version:2});
  const applied=requireRevisionProcedure(hub.db,"tanaka",job,"revise-2");
  assert.equal(applied.hash,hash);
  assert.deepEqual(applied.teamQuote.criteria,["料金"]);
  hub.db.prepare("UPDATE procedures SET revoked_at=? WHERE id=?").run(Date.now(),id);
  assert.throws(()=>requireRevisionProcedure(hub.db,"tanaka",job,"revise-2"),{status:423});
  let sends=0;
  await createWorker(hub.db,async()=>{sends++;})();
  assert.equal(sends,0);
  assert.equal(hub.get("tanaka",job).status,"procedure_revoked");
  assert.equal(hub.get("tanaka",job).versions.length,1);
});
