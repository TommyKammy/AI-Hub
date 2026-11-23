import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renewalTeam } from "../fixtures.mjs";
import { recordAdminChange } from "../identity/memberships.mjs";
import { HubError, reasonText, transaction } from "../operations.mjs";
import { standardWorkflows } from "../../skills/workspace-tasks.mjs";
import { releases as renewalReleases } from "../../skills/renewal-brief/releases.mjs";

const renewal = {
  id: "renewal-brief",
  kind: "renewal",
  scope: renewalTeam,
  name: "更新商談の準備",
  source: "契約台帳・商談議事録",
  example: "更新商談の論点を確認して",
  output: "前提と確認事項を分けた更新商談メモ",
};
const packages = JSON.parse(readFileSync(new URL("./industry-packages.json", import.meta.url), "utf8"));
const procedureIds = [renewal.id, ...standardWorkflows.keys()];
const limits = { name: 120, source: 400, example: 400, output: 400, instruction: 20_000 };
const fields = "id,kind,scope,version,hash,content_hash,name,source,example,output,instruction,created_at,operator";
const sha256 = value => createHash("sha256").update(value).digest("hex");

function revisionHash(release) {
  return sha256(JSON.stringify([release.id, release.version, release.name, release.source,
    release.example, release.output, release.content_hash]));
}

function insertRelease(db, release, seed = false) {
  const { id, kind, scope, version, hash, content_hash, name, source, example, output,
    instruction, created_at = null, operator = null } = release;
  db.prepare(`INSERT INTO standard_procedure_releases(${fields}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ${seed ? "ON CONFLICT(id,version) DO NOTHING" : ""}`)
    .run(id, kind, scope, version, hash, content_hash, name, source, example, output, instruction, created_at, operator);
}

