import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { transfer } from "../../src/identity/memberships.mjs";
import { draftFromScreenshot } from "../../src/inquiries/inquiry-screenshot.mjs";
import { receivedInquiries, recordInquiryReview, registerInquiry } from "../../src/inquiries/inquiries.mjs";
import { openHub } from "../../src/jobs/hub.mjs";
import { connections, publish, register } from "../../src/models/catalog.mjs";
import { changeUsagePolicy, restrictedSynthetic, usagePolicy } from "../../src/models/usage-policy.mjs";
import { setStopped } from "../../src/operations.mjs";

const modelId = "qwen3.8-flash-next";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBCsAAAAASUVORK5CYII=", "base64");
const body = "【画像から読み取った表示】\nUpload failed\n\n【ご自身が行った操作】\n画面を開いた。";
const ticket = {version:1,desk:"operations",recipient:"tanaka",subject:"合成検証",body,attachments:[]};
const imageReply = () => Response.json({model:modelId,choices:[{message:{content:"Upload failed"}}]});

function setup(t) {
  const hub = openHub(":memory:"), {db} = hub, original = connections["local-mlx"];
  connections["local-mlx"] = {name:"Fixture",url:"http://invalid.test/v1"};
  t.after(() => {
    if (original) connections["local-mlx"] = original;
    else delete connections["local-mlx"];
    hub.close();
  });
  const model = register(db,{connection:"local-mlx",name:"Fixture image model",model_id:modelId,data_class:"合成資料"},"aoki");
  db.prepare("UPDATE models SET probe='passed' WHERE id=?").run(model);
  publish(db,model,1,"aoki","使い捨て環境の試験モデル");
  const job = hub.create("sato",{kind:"general",company:"A社",ask:"合成依頼の原文"},randomUUID());
  db.prepare("UPDATE jobs SET status='done',memo=? WHERE id=?").run("合成依頼の成果物",job);
  db.prepare("INSERT INTO inquiry_drafts(job,version,phase,result) VALUES(?,1,?,?)")
    .run(job,"inquiry-"+randomUUID(),JSON.stringify({subject:"合成案",body:"合成案の本文",attachments:[]}));
  return {hub,db,model,job,analyze:send=>draftFromScreenshot(hub,"sato",job,1,"image/png",png,send)};
}

test("画像推論中の所属変更で結果を返さず、画像だけを指定モデルに送る", async t => {
  const {db,analyze,job} = setup(t);
  const pending = analyze(async (model,payload,headers) => {
    assert.equal(model.model_id,modelId);
    assert.equal(headers["X-Hub-Job"],job);
    assert.equal(payload.generation_mode,"mtp");
    assert.match(JSON.stringify(payload),/data:image\/png;base64,/);
    assert.doesNotMatch(JSON.stringify(payload),/合成依頼の原文|合成依頼の成果物|合成案の本文/);
    transfer(db,"sato",{base:1,team:"異動先",reason:"推論中の異動"},"aoki");
    return imageReply();
  });
  await assert.rejects(pending,{status:409});
  assert.equal(db.prepare("SELECT screenshot_review_required FROM inquiry_drafts WHERE job=?").get(job).screenshot_review_required,0);
  assert.deepEqual(receivedInquiries(db,"tanaka"),[]);
});

test("画像起票の確認後に起票者が異動すると、確認済みの文章を送信できない", async t => {
  const {hub,db,analyze,job} = setup(t);
  assert.deepEqual(await analyze(imageReply),{findings:"Upload failed"});
  const {seq} = recordInquiryReview(hub,"sato",job,{...ticket,action:"preview",expected:0});
  assert.throws(()=>registerInquiry(hub,"sato",job,{...ticket,body:body+"追記",review_seq:seq}),{status:409});
  transfer(db,"sato",{base:1,team:"異動先",reason:"確認後の異動"},"aoki");
  assert.throws(()=>registerInquiry(hub,"sato",job,{...ticket,review_seq:seq}),{status:403});
  assert.deepEqual(receivedInquiries(db,"tanaka"),[]);
});

test("画像推論は送信時の限定資料の許可と予算・モデル停止を確認する", async t => {
  const {db,model,job,analyze} = setup(t);
  const publishPolicy = settings => changeUsagePolicy(db,{base:usagePolicy(db).version,reason:"画像推論の許可を検証",settings},
    "publish","aoki",Object.keys(connections));
  const initial = usagePolicy(db).settings;
  publishPolicy({...initial,restricted:{...initial.restricted,enabled:false}});
  await assert.rejects(analyze(assert.fail),{status:422});
  publishPolicy({...initial,budget:{limit:1,threshold:50},rates:[{model,input:100,output:100,reserve:2}]});
  await assert.rejects(analyze(assert.fail),{status:423});
  assert.equal(db.prepare("SELECT data_class FROM model_calls WHERE job=?").get(job).data_class,restrictedSynthetic);
  publishPolicy(initial);
  setStopped(db,model,{generation:0,reason:"画像対応モデルの停止"},true,"aoki");
  await assert.rejects(analyze(assert.fail),{status:422});
});
