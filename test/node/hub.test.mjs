import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHub, createWorker, HubError, skill } from "../../src/jobs/hub.mjs";

function setup(t) {
  const hub = openHub(":memory:");
  t.after(() => hub.close());
  const input = { company: "A社", ask: "更新商談を準備して" };
  const key = "synthetic-key-01";
  return { hub, input, key, id: hub.create("sato", input, key) };
}
test("同じ依頼の再送は同一ID、内容変更と他人の案件・仕事は拒否する", (t) => {
  const { hub, input, key, id } = setup(t);
  assert.equal(hub.create("sato", input, key), id);
  assert.throws(() => hub.create("sato", { ...input, ask: "変更" }, key), {
    status: 409,
  });
  assert.throws(() => hub.create("tanaka", input, key), { status: 403 });
  assert.throws(() => hub.answer("tanaka", id, { answer: "設定" }), {
    status: 404,
  });
  assert.throws(() => hub.get("tanaka", id), { status: 404 });
  assert.deepEqual(hub.list("tanaka"), []);
});
test("依頼と回答を別の冪等キーで一度ずつ送り、根拠・公開版・実行IDを対応づける", async (t) => {
  const { hub, id } = setup(t);
  const posts = [];
  const call = async (actor, path, options) => {
    assert.equal(actor, "sato");
    if (options) {
      const body = JSON.parse(options.body);
      posts.push(options.headers["Idempotency-Key"]);
      assert.match(body.input, /12月31日/);
      assert.doesNotMatch(body.input, /調達部/);
      return { run_id: "r" + posts.length };
    }
    return {
      status: "completed",
      output: path.endsWith("r1") ? "いつですか？" : "未確定 [1] [2]",
    };
  };
  const tick = createWorker(hub.db, call);
  await Promise.all([tick(), tick()]);
  await tick();
  assert.equal(hub.get("sato", id).status, "waiting");
  hub.answer("sato", id, { answer: "未確定" });
  hub.answer("sato", id, { answer: "未確定" });
  assert.throws(() => hub.answer("sato", id, { answer: "別の回答" }), {
    status: 409,
  });
  await tick();
  await tick();
  assert.equal(hub.get("sato", id).memo, "未確定 [1] [2]");
  assert.equal(hub.get("sato", id).skill_hash, skill.hash);
  assert.deepEqual(posts, [id + "-review", id + "-draft"]);
  assert.deepEqual(
    hub.db
      .prepare(
        "SELECT hermes_run_id FROM attempts ORDER BY dispatch_time,rowid",
      )
      .all()
      .map((x) => x.hermes_run_id),
    ["r1", "r2"],
  );
});
test("プロフィール更新はツールの保存記録で判定し、最後の応答だけが途切れても保存済みと表示する", async t => {
  const hub = openHub(":memory:");
  t.after(() => hub.close());
  const input = {kind:"assistant", company:"A社", ask:"次回から結論を先に書いて"};
  for (const saved of [false,true]) {
    const id = hub.create("sato", input, "profile-check-"+saved);
    const tick = createWorker(hub.db, async (_actor, _path, options) => {
      if (options) return {run_id:"profile-"+id};
      return saved ? {status:"interrupted"} : {status:"completed",output:"希望を保存しました。"};
    });
    await tick();
    if (saved) hub.db.prepare("UPDATE work_tool_results SET profile_saved=1 WHERE job=?").run(id);
    await tick();
    assert.equal(hub.get("sato",id).status,saved ? "done" : "failed");
  }
});

test("資料と旧版だけに残った言葉でも本人の仕事を検索できる", t => {
  const {hub,id} = setup(t);
  hub.db.prepare("UPDATE jobs SET sources_json=?,memo=? WHERE id=?").run(
    JSON.stringify([{id:1,title:"西支店の在庫表",text:"帳票IDはA_10%。"}]), "最新版", id);
  hub.db.prepare("INSERT INTO memo_versions(job_id,version,memo) VALUES(?,1,?)").run(id,"在庫の旧集計");
  for (const term of ["西支店","a_10%","旧集計"]) {
    assert.deepEqual(hub.search("sato",term).map(job => job.id),[id]);
    assert.deepEqual(hub.search("tanaka",term),[]);
  }
});

