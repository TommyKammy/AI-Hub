import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createWorker, openHub } from "../../src/jobs/hub.mjs";
import { adminAudit, adminAuditCsv, auditExportHistory, member, memberHistory, migrateMemberships, recordAdminDenial, savedExportRows, setMemberActive, stoppedDispatches, transfer } from "../../src/identity/memberships.mjs";
import { makeDraft, publishProcedure, publishedFor, submitDraft } from "../../src/procedures/procedures.mjs";

test("異動後は古い回答画面・キュー・再開で所属を照合し、再起動後も所属と停止状態を維持する", async t => {
  const dir = mkdtempSync(join(tmpdir(), "ai-hub-members-"));
  const path = join(dir, "hub.sqlite");
  let hub = openHub(path);
  t.after(() => { hub.close(); rmSync(dir, { recursive: true }); });
  const seed = { ask: "更新商談", company: "A社" };
  const source = hub.create("sato", seed, randomUUID());
  hub.db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(source);
  const p = makeDraft(hub.db, "sato", source, "meeting");
  submitDraft(hub.db, "sato", source, p.hash);
  publishProcedure(hub.db, p.id, p.hash, "aoki");

  const input = { ...seed, company: "B社", procedure_id: p.id };
  const waiting = hub.create("tanaka", input, randomUUID());
  hub.db.prepare("UPDATE jobs SET status='waiting' WHERE id=?").run(waiting);
  const queued = hub.create("tanaka", input, randomUUID());
  const held = hub.create("tanaka", { ...seed, company: "B社" }, randomUUID());
  hub.db.prepare("UPDATE jobs SET status='held' WHERE id=?").run(held);
  const sato = hub.create("sato", { ...seed, procedure_id: p.id }, randomUUID());
  const old = member(hub.db, "tanaka");
  assert.throws(() => transfer(hub.db, "tanaka", { base: old.revision, team: "  ", reason: "動作確認" }, "admin"), { status: 400 });
  const next = transfer(hub.db, "tanaka", { base: old.revision, team: "業務企画部", reason: "動作確認" }, "admin");
  assert.throws(() => transfer(hub.db, "tanaka", { base: old.revision, team: "別部門", reason: "動作確認" }, "admin"), { status: 409 });
  hub.close();
  hub = openHub(path);
  assert.equal(member(hub.db, "tanaka").team, next.team);
  assert.deepEqual(publishedFor(hub.db, "tanaka"), []);
  assert.equal(publishedFor(hub.db, "sato")[0].id, p.id);
  assert.throws(() => hub.create("tanaka", input, randomUUID()), { status: 403 });
  assert.throws(() => hub.create("tanaka", { ...seed, company: "B社" }, randomUUID()), { status: 403 });
  assert.equal(hub.get("tanaka", waiting).team_denied, true);
  hub.answer("tanaka", waiting, { answer: "後日確認" });
  hub.answer("tanaka", waiting, { answer: "後日確認" });
  assert.equal(hub.get("tanaka", waiting).answer, "後日確認");
  for (const id of [waiting, queued, held]) {
    assert.equal(hub.get("tanaka", id).status, "membership_blocked");
    assert.throws(() => hub.resume("tanaka", id), { status: 403 });
  }
  const calls = [];
  const tick = createWorker(hub.db, async (actor, route, options) => {
    calls.push([actor, options.headers["Idempotency-Key"]]);
    return { run_id: randomUUID() };
  });
  await tick();
  assert.deepEqual(calls, [["sato", sato + "-review"]]);
  transfer(hub.db, "tanaka", { base: next.revision, team: old.team, reason: "動作確認" }, "admin");
  assert.equal(hub.get("tanaka", waiting).status, "membership_blocked");
  assert.equal(publishedFor(hub.db, "tanaka")[0].id, p.id);
  assert.equal(hub.db.prepare("SELECT count(*) AS n FROM attempts WHERE job_id IN (?,?,?)").get(waiting, queued, held).n, 0);
});

