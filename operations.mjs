import { randomUUID } from "node:crypto";
import { migrateUsagePolicy, modelPolicyDenial, reserveUsage, settleUsage, usagePolicy } from "./usage-policy.mjs";
import { splitCallDenial } from "./work-split.mjs";

export class HubError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function migrateOperations(db) {
  if (
    !db
      .prepare("PRAGMA table_info(models)")
      .all()
      .some((x) => x.name === "stopped")
  ) {
    db.exec(
      "ALTER TABLE models ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0; ALTER TABLE models ADD COLUMN generation INTEGER NOT NULL DEFAULT 0",
    );
  }
  db.exec(`CREATE TABLE IF NOT EXISTS model_changes (
    seq INTEGER PRIMARY KEY, time INTEGER, actor TEXT, action TEXT NOT NULL,
    model TEXT NOT NULL, version INTEGER NOT NULL, source_version INTEGER, reason TEXT);
    CREATE TABLE IF NOT EXISTS model_calls (
    seq INTEGER PRIMARY KEY, call_id TEXT UNIQUE NOT NULL, started INTEGER NOT NULL, finished INTEGER,
    actor TEXT NOT NULL, job TEXT, phase TEXT NOT NULL, version INTEGER, model TEXT NOT NULL,
    connection TEXT NOT NULL, requested TEXT NOT NULL, served TEXT, outcome TEXT NOT NULL, http_status INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER);
    CREATE INDEX IF NOT EXISTS calls_by_job ON model_calls(job,seq);`);
  if (!db.prepare("SELECT 1 FROM model_changes LIMIT 1").get()) {
    db.exec(`INSERT INTO model_changes(time,action,model,version,source_version)
      SELECT NULLIF(published,0),'previous_release',model,version,NULLIF(version-1,0) FROM model_releases ORDER BY version`);
  }
  migrateUsagePolicy(db);
}
export function reasonText(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 240)
    throw new HubError(400, "理由を1〜240文字で入力してください。");
  return value.trim();
}
export function change(
  db,
  { action, model, version, source = null, reason, actor },
) {
  db.prepare(
    "INSERT INTO model_changes(time,actor,action,model,version,source_version,reason) VALUES(?,?,?,?,?,?,?)",
  ).run(Date.now(), actor, action, model, version, source, reasonText(reason));
}
export function setStopped(db, id, input, stopped, actor) {
  return transaction(db, () => {
    const r = db
      .prepare(
        "UPDATE models SET stopped=?,generation=generation+1 WHERE id=? AND generation=? AND stopped<>?",
      )
      .run(
        Number(stopped),
        id,
        Number.isSafeInteger(input.generation) ? input.generation : -1,
        Number(stopped),
      );
    if (!r.changes)
      throw new HubError(
        409,
        "モデルの状態が変わっています。最新の状態から操作してください。",
      );
    const { version } = db
      .prepare("SELECT max(version) AS version FROM model_releases")
      .get();
    change(db, {
      actor,
      action: stopped ? "stop" : "enable",
      model: id,
      version,
      reason: input.reason,
    });
  });
}
export function modelForVersion(db, version) {
  return db
    .prepare(
      "SELECT m.* FROM model_releases r JOIN models m ON r.model=m.id WHERE r.version=?",
    )
    .get(version);
}
export function pageCursor(params, key = "before") {
  const before = params.get(key);
  if (
    before !== null &&
    (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))
  )
    throw new HubError(400, "ページ指定が正しくありません。");
  return before === null ? Number.MAX_SAFE_INTEGER : Number(before);
}
export function readLog(db, kind, params) {
  const cursor = pageCursor(params), job = params.get("job") || "";
  const rows =
    kind === "changes"
      ? db
          .prepare(
            `SELECT c.*,m.name FROM model_changes c JOIN models m ON m.id=c.model WHERE seq<? ORDER BY seq DESC LIMIT 31`,
          )
          .all(cursor)
      : db
          .prepare(
            `SELECT c.*,m.name FROM model_calls c JOIN models m ON m.id=c.model WHERE seq<? AND (?='' OR job=?) ORDER BY seq DESC LIMIT 31`,
          )
          .all(cursor, job, job);
  return {
    rows: rows.slice(0, 30),
    next: rows.length > 30 ? rows[29].seq : null,
  };
}
function startRecord(db, model, ctx, blocked, reason = null, policyVersion = null) {
  const call = randomUUID(),
    now = Date.now();
  db.prepare(
    `INSERT INTO model_calls(call_id,started,finished,actor,job,phase,version,model,connection,requested,outcome,block_reason,policy_version,data_class)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    call,
    now,
    blocked ? now : null,
    ctx.actor,
    ctx.job ?? null,
    ctx.phase,
    ctx.version ?? null,
    model.id,
    model.connection,
    model.model_id,
    blocked ? "blocked" : "sending",
    reason, policyVersion, ctx.dataClass ?? null,
  );
  return call;
}
export function recordBlocked(db, m, ctx, reason) {
  startRecord(db, m, ctx, true, reason, usagePolicy(db).version);
}

// The stop check, admission record and fetch invocation have no intervening await.
// All model dispatches and operator writes run in the same Hub process.
export async function measuredSend(db, model, ctx, payload, send) {
  const current = db
    .prepare("SELECT * FROM models WHERE id=?")
    .get(model.id);
  const policy=usagePolicy(db);
  const denied = !current || current.stopped ? "モデルは緊急停止中です。" : modelPolicyDenial(policy,current,ctx.dataClass);
  if (denied) {
    recordBlocked(db, model, ctx, denied);
    throw new HubError(423, denied);
  }
  let call;
  try {
    call = transaction(db, () => {
      const denial=splitCallDenial(db,ctx.job);
      if (denial) throw new HubError(423,denial);
      const id = startRecord(db, model, ctx, false, null, policy.version);
      reserveUsage(db, policy, current, id);
      return id;
    });
  } catch (error) {
    if (error instanceof HubError) recordBlocked(db, model, ctx, error.message);
    throw error;
  }
  const headers = { "X-Hub-Call": call, "X-Hub-Phase": ctx.phase };
  if (ctx.job) {
    headers["X-Hub-Job"] = ctx.job;
    headers["X-Hub-Version"] = String(ctx.version);
  }
  let http = null,
    served = null,
    usage = null,
    settled = false;
  function finish(outcome) {
    if (settled) return;
    settled = true;
    const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);
    transaction(db, () => {
      db.prepare(
        `UPDATE model_calls SET finished=?,outcome=?,http_status=?,served=?,input_tokens=?,output_tokens=?,total_tokens=? WHERE call_id=?`,
      ).run(Date.now(), outcome, http, served, count(usage?.prompt_tokens), count(usage?.completion_tokens), count(usage?.total_tokens), call);
      if (outcome === "ok") settleUsage(db,call,served,usage);
    });
  }
  try {
    const response = await send(model, payload, headers);
    http = response.status;
    if (!response.ok || !response.body) {
      finish(response.ok ? "unknown" : "error");
      return response;
    }
    const stream = response.headers
      .get("content-type")
      ?.includes("text/event-stream");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      done = false,
      invalid = false;
    function observe(data) {
      if (data === "[DONE]") {
        done = true;
        return;
      }
      try {
        const r = JSON.parse(data);
        if (typeof r.model === "string") served = r.model.slice(0, 256);
        if (r.usage) usage = r.usage;
        if (r.error) invalid = true;
      } catch {
        invalid = true;
      }
    }
    function consume(text, atEnd = false) {
      if (invalid) return;
      buffer += text;
      if (stream) {
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at).trimEnd();
          buffer = buffer.slice(at + 1);
          if (line.startsWith("data:")) observe(line.slice(5).trim());
        }
      }
      if (buffer.length > 4_000_000) {
        invalid = true;
        buffer = "";
      }
      if (atEnd && !invalid) {
        if (!stream) observe(buffer);
        else if (buffer.startsWith("data:")) observe(buffer.slice(5).trim());
      }
    }
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            consume(decoder.decode(), true);
            finish(!invalid && served && (!stream || done) ? "ok" : "unknown");
            controller.close();
          } else {
            consume(decoder.decode(part.value, { stream: true }));
            controller.enqueue(part.value);
          }
        } catch (e) {
          finish("unknown");
          controller.error(e);
        }
      },
      async cancel(reason) {
        finish("unknown");
        await reader.cancel(reason);
      },
    });
    return new Response(body, { status: http, headers: response.headers });
  } catch (e) {
    finish("unknown");
    throw e;
  }
}