test("検証済みの出典箇所IDだけを社員に見せる資料番号へ変換する", async t => {
  const hub = openHub(":memory:");
  t.after(()=>hub.close());
  const input = {kind:"assistant",company:"A社",ask:"出張取消の提出物を確認",
    contract:{name:"旅費規程.md",text:"第4条　日当を支給する。\n第8条　領収書と承認記録を提出する。"}};
  for (const sample of [
    {key:"known-passage-1",output:"領収書と承認記録を提出します [1.2]。",expected:"done"},
    {key:"unknown-passage-1",output:"別の提出物が必要です [1] [1.3]。",expected:"failed"},
  ]) {
    const id = hub.create("sato",input,sample.key);
    const tick = createWorker(hub.db,async (_actor,_path,options)=>options
      ? {run_id:"checked-"+id} : {status:"completed",output:sample.output});
    await tick();
    const evidence = [{ref:"1.2",source:1,text:"第8条　領収書と承認記録を提出する。"}];
    hub.db.prepare("UPDATE work_tool_results SET result=? WHERE job=?")
      .run(JSON.stringify({tool:"read_passages",evidence}),id);
    await tick();
    const job = hub.get("sato",id);
    assert.equal(job.status,sample.expected);
    assert.equal(job.memo,sample.expected==="done" ? "領収書と承認記録を提出します [1]。" : null);
  }
});

test("依頼本文を資料にした週報にも有効な出典番号を求める", async t => {
  const hub = openHub(":memory:");
  t.after(() => hub.close());
  const ask = "棚卸しが完了したので週報にまとめて。";
  const input = { kind: "weekly", company: "A社", ask };
  const id = hub.create("sato", input, "weekly-inline-key");
  const [source] = hub.get("sato", id).sources;
  assert.equal(source.title, "依頼内容");
  assert.equal(source.text, ask);
  let inputFrame;
  const tick = createWorker(hub.db, async (_actor, _path, options) => {
    if (!options) return {status:"completed", output:"棚卸しが完了。"};
    inputFrame = JSON.parse(options.body).input;
    return {run_id:"inline-weekly"};
  });
  await tick();
  await tick();
  assert.doesNotMatch(inputFrame, /A社/);
  assert.equal(hub.get("sato", id).status, "failed");
  assert.equal(hub.get("sato", id).memo, null);
});

test("旧手順で確認待ちの依頼は回答後も v1 を使い、新規依頼は v2 を使う", async (t) => {
  const { hub, input, id } = setup(t);
  const oldHash = "b5f25994d533d7641c9f28ff764f4f7bf738e20cc075b0f45bb84ae3ae385f40";
  hub.db.prepare("UPDATE jobs SET skill_hash=?,status='waiting',question='更新日をどう扱いますか？' WHERE id=?").run(oldHash, id);
  hub.answer("sato", id, { answer: "先方に確認する" });
  const fresh = hub.create("sato", input, "another-new-request");
  const sent = [];
  const tick = createWorker(hub.db, async (_actor, _path, options) => {
    if (!options) return { status: "completed", output: "先方に確認する" };
    sent.push(JSON.parse(options.body));
    return { run_id: "run-" + sent.length };
  });
  await tick();
  await tick();
  await tick();
  assert.equal(hub.get("sato", id).skill_version, 1);
  assert.equal(hub.get("sato", id).status, "done");
  assert.equal(hub.get("sato", fresh).skill_version, 2);
  assert.match(sent[0].instructions, /「変更点」「先方への確認事項」/);
  assert.match(sent[1].instructions, /社員が入力した回答を原文のまま/);
});
test("受付結果不明は自動再送せず、再起動後も保留する", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aihub-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hub.sqlite");
  const hub = openHub(path);
  const id = hub.create(
    "sato",
    { ask: "更新手続き", company: "A社" },
    "synthetic-key-01",
  );
  let calls = 0;
  const call = async () => {
    calls++;
    throw Error("connection reset");
  };
  await createWorker(hub.db, call)();
  hub.close();
  const restarted = openHub(path);
  t.after(() => restarted.close());
  await createWorker(restarted.db, call)();
  assert.equal(calls, 1);
  assert.equal(restarted.get("sato", id).status, "unknown");
});
test("実行照合の一時障害は同じrunを再取得し、消失時は結果確認に切り替える", async (t) => {
  const { hub, id } = setup(t);
  let reads = 0,
    posts = 0;
  const tick = createWorker(hub.db, async (_actor, _path, options) => {
    if (options) {
      posts++;
      return { run_id: "r1" };
    }
    if (++reads === 1) throw Error("transient");
    throw new HubError(404, "gone");
  });
  await tick();
  await tick();
  assert.equal(hub.get("sato", id).status, "running");
  await tick();
  assert.equal(hub.get("sato", id).status, "unknown");
  assert.equal(posts, 1);
});

