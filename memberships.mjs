import { createHash } from "node:crypto";
import { auditFields, exportHistoryFields } from "./public/audit-format.js";
import { employees, renewalTeam } from "./fixtures.mjs";
import { HubError, pageCursor, reasonText, transaction } from "./operations.mjs";

export function migrateMemberships(db) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS memberships (
      actor TEXT PRIMARY KEY, team TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
      CREATE VIEW IF NOT EXISTS permitted_job_teams AS
      SELECT j.id FROM jobs j JOIN memberships m ON m.actor=j.actor
      LEFT JOIN procedures p ON p.id=j.procedure_id
      WHERE m.team=COALESCE(j.scope_team, CASE WHEN j.procedure_id IS NULL THEN '${renewalTeam}' ELSE p.scope END)`);
    if (!db.prepare("PRAGMA table_info(memberships)").all().some(c => c.name === "active"))
      db.exec("ALTER TABLE memberships ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))");
    if (!db.prepare("PRAGMA table_info(memberships)").all().some(c => c.name === "responsibility"))
      db.exec("ALTER TABLE memberships ADD COLUMN responsibility TEXT NOT NULL DEFAULT ''");
    if (!db.prepare("PRAGMA table_info(memberships)").all().some(c => c.name === "directory_revision"))
      db.exec("ALTER TABLE memberships ADD COLUMN directory_revision INTEGER NOT NULL DEFAULT 1; UPDATE memberships SET directory_revision=revision");
    if (!db.prepare("PRAGMA table_info(memberships)").all().some(c => c.name === "manual_active"))
      db.exec(`ALTER TABLE memberships ADD COLUMN manual_active INTEGER NOT NULL DEFAULT 1 CHECK(manual_active IN (0,1));
        ALTER TABLE memberships ADD COLUMN directory_active INTEGER NOT NULL DEFAULT 1 CHECK(directory_active IN (0,1));
        UPDATE memberships SET manual_active=active`);
    db.exec(`CREATE TABLE IF NOT EXISTS member_changes (
      seq INTEGER PRIMARY KEY, time INTEGER NOT NULL, operator TEXT NOT NULL,
      employee TEXT NOT NULL, employee_name TEXT NOT NULL, revision INTEGER NOT NULL,
      action TEXT NOT NULL, before_team TEXT NOT NULL, after_team TEXT NOT NULL,
      before_active INTEGER NOT NULL, after_active INTEGER NOT NULL, reason TEXT NOT NULL,
      UNIQUE(employee,revision));
      CREATE INDEX IF NOT EXISTS changes_by_employee ON member_changes(employee,seq);
      CREATE TABLE IF NOT EXISTS member_stopped_jobs (
        change_seq INTEGER NOT NULL REFERENCES member_changes(seq), job TEXT NOT NULL REFERENCES jobs(id),
        attempts_at_stop INTEGER NOT NULL, PRIMARY KEY(change_seq,job))`);
    if (!db.prepare("PRAGMA table_info(member_changes)").all().some(c => c.name === "before_responsibility"))
      db.exec("ALTER TABLE member_changes ADD COLUMN before_responsibility TEXT; ALTER TABLE member_changes ADD COLUMN after_responsibility TEXT");
    // Keep a single pagination order for applied changes and denied attempts, including older changes.
    db.exec(`CREATE TABLE IF NOT EXISTS admin_audit (
        seq INTEGER PRIMARY KEY, change_seq INTEGER UNIQUE REFERENCES member_changes(seq),
        time INTEGER NOT NULL, operator TEXT NOT NULL, scope TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_exports (
        seq INTEGER PRIMARY KEY, started INTEGER NOT NULL, exported_by TEXT NOT NULL,
        employee TEXT, filter_operator TEXT, outcome TEXT, from_jst TEXT, to_jst TEXT,
        before_seq INTEGER NOT NULL, completed INTEGER, row_count INTEGER CHECK(row_count>=0));
      CREATE INDEX IF NOT EXISTS exports_by_account ON audit_exports(exported_by,seq);
      CREATE INDEX IF NOT EXISTS audit_by_target ON admin_audit(scope,target,seq);
      CREATE INDEX IF NOT EXISTS audit_by_operator ON admin_audit(operator,seq);
      CREATE TRIGGER IF NOT EXISTS audit_member_change AFTER INSERT ON member_changes BEGIN
        INSERT INTO admin_audit(change_seq,time,operator,scope,target,action)
        VALUES(NEW.seq,NEW.time,NEW.operator,'employee',NEW.employee,NEW.action);
      END;
      INSERT INTO admin_audit(change_seq,time,operator,scope,target,action)
        SELECT c.seq,c.time,c.operator,'employee',c.employee,c.action FROM member_changes c
        WHERE NOT EXISTS (SELECT 1 FROM admin_audit a WHERE a.change_seq=c.seq) ORDER BY c.seq`);
    if (!db.prepare("PRAGMA table_info(admin_audit)").all().some(c => c.name === "closure_job"))
      db.exec("ALTER TABLE admin_audit ADD COLUMN closure_job TEXT REFERENCES meeting_closures(meeting)");
    if (!db.prepare("PRAGMA table_info(admin_audit)").all().some(c => c.name === "change_reason"))
      db.exec(`ALTER TABLE admin_audit ADD COLUMN change_reason TEXT;
        ALTER TABLE admin_audit ADD COLUMN before_value TEXT;
        ALTER TABLE admin_audit ADD COLUMN after_value TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS audit_by_closure ON admin_audit(closure_job);
      CREATE TRIGGER IF NOT EXISTS audit_meeting_closure AFTER INSERT ON meeting_closures BEGIN
        INSERT INTO admin_audit(time,operator,scope,target,action,closure_job)
        VALUES(NEW.time,NEW.operator,'job',NEW.meeting,'close_unconfirmed',NEW.meeting);
      END;
      INSERT OR IGNORE INTO admin_audit(time,operator,scope,target,action,closure_job)
        SELECT time,operator,'job',meeting,'close_unconfirmed',meeting
        FROM meeting_closures ORDER BY time,meeting`);
    const columns = db.prepare("PRAGMA table_info(audit_exports)").all().map(c => c.name);
    if (!columns.includes("source")) db.exec("ALTER TABLE audit_exports ADD COLUMN source TEXT NOT NULL DEFAULT 'audit'");
    if (!columns.includes("filter_exporter")) db.exec("ALTER TABLE audit_exports ADD COLUMN filter_exporter TEXT");
    if (!columns.includes("snapshot_completion")) db.exec("ALTER TABLE audit_exports ADD COLUMN snapshot_completion INTEGER");
    if (!columns.includes("filter_source")) db.exec("ALTER TABLE audit_exports ADD COLUMN filter_source TEXT");
    if (!columns.includes("completion_seq")) db.exec("ALTER TABLE audit_exports ADD COLUMN completion_seq INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("filter_job")) db.exec("ALTER TABLE audit_exports ADD COLUMN filter_job TEXT; ALTER TABLE audit_exports ADD COLUMN filter_reason TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS exports_by_completion ON audit_exports(completion_seq)");
    const seed = db.prepare("INSERT OR IGNORE INTO memberships(actor,team) VALUES(?,?)");
    for (const [id, e] of Object.entries(employees)) seed.run(id, e.team);
  });
}

export function member(db, actor) {
  const row = db.prepare("SELECT actor,team,revision,active,responsibility FROM memberships WHERE actor=?").get(actor);
  if (!row || !Object.hasOwn(employees, actor)) throw new HubError(404, "社員が見つかりません。");
  return { ...employees[actor], ...row, active: Boolean(row.active) };
}

export function adminMember(db, actor) {
  const person = member(db, actor);
  const state=db.prepare("SELECT directory_revision,manual_active,directory_active FROM memberships WHERE actor=?").get(actor);
  return { ...person, revision: state.directory_revision, manual_active:Boolean(state.manual_active), directory_active:Boolean(state.directory_active) };
}

export function adminAccount(db, actor) {
  const person = adminMember(db, actor);
  const directory = db.prepare("SELECT display_name AS directory_name,email,object_id AS directory_id FROM enterprise_people WHERE actor=?").get(actor);
  return { ...person, ...directory, role: person.role ?? "employee" };
}

export function memberDirectory(db, filters) {
  const query = (filters.get("q") || "").trim().normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
  const team = filters.get("team") || "";
  const state = filters.get("state") || "";
  const role = filters.get("role") || "";
  if (!["", "manager", "auditor", "employee"].includes(role) || query.length > 100 || team.length > 80 || !["", "active", "stopped"].includes(state))
    throw new HubError(400, "社員の絞り込み条件が正しくありません。");
  const all = Object.keys(employees).map(id => adminAccount(db, id));
  const rows = all.filter(person => (!team || person.team === team)
    && (!role || person.role === role)
    && (!state || person.active === (state === "active"))
    && (!query || [person.actor, person.name, person.responsibility, person.email || "", person.directory_name || ""]
      .some(value => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "").includes(query))));
  const snapshot = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  return { rows, snapshot, teams: [...new Set(all.map(person => person.team))].sort((a, b) => a.localeCompare(b, "ja")) };
}

export function memberDirectoryCsv(db, filters) {
  const { rows, snapshot } = memberDirectory(db, filters);
  if (filters.get("snapshot") !== snapshot)
    throw new HubError(409, "社員一覧が更新されました。絞り込みを実行してからCSVを出力してください。");
  return "\uFEFF" + csvLine(["社員ID", "氏名", "所属", "担当", "利用状態", "メールアドレス", "権限"]) + rows.map(person =>
    csvLine([person.actor, person.name, person.team, person.responsibility, person.active ? "利用可能" : "利用停止中", person.email || "", {employee:"一般社員",manager:"管理者",auditor:"閲覧専用管理者"}[person.role]])
  ).join("");
}

export function activeMember(db, actor) {
  const employee = member(db, actor);
  if (!employee.active) throw new HubError(403, "このアカウントの利用は停止されています。", "employee_disabled");
  return employee;
}

// Called inside the same write transaction as the member and job updates.
function recordMemberChange(db, operator, action, before, after, reason, stoppedJobs) {
  const event = db.prepare(`INSERT INTO member_changes(time,operator,employee,employee_name,revision,
    action,before_team,after_team,before_active,after_active,reason,before_responsibility,after_responsibility)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(Date.now(), operator, before.actor, before.name, after.revision, action, before.team, after.team,
      Number(before.active), Number(after.active), reasonText(reason), before.responsibility, after.responsibility);
  const link = db.prepare(`INSERT INTO member_stopped_jobs(change_seq,job,attempts_at_stop)
    SELECT ?,?,count(*) FROM attempts WHERE job_id=?`);
  for (const { id } of stoppedJobs) link.run(event.lastInsertRowid, id, id);
  return after;
}

export function memberHistory(db, params) {
  const employee = params.get("employee") || "";
  const rows = db.prepare(`SELECT c.*, (SELECT count(*) FROM member_stopped_jobs WHERE change_seq=c.seq) AS stopped_jobs
    FROM member_changes c WHERE c.seq<? AND (?='' OR c.employee=?) ORDER BY c.seq DESC LIMIT 31`)
    .all(pageCursor(params), employee, employee);
  return { rows: rows.slice(0, 30), next: rows.length > 30 ? rows[29].seq : null };
}

export function recordAdminChange(db,{operator,scope,target,action,before,after,reason}) {
  db.prepare(`INSERT INTO admin_audit(time,operator,scope,target,action,before_value,after_value,change_reason)
    VALUES(?,?,?,?,?,?,?,?)`).run(Date.now(),operator,scope,target,action,before ?? "",after ?? "",reasonText(reason));
}

export function recordAdminDenial(db, operator, scope, target, action) {
  db.prepare("INSERT INTO admin_audit(time,operator,scope,target,action) VALUES(?,?,?,?,?)")
    .run(Date.now(), operator, scope, target, action);
}

// The form and audit timestamps both use Japan time. Bounds include the entire selected second.
function auditSecond(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))
    throw new HubError(400, "期間は日本時間の日時で指定してください。");
  const stamp = value.length === 16 ? value + ":00" : value;
  const wallTime = Date.parse(stamp + "Z");
  if (!Number.isFinite(wallTime) || new Date(wallTime).toISOString().slice(0, 19) !== stamp)
    throw new HubError(400, "期間の日時が正しくありません。");
  return Date.parse(stamp + "+09:00");
}

