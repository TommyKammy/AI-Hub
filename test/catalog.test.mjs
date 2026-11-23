import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openHub } from "../hub.mjs";
import {
  catalog,
  migrateCatalog,
  probe,
  publish,
  register,
} from "../catalog.mjs";

const candidate = {
  name: "合成モデル B",
  model_id: "fixture-model-b",
  connection: "local-b",
  data_class: "合成資料",
};
test("期限の異なる二つの管理画面と失敗した接続テストは公開済み設定を上書きしない", async (t) => {
  const hub = openHub(":memory:");
  t.after(() => hub.close());
  const db = hub.db,
    id = register(db, candidate, "aoki");
  const old = hub.create(
    "sato",
    { ask: "更新日を確認", company: "A社" },
    randomUUID(),
  );
  assert.throws(() => publish(db, id, 1, "mori"), { status: 409 });
  assert.equal(
    (await probe(db, id, "aoki", async () => new Response(null, { status: 404 })))
      .state,
    "failed",
  );
  assert.throws(() => publish(db, id, 1, "mori"), { status: 409 });
  const reply = async (model, payload) => {
    const context = JSON.parse(payload.messages[0].content.split("\n")[1]);
    return Response.json({
      model: model.model_id,
      choices: [
        {
          message: {
            content: "12月31日・12月15日 [1] [2] " + (context.answer || "?"),
          },
        },
      ],
    });
  };
  assert.equal((await probe(db, id, "aoki", reply)).state, "passed");
  publish(db, id, 1, "mori");
  assert.equal(catalog(db).current.version, 2);
  assert.equal(hub.get("sato", old).model_version, 1);
  const key = randomUUID(),
    input = { ask: "準備", company: "B社" },
    recent = hub.create("tanaka", input, key);
  assert.equal(hub.get("tanaka", recent).model_version, 2);
  await probe(db, "legacy", "aoki", reply);
  assert.throws(() => publish(db, "legacy", 1, "mori"), { status: 409 });
  publish(db, "legacy", 2, "mori");
  assert.equal(hub.create("tanaka", input, key), recent);
  assert.equal(hub.get("tanaka", recent).model_version, 2);
});
test("従来の確認待ち依頼は初期設定版に移行し再起動で変更されない", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE jobs(id TEXT,status TEXT,answer TEXT);INSERT INTO jobs VALUES('old','waiting',NULL);CREATE TABLE attempts(job_id TEXT,phase TEXT)",
    );
    migrateCatalog(db);
    migrateCatalog(db);
    assert.equal(
      db
        .prepare(
          "SELECT model_version FROM jobs WHERE id='old' AND status='waiting'",
        )
        .get().model_version,
      1,
    );
    assert.equal(catalog(db).current.model, "legacy");
  } finally {
    db.close();
  }
});