test("貼り付けた議事録と原稿を保持し、本人の同じ依頼で修正を一度だけ実行する", async t => {
  const hub = openHub(":memory:");
  t.after(() => hub.close());
  const input = { company: "A社", ask: "更新商談", minutes: "先方希望は2月17日。\n営業会議に諮る。" };
  const id = hub.create("sato", input, "minutes-test-key");
  assert.equal(hub.create("sato", input, "minutes-test-key"), id);
  assert.throws(() => hub.create("sato", { ...input, minutes: "別の議事録" }, "minutes-test-key"), { status: 409 });
  assert.throws(() => hub.create("sato", { ...input, minutes: "あ".repeat(6001) }, "minutes-too-long"), { status: 400 });
  const submitted = [];
  let output = "希望日の扱いは？";
  const tick = createWorker(hub.db, async (actor, path, options) => {
    if (!options) return { status: "completed", output };
    const { input: frame } = JSON.parse(options.body);
    const ctx = JSON.parse(frame.split("AI_HUB_INPUT\n")[1].split("\nEND_AI_HUB_INPUT")[0]);
    assert.equal(actor, "sato");
    assert.equal(ctx.sources[1].text, input.minutes);
    assert.doesNotMatch(frame, /12月15日/);
    submitted.push(ctx);
    return { run_id: "test-run-" + submitted.length };
  });
  await tick();
  await tick();
  hub.answer("sato", id, { answer: "予定を確認" });
  const original = "契約は12月31日 [1]\n希望は2月17日 [2]\n予定を確認";
  output = original;
  await tick();
  await tick();
  const edit = { base: 1, instruction: "上司向けに短く" };
  assert.throws(() => hub.revise("tanaka", id, edit, "revision-test-key"), { status: 404 });
  hub.revise("sato", id, edit, "revision-test-key");
  hub.revise("sato", id, edit, "revision-test-key");
  assert.throws(() => hub.revise("sato", id, { ...edit, instruction: "別の指示" }, "revision-test-key"), { status: 409 });
  assert.throws(() => hub.revise("sato", id, edit, "concurrent-edit-key"), { status: 409 });
  assert.equal(hub.get("sato", id).memo, original);
  await tick();
  output = "満了 [1]、希望日 [2] を確認。";
  await tick();
  const revised = hub.get("sato", id);
  assert.deepEqual(revised.versions.map(v => v.memo), [original, output]);
  assert.equal(submitted[2].previous_memo, original);
  assert.equal(submitted[2].revision_instruction, edit.instruction);
  assert.equal(submitted[2].answer, "予定を確認");
  hub.revise("sato", id, edit, "revision-test-key");
  assert.throws(() => hub.revise("sato", id, edit, "outdated-edit-key"), { status: 409 });
  hub.revise("sato", id, { ...edit, base: 2 }, "next-revision-key");
  await tick();
  output = "存在しない出典 [9]";
  await tick();
  const failed = hub.get("sato", id);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.versions, revised.versions);
  assert.equal(failed.memo, revised.memo);
});