test("既存社員を有効で移行し、停止・再起動・再有効化をまたいで未完了の依頼を再送しない", async t => {
  const dir = mkdtempSync(join(tmpdir(), "ai-hub-access-"));
  const path = join(dir, "hub.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE memberships(actor TEXT PRIMARY KEY,team TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
    INSERT INTO memberships VALUES('tanaka','営業企画部',7)`);
  legacy.close();
  let hub = openHub(path);
  t.after(() => { hub.close(); rmSync(dir, { recursive: true }); });
  const first = member(hub.db, "tanaka");
  assert.equal(first.active, true);
  assert.equal(first.revision, 7);
  const input = { ask: "更新商談", company: "B社" };
  const jobs = new Map();
  for (const status of ["waiting", "queued", "dispatching", "running", "held", "held_dispatched", "done", "membership_blocked", "unknown"]) {
    const id = hub.create("tanaka", input, randomUUID());
    hub.db.prepare("UPDATE jobs SET status=? WHERE id=?").run(status, id);
    jobs.set(status, id);
  }
  assert.throws(() => setMemberActive(hub.db, "tanaka", { base: 7, active: "false", reason: "動作確認" }, "admin"), { status: 400 });
  const disabled = setMemberActive(hub.db, "tanaka", { base: first.revision, active: false, reason: "動作確認" }, "admin");
  assert.equal(disabled.active, false);
  assert.throws(() => setMemberActive(hub.db, "tanaka", { base: first.revision, active: true, reason: "動作確認" }, "admin"), { status: 409 });
  assert.throws(() => transfer(hub.db, "tanaka", { base: first.revision, team: "別部門", reason: "動作確認" }, "admin"), { status: 409 });
  hub.close();
  hub = openHub(path);
  const denied = { status: 403, code: "employee_disabled" };
  assert.throws(() => hub.create("tanaka", input, randomUUID()), denied);
  assert.throws(() => hub.get("tanaka", jobs.get("done")), denied);
  assert.throws(() => hub.answer("tanaka", jobs.get("waiting"), { answer: "確認" }), denied);
  assert.throws(() => makeDraft(hub.db, "tanaka", jobs.get("done"), "meeting"), denied);
  assert.throws(() => publishedFor(hub.db, "tanaka"), denied);
  const calls = [];
  const tick = createWorker(hub.db, async actor => { calls.push(actor); return { run_id: randomUUID() }; });
  const sato = hub.create("sato", { ...input, company: "A社" }, randomUUID());
  await tick();
  assert.equal(hub.get("sato", sato).status, "running");
  setMemberActive(hub.db, "tanaka", { base: disabled.revision, active: true, reason: "動作確認" }, "admin");
  await tick();
  for (const [status, id] of jobs) {
    const retained = ["done", "membership_blocked", "unknown"].includes(status);
    assert.equal(hub.get("tanaka", id).status, retained ? status : "account_blocked");
  }
  assert.ok(calls.every(actor => actor === "sato"));
  assert.equal(hub.get("tanaka", jobs.get("waiting")).answer, null);
  assert.throws(() => hub.resume("tanaka", jobs.get("held")), { status: 409 });
});

test("Hermesの受付中に停止・再有効化しても、遅れて届いた実行IDで旧依頼を再開しない", async t => {
  const hub = openHub(":memory:");
  t.after(() => hub.close());
  const input = { ask: "更新商談", company: "B社" };
  const id = hub.create("tanaka", input, randomUUID());
  const sent = [];
  const ack = Promise.withResolvers();
  const tick = createWorker(hub.db, async (actor, path, options) => {
    sent.push(options.headers["Idempotency-Key"]);
    return ack.promise;
  });
  const pending = tick();
  assert.equal(hub.get("tanaka", id).status, "dispatching");
  const stopped = setMemberActive(hub.db, "tanaka", { base: 1, active: false, reason: "動作確認" }, "admin");
  setMemberActive(hub.db, "tanaka", { base: stopped.revision, active: true, reason: "動作確認" }, "admin");
  ack.resolve({ run_id: "already-accepted" });
  await pending;
  await tick();
  assert.deepEqual(sent, [id + "-review"]);
  assert.equal(hub.get("tanaka", id).status, "account_blocked");
  assert.equal(hub.get("tanaka", id).run_id, "already-accepted");
});

test("社員管理の履歴は確定した変更と一体で記録し、停止時の送信数と最初の再有効化を保持する", t => {
  const hub = openHub(":memory:"), db = hub.db;
  t.after(() => hub.close());
  const input = { company: "B社", ask: "商談" };
  const id = hub.create("tanaka", input, randomUUID());
  const list = employee => memberHistory(db, new URLSearchParams({ employee })).rows;
  assert.deepEqual(list("tanaka"), []);
  for (const reason of [undefined, "  ", "a".repeat(241)]) {
    assert.throws(() => setMemberActive(db, "tanaka", { base: 1, active: false, reason }, "admin"), { status: 400 });
    assert.equal(hub.get("tanaka", id).status, "queued");
    assert.equal(member(db, "tanaka").revision, 1);
    assert.deepEqual(list("tanaka"), []);
  }
  assert.throws(() => transfer(db, "tanaka", { base: 1, team: "企画" }, "admin"), { status: 400 });
  setMemberActive(db, "tanaka", { base: 1, active: false, reason: " 権限点検 ", operator: "別人" }, "admin");
  setMemberActive(db, "tanaka", { base: 2, active: false, reason: "再クリック" }, "admin");
  assert.throws(() => setMemberActive(db, "tanaka", { base: 1, active: true, reason: "古い画面" }, "admin"), { status: 409 });
  setMemberActive(db, "tanaka", { base: 2, active: true, reason: "点検完了" }, "admin");
  const [enabled, stopped] = list("tanaka");
  assert.deepEqual([stopped.reason, stopped.operator, stopped.employee, stopped.before_active, stopped.after_active],
    ["権限点検", "admin", "tanaka", 1, 0]);
  assert.equal(list("tanaka").length, 2);
  assert.deepEqual(list("sato"), []);
  assert.equal(stoppedDispatches(db, stopped.seq).jobs[0].additional, 0);
  // An attempt without a returned run ID must still count. Use the same timestamp as the change.
  db.prepare("INSERT INTO attempts(job_id,phase,dispatch_time) VALUES(?,'review',?)").run(id, stopped.time);
  setMemberActive(db, "tanaka", { base: 3, active: false, reason: "再点検" }, "admin");
  setMemberActive(db, "tanaka", { base: 4, active: true, reason: "再点検完了" }, "admin");
  const trace = stoppedDispatches(db, stopped.seq);
  assert.equal(trace.enabled.seq, enabled.seq);
  assert.deepEqual(trace.jobs.map(j => [j.id, j.additional, j.sends[0].hermes_run_id]), [[id, 1, null]]);
  assert.throws(() => stoppedDispatches(db, 999), { status: 404 });
  for (let i=0; i<32; i++)
    transfer(db, "sato", { base: i+1, team: "部門" + i, reason: "配属変更" }, "admin");
  const params = new URLSearchParams({ employee: "sato" });
  const page = memberHistory(db, params);
  assert.equal(page.rows.length, 30);
  params.set("before", page.next);
  const rest = memberHistory(db, params);
  assert.equal(rest.next, null);
  assert.equal(rest.rows.length, 2);
  assert.deepEqual([rest.rows[1].before_team, rest.rows[1].after_team], ["営業企画部", "部門0"]);
});

test("既存の変更と拒否を一つの順序でページ送りし、再起動後も重複しない", t => {
  const hub = openHub(":memory:"), { db } = hub;
  t.after(() => hub.close());
  db.exec("DROP TRIGGER audit_member_change; DROP TABLE admin_audit");
  setMemberActive(db, "tanaka", { base: 1, active: false, reason: "担当確認" }, "aoki");
  migrateMemberships(db);
  for (let i = 0; i < 31; i++) recordAdminDenial(db, "mori", "employee", "tanaka", "enable");
  recordAdminDenial(db, "mori", "model", "tanaka", "stop");
  setMemberActive(db, "tanaka", { base: 2, active: true, reason: "確認完了" }, "aoki");
  migrateMemberships(db);
  const params = new URLSearchParams({ employee: "tanaka" });
  const first = adminAudit(db, params);
  params.set("before", first.next);
  const last = adminAudit(db, params);
  const rows = [...first.rows, ...last.rows];
  assert.equal(first.rows.length, 30);
  assert.equal(last.next, null);
  assert.equal(rows.length, 33);
  assert.equal(new Set(rows.map(e => e.seq)).size, 33);
  assert.deepEqual(rows.filter(e => e.outcome === "applied").map(e => [e.action, e.reason]),
    [["enable", "確認完了"], ["disable", "担当確認"]]);
  assert.ok(rows.slice(1, -1).every(e => e.outcome === "denied" && e.operator === "mori" && e.change_seq === null));
  assert.equal(adminAudit(db, new URLSearchParams()).rows[1].scope, "model");
});

test("監査の条件をページ送りの前に適用し、日本時間の開始秒・終了秒を含める", t => {
  const hub = openHub(":memory:"), { db } = hub;
  t.after(() => hub.close());
  const midnight = Date.parse("2026-02-28T00:00:00+09:00");
  const insert = db.prepare("INSERT INTO admin_audit(time,operator,scope,target,action) VALUES(?,?,?,?,?)");
  const denied = (offset, actor = "mori", target = "tanaka") =>
    Number(insert.run(midnight + offset, actor, "employee", target, "disable").lastInsertRowid);
  const previous = denied(-1);
  const ids = Array.from({ length: 31 }, (_, i) => denied(i));
  ids.push(denied(999));
  const later = denied(1000);
  denied(0, "mori", "sato");
  denied(0, "admin"); // Historical account ID.
  setMemberActive(db, "tanaka", { base: 1, active: false, reason: "確認" }, "aoki");
  db.prepare("UPDATE admin_audit SET time=? WHERE change_seq IS NOT NULL").run(midnight);
  const read = filters => adminAudit(db, new URLSearchParams(filters));
  const at = "2026-02-28T00:00", filters = { employee: "tanaka", operator: "mori", outcome: "denied", from: at, to: at };
  const first = read(filters), second = read({ ...filters, before: first.next });
  assert.equal(first.rows.length, 30);
  assert.equal(second.next, null);
  assert.deepEqual([...first.rows, ...second.rows].map(x => x.seq), ids.reverse());
  assert.deepEqual(first.operators, ["admin", "aoki", "mori"]);
  assert.deepEqual(read({ ...filters, operator: "aoki", outcome: "applied" }).rows.map(x => x.action), ["disable"]);
  assert.equal(read({ ...filters, operator: "aoki" }).rows.length, 0);
  assert.equal(read({ ...filters, from: "2026-02-28T00:00:01", to: "" }).rows[0].seq, later);
  assert.equal(read({ ...filters, from: "", to: "2026-02-27T23:59:59" }).rows[0].seq, previous);
  for (const invalid of [{ from: "2026-02-30T03:15" }, { to: "abc" }, { from: "2026-02-28T24:00" },
    { from: "2026-02-28T00:01", to: at }, { outcome: "other" }])
    assert.throws(() => read(invalid), { status: 400 });
});

test("監査CSVは一覧の先頭を固定し、絞り込みに一致する未表示ページも同じ順序で出力する", t => {
  const hub = openHub(":memory:"), { db } = hub;
  t.after(() => hub.close());
  // Use the reason as a unique marker across pages, including a quoted multiline CSV field.
  const reasons = [];
  for (let n = 1; n <= 34; n++) {
    const reason = n === 1 ? '=確認,"記録"\n二行目' : "確認 " + n;
    transfer(db, "tanaka", { base: n, team: "部門" + n, reason }, "aoki");
    recordAdminDenial(db, "mori", "employee", "tanaka", "disable");
    reasons.unshift(reason);
  }
  const filters = new URLSearchParams({ employee: "tanaka", outcome: "applied", operator: "aoki" });
  filters.set("before", adminAudit(db, filters).rows[0].seq + 1);
  transfer(db, "tanaka", { base: 35, team: "次の部門", reason: "表示後の操作" }, "aoki");
  const csv = adminAuditCsv(db, filters, "mori");
  const history = () => auditExportHistory(db, new URLSearchParams()).rows;
  assert.throws(() => csv.markSent());
  assert.equal(history()[0].row_count, null);
  const [header, ...lines] = csv.lines;
  csv.markSent();
  assert.deepEqual([history()[0].exported_by, history()[0].filter_operator, history()[0].row_count], ["mori", "aoki", 34]);
  assert.ok(header.startsWith("\uFEFF"));
  assert.equal(lines.length, reasons.length);
  for (const [i, reason] of reasons.entries()) {
    const cell = i === reasons.length - 1 ? `'=確認,""記録""\n二行目` : reason;
    assert.ok(lines[i].endsWith('"' + cell + '","0"\r\n'));
  }
  const drillDown = (params = {}) => savedExportRows(db, history()[0].seq, new URLSearchParams(params), "audit");
  transfer(db, "tanaka", { base: 36, team: "別部門", reason: "出力後の操作" }, "aoki");
  const first = drillDown({before: "999999", outcome: "denied", operator: "mori", employee: "sato"});
  assert.equal(first.rows.length, 30);
  const second = drillDown({before: first.next});
  assert.deepEqual([...first.rows, ...second.rows].map(e => e.reason), reasons);
  assert.equal(second.next, null);
  assert.throws(() => drillDown({before: "abc"}), {status: 400});
  filters.set("before", 0);
  const empty = adminAuditCsv(db, filters, "aoki");
  assert.deepEqual([...empty.lines], [header]);
  empty.markSent();
  assert.equal(history()[0].row_count, 0);
  assert.deepEqual(drillDown(), {rows: [], next: null});
  const interrupted = adminAuditCsv(db, filters, "mori");
  assert.throws(() => drillDown(), {status: 409});
  interrupted.lines.next();
  interrupted.lines.return();
  assert.equal(history()[0].completed, null);
  assert.equal(history()[0].row_count, null);
  filters.set("from", "invalid");
  assert.throws(() => adminAuditCsv(db, filters, "mori"), { status: 400 });
  assert.equal(history().length, 3);
});

