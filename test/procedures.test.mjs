import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openHub, createWorker } from "../hub.mjs";
import { formatSharedMemo, makeDraft, submitDraft, publishProcedure, publishedFor, reviewList,
  previewRevision, publishRevision, revokeProcedure } from "../procedures.mjs";
import { sourcesFor } from "../fixtures.mjs";

test("資料の完全一致引用は文ごとに番号を付け、社員の文章はそのまま残す", () => {
  const sources = sourcesFor("tanaka", "B社");
  const line = sources[1].text + " [2]";
  const answer = "\n\n社員の判断\n" + line;
  assert.equal(formatSharedMemo("資料の事実\n" + line + answer, sources),
    "資料の事実\n先方は4月15日の更新を希望。 [2]\n調達部との調整日を次回確認する。 [2]" + answer);
});

test("改訂時に受付済みの版を保存し、取消後は旧版と新版の送信・再開を止める", async t => {
  const hub = openHub(":memory:"), db = hub.db;
  t.after(() => hub.close());
  const source = hub.create("sato", { company: "A社", ask: "商談準備" }, randomUUID());
  db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(source);
  const p = makeDraft(db, "sato", source, "meeting");
  submitDraft(db, "sato", source, p.hash);
  publishProcedure(db, p.id, p.hash, "aoki");
  const input = { company: "B社", ask: "商談準備", procedure_id: p.id };
  const key = randomUUID(), old = hub.create("tanaka", input, key);
  db.prepare("UPDATE jobs SET status='waiting',question='日付は？' WHERE id=?").run(old);
  const base = { base: p.hash, layout: "contract" }, next = previewRevision(db, p.id, base);
  assert.equal(hub.get("tanaka", old).skill_version, 1);
  assert.throws(() => publishRevision(db, p.id, { ...base, hash: "別の内容" }, "mori"), { status: 409 });
  publishRevision(db, p.id, { ...base, hash: next.hash }, "mori");
  assert.throws(() => revokeProcedure(db, p.id, p.hash), { status: 409 });
  assert.throws(() => previewRevision(db, p.id, base), { status: 409 });
  assert.equal(hub.create("tanaka", input, key), old);
  const queued = hub.create("tanaka", input, randomUUID());
  assert.equal(hub.get("tanaka", queued).skill_hash, next.hash);
  const held = hub.create("tanaka", input, randomUUID());
  db.prepare("UPDATE jobs SET status='held' WHERE id=?").run(held);
  revokeProcedure(db, p.id, next.hash);
  revokeProcedure(db, p.id, next.hash);
  hub.answer("tanaka", old, { answer: "後日確認" });
  hub.answer("tanaka", old, { answer: "後日確認" });
  assert.equal(hub.get("tanaka", old).answer, "後日確認");
  assert.equal(hub.get("tanaka", old).skill_hash, p.hash);
  assert.equal(hub.get("tanaka", old).skill_version, 1);
  assert.equal(hub.create("tanaka", input, key), old);
  assert.deepEqual(publishedFor(db, "tanaka"), []);
  assert.equal(reviewList(db)[0].state, "revoked");
  assert.throws(() => hub.create("tanaka", input, randomUUID()), { status: 423 });
  assert.throws(() => publishProcedure(db, p.id, next.hash, "aoki"), { status: 409 });
  const calls = [];
  await createWorker(db, (...args) => calls.push(args))();
  assert.deepEqual(calls, []);
  for (const id of [old, held, queued]) {
    assert.equal(hub.get("tanaka", id).status, "procedure_revoked");
    assert.throws(() => hub.resume("tanaka", id), { status: 423 });
  }
});

test("本人の完了依頼から申請した本文だけを公開し、再利用時は本人の案件と回答で実行する", async t => {
  const hub = openHub(":memory:"), db = hub.db;
  t.after(() => hub.close());
  const source = hub.create("sato", { company: "A社", ask: "佐藤の依頼" }, randomUUID());
  const reusable = { company: "B社", ask: "更新商談" };
  assert.throws(() => makeDraft(db, "sato", source, "meeting"), { status: 409 });
  db.prepare("UPDATE jobs SET status='done',answer='私用の回答',memo='私用メモ' WHERE id=?").run(source);
  assert.throws(() => makeDraft(db, "tanaka", source, "meeting"), { status: 404 });
  const draft = makeDraft(db, "sato", source, "meeting");
  assert.equal(makeDraft(db, "sato", source, "meeting").id, draft.id);
  assert.deepEqual(reviewList(db), []);
  assert.throws(() => publishProcedure(db, draft.id, draft.hash, "aoki"), { status: 404 });
  assert.throws(() => submitDraft(db, "tanaka", source, draft.hash), { status: 404 });
  submitDraft(db, "sato", source, draft.hash);
  assert.equal(reviewList(db)[0].instruction, draft.instruction);
  assert.deepEqual(publishedFor(db, "tanaka"), []);
  reusable.procedure_id = draft.id;
  assert.throws(() => hub.create("tanaka", reusable, randomUUID()), { status: 404 });
  assert.throws(() => publishProcedure(db, draft.id, "古い版", "aoki"), { status: 409 });
  publishProcedure(db, draft.id, draft.hash, "aoki");
  publishProcedure(db, draft.id, draft.hash, "aoki");
  assert.equal(publishedFor(db, "tanaka").length, 1);
  assert.throws(() => hub.create("tanaka", { ...reusable, company: "A社" }, randomUUID()), { status: 403 });
  const key = randomUUID(), job = hub.create("tanaka", reusable, key);
  assert.throws(() => hub.create("tanaka", { company: "B社", ask: reusable.ask }, key), { status: 409 });
  const posts = [];
  const tick = createWorker(db, async (actor, path, options) => {
    assert.equal(actor, "tanaka");
    if (!options) return { status: "completed", output: "確認" };
    const payload = JSON.parse(options.body);
    assert.ok(payload.instructions.startsWith(draft.instruction + "\n"));
    assert.doesNotMatch(options.body, /A社|佐藤の依頼|私用の回答|私用メモ/);
    posts.push(JSON.parse(payload.input.split("AI_HUB_INPUT\n")[1].split("\nEND_AI_HUB_INPUT")[0]));
    return { run_id: randomUUID() };
  });
  await tick(); await tick();
  hub.answer("tanaka", job, { answer: "田中の回答" });
  await tick(); await tick();
  assert.deepEqual(posts.map(p => p.answer), [null, "田中の回答"]);
  for (const p of posts) assert.deepEqual(p.sources, sourcesFor("tanaka", "B社"));
  assert.equal(hub.get("tanaka", job).skill_hash, draft.hash);
  db.prepare("UPDATE procedures SET instruction='異なる本文' WHERE id=?").run(draft.id);
  assert.throws(() => hub.create("tanaka", reusable, randomUUID()), { status: 409 });
});
