import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renewalTeam } from "../../src/fixtures.mjs";
import { openHub } from "../../src/jobs/hub.mjs";
import { standardWorkflows } from "../../skills/workspace-tasks.mjs";
import { releases as renewalReleases } from "../../skills/renewal-brief/releases.mjs";
import { currentStandardProcedure, findStandardProcedureVersion, listStandardProcedures, saveStandardProcedure,
  standardProcedureAdministration, standardProcedureVersion } from "../../src/procedures/standard-procedures.mjs";

function edit(release, changes) {
  const { name, source, example, output, instruction, version } = release;
  return { name, source, example, output, instruction, base: version, reason: "手順を見直したため", ...changes };
}

test("5種類の会社標準手順と旧更新商談版を、記録済みのハッシュで解決できる", t => {
  const hub = openHub(":memory:");
  t.after(() => hub.close());
  const { db } = hub;
  assert.deepEqual(listStandardProcedures(db).map(item => item.id),
    ["renewal-brief", "csv-summary", "quote-comparison", "source-answer", "document-draft"]);
  const renewal = standardProcedureAdministration(db, "renewal-brief");
  assert.equal(renewal.scope, renewalTeam);
  assert.equal(renewal.version, 2);
  assert.deepEqual(renewal.versions.map(item => item.version), [2, 1]);
  for (const release of renewalReleases.values()) {
    const pinned = standardProcedureVersion(db, "renewal-brief", release.hash);
    assert.equal(pinned.instruction, release.instruction);
    assert.equal(pinned.content_hash, release.hash);
  }
  for (const { id, hash } of standardWorkflows.values()) {
    const release = currentStandardProcedure(db, id);
    assert.equal(release.scope, "全社員");
    assert.equal(release.hash, hash);
    assert.deepEqual(standardProcedureVersion(db, id, hash), release);
  }
  assert.equal(findStandardProcedureVersion(db, "csv-summary", renewal.hash), null);
  assert.throws(() => standardProcedureVersion(db, "csv-summary", renewal.hash), { status: 409 });
});

test("手順の独立した改訂と監査履歴は再起動後も保持される", t => {
  const directory = mkdtempSync(join(tmpdir(), "hub-standard-procedures-"));
  const path = join(directory, "hub.sqlite");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writer = openHub(path);
  const concurrent = openHub(path);
  const before = listStandardProcedures(writer.db);
  try {
    for (const old of before) {
      const result = saveStandardProcedure(writer.db, old.id, edit(old, { name: old.name + " 改訂", scope: "別部門" }), "operator");
      assert.equal(result.scope, old.scope);
      assert.equal(result.version, old.version + 1);
      assert.equal(result.content_hash, old.content_hash);
      assert.notEqual(result.hash, old.hash);
      const [history] = standardProcedureAdministration(writer.db, old.id).history;
      assert.deepEqual({ ...history }, { version: result.version, base_version: old.version,
        operator: "operator", time: result.created_at, reason: "手順を見直したため" });
      const audit = writer.db.prepare(`SELECT before_value,after_value,change_reason FROM admin_audit
        WHERE scope='procedure' AND target=? AND operator='operator'`).get(old.id);
      assert.deepEqual({ ...audit }, { before_value: "v" + old.version, after_value: "v" + result.version,
        change_reason: "手順を見直したため" });
      assert.throws(() => saveStandardProcedure(concurrent.db, old.id, edit(old), "concurrent"), { status: 409 });
      assert.deepEqual(standardProcedureVersion(concurrent.db, old.id, old.hash), old);
    }
    const current = currentStandardProcedure(writer.db, "csv-summary");
    const instruction = current.instruction + "\n合計には対象外の金額を含めない。\n";
    const result = saveStandardProcedure(writer.db, current.id, edit(current, { instruction }), "operator");
    assert.equal(result.instruction, instruction);
    assert.equal(result.content_hash, createHash("sha256").update(instruction).digest("hex"));
    assert.deepEqual(standardProcedureAdministration(writer.db, current.id).versions.map(item => item.version), [3, 2, 1]);
  } finally {
    concurrent.close();
    writer.close();
  }
  const reopened = openHub(path);
  try {
    for (const old of before) {
      const saved = standardProcedureAdministration(reopened.db, old.id);
      assert.equal(saved.name, old.name + " 改訂");
      assert.equal(saved.history.length, old.id === "csv-summary" ? 2 : 1);
      assert.deepEqual(standardProcedureVersion(reopened.db, old.id, old.hash), old);
    }
  } finally {
    reopened.close();
  }
});

test("入力エラーと監査履歴への書き込み失敗では改訂を残さない", t => {
  const hub = openHub(":memory:");
  t.after(() => hub.close());
  const { db } = hub;
  const old = currentStandardProcedure(db, "document-draft");
  for (const invalid of [{ base: "1" }, { reason: "" }, { instruction: " " }, { instruction: "a".repeat(20_001) },
    { name: "見出し\n改行" }, { instruction: "不正な制御文字\0" }]) {
    assert.throws(() => saveStandardProcedure(db, old.id, edit(old, invalid), "operator"), { status: 400 });
  }
  assert.throws(() => saveStandardProcedure(db, "nonexistent", edit(old), "operator"), { status: 404 });
  assert.deepEqual(saveStandardProcedure(db, old.id, edit(old), "operator"), old);
  assert.deepEqual(standardProcedureAdministration(db, old.id).history, []);
  db.exec(`CREATE TRIGGER reject_standard_audit BEFORE INSERT ON admin_audit WHEN NEW.scope='procedure'
    BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;`);
  assert.throws(() => saveStandardProcedure(db, old.id, edit(old, { output: "改訂内容" }), "operator"), /test audit failure/);
  assert.deepEqual(currentStandardProcedure(db, old.id), old);
  assert.deepEqual(standardProcedureAdministration(db, old.id).history, []);
  db.exec("DROP TRIGGER reject_standard_audit");
  assert.equal(saveStandardProcedure(db, old.id, edit(old, { output: "改訂内容" }), "operator").version, 2);
});