test("出力履歴は出力者・指定社員・出力開始時刻を組み合わせ、全件出力と期間外を除いてページ送りする", t => {
  const hub = openHub(":memory:"), { db } = hub;
  t.after(() => hub.close());
  const midnight = Date.parse("2026-11-22T00:00:00+09:00"), at = "2026-11-22T00:00:00";
  const insert = db.prepare(`INSERT INTO audit_exports
    (started,exported_by,employee,filter_operator,from_jst,to_jst,before_seq) VALUES(?,?,?,'aoki','2025-01-01T00:00','2025-01-01T23:59',0)`);
  const add = (ms, actor = "mori", employee = "tanaka") => Number(insert.run(midnight + ms, actor, employee).lastInsertRowid);
  const before = add(-1), ids = Array.from({ length: 31 }, (_, i) => add(i));
  ids.push(add(999)); const after = add(1000);
  add(0, "aoki"); add(0, "mori", "sato"); add(0, "mori", null);
  const read = filters => auditExportHistory(db, new URLSearchParams(filters));
  const conditions = { exported_by: "mori", employee: "tanaka", from: at, to: at };
  const first = read(conditions), second = read({ ...conditions, before: first.next });
  assert.deepEqual(first.exporters, ["aoki", "mori"]);
  assert.deepEqual(first.employees, ["sato", "tanaka"]);
  assert.deepEqual([...first.rows, ...second.rows].map(e => e.seq), ids.reverse());
  assert.equal(first.rows.length, 30); assert.equal(second.next, null);
  assert.deepEqual(read({ ...conditions, from: "", to: "2026-11-21T23:59:59" }).rows.map(e => e.seq), [before]);
  assert.deepEqual(read({ ...conditions, from: "2026-11-22T00:00:01", to: "" }).rows.map(e => e.seq), [after]);
  assert.throws(() => read({ ...conditions, from: "2026-11-22T00:01" }), { status: 400 });
  assert.throws(() => read({ to: "invalid" }), { status: 400 });
});

