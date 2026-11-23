import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openHub, createWorker } from "../hub.mjs";
import { catalog, register, publish, probe } from "../catalog.mjs";
import {
  setStopped,
  measuredSend,
  modelForVersion,
  readLog,
} from "../operations.mjs";

function setup(t) {
  const hub = openHub(":memory:");
  t.after(() => hub.close());
  const db = hub.db;
  const b = register(db, {
    name: "B",
    model_id: "fixture-model-b",
    connection: "local-b",
    data_class: "合成資料",
  }, "aoki");
  db.prepare("UPDATE models SET probe='passed' WHERE id=?").run(b);
  publish(db, b, 1, "mori");
  return { hub, db, b, model: modelForVersion(db, 2) };
}
test("緊急停止・復元は別操作。復元後も同じモデルへの回答は未送信で保留する", async (t) => {
  const { db, hub, b } = setup(t);
  const id = hub.create("sato", { ask: "商談", company: "A社" }, randomUUID());
  db.prepare("UPDATE jobs SET status='waiting' WHERE id=?").run(id);
  setStopped(db, b, { generation: 0, reason: "障害確認" }, true, "aoki");
  assert.throws(
    () => setStopped(db, b, { generation: 0, reason: "古い操作" }, false, "aoki"),
    { status: 409 },
  );
  assert.throws(
    () => hub.create("sato", { ask: "新規", company: "A社" }, randomUUID()),
    { status: 423 },
  );
  await assert.rejects(() => probe(db, b, "aoki"), { status: 423 });
  assert.throws(() => publish(db, "legacy", 2, "mori", "  ", true), { status: 400 });
  assert.equal(catalog(db).current.version, 2);
  publish(db, "legacy", 2, "mori", "直前の設定へ復元", true);
  hub.answer("sato", id, { answer: "先方に確認" });
  hub.answer("sato", id, { answer: "先方に確認" });
  const tick = createWorker(db, () => assert.fail("未送信のはず"));
  await tick();
  assert.equal(hub.get("sato", id).status, "held");
  assert.throws(() => hub.resume("sato", id), { status: 423 });
  assert.equal(
    readLog(db, "usage", new URLSearchParams({ job: id })).rows.length,
    1,
  );
  assert.equal(
    readLog(db, "usage", new URLSearchParams({ job: id })).rows[0].outcome,
    "blocked",
  );
  assert.deepEqual(
    readLog(db, "changes", new URLSearchParams())
      .rows.slice(0, 2)
      .map((r) => r.action),
    ["restore", "stop"],
  );
  assert.throws(() => publish(db, b, 3, "mori", "停止中の版に戻す", true), {
    status: 409,
  });
  setStopped(db, b, { generation: 1, reason: "障害解消" }, false, "aoki");
  await tick();
  assert.equal(hub.get("sato", id).status, "held");
  hub.resume("sato", id);
  assert.equal(hub.get("sato", id).status, "queued");
  assert.equal(hub.get("sato", id).model_version, 2);
  assert.deepEqual(readLog(db, "changes", new URLSearchParams()).rows.slice(0, 3).map(r => r.actor), ["aoki", "mori", "aoki"]);
});
test("接続テストの質問後に停止するとメモ段階の送信を拒否する", async (t) => {
  const { db, b } = setup(t);
  let count = 0;
  const result = await probe(db, b, "aoki", async () => {
    count++;
    setStopped(db, b, { generation: 0, reason: "提供元の停止" }, true, "aoki");
    return Response.json({
      model: "fixture-model-b",
      choices: [{ message: { content: "12月31日 と 12月15日" } }],
    });
  });
  assert.equal(count, 1);
  assert.ok(readLog(db, "usage", new URLSearchParams()).rows.every(r => r.actor === "aoki"));
  assert.equal(result.state, "failed");
  assert.deepEqual(
    readLog(db, "usage", new URLSearchParams()).rows.map((r) => r.outcome),
    ["blocked", "ok"],
  );
});
test("ストリームの実モデル・使用量を記録し、中断・通信障害は不明として扱う", async (t) => {
  const { db, model, b } = setup(t);
  const ctx = { actor: "sato", job: randomUUID(), phase: "draft", version: 2 };
  const sse = (text) =>
    new Response(text, { headers: { "Content-Type": "text/event-stream" } });
  const line =
    "data: " +
    JSON.stringify({
      model: "actually-served",
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }) +
    "\r\n\r\n";
  let reply = await measuredSend(db, model, ctx, {}, async () =>
    sse(line + "data: [DONE]\n\n"),
  );
  await reply.text();
  reply = await measuredSend(db, model, ctx, {}, async () =>
    sse('data: {"model":"partial"}\n\n'),
  );
  await reply.text();
  await assert.rejects(
    measuredSend(db, model, ctx, {}, async () => {
      throw Error("network");
    }),
  );
  setStopped(db, b, { generation: 0, reason: "遮断" }, true, "aoki");
  await assert.rejects(
    measuredSend(db, model, ctx, {}, () => assert.fail("停止後の送信")),
    { status: 423 },
  );
  const rows = readLog(
    db,
    "usage",
    new URLSearchParams({ job: ctx.job }),
  ).rows.reverse();
  assert.deepEqual(
    rows.map((r) => r.outcome),
    ["ok", "unknown", "unknown", "blocked"],
  );
  assert.equal(rows[0].served, "actually-served");
  assert.equal(rows[0].total_tokens, 5);
  assert.equal(rows[1].total_tokens, null);
  assert.equal(rows[2].served, null);
  assert.equal(rows[3].http_status, null);
});
