import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { releases } from "../skills/renewal-brief/releases.mjs";

const id = "legacy-candidate-renewal";
const memo = "期末の更新確認。 [1] 承認日は未定。 [2]";

export function seedLegacyWorkspace(path) {
  if (process.env.AIHUB_VERIFY_LEGACY!=="1") return null;
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE jobs(id TEXT PRIMARY KEY, actor TEXT NOT NULL, request_key TEXT NOT NULL, company TEXT NOT NULL,
      ask TEXT NOT NULL, created INTEGER NOT NULL, skill_hash TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL,
      question TEXT, answer TEXT, memo TEXT, run_id TEXT, UNIQUE(actor,request_key))`);
    const [version] = releases.keys();
    db.prepare("INSERT INTO jobs VALUES(?,'sato','legacy-candidate-request','A社','旧契約の合成記録',1,?,'draft','done',NULL,NULL,?,'legacy-candidate-run')")
      .run(id,version,memo);
    return id;
  } finally {
    db.close();
  }
}

export async function verifyLegacyWorkspace(origin,id) {
  if (!id) return;
  const response = await fetch(origin+"/api/jobs/"+id);
  assert.equal(response.status,200);
  const job = await response.json();
  assert.equal(job.versions[0].memo,memo);
  assert.equal(job.sources[0].version,"11月10日版・更新条件 §2");
  assert.equal(job.adopted_version,null);
  assert.equal(job.skill_version,1);
  assert.equal(job.run_id,"legacy-candidate-run");
}