test("履歴CSVは全ページで一覧時点の件数を保持し、同じ出力者による今回と後続の保存を除く", t => {
  const hub = openHub(":memory:"), { db } = hub;
  t.after(() => hub.close());
  const all = new URLSearchParams(), pending = adminAuditCsv(db, all, "aoki");
  for (let i = 0; i < 31; i++) {
    const csv = adminAuditCsv(db, all, "aoki");
    [...csv.lines]; csv.markSent();
  }
  const filters = new URLSearchParams({ exported_by: "aoki" });
  const page = auditExportHistory(db, filters);
  filters.set("before", page.rows[0].seq + 1);
  filters.set("completion", page.completion);
  [...pending.lines]; pending.markSent();
  const open = () => adminAuditCsv(db, filters, "aoki", "history");
  const first = open(), later = open();
  for (const csv of [first, later]) {
    const [header, ...rows] = csv.lines;
    csv.markSent();
    assert.ok(header.startsWith("\uFEFF"));
    assert.equal(rows.length, 32);
    assert.ok(rows.slice(0, -1).every(line => line.endsWith(',"0",""\r\n')));
    assert.ok(rows.at(-1).endsWith(',"送信完了未確認",""\r\n'));
    assert.ok(rows.every(line => line.startsWith('"CSV出力",')));
  }
  const unfiltered = adminAuditCsv(db, all, "aoki", "history");
  const [, ...rows] = unfiltered.lines;
  assert.equal(rows.length, 34);
  assert.equal(rows.filter(line => line.startsWith('"出力履歴のCSV保存",')).length, 2);
  unfiltered.markSent();
  const empty = adminAuditCsv(db, new URLSearchParams({before:"0"}), "aoki", "history");
  assert.equal([...empty.lines].length, 1); empty.markSent();
  assert.equal(auditExportHistory(db, all).rows[0].row_count, 0);
});