function addPeriodFilter(params, column, where, values) {
  const from = auditSecond(params.get("from")), to = auditSecond(params.get("to"));
  if (from !== null && to !== null && from > to)
    throw new HubError(400, "終了日時は開始日時以降を指定してください。");
  if (from !== null) {
    where.push(column + ">=?");
    values.push(from);
  }
  if (to !== null) {
    where.push(column + "<?");
    values.push(to + 1000);
  }
}

export function adminAudit(db, params) {
  const employee = params.get("employee"), operator = params.get("operator"), outcome = params.get("outcome");
  const job = params.get("job")?.trim().toLowerCase(), reason = params.get("reason")?.trim();
  if (outcome && !["denied", "applied", "closed_unconfirmed"].includes(outcome))
    throw new HubError(400, "操作結果が正しくありません。");
  if (job && !/^[a-z0-9-]{1,64}$/.test(job) || reason && reason.length > 240)
    throw new HubError(400, "依頼IDまたは理由の検索条件が正しくありません。");

  const where = ["a.seq<?"], values = [pageCursor(params)];
  if (employee) {
    where.push("((a.scope='employee' AND a.target=?) OR j.actor=?)");
    values.push(employee, employee);
  }
  if (operator) {
    where.push("a.operator=?");
    values.push(operator);
  }
  if (job) {
    where.push("a.scope='job' AND a.target=?");
    values.push(job);
  }
  if (reason) {
    where.push("instr(COALESCE(a.change_reason,c.reason,m.reason, '管理操作の権限不足（HTTP 403）'),?)>0");
    values.push(reason);
  }
  if (outcome === "closed_unconfirmed") where.push("a.closure_job IS NOT NULL");
  if (outcome === "denied") where.push("a.change_seq IS NULL AND a.closure_job IS NULL AND a.change_reason IS NULL");
  if (outcome === "applied") where.push("a.change_seq IS NOT NULL OR a.closure_job IS NOT NULL OR a.change_reason IS NOT NULL");
  addPeriodFilter(params, "a.time", where, values);
  const rows = db.prepare(`SELECT a.*, c.employee_name,c.before_team,c.after_team,c.before_active,c.after_active,COALESCE(a.change_reason,c.reason,m.reason) AS reason,
    c.before_responsibility,c.after_responsibility,
    (SELECT count(*) FROM member_stopped_jobs WHERE change_seq=a.change_seq) AS stopped_jobs
    FROM admin_audit a LEFT JOIN member_changes c ON c.seq=a.change_seq
      LEFT JOIN meeting_closures m ON m.meeting=a.closure_job
      LEFT JOIN jobs j ON j.id=m.meeting
    WHERE ${where.map(condition => "(" + condition + ")").join(" AND ")} ORDER BY a.seq DESC LIMIT 31`)
    .all(...values);
  const operators = params.has("before") ? undefined
    : db.prepare("SELECT DISTINCT operator FROM admin_audit ORDER BY operator").all().map(row => row.operator);
  const checks = db.prepare(`SELECT time,outcome FROM receipt_checks
    WHERE job=? AND phase='compose' AND operator='system:auto-receipt' ORDER BY seq`);
  const retries = db.prepare("SELECT checks FROM meeting_receipt_retries WHERE meeting=?");
  return { operators, rows: rows.slice(0, 30).map(row => ({ ...row,
    outcome: row.change_reason || row.closure_job || row.change_seq !== null ? "applied" : "denied",
    ...(row.closure_job ? { checks: checks.all(row.closure_job), reserved: retries.get(row.closure_job)?.checks ?? null } : {}),
    employee_name: row.employee_name ?? (row.scope === "employee" && Object.hasOwn(employees, row.target)
      ? employees[row.target].name : null) })), next: rows.length > 30 ? rows[29].seq : null };
}