export function migrateStandardProcedures(db) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS standard_procedure_releases (
      id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('renewal','assistant')), scope TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0), hash TEXT NOT NULL, content_hash TEXT NOT NULL,
      name TEXT NOT NULL, source TEXT NOT NULL, example TEXT NOT NULL, output TEXT NOT NULL,
      instruction TEXT NOT NULL, created_at INTEGER, operator TEXT,
      PRIMARY KEY(id,version), UNIQUE(id,hash)
    );
    CREATE TABLE IF NOT EXISTS industry_procedure_imports (
      id TEXT PRIMARY KEY, package_id TEXT NOT NULL, package_version INTEGER NOT NULL, workflow TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS standard_procedure_changes (
      id TEXT NOT NULL, version INTEGER NOT NULL, base_version INTEGER NOT NULL,
      operator TEXT NOT NULL, time INTEGER NOT NULL, reason TEXT NOT NULL,
      PRIMARY KEY(id,version),
      FOREIGN KEY(id,version) REFERENCES standard_procedure_releases(id,version),
      FOREIGN KEY(id,base_version) REFERENCES standard_procedure_releases(id,version)
    );`);
    for (const release of renewalReleases.values()) {
      insertRelease(db, { ...renewal, ...release, content_hash: release.hash }, true);
    }
    for (const workflow of standardWorkflows.values()) {
      const instruction = readFileSync(new URL(`../../skills/${workflow.id}/SKILL.md`, import.meta.url), "utf8");
      if (sha256(instruction) !== workflow.hash) throw new Error("標準手順の初期版を確認してください。");
      insertRelease(db, { ...workflow, instruction, kind: "assistant", scope: "全社員", content_hash: workflow.hash }, true);
    }
  });
}

function verifiedRelease(release) {
  // Existing jobs pin the original body hashes. New revisions pin the editable metadata too.
  if (release.content_hash !== sha256(release.instruction) ||
      release.hash !== (release.operator === null ? release.content_hash : revisionHash(release)))
    throw new HubError(409, "標準手順の版を確認できません。");
  return release;
}

export function currentStandardProcedure(db, id) {
  const release = db.prepare(`SELECT ${fields} FROM standard_procedure_releases
    WHERE id=? ORDER BY version DESC LIMIT 1`).get(id);
  if (!release) throw new HubError(404, "標準手順が見つかりません。");
  return verifiedRelease(release);
}

export function listStandardProcedures(db) {
  const imported=db.prepare("SELECT id FROM industry_procedure_imports ORDER BY package_id,id").all();
  return [...procedureIds,...imported.map(row=>row.id)].map(id => currentStandardProcedure(db, id));
}

export function findStandardProcedureVersion(db, id, hash) {
  if (typeof hash !== "string") return null;
  const release = db.prepare(`SELECT ${fields} FROM standard_procedure_releases WHERE id=? AND hash=?`).get(id, hash);
  return release ? verifiedRelease(release) : null;
}

export function standardProcedureVersion(db, id, hash) {
  const release = findStandardProcedureVersion(db, id, hash);
  if (!release) throw new HubError(409, "受付時の標準手順版を確認できません。");
  return release;
}

export function standardProcedureAdministration(db, id) {
  const current = currentStandardProcedure(db, id);
  const versions = db.prepare(`SELECT ${fields} FROM standard_procedure_releases
    WHERE id=? AND version<=? ORDER BY version DESC`).all(id, current.version).map(verifiedRelease);
  const history = db.prepare(`SELECT version,base_version,operator,time,reason FROM standard_procedure_changes
    WHERE id=? AND version<=? ORDER BY version DESC`).all(id, current.version);
  return { ...current, versions, history };
}

function editedFields(input) {
  const result = {};
  for (const [field, max] of Object.entries(limits)) {
    const value = input[field];
    if (typeof value !== "string" || !value.trim() || value.length > max ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value) ||
        (field !== "instruction" && /[\r\n]/u.test(value)))
      throw new HubError(400, "標準手順の各項目と文字数を確認してください。");
    result[field] = field === "instruction" ? value : value.trim();
  }
  return result;
}

export function saveStandardProcedure(db, id, input, operator) {
  if (!input || !Number.isSafeInteger(input.base) || input.base < 1)
    throw new HubError(400, "編集を始めた標準手順の版を確認してください。");
  const edits = editedFields(input);
  const reason = reasonText(input.reason);
  return transaction(db, () => {
    const current = currentStandardProcedure(db, id);
    if (current.version !== input.base)
      throw new HubError(409, "標準手順が更新されました。最新の版を開き直してください。");
    if (Object.entries(edits).every(([field, value]) => current[field] === value)) return current;
    const release = { ...current, ...edits, version: current.version + 1, operator, created_at: Date.now(),
      content_hash: sha256(edits.instruction) };
    release.hash = revisionHash(release);
    insertRelease(db, release);
    db.prepare(`INSERT INTO standard_procedure_changes(id,version,base_version,operator,time,reason)
      VALUES(?,?,?,?,?,?)`).run(id, release.version, current.version, operator, release.created_at, reason);
    recordAdminChange(db, { operator, scope: "procedure", target: id, action: "会社標準手順の改訂",
      before: "v" + current.version, after: "v" + release.version, reason });
    return release;
  });
}

export function executionWorkflow(db, id) {
  if (typeof id !== "string") return null;
  if (standardWorkflows.has(id)) return id;
  return db.prepare("SELECT workflow FROM industry_procedure_imports WHERE id=?").get(id)?.workflow;
}

function importedId(pkg, item) {
  return `industry-${pkg.id}--${item.id}`;
}

export function industryPackages(db) {
  const rows = db.prepare("SELECT id FROM industry_procedure_imports").all();
  const installed = new Set(rows.map(row => row.id));
  return packages.map(pkg => ({
    ...pkg,
    procedures: pkg.procedures.map(item => ({ ...item, installed: installed.has(importedId(pkg, item)) })),
  }));
}

export function importIndustryProcedures(db, packageId, input, operator) {
  const pkg = packages.find(row => row.id === packageId);
  if (!pkg) throw new HubError(404, "業種パッケージが見つかりません。");
  if (input?.version !== pkg.version) throw new HubError(409, "パッケージを開き直してください。");

  const ids = input.procedures;
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
      !ids.every(id => pkg.procedures.some(item => item.id === id)))
    throw new HubError(400, "取り込む手順を選択してください。");

  return transaction(db, () => {
    const imported = [];
    const insert = db.prepare(`INSERT INTO industry_procedure_imports(id, package_id, package_version, workflow)
      VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING`);
    for (const item of pkg.procedures.filter(item => ids.includes(item.id))) {
      const id = importedId(pkg, item);
      if (!insert.run(id, pkg.id, pkg.version, "document-draft").changes) continue;
      const edits = editedFields(item);
      const release = {
        ...edits, id, kind: "assistant", scope: "全社員", version: 1, operator,
        created_at: Date.now(), content_hash: sha256(edits.instruction),
      };
      release.hash = revisionHash(release);
      insertRelease(db, release);
      recordAdminChange(db, { operator, scope: "procedure", target: id, action: "業種パッケージの取込",
        before: "未導入", after: "v1", reason: pkg.name + "パッケージ v" + pkg.version });
      imported.push(id);
    }
    return { imported };
  });
}