test("履歴の種別で全ページを絞り、保存記録に選択した種別を残す", t => {
  const hub = openHub(":memory:"), { db } = hub;
  t.after(() => hub.close());
  const insert = db.prepare("INSERT INTO audit_exports(started,exported_by,employee,source,before_seq) VALUES(0,?,?,?,0)");
  const ids = [];
  for (let i = 0; i < 32; i++) {
    insert.run("aoki", "tanaka", "audit");
    ids.unshift(Number(insert.run("aoki", "tanaka", "history").lastInsertRowid));
  }
  insert.run("mori", "tanaka", "history");
  insert.run("aoki", null, "history");
  const filters = new URLSearchParams({ source: "history", exported_by: "aoki", employee: "tanaka" });
  const first = auditExportHistory(db, filters);
  const second = auditExportHistory(db, new URLSearchParams([...filters, ["before", String(first.next)]]));
  assert.deepEqual([...first.rows, ...second.rows].map(e => e.seq), ids);
  const csv = adminAuditCsv(db, filters, "aoki", "history");
  const [, ...rows] = csv.lines;
  csv.markSent();
  assert.equal(rows.length, 32);
  assert.ok(rows.every(line => line.startsWith('"出力履歴のCSV保存",')));
  const receipt = auditExportHistory(db, filters).rows[0];
  assert.deepEqual([receipt.filter_source, receipt.filter_exporter, receipt.row_count], ["history", "aoki", 32]);
  filters.set("source", "audit");
  assert.ok(auditExportHistory(db, filters).rows.every(e => e.source === "audit"));
  filters.set("source", "unknown");
  assert.throws(() => auditExportHistory(db, filters), {status: 400});
  assert.throws(() => adminAuditCsv(db, filters, "aoki", "history"), {status: 400});
  assert.equal(auditExportHistory(db, new URLSearchParams()).rows[0].seq, receipt.seq);
});