// Quote every field and keep spreadsheet applications from evaluating user-entered text.
export function csvLine(values) {
  return values.map(value => {
    let text = String(value);
    if (/^\s*[=+@-]|^[\t\r\n]/u.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }).join(",") + "\r\n";
}

export function adminAuditCsv(db, filters, exportedBy, source = "audit") {
  const history = source === "history";
  const readPage = history ? auditExportHistory : adminAudit;
  const params = new URLSearchParams(filters);
  if (!params.has("before")) params.set("before", Number.MAX_SAFE_INTEGER);
  // Validate filters before the response starts. Subsequent pages descend from this one.
  const first = readPage(db, params);
  if (history) params.set("completion", first.completion);
  const entry = db.prepare(`INSERT INTO audit_exports
    (started,exported_by,employee,filter_operator,outcome,from_jst,to_jst,before_seq,source,filter_exporter,filter_source,snapshot_completion,filter_job,filter_reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(Date.now(), exportedBy, params.get("employee") || null,
      history ? null : params.get("operator") || null, history ? null : params.get("outcome") || null,
      params.get("from") || null, params.get("to") || null, first.rows.length ? first.rows[0].seq + 1 : 0,
      source, history ? params.get("exported_by") || null : null, history ? params.get("source") || null : null,
      history ? first.completion : null, history ? null : params.get("job")?.trim() || null,
      history ? null : params.get("reason")?.trim() || null);
  let completedRows;
  function* pages() {
    let count = 0;
    yield "\uFEFF" + csvLine(history
      ? ["種別", "出力日時（日本時間）", "出力者", "対象社員", "抽出した操作の操作者", "操作結果", "抽出した履歴の出力者",
        "CSV対象開始（日本時間）", "CSV対象終了（日本時間）", "出力件数", "抽出した履歴の種別"]
      : ["日時（日本時間）", "操作者", "対象", "操作", "操作結果", "変更前", "変更後", "理由", "停止した依頼数"]);
    let page = first;
    while (true) {
      for (const event of page.rows) {
        count++;
        if (history) {
          const f = exportHistoryFields(event);
          yield csvLine([f.type, f.time, f.exporter, f.employee, f.operator, f.outcome, f.filterExporter, f.from, f.to, f.count, f.filterSource]);
        } else {
          const f = auditFields(event);
          yield csvLine([f.time, f.operator, f.target, f.action, f.outcome, f.before, f.after, f.reason, f.stopped]);
        }
      }
      if (!page.next) break;
      params.set("before", page.next);
      page = readPage(db, params);
    }
    completedRows = count;
  }
  return {
    lines: pages(),
    markSent() {
      if (completedRows === undefined) throw Error("CSVの生成が完了していません。");
      db.prepare(`UPDATE audit_exports SET completed=?,row_count=?,
        completion_seq=(SELECT max(completion_seq)+1 FROM audit_exports) WHERE seq=? AND completed IS NULL`)
        .run(Date.now(), completedRows, entry.lastInsertRowid);
    },
  };
}

export function auditExportHistory(db, params) {
  const where = ["seq<?"], values = [pageCursor(params)];
  const exporter = params.get("exported_by"), employee = params.get("employee");
  const source = params.get("source");
  if (source) {
    if (!["audit", "history"].includes(source)) throw new HubError(400, "出力種別が正しくありません。");
    where.push("source=?");
    values.push(source);
  }
  if (exporter) {
    where.push("exported_by=?");
    values.push(exporter);
  }
  if (employee) {
    where.push("employee=?");
    values.push(employee);
  }
  addPeriodFilter(params, "started", where, values);
  // A send can finish after the list is displayed. Keep its displayed count for pagination and download.
  const latestCompletion = db.prepare("SELECT coalesce(max(completion_seq),0) AS n FROM audit_exports").get().n;
  const completion = Math.min(pageCursor(params, "completion"), latestCompletion);
  const rows = db.prepare(`SELECT * FROM audit_exports WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT 31`).all(...values);
  const page = { completion, rows: rows.slice(0, 30).map(row => row.completion_seq > completion
    ? { ...row, completed: null, row_count: null } : row), next: rows.length > 30 ? rows[29].seq : null };
  if (!params.has("before")) {
    page.exporters = db.prepare("SELECT DISTINCT exported_by FROM audit_exports ORDER BY exported_by").all().map(r => r.exported_by);
    page.employees = db.prepare("SELECT DISTINCT employee FROM audit_exports WHERE employee IS NOT NULL ORDER BY employee").all().map(r => r.employee);
  }
  return page;
}

export function savedExportRows(db, seq, params, source = "history") {
  const receipt = db.prepare("SELECT * FROM audit_exports WHERE seq=? AND source=?").get(seq, source);
  if (!receipt) throw new HubError(404, "対象のCSV出力記録が見つかりません。");
  if (receipt.completed === null) throw new HubError(409, "このCSVの送信完了を確認できません。");

  // Only the page cursor comes from the viewer. All selection criteria belong to the saved CSV.
  const filters = new URLSearchParams({ before: Math.min(receipt.before_seq, pageCursor(params)) });
  const criteria = { employee: receipt.employee, from: receipt.from_jst, to: receipt.to_jst };
  if (source === "audit") {
    criteria.operator = receipt.filter_operator;
    criteria.outcome = receipt.outcome;
    criteria.job = receipt.filter_job;
    criteria.reason = receipt.filter_reason;
  } else {
    criteria.exported_by = receipt.filter_exporter;
    criteria.source = receipt.filter_source;
    criteria.completion = receipt.snapshot_completion;
  }
  for (const [key, value] of Object.entries(criteria)) {
    if (value !== null) filters.set(key, value);
  }
  if (source === "audit") {
    const { rows, next } = adminAudit(db, filters);
    return { rows, next };
  }
  const { rows, next } = auditExportHistory(db, filters);
  return { rows, next, legacyCounts: receipt.snapshot_completion === null };
}

export function stoppedDispatches(db, seq) {
  const change = db.prepare("SELECT * FROM member_changes WHERE seq=?").get(seq);
  if (!change) throw new HubError(404, "対象の変更履歴が見つかりません。");
  const enabled = change.action === "disable" ? db.prepare(`SELECT * FROM member_changes
    WHERE employee=? AND seq>? AND action='enable' ORDER BY seq LIMIT 1`).get(change.employee, seq) : null;
  const stopped = db.prepare(`SELECT j.id,j.company,s.attempts_at_stop FROM member_stopped_jobs s
    JOIN jobs j ON j.id=s.job WHERE s.change_seq=? ORDER BY j.created,j.id`).all(seq);
  const attempts = db.prepare(`SELECT dispatch_time,phase,hermes_run_id FROM attempts
    WHERE job_id=? ORDER BY dispatch_time,rowid`);
  const jobs = stopped.map(job => {
    const sends = attempts.all(job.id);
    return { ...job, sends, additional: sends.length - job.attempts_at_stop };
  });
  return { change, enabled: enabled ?? null, jobs };
}

export function setMemberActive(db, actor, input, operator) {
  if (typeof input.active !== "boolean") throw new HubError(400, "利用状態を指定してください。");
  return transaction(db, () => {
    const before = adminMember(db, actor);
    if (before.revision !== input.base) throw new HubError(409, "社員情報が変わりました。画面を開き直してください。");
    if (before.manual_active === input.active) return before;
    return updateEligibility(db,before,input.active,before.directory_active,input.active ? "enable" : "disable",input.reason,operator);
  });
}

// An identity sync calls this inside the same transaction as the directory update.
export function updateDirectoryEligibility(db,before,active,reason,operator) {
  if (before.directory_active === active) return before;
  return updateEligibility(db,before,before.manual_active,active,active ? "sync_enable" : "sync_disable",reason,operator);
}

function updateEligibility(db,before,manual,directory,action,reason,operator) {
  const active=manual && directory;
  db.prepare(`UPDATE memberships SET active=?,manual_active=?,directory_active=?,revision=revision+?,
    directory_revision=directory_revision+1 WHERE actor=?`)
    .run(Number(active),Number(manual),Number(directory),Number(active!==before.active),before.actor);
  if (!active && before.active && db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='weekly_schedules'").get())
    db.prepare("UPDATE weekly_schedules SET enabled=0 WHERE actor=? AND enabled=1").run(before.actor);
  const stopped=active || !before.active ? [] : db.prepare(`UPDATE jobs SET status='account_blocked' WHERE actor=?
    AND status IN ('scheduled','queued','dispatching','running','waiting','held','held_dispatched','source_waiting','split_waiting') RETURNING id`).all(before.actor);
  return recordMemberChange(db,operator,action,before,adminMember(db,before.actor),reason,stopped);
}

export function teamPermitsJob(db, job) {
  return !!db.prepare("SELECT 1 FROM permitted_job_teams WHERE id=?").get(job);
}

export function transfer(db, actor, input, operator) {
  const team = typeof input.team === "string" ? input.team.trim() : "";
  if (!team || team.length > 80 || /[\u0000-\u001f\u007f]/u.test(team))
    throw new HubError(400, "異動先の部門名を1〜80文字で入力してください。");
  return transaction(db, () => {
    const before = adminMember(db, actor);
    if (before.revision !== input.base) throw new HubError(409, "所属が更新されています。最新の所属を確認してください。");
    const responsibility = Object.hasOwn(input, "responsibility")
      ? typeof input.responsibility === "string" ? input.responsibility.trim() : null
      : before.responsibility;
    if (responsibility === null || responsibility.length > 120 || /[\u0000-\u001f\u007f]/u.test(responsibility))
      throw new HubError(400, "担当は120文字以内で入力してください。");
    const transferring = before.team !== team;
    if (!transferring && before.responsibility === responsibility) return before;
    db.prepare("UPDATE memberships SET team=?,responsibility=?,revision=revision+?,directory_revision=directory_revision+1 WHERE actor=?")
      .run(team, responsibility, Number(transferring), actor);
    // Waiting jobs retain their question. Answer admission rechecks the current team.
    const stopped = transferring ? db.prepare(`UPDATE jobs SET status='membership_blocked' WHERE actor=?
      AND status IN ('scheduled','queued','dispatching','running','held','held_dispatched','source_waiting','split_waiting')
      AND NOT EXISTS (SELECT 1 FROM permitted_job_teams a WHERE a.id=jobs.id) RETURNING id`).all(actor) : [];
    return recordMemberChange(db, operator, transferring ? "transfer" : "responsibility", before, adminMember(db, actor), input.reason, stopped);
  });
}
