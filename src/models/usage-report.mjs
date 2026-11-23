import { HubError } from "../operations.mjs";
import { usageSnapshot } from "./usage-policy.mjs";

const dayMs = 86_400_000;
const japanOffset = 9 * 3_600_000;
const pageSize = 10;
const dayFor = time => new Date(time + japanOffset).toISOString().slice(0, 10);

function dayStart(day) {
  const time = Date.parse(day + "T00:00:00+09:00");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(time) || dayFor(time) !== day)
    throw new HubError(400, "集計日を確認してください。");
  return time;
}

const reports = `WITH records AS (
  SELECT c.*, COALESCE(m.name,c.model) AS model_name,
    CASE WHEN c.job IS NULL THEN '接続テスト' ELSE COALESCE(j.scope_team,'所属記録なし') END AS department,
    CASE WHEN c.finished >= c.started AND c.outcome <> 'blocked' THEN c.finished-c.started END AS elapsed,
    r.actual, CASE WHEN r.actual IS NULL THEN r.reserved END AS pending
  FROM model_calls c
  LEFT JOIN jobs j ON j.id=c.job
  LEFT JOIN models m ON m.id=c.model
  LEFT JOIN model_reservations r ON r.call=c.call_id
  WHERE c.started>=:start AND c.started<:end AND (:cost=1 OR c.job IS NOT NULL)
), filtered AS (
  SELECT * FROM records
  WHERE (:department='' OR department=:department) AND (:model='' OR model=:model)
    AND (:outcome='' OR outcome=:outcome)
)`;

const metrics = `count(*) AS records, count(DISTINCT job) AS jobs,
  count(DISTINCT actor) FILTER(WHERE job IS NOT NULL AND outcome<>'blocked') AS users,
  count(*) FILTER(WHERE outcome<>'blocked') AS calls,
  count(*) FILTER(WHERE outcome='ok') AS successes,
  count(*) FILTER(WHERE outcome='error') AS failures,
  count(*) FILTER(WHERE outcome IN ('unknown','sending')) AS uncertain,
  count(*) FILTER(WHERE outcome='blocked') AS blocked,
  round(avg(elapsed)) AS average_ms, count(elapsed) AS timed,
  sum(total_tokens) AS tokens, count(total_tokens) AS measured,
  sum(actual) AS settled, count(actual) AS settled_calls, sum(pending) AS pending,
  count(pending) AS pending_calls,
  count(*) FILTER(WHERE outcome<>'blocked' AND actual IS NULL AND pending IS NULL) AS unpriced`;

export function usageReport(db, params, now = Date.now()) {
  const days = params.get("days") === "30" ? 30 : 7;
  const to = params.get("to") || dayFor(now);
  const from = params.get("from") || dayFor(dayStart(to) - (days - 1) * dayMs);
  const start = dayStart(from), end = dayStart(to) + dayMs;
  if (end <= start || end - start > 366 * dayMs)
    throw new HubError(400, "集計期間を1〜366日で指定してください。");

  const dashboard = params.get("view") === "dashboard";
  const cost = Number(!dashboard && params.get("view") === "cost");
  const department = dashboard ? "" : params.get("department") || "";
  const model = dashboard ? "" : params.get("model") || "";
  const outcome = dashboard ? "" : params.get("outcome") || "";
  const group = !dashboard && params.get("group") === "model" ? "model" : "department";
  const rawPage = params.get("page") ?? "0";
  if (!/^\d{1,8}$/.test(rawPage) || department.length > 100 || model.length > 160 ||
      !["", "ok", "error", "unknown", "sending", "blocked"].includes(outcome))
    throw new HubError(400, "集計条件を確認してください。");

  const args = { start, end, cost, department, model, outcome };
  const total = db.prepare(`${reports} SELECT ${metrics} FROM filtered`).get(args);
  const groupColumn = group === "model" ? "model, model_name" : "department";
  const keyColumn = group === "model" ? "model AS key, model_name AS name" : "department AS key, department AS name";
  const groups = db.prepare(`${reports} SELECT ${keyColumn}, ${metrics}
    FROM filtered GROUP BY ${groupColumn}
    ORDER BY ${cost ? "settled DESC," : ""} calls DESC, name, key`).all(args);
  if (dashboard) {
    const daily = db.prepare(`${reports}
      SELECT date(started/1000,'unixepoch','+9 hours') AS day, ${metrics}
      FROM filtered GROUP BY day ORDER BY day`).all(args);
    return { from, to, days, total, daily, groups, month: usageSnapshot(db, now) };
  }

  const filterArgs = {start, end, cost, department: "", model: "", outcome: ""};
  const departments = db.prepare(`${reports} SELECT DISTINCT department FROM filtered ORDER BY department`)
    .all(filterArgs).map(row => row.department);
  const models = db.prepare(`${reports} SELECT DISTINCT model AS key, model_name AS name FROM filtered ORDER BY name, key`)
    .all(filterArgs);
  const page = Math.min(Number(rawPage), Math.max(0, Math.ceil(total.records / pageSize) - 1));
  const rows = db.prepare(`${reports}
    SELECT call_id, job, started, actor, department, model_name, requested, served, version,
      phase, outcome, elapsed, total_tokens, actual, pending
    FROM filtered ORDER BY started DESC, seq DESC LIMIT :pageSize OFFSET :offset`)
    .all({...args, pageSize, offset: page * pageSize});
  const jobs = cost ? db.prepare(`${reports}
    SELECT job, department, ${metrics} FROM filtered WHERE job IS NOT NULL
    GROUP BY job, department ORDER BY settled DESC, max(started) DESC, job LIMIT 10`).all(args) : [];
  return { from, to, total, group, groups, departments, models, rows, jobs, page, pageSize, month: usageSnapshot(db, now) };
}
