import { randomUUID } from "node:crypto";
import { sourcesFor } from "./fixtures.mjs";
import { current as renewalBrief } from "./skills/renewal-brief/releases.mjs";

import {
  HubError,
  migrateOperations,
  transaction,
  change,
  measuredSend,
} from "./operations.mjs";
export { HubError };

// Trusted destinations are installed by the operator. Admins select a connection
// and model, so probe requests and credentials stay on the intended network.
export const connections = {
  "local-a": {
    name: "ローカル A",
    url: "http://model:8000/v1",
    key: "synthetic-only",
  },
  "local-b": {
    name: "ローカル B",
    url: "http://model-b:8000/v1",
    key: "synthetic-only",
  },
};
if (process.env.LOCAL_MLX_ENABLED === "1") {
  connections["local-mlx"] = {
    name: "Mac ローカル推論（MLX）",
    url: "http://host.lima.internal:8001/v1",
    timeout: 120_000,
  };
}
export function migrateCatalog(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, connection TEXT NOT NULL, model_id TEXT NOT NULL,
      data_class TEXT NOT NULL, probe TEXT NOT NULL DEFAULT 'untested',
      probe_token TEXT, result TEXT, UNIQUE(connection,model_id));
      CREATE TABLE IF NOT EXISTS model_releases (
      version INTEGER PRIMARY KEY, model TEXT NOT NULL REFERENCES models(id), published INTEGER NOT NULL);
      INSERT OR IGNORE INTO models(id,name,connection,model_id,data_class)
        VALUES('legacy','合成モデル A','local-a','fixture-model','合成資料');
      INSERT OR IGNORE INTO model_releases VALUES(1,'legacy',0);`);
    if (
      !db
        .prepare("PRAGMA table_info(jobs)")
        .all()
        .some((c) => c.name === "model_version")
    )
      db.exec(
        "ALTER TABLE jobs ADD COLUMN model_version INTEGER NOT NULL DEFAULT 1",
      );
    if (
      !db
        .prepare("PRAGMA table_info(attempts)")
        .all()
        .some((c) => c.name === "route_key")
    )
      db.exec(
        "ALTER TABLE attempts ADD COLUMN route_key TEXT; CREATE UNIQUE INDEX attempt_route ON attempts(route_key)",
      );
    migrateOperations(db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function catalog(db) {
  const models = db
    .prepare(
      "SELECT id,name,connection,model_id,data_class,probe,result,stopped,generation FROM models ORDER BY rowid",
    )
    .all()
    .map((m) => ({ ...m, result: JSON.parse(m.result) }));
  const current = db
    .prepare(
      "SELECT version, model, published FROM model_releases ORDER BY version DESC LIMIT 1",
    )
    .get();
  return {
    models,
    current,
    usageTotals: db
      .prepare(
        `SELECT model,COUNT(DISTINCT job) AS jobs,COUNT(*) AS calls,
      SUM(outcome='error') AS failures,SUM(outcome='unknown') AS uncertain,
      SUM(total_tokens) AS known_tokens,SUM(total_tokens IS NULL) AS missing_tokens,
      ROUND(AVG(finished-started)) AS mean_ms FROM model_calls
      WHERE outcome<>'blocked' GROUP BY model`,
      )
      .all(),
    previous:
      db
        .prepare(
          "SELECT version,model FROM model_releases WHERE version<? ORDER BY version DESC LIMIT 1",
        )
        .get(current.version) ?? null,
    connections: Object.entries(connections).map(([id, c]) => ({
      id,
      name: c.name,
      url: c.url,
    })),
  };
}
export function register(db, input, actor) {
  if (
    !Object.hasOwn(connections, input.connection) ||
    input.data_class !== "合成資料" ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.trim().length > 80 ||
    typeof input.model_id !== "string" ||
    !/^[-a-zA-Z0-9._/:]{1,120}$/.test(input.model_id)
  )
    throw new HubError(
      400,
      "表示名、接続先、モデルID、データ区分を確認してください。",
    );
  const id = randomUUID();
  return transaction(db, () => {
    const { changes } = db
      .prepare(
        "INSERT INTO models(id,name,connection,model_id,data_class) VALUES(?,?,?,?,?) ON CONFLICT(connection,model_id) DO NOTHING",
      )
      .run(
        id,
        input.name.trim(),
        input.connection,
        input.model_id,
        input.data_class,
      );
    if (!changes)
      throw new HubError(409, "この接続先とモデルIDは登録済みです。");
    const { version } = db
      .prepare("SELECT max(version) version FROM model_releases")
      .get();
    change(db, {
      actor,
      action: "register",
      model: id,
      version,
      reason: "モデル台帳への登録",
    });
    return id;
  });
}
export function publish(
  db,
  id,
  base,
  actor,
  reason = "全社標準モデルの変更",
  restore = false,
) {
  return transaction(db, () => {
    const cur = db
      .prepare(
        "SELECT version,model FROM model_releases ORDER BY version DESC LIMIT 1",
      )
      .get();
    if (cur.version !== base)
      throw new HubError(
        409,
        "標準設定が更新されました。最新の状態を確認してください。",
      );
    const previous = db
      .prepare(
        "SELECT version,model FROM model_releases WHERE version<? ORDER BY version DESC LIMIT 1",
      )
      .get(base);
    if (restore && previous?.model !== id)
      throw new HubError(409, "復元先が直前の設定と一致しません。");
    const m = db.prepare("SELECT stopped,probe FROM models WHERE id=?").get(id);
    if (
      !m ||
      m.stopped ||
      id === cur.model ||
      (!restore && m.probe !== "passed")
    )
      throw new HubError(409, "停止状態と接続テスト結果を確認してください。");
    db.prepare(
      "INSERT INTO model_releases(version,model,published) VALUES(?,?,?)",
    ).run(base + 1, id, Date.now());
    change(db, {
      actor,
      action: restore ? "restore" : "publish",
      model: id,
      version: base + 1,
      source: restore ? previous.version : base,
      reason,
    });
  });
}
export function upstream(model, payload, metadata = {}) {
  const c = connections[model.connection];
  return fetch(c.url + "/chat/completions", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(c.timeout ?? 20_000),
    headers: {
      ...(c.key && { Authorization: "Bearer " + c.key }),
      "Content-Type": "application/json",
      ...metadata,
    },
    body: JSON.stringify({
      ...payload,
      ...(model.connection === "local-mlx" && {
        enable_thinking: false,
        temperature: 0,
        max_tokens: 1200,
      }),
      model: model.model_id,
    }),
  });
}
export function frameInput(context) {
  return "AI_HUB_INPUT\n" + JSON.stringify(context) + "\nEND_AI_HUB_INPUT";
}
export async function probe(db, id, actor, send = upstream) {
  const model = db.prepare("SELECT * FROM models WHERE id=?").get(id);
  if (!model) throw new HubError(404, "モデルが見つかりません。");
  if (model.stopped) throw new HubError(423, "モデルは緊急停止中です。");
  const token = randomUUID(),
    started = Date.now();
  db.prepare(
    "UPDATE models SET probe='testing',probe_token=?,result=NULL WHERE id=?",
  ).run(token, id);
  const result = { question: null, memo: null, elapsed_ms: 0, tokens: 0 };
  let state = "failed";
  try {
    for (const phase of ["review", "draft"]) {
      const answer =
        phase === "draft" ? "日付は未確定として両方を先方に確認する。" : null;
      const content = frameInput({
        skill_version: renewalBrief.version,
        phase,
        answer,
        company: "A社",
        ask: "商談の準備",
        sources: sourcesFor("sato", "A社"),
      });
      const task = phase === "review"
        ? "契約満了日と先方希望日を明記し、日付の扱いを社員に質問してください。"
        : "手順に沿って回答後のメモを返してください。";
      const response = await measuredSend(
        db,
        model,
        { actor, phase: "probe-" + phase },
        { messages: [{ role: "user", content: content + "\n" + renewalBrief.instruction + "\n今回の作業：" + task }], stream: false },
        send,
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw Error();
      }
      const reply = await response.json(),
        text = reply.choices?.[0]?.message?.content;
      if (typeof text === "string" && reply.model === model.model_id)
        result[phase === "draft" ? "memo" : "question"] = text;
      if (
        reply.model !== model.model_id ||
        typeof text !== "string" ||
        !text.trim() ||
        !text.includes("12月31日") ||
        !text.includes("12月15日") ||
        (phase === "draft" &&
          (!text.includes(answer) ||
            !text.includes("[1]") ||
            !text.includes("[2]")))
      )
        throw Error();
      result.tokens =
        Number.isFinite(reply.usage?.total_tokens) && result.tokens !== null
          ? result.tokens + reply.usage.total_tokens
          : null;
    }
    state = "passed";
  } catch {
    result.error = "接続先、モデルID、または合成案件の応答を確認してください。";
  }
  result.elapsed_ms = Date.now() - started;
  const r = db
    .prepare("UPDATE models SET probe=?,result=? WHERE id=? AND probe_token=?")
    .run(state, JSON.stringify(result), id, token);
  if (!r.changes)
    throw new HubError(409, "新しいテスト結果を確認してください。");
  return { state, result };
}