test("保存記録を開くと保存した全ページと当時の件数を再現し、後続の同条件出力を除く", t => {
  const hub = openHub(":memory:"), { db } = hub;
  t.after(() => hub.close());
  const params = new URLSearchParams({ employee: "tanaka" });
  const latest = () => auditExportHistory(db, new URLSearchParams()).rows[0];
  function finish(csv) {
    const lines = [...csv.lines];
    csv.markSent();
    return lines.slice(1);
  }
  const pending = adminAuditCsv(db, params, "mori");
  const ids = [latest().seq];
  for (let i = 0; i < 31; i++) {
    finish(adminAuditCsv(db, params, "mori"));
    ids.unshift(latest().seq);
  }
  const filters = new URLSearchParams({ exported_by: "mori", source: "audit", employee: "tanaka" });
  filters.set("completion", auditExportHistory(db, filters).completion);
  // The oldest export completes after display, before save.
  finish(pending);
  finish(adminAuditCsv(db, params, "aoki"));
  const save = adminAuditCsv(db, filters, "aoki", "history");
  const id = latest().seq;
  const view = (query = {}) => savedExportRows(db, id, new URLSearchParams(query));
  assert.throws(() => view(), {status: 409});
  const lines = finish(save);
  assert.equal(lines.length, ids.length);
  assert.ok(lines.at(-1).includes("送信完了未確認"));
  finish(adminAuditCsv(db, params, "mori"));
  const first = view({ exported_by: "aoki", source: "history", completion: "99999", before: "99999" });
  assert.equal(first.legacyCounts, false);
  const second = view({ before: first.next });
  assert.deepEqual([...first.rows, ...second.rows].map(row => row.seq), ids);
  assert.equal(second.next, null);
  assert.equal(second.rows.at(-1).completed, null);
  assert.equal(second.rows.at(-1).row_count, null);
  assert.throws(() => view({before: "-1"}), {status: 400});
  assert.throws(() => savedExportRows(db, ids[0], params), {status: 404});
  assert.throws(() => savedExportRows(db, 999999, params), {status: 404});
  // Older receipts retained all selection criteria and the upper row bound, but not the count snapshot.
  db.prepare("UPDATE audit_exports SET snapshot_completion=NULL WHERE seq=?").run(id);
  const legacy = view({before: first.next});
  assert.ok(legacy.legacyCounts);
  assert.deepEqual(legacy.rows.map(row => row.seq), ids.slice(30));
  assert.equal(legacy.rows.at(-1).row_count, 0);
  finish(adminAuditCsv(db, new URLSearchParams({before: "0"}), "aoki", "history"));
  assert.deepEqual(savedExportRows(db, latest().seq, params), {rows: [], next: null, legacyCounts: false});
});
