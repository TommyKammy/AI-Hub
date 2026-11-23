import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeMember } from "../identity/memberships.mjs";
import { HubError, transaction } from "../operations.mjs";

export function migrateEmployeeProfile(db) {
  transaction(db,()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS employee_preferences(
      id TEXT PRIMARY KEY,actor TEXT NOT NULL,project TEXT,source_job TEXT,source_version INTEGER,request_key TEXT,content TEXT,
      revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER);
      CREATE INDEX IF NOT EXISTS employee_preference_owner ON employee_preferences(actor,updated_at)`);
    const columns=db.prepare("PRAGMA table_info(employee_preferences)").all().map(column=>column.name);
    if (!columns.includes("source_version")) db.exec("ALTER TABLE employee_preferences ADD COLUMN source_version INTEGER");
    if (!columns.includes("request_key")) db.exec("ALTER TABLE employee_preferences ADD COLUMN request_key TEXT");
    db.exec(`DROP INDEX IF EXISTS employee_preference_origin;
      CREATE UNIQUE INDEX IF NOT EXISTS employee_legacy_preference_origin ON employee_preferences(actor,source_job)
        WHERE source_job IS NOT NULL AND source_version IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS employee_answer_preference_request ON employee_preferences(actor,request_key)
        WHERE request_key IS NOT NULL`);
  });
}

export function canUseProfileProject(db, actor, project) {
  const employee=activeMember(db,actor);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_members'").get()) return false;
  return Boolean(db.prepare(`SELECT 1 FROM work_projects p WHERE p.id=? AND p.team=? AND (
    (p.revision=0 AND p.actor=?) OR EXISTS(
      SELECT 1 FROM project_members m WHERE m.project=p.id AND m.actor=? AND m.member_revision=?))`)
    .get(project,employee.team,actor,actor,employee.revision));
}

export function employeePreferences(db, actor) {
  activeMember(db,actor);
  return db.prepare(`SELECT id,project,source_job,source_version,content,revision,updated_at FROM employee_preferences
    WHERE actor=? AND deleted_at IS NULL ORDER BY updated_at,id`).all(actor)
    .filter(item=>!item.project || canUseProfileProject(db,actor,item.project));
}

export function profileProjection(db, actor, project, snapshot) {
  const managed=Boolean(db.prepare("SELECT 1 FROM employee_preferences WHERE actor=? LIMIT 1").get(actor));
  const preferences=managed ? employeePreferences(db,actor)
    .filter(item=>!snapshot || snapshot.some(entry=>entry.id===item.id && entry.revision===item.revision)) : [];
  const bullet=item=>"- "+item.content.replace(/\r?\n/g," ");
  const user=preferences.filter(item=>!item.project).map(bullet).join("\n");
  const memory=project ? preferences.filter(item=>item.project===project).map(bullet).join("\n") : "";
  return {managed,user,memory};
}

export function writeProfileFiles(db, actor, dataDir) {
  if (!dataDir) return;
  const profile=profileProjection(db,actor);
  if (!profile.managed) return;
  const path=join(dataDir,"employee-profiles",actor);
  mkdirSync(path,{recursive:true,mode:0o700});
  for (const [name,text] of Object.entries({"USER.md":profile.user,"MEMORY.md":profile.memory})) {
    const target=join(path,name), temp=target+"."+randomUUID()+".tmp";
    writeFileSync(temp,text ? text+"\n" : "",{mode:0o600,flag:"wx"});
    renameSync(temp,target);
  }
}

export function saveEmployeePreference(db, actor, input, requestKey) {
  return transaction(db,()=>{
    activeMember(db,actor);
    if (input.id!==undefined && (typeof input.id!=="string" || !Number.isSafeInteger(input.revision) || input.revision<1))
      throw new HubError(400,"変更する記憶と版を確認してください。");
    if (input.project && typeof input.project!=="string" || input.source_job && typeof input.source_job!=="string")
      throw new HubError(400,"適用する案件と元の仕事を確認してください。");
    const timestamp=Date.now();
    if (input.deleted===true) {
      const row=db.prepare(`UPDATE employee_preferences SET content=NULL,deleted_at=?,updated_at=?,revision=revision+1
        WHERE id=? AND actor=? AND revision=? AND deleted_at IS NULL RETURNING id,revision`)
        .get(timestamp,timestamp,input.id,actor,input.revision);
      if (!row) throw new HubError(409,"この記憶が更新されています。一覧を開き直してください。");
      return row;
    }
    const content=typeof input.content==="string" ? input.content.trim() : "";
    if (!content || content.length>280) throw new HubError(400,"覚えておく内容を280文字以内で入力してください。");
    const existing=input.id && db.prepare("SELECT project,source_job FROM employee_preferences WHERE id=? AND actor=? AND deleted_at IS NULL")
      .get(input.id,actor);
    const project=existing ? existing.project : input.project || null;
    if (project && !canUseProfileProject(db,actor,project))
      throw new HubError(404,"この案件は現在利用できません。");
    const source=existing ? existing.source_job : input.source_job || null;
    const version=input.source_version ?? null;
    if (input.source_version!==undefined) {
      if (input.id || project || !source || !Number.isSafeInteger(version) || version<1 ||
        typeof requestKey!=="string" || !/^[a-zA-Z0-9-]{12,100}$/.test(requestKey))
        throw new HubError(400,"好みを保存する元の仕事と版を確認してください。");
      const prior=db.prepare(`SELECT id,revision,content,source_job,source_version,deleted_at
        FROM employee_preferences WHERE actor=? AND request_key=?`).get(actor,requestKey);
      if (prior) {
        if (prior.deleted_at!==null || prior.content!==content || prior.source_job!==source || prior.source_version!==version)
          throw new HubError(409,"同じ保存操作で記憶の内容を変更・復元できません。");
        return {id:prior.id,revision:prior.revision};
      }
    }
    if (source && !db.prepare("SELECT 1 FROM jobs WHERE id=? AND actor=?").get(source,actor))
      throw new HubError(404,"元の仕事が見つかりません。");
    if (input.id) {
      const row=db.prepare(`UPDATE employee_preferences SET content=?,updated_at=?,revision=revision+1
        WHERE id=? AND actor=? AND revision=? AND deleted_at IS NULL RETURNING id,revision`)
        .get(content,timestamp,input.id,actor,input.revision);
      if (!row) throw new HubError(409,"この記憶が更新されています。一覧を開き直してください。");
      return row;
    }
    if (source && version===null) {
      const prior=db.prepare(`SELECT id,revision,deleted_at FROM employee_preferences
        WHERE actor=? AND source_job=? AND source_version IS NULL`).get(actor,source);
      if (prior) {
        if (prior.deleted_at!==null) throw new HubError(409,"削除した記憶は元の仕事から復元できません。");
        return {id:prior.id,revision:prior.revision};
      }
    }
    return db.prepare(`INSERT INTO employee_preferences(id,actor,project,source_job,source_version,request_key,content,revision,updated_at)
      VALUES(?,?,?,?,?,?,?,1,?) RETURNING id,revision`).get(randomUUID(),actor,project,source,version,version===null ? null : requestKey,content,timestamp);
  });
}
