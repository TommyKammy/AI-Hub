import { createHash } from "node:crypto";
import { adminMember, activeMember, recordAdminChange, updateDirectoryEligibility } from "./memberships.mjs";
import { HubError, reasonText, transaction } from "./operations.mjs";
import { generalSynthetic, modelPolicyDenial, restrictedSynthetic, usagePolicy } from "./usage-policy.mjs";

const objectId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const id = value => typeof value==="string" && objectId.test(value) ? value.toLowerCase() : null;

export function migrateEnterpriseDirectory(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS enterprise_tenant(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), tenant TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS enterprise_people(
    tenant TEXT NOT NULL, object_id TEXT NOT NULL, actor TEXT NOT NULL UNIQUE REFERENCES memberships(actor),
    display_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
    retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)), PRIMARY KEY(tenant,object_id));
    CREATE TABLE IF NOT EXISTS enterprise_sync_history(
    seq INTEGER PRIMARY KEY, actor TEXT NOT NULL, version INTEGER NOT NULL,
    synced INTEGER NOT NULL, operator TEXT NOT NULL, reason TEXT NOT NULL,
    before_data TEXT NOT NULL, after_data TEXT NOT NULL, UNIQUE(actor,version));
    CREATE TABLE IF NOT EXISTS enterprise_groups(
      id TEXT PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS enterprise_group_models(
      group_id TEXT NOT NULL REFERENCES enterprise_groups(id),connection TEXT NOT NULL,model_id TEXT NOT NULL,
      PRIMARY KEY(group_id,connection,model_id));
    CREATE TABLE IF NOT EXISTS enterprise_group_members(
      actor TEXT NOT NULL REFERENCES enterprise_people(actor),group_id TEXT NOT NULL REFERENCES enterprise_groups(id),
      PRIMARY KEY(actor,group_id));
    CREATE TABLE IF NOT EXISTS local_model_groups(
      id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK(mode IN ('inherit','fixed','approved')),
      members TEXT NOT NULL,models TEXT NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS directory_group_links(
      source TEXT PRIMARY KEY REFERENCES enterprise_groups(id),
      target TEXT NOT NULL UNIQUE REFERENCES local_model_groups(id));
    CREATE TABLE IF NOT EXISTS company_model_selection(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('fixed','approved','groups')), models TEXT NOT NULL);`);
  if (!db.prepare("PRAGMA table_info(enterprise_tenant)").all().some(column=>column.name==="group_policy"))
    db.exec("ALTER TABLE enterprise_tenant ADD COLUMN group_policy INTEGER NOT NULL DEFAULT 0");
}

export function configureLocalDirectory(db,config) {
  const tenant=id(config?.tenant);
  if (!tenant || !Array.isArray(config.bindings) || !config.bindings.length || config.bindings.length>50)
    throw new HubError(400,"ローカル検証のテナントと社員対応を確認してください。");
  return transaction(db,()=>{
    const stored=db.prepare("SELECT tenant FROM enterprise_tenant WHERE singleton=1").get();
    if (stored && stored.tenant!==tenant) throw new HubError(409,"設定済みのテナントと一致しません。");
    db.prepare("INSERT OR IGNORE INTO enterprise_tenant(singleton,tenant) VALUES(1,?)").run(tenant);
    if (config.groups!==undefined) configureGroups(db,config.groups);
    for (const binding of config.bindings) {
      const object=id(binding?.objectId), actor=binding?.actor;
      if (!object || typeof actor!=="string") throw new HubError(400,"社員IDとEntra object IDを確認してください。");
      adminMember(db,actor);
      const prior=db.prepare("SELECT * FROM enterprise_people WHERE actor=? OR (tenant=? AND object_id=?)").all(actor,tenant,object);
      if (prior.length) {
        if (prior.length!==1 || prior[0].actor!==actor || prior[0].tenant!==tenant || prior[0].object_id!==object)
          throw new HubError(409,"この社員またはオブジェクトIDには固定の社員対応があります。");
        continue;
      }
      db.prepare("INSERT INTO enterprise_people(tenant,object_id,actor,retired) VALUES(?,?,?,?)")
        .run(tenant,object,actor,Number(binding.retired===true));
      if (binding.groups!==undefined) replaceGroups(db,actor,checkedGroups(db,binding.groups));
      if (binding.retired===true)
        updateDirectoryEligibility(db,adminMember(db,actor),false,"検証台帳で退職済み","system:local-directory");
    }
  });
}

function configureGroups(db,groups) {
  if (!Array.isArray(groups) || groups.length>50 || new Set(groups.map(group=>id(group?.id))).size!==groups.length)
    throw new HubError(400,"検証用グループに重複しないEntra object IDを指定してください。");
  db.prepare("UPDATE enterprise_tenant SET group_policy=1 WHERE singleton=1").run();
  db.prepare("UPDATE enterprise_groups SET active=0").run();
  for (const group of groups) {
    const groupId=id(group?.id), name=checkedAttribute(group?.name,100);
    if (!groupId || !name || !Array.isArray(group.models) || group.models.length>30)
      throw new HubError(400,"グループ名と承認済みモデルの対応を確認してください。");
    db.prepare(`INSERT INTO enterprise_groups(id,name,active) VALUES(?,?,1)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=1`).run(groupId,name);
    db.prepare("DELETE FROM enterprise_group_models WHERE group_id=?").run(groupId);
    for (const model of group.models) {
      const connection=checkedAttribute(model?.connection,80), modelId=checkedAttribute(model?.modelId,120);
      if (!connection || !modelId) throw new HubError(400,"接続先とモデルIDを指定してください。");
      db.prepare("INSERT OR IGNORE INTO enterprise_group_models VALUES(?,?,?)").run(groupId,connection,modelId);
    }
  }
}

function groupsFor(db,actor) {
  return db.prepare(`SELECT g.id FROM enterprise_group_members m JOIN enterprise_groups g ON g.id=m.group_id
    WHERE m.actor=? AND g.active=1 ORDER BY g.id`).all(actor).map(group=>group.id);
}

function checkedGroups(db,groups) {
  if (!Array.isArray(groups) || groups.length>50 || groups.some(value=>!id(value)))
    throw new HubError(400,"同期するグループIDを確認してください。");
  const ids=groups.map(id).sort();
  if (new Set(ids).size!==ids.length || ids.some(value=>!db.prepare("SELECT 1 FROM enterprise_groups WHERE id=? AND active=1").get(value)))
    throw new HubError(400,"未設定または重複したグループを同期できません。");
  return ids;
}

function replaceGroups(db,actor,groups) {
  db.prepare("DELETE FROM enterprise_group_members WHERE actor=?").run(actor);
  const add=db.prepare("INSERT INTO enterprise_group_members VALUES(?,?)");
  for (const group of groups) add.run(actor,group);
}

function exactIdentity(db,verifiedTenant,verifiedObject) {
  const tenant=id(verifiedTenant), object=id(verifiedObject);
  if (!tenant || !object || db.prepare("SELECT tenant FROM enterprise_tenant WHERE singleton=1").get()?.tenant!==tenant)
    throw new HubError(403,"許可されたテナントとEntra object IDを確認できません。");
  const binding=db.prepare("SELECT * FROM enterprise_people WHERE tenant=? AND object_id=?").get(tenant,object);
  if (!binding || binding.retired) throw new HubError(403,"このEntraアカウントは利用できません。");
  return binding;
}

// These arguments come from the verified token or fixture transport, never from email or profile lookups.
export function resolveVerifiedEmployee(db,{tid,oid,acct}) {
  if (acct===1 || acct==="1") throw new HubError(403,"ゲストアカウントでは利用できません。");
  return activeMember(db,exactIdentity(db,tid,oid).actor);
}

function checkedAttribute(value,limit) {
  if (typeof value!=="string" || value.length>limit || /[\u0000-\u001f\u007f]/u.test(value))
    throw new HubError(400,"同期属性の形式を確認してください。");
  return value.trim();
}

function groupManaged(db,actor) {
  return Boolean(db.prepare(`SELECT 1 FROM enterprise_people p JOIN enterprise_tenant t ON p.tenant=t.tenant
    WHERE p.actor=? AND t.group_policy=1`).get(actor));
}

function scimAllows(db,actor,model) {
  return Boolean(db.prepare(`SELECT 1 FROM enterprise_group_members member JOIN enterprise_groups g ON g.id=member.group_id AND g.active=1
    JOIN enterprise_group_models allowed ON allowed.group_id=g.id WHERE member.actor=? AND allowed.connection=? AND allowed.model_id=?`)
    .get(actor,model.connection,model.model_id));
}

function releasedModels(db) {
  return db.prepare(`SELECT m.*,max(r.version) release FROM models m JOIN model_releases r ON r.model=m.id
    GROUP BY m.id ORDER BY release DESC`).all();
}

function localGroups(db,actor,proposed,directoryIds) {
  const sources=JSON.stringify(directoryIds ?? groupsFor(db,actor));
  const groups=db.prepare(`SELECT g.*, link.source directory_source FROM local_model_groups g LEFT JOIN directory_group_links link ON link.target=g.id
    WHERE EXISTS (SELECT 1 FROM json_each(g.members) WHERE value=$actor) OR link.source IN (SELECT value FROM json_each($sources))
    ORDER BY g.name,g.id`).all({actor,sources}).map(readLocalGroup).filter(group=>group.id!==proposed?.id);
  if (proposed && (proposed.members.includes(actor) || linkedSource(db,proposed.id,sources))) groups.push(proposed);
  return groups;
}

function linkedSource(db,target,sources) {
  return Boolean(db.prepare("SELECT 1 FROM directory_group_links WHERE target=? AND source IN (SELECT value FROM json_each(?))").get(target,sources));
}

function readLocalGroup(row) {
  return {...row,members:JSON.parse(row.members),models:JSON.parse(row.models)};
}

function localRestriction(groups,baseline) {
  if (groups.some(group=>group.mode==="fixed")) return new Set(baseline ? [baseline.id] : []);
  const approved=groups.filter(group=>group.mode==="approved");
  if (!approved.length) return null;
  return new Set([...(baseline ? [baseline.id] : []),...approved.flatMap(group=>group.models)]);
}

function companySelection(db) {
  const row=db.prepare("SELECT mode,models,revision FROM company_model_selection WHERE singleton=1").get();
  return row ? {...row,models:JSON.parse(row.models)} : {mode:"groups",models:[],revision:0};
}

function modelRestriction(db,groups,baseline) {
  const policy=companySelection(db);
  const standard=baseline ? [baseline.id] : [];
  if (policy.revision && policy.mode==="fixed") return new Set(standard);
  if (policy.revision && policy.mode==="approved") return new Set([...standard,...policy.models]);
  const local=localRestriction(groups,baseline);
  if (!policy.revision) return local;
  const companyAllowed=new Set([...standard,...policy.models]);
  return local ? new Set([...local].filter(model=>companyAllowed.has(model))) : new Set(standard);
}

export function employeeGroupAllows(db,actor,model) {
  const scoped=groupManaged(db,actor);
  if (scoped && !scimAllows(db,actor,model)) return false;
  const groups=localGroups(db,actor);
  if (!companySelection(db).revision && !groups.some(group=>group.mode!=="inherit")) return true;
  const baseline=releasedModels(db).find(item=>!scoped || scimAllows(db,actor,item));
  const allowed=modelRestriction(db,groups,baseline);
  const selected=db.prepare("SELECT id FROM models WHERE connection=? AND model_id=?")
    .get(model.connection,model.model_id);
  return selected ? allowed.has(selected.id) : false;
}

function modelsFor(db,actor,eligible,dataClass,groups,proposed) {
  if (!eligible) return [];
  const managed=groupManaged(db,actor);
  const available=releasedModels(db);
  const policy=usagePolicy(db);
  const groupAllowed=groups && db.prepare(`SELECT 1 FROM enterprise_group_models allowed JOIN enterprise_groups g ON g.id=allowed.group_id
    WHERE g.active=1 AND allowed.connection=? AND allowed.model_id=? AND g.id IN (SELECT value FROM json_each(?))`);
  const scoped=managed ? available.filter(model=>groupAllowed
    ? groupAllowed.get(model.connection,model.model_id,JSON.stringify(groups)) : scimAllows(db,actor,model)) : available;
  const local=modelRestriction(db,localGroups(db,actor,proposed,groups),scoped[0]);
  const choices=local ? scoped.filter(model=>local.has(model.id)) : managed ? scoped : scoped.slice(0,1);
  return choices.filter(model=>!model.stopped && !modelPolicyDenial(policy,model,dataClass))
    .map(model=>({id:model.id,name:model.name,release:model.release}));
}

export function employeeModelChoices(db,actor) {
  const member=activeMember(db,actor);
  return {scoped:Boolean(companySelection(db).revision)||groupManaged(db,actor)||localGroups(db,actor).some(group=>group.mode!=="inherit"),general:modelsFor(db,actor,member.active,generalSynthetic),
    restricted:modelsFor(db,actor,member.active,restrictedSynthetic)};
}

export function directorySyncPreview(db,input) {
  const binding=exactIdentity(db,input.tenant,input.externalId);
  if (typeof input.active!=="boolean") throw new HubError(400,"ディレクトリ上の利用資格を指定してください。");
  const person=adminMember(db,binding.actor);
  const previousGroups=groupsFor(db,person.actor);
  const nextGroups=input.groups===undefined ? previousGroups : checkedGroups(db,input.groups);
  const before={displayName:binding.display_name,email:binding.email,directoryActive:person.directory_active,
    eligible:person.active,groups:previousGroups,models:modelsFor(db,person.actor,person.active,generalSynthetic,previousGroups),
    restrictedModels:modelsFor(db,person.actor,person.active,restrictedSynthetic,previousGroups)};
  const eligible=person.manual_active && input.active;
  const after={displayName:checkedAttribute(input.displayName,120),email:checkedAttribute(input.email,254),
    directoryActive:input.active,eligible,groups:nextGroups,models:modelsFor(db,person.actor,eligible,generalSynthetic,nextGroups),
    restrictedModels:modelsFor(db,person.actor,eligible,restrictedSynthetic,nextGroups)};
  const version=binding.revision, operatorLock=!person.manual_active, changed=JSON.stringify(before)!==JSON.stringify(after);
  const preview=createHash("sha256").update(JSON.stringify([binding.tenant,binding.object_id,version,person.revision,before,after])).digest("hex");
  return { actor:person.actor,name:person.name,team:person.team,version,operatorLock,before,after,changed,preview };
}

export function applyDirectorySync(db,input,operator) {
  return transaction(db,()=>{
    const state=directorySyncPreview(db,input);
    if (!state.changed) return state;
    if (input.preview!==state.preview) throw new HubError(409,"同期差分が更新されました。適用前に確認してください。");
    const reason=reasonText(input.reason), version=state.version+1;
    db.prepare("UPDATE enterprise_people SET display_name=?,email=?,revision=? WHERE actor=?")
      .run(state.after.displayName,state.after.email,version,state.actor);
    replaceGroups(db,state.actor,state.after.groups);
    updateDirectoryEligibility(db,adminMember(db,state.actor),state.after.directoryActive,reason,operator);
    const summarize = entry => [entry.displayName || "表示名未登録", entry.email || "メール未登録", "グループ "+(entry.groups.join("、") || "なし")].join(" ／ ");
    if (summarize(state.before)!==summarize(state.after))
      recordAdminChange(db,{operator,scope:"employee",target:state.actor,action:"Entra ID の同期",before:summarize(state.before),after:summarize(state.after),reason});
    db.prepare(`INSERT INTO enterprise_sync_history(actor,version,synced,operator,reason,before_data,after_data)
      VALUES(?,?,?,?,?,?,?)`).run(state.actor,version,Date.now(),operator,reason,JSON.stringify(state.before),JSON.stringify(state.after));
    return {...state,version};
  });
}

export function localDirectoryOverview(db) {
  const tenant=db.prepare("SELECT tenant FROM enterprise_tenant WHERE singleton=1").get()?.tenant ?? null;
  const people=db.prepare("SELECT object_id AS externalId,actor,display_name AS displayName,email FROM enterprise_people WHERE retired=0 ORDER BY actor")
    .all().map(row=>{
      const employee=adminMember(db,row.actor);
      return {...row,name:employee.name,active:employee.directory_active,eligible:employee.active,groups:groupsFor(db,row.actor)};
    });
  const history=db.prepare("SELECT * FROM enterprise_sync_history ORDER BY seq DESC LIMIT 30").all().map(row=>
    ({...row,before:JSON.parse(row.before_data),after:JSON.parse(row.after_data)}));
  const groups=db.prepare(`SELECT g.id,g.name,l.target FROM enterprise_groups g LEFT JOIN directory_group_links l ON l.source=g.id
    WHERE g.active=1 ORDER BY g.name,g.id`).all().map(group=>({...group,members:directoryMembers(db,group.id)}));
  const targets=db.prepare(`SELECT g.id,g.name,l.source FROM local_model_groups g LEFT JOIN directory_group_links l ON l.target=g.id
    ORDER BY g.name,g.id`).all();
  return {tenant,people,history,groups,targets};
}

function directoryMembers(db,source) {
  return db.prepare(`SELECT m.actor FROM enterprise_group_members m JOIN enterprise_people p ON p.actor=m.actor
    WHERE m.group_id=? AND p.retired=0 ORDER BY m.actor`).all(source).map(row=>row.actor);
}

function groupSyncPlan(db,input) {
  const tenant=id(input?.tenant);
  const sourceId=id(input?.source);
  const targetId=id(input?.target);
  const configured=db.prepare("SELECT tenant FROM enterprise_tenant WHERE singleton=1").get();
  if (!tenant || configured?.tenant!==tenant || !sourceId || !targetId || typeof input.create!=="boolean" ||
      !Array.isArray(input.members) || input.members.length>50 || input.members.some(member=>!id(member)))
    throw new HubError(400,"ローカルテナント、同期元グループと対応先を確認してください。");
  const source=db.prepare("SELECT id,name FROM enterprise_groups WHERE id=? AND active=1").get(sourceId);
  if (!source) throw new HubError(404,"同期元のEntraグループが見つかりません。");
  const link=db.prepare("SELECT target FROM directory_group_links WHERE source=?").get(sourceId);
  const conflicting=db.prepare("SELECT source FROM directory_group_links WHERE target=?").get(targetId);
  if ((link && link.target!==targetId) || (conflicting && conflicting.source!==sourceId))
    throw new HubError(409,"グループの対応が変更されています。同期画面を開き直してください。");
  const stored=db.prepare("SELECT * FROM local_model_groups WHERE id=?").get(targetId);
  const create=input.create && !link;
  if (create && (stored || db.prepare("SELECT 1 FROM local_model_groups WHERE name=?").get(source.name)))
    throw new HubError(409,"同名または同じIDのグループがあります。既存グループを選んでください。");
  if (!create && !stored) throw new HubError(404,"対応するAI Hubグループが見つかりません。");
  if (create && db.prepare("SELECT count(*) n FROM local_model_groups").get().n>=50)
    throw new HubError(409,"グループは50件まで登録できます。");
  const target=stored ? readLocalGroup(stored) :
    {id:targetId,name:source.name,mode:"inherit",members:[],models:[],revision:0};
  const members=[...new Set(input.members.map(value=>exactIdentity(db,tenant,value).actor))].sort();
  if (members.length!==input.members.length) throw new HubError(400,"受信したメンバーに重複があります。");
  const previous=directoryMembers(db,sourceId);
  const affected=[...new Set([...previous,...members,...target.members])].sort();
  const before=affected.map(actor=>{
    const member=adminMember(db,actor);
    return {actor,name:member.name,access:effectiveGroupAccess(db,member)};
  });
  db.exec("SAVEPOINT directory_group_preview");
  let after;
  try {
    writeGroupSync(db,{source,target,create,members});
    after=affected.map(actor=>effectiveGroupAccess(db,adminMember(db,actor)));
  } finally {
    db.exec("ROLLBACK TO directory_group_preview");
    db.exec("RELEASE directory_group_preview");
  }
  const impact=before.map((row,index)=>({actor:row.actor,name:row.name,before:row.access,after:after[index]}));
  const changed=!link || JSON.stringify(previous)!==JSON.stringify(members);
  const preview=createHash("sha256").update(JSON.stringify([tenant,source,target,previous,members,impact])).digest("hex");
  return {source,target,create,members,
    added:members.filter(actor=>!previous.includes(actor)),removed:previous.filter(actor=>!members.includes(actor)),impact,changed,preview};
}

function writeGroupSync(db,{source,target,create,members}) {
  if (create) db.prepare("INSERT INTO local_model_groups VALUES(?,?,'inherit','[]','[]',1)").run(target.id,target.name);
  db.prepare("INSERT OR IGNORE INTO directory_group_links(source,target) VALUES(?,?)").run(source.id,target.id);
  db.prepare(`DELETE FROM enterprise_group_members WHERE group_id=? AND actor IN (SELECT actor FROM enterprise_people WHERE retired=0)`)
    .run(source.id);
  const add=db.prepare("INSERT INTO enterprise_group_members(actor,group_id) VALUES(?,?)");
  for (const actor of members) add.run(actor,source.id);
}

export function previewGroupSync(db,input) {
  return groupSyncPlan(db,input);
}

export function applyGroupSync(db,input,operator) {
  return transaction(db,()=>{
    const state=groupSyncPlan(db,input);
    const reason=reasonText(input.reason);
    if (!state.changed) return state;
    if (input.preview!==state.preview) throw new HubError(409,"同期差分が更新されました。適用前に確認してください。");
    writeGroupSync(db,state);
    recordAdminChange(db,{operator,scope:"group",target:state.target.id,action:"Entra グループ同期",
      before:state.source.name,after:state.target.name+" ／ 追加 "+state.added.length+" 人・除外 "+state.removed.length+" 人",reason});
    return state;
  });
}


// Group-level access is visible to auditors without disclosing employee identities.
export function groupOverview(db, manager=false) {
  const tenant = db.prepare("SELECT group_policy FROM enterprise_tenant WHERE singleton=1").get();
  const groups = db.prepare(`
    SELECT g.id, g.name, count(p.actor) AS memberCount
    FROM enterprise_groups g
    LEFT JOIN enterprise_group_members m ON m.group_id = g.id
    LEFT JOIN enterprise_people p ON p.actor = m.actor AND p.retired = 0
    WHERE g.active = 1 GROUP BY g.id ORDER BY g.name, g.id
  `).all();
  const models = db.prepare(`
    SELECT connection, model_id AS modelId FROM enterprise_group_models
    WHERE group_id = ? ORDER BY connection, model_id
  `);
  const local = db.prepare(`SELECT g.*,l.source FROM local_model_groups g LEFT JOIN directory_group_links l ON l.target=g.id
    ORDER BY g.name,g.id`).all().map(readLocalGroup);
  const selection=companySelection(db);
  const candidates = releasedModels(db).map(model=>({id:model.id,name:model.name,stopped:Boolean(model.stopped)}));
  return { configured: Boolean(tenant?.group_policy || local.length || selection.revision),
    ...((manager || selection.revision) && {selection}),
    groups: [...groups.map(group=>({...group, models:models.all(group.id)})),
      ...local.map(group=>({id:group.id,name:group.name,mode:group.mode,revision:group.revision,
        memberCount:new Set([...group.members,...(group.source ? directoryMembers(db,group.source) : [])]).size,
        models:group.models.map(model=>({id:model,name:candidates.find(item=>item.id===model)?.name || model})),
        ...(group.source && {directorySource:group.source}),
        ...(manager && {members:group.members})}))],
    ...(manager && {manager:true,candidates, employees:db.prepare("SELECT actor FROM memberships ORDER BY actor").all().map(({actor})=>{
      const member=adminMember(db,actor);
      return {actor,name:member.name,team:member.team};
    })})};
}

export function saveCompanySelection(db,input,operator) {
  return transaction(db,()=>{
    const prior=companySelection(db);
    if (input?.revision!==prior.revision) throw new HubError(409,"全社方針が変更されました。画面を開き直してください。");
    if (!["fixed","approved","groups"].includes(input.mode) || !Array.isArray(input.models) ||
        input.models.length>30 || input.models.some(value=>typeof value!=="string"))
      throw new HubError(400,"公開する方針とモデルを確認してください。");
    const reason=reasonText(input.reason);
    const models=input.mode==="fixed" ? [] : [...new Set(input.models)].sort();
    const published=releasedModels(db);
    if ((input.mode==="approved" && !models.length) || models.some(id=>!published.some(model=>
      model.id===id && (!model.stopped || prior.models.includes(id)))))
      throw new HubError(400,"現在公開されているモデルを選んでください。");
    if (prior.revision && prior.mode===input.mode && JSON.stringify(models)===JSON.stringify(prior.models)) return prior;
    const revision=prior.revision+1;
    db.prepare(`INSERT INTO company_model_selection(singleton,revision,mode,models) VALUES(1,?,?,?)
      ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,mode=excluded.mode,models=excluded.models`)
      .run(revision,input.mode,JSON.stringify(models));
    const labels={fixed:"標準モデルに固定",approved:"全社員が承認済みモデルから選択可",groups:"グループ別に設定"};
    const text=(mode,ids)=>[labels[mode],...ids.map(id=>published.find(model=>model.id===id)?.name || id)].join(" ／ ");
    recordAdminChange(db,{operator,scope:"group",target:"company-model-selection",action:"全社モデル選択方針を変更",
      before:prior.revision ? text(prior.mode,prior.models) : "従来の全社既定",after:text(input.mode,models),reason});
    return {mode:input.mode,models,revision};
  });
}

function checkedLocalGroup(db,input) {
  const groupId=id(input?.id);
  const name=checkedAttribute(input?.name,80);
  if (!groupId || !name || !["inherit","fixed","approved"].includes(input.mode) ||
      !Array.isArray(input.members) || input.members.length>50 ||
      !Array.isArray(input.models) || input.models.length>30 ||
      input.members.some(actor=>typeof actor!=="string") || input.models.some(model=>typeof model!=="string"))
    throw new HubError(400,"グループ名、メンバーとモデル選択方針を確認してください。");
  const members=[...new Set(input.members)].sort();
  members.forEach(actor=>adminMember(db,actor));
  const models=input.mode==="approved" ? [...new Set(input.models)].sort() : [];
  const candidates=releasedModels(db);
  if (input.mode==="approved" && (!models.length || models.some(id=>!candidates.some(model=>model.id===id))))
    throw new HubError(400,"公開済みモデルを1件以上選んでください。");
  const prior=db.prepare("SELECT * FROM local_model_groups WHERE id=?").get(groupId);
  if ((prior?.revision ?? 0)!==input.revision) throw new HubError(409,"グループの設定が変更されました。一覧から開き直してください。");
  if (db.prepare("SELECT 1 FROM local_model_groups WHERE id<>? AND name=?").get(groupId,name))
    throw new HubError(409,"このグループ名はすでに使われています。");
  return {prior:prior && readLocalGroup(prior),
    proposed:{id:groupId,name,mode:input.mode,members,models,revision:input.revision}};
}

function effectiveGroupAccess(db,member,proposed) {
  const directoryIds=groupsFor(db,member.actor);
  const directoryNames=db.prepare("SELECT name FROM enterprise_groups WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name")
    .all(JSON.stringify(directoryIds)).map(row=>row.name);
  return {eligible:member.active,
    groups:[...directoryNames,...localGroups(db,member.actor,proposed).map(group=>group.name)],
    general:modelsFor(db,member.actor,member.active,generalSynthetic,directoryIds,proposed),
    restricted:modelsFor(db,member.actor,member.active,restrictedSynthetic,directoryIds,proposed)};
}

export function groupAccess(db,actor) {
  return effectiveGroupAccess(db,adminMember(db,actor));
}

function localGroupChange(db,input) {
  const {prior,proposed}=checkedLocalGroup(db,input);
  const source=db.prepare("SELECT source FROM directory_group_links WHERE target=?").get(proposed.id)?.source;
  const affected=[...new Set([...(prior?.members || []),...proposed.members,...(source ? directoryMembers(db,source) : [])])].sort();
  const impact=affected.map(actor=>{
    const member=adminMember(db,actor);
    return {actor,before:effectiveGroupAccess(db,member),after:effectiveGroupAccess(db,member,proposed)};
  });
  const preview=createHash("sha256").update(JSON.stringify([proposed,impact])).digest("hex");
  return {prior,proposed,impact,preview};
}

export function previewLocalGroup(db,input) {
  const {preview,impact,proposed}=localGroupChange(db,input);
  const result=impact.find(row=>row.actor===input.employee);
  const member=adminMember(db,input.employee);
  const before=result?.before ?? effectiveGroupAccess(db,member);
  return {preview,before,after:result?.after ?? before,affected:impact.length,group:proposed};
}

function auditGroup(group) {
  if (!group) return "";
  const names={inherit:"全社設定を継承",fixed:"標準モデルのみ",approved:"承認済みモデルから選択"};
  return [group.name,names[group.mode],"メンバー "+group.members.length+" 人",group.models.join("、")].filter(Boolean).join(" ／ ");
}

export function saveLocalGroup(db,input,operator) {
  return transaction(db,()=>{
    const {prior,proposed,preview}=localGroupChange(db,input);
    if (input.preview!==preview) throw new HubError(409,"保存前プレビューを再確認してください。");
    const reason=reasonText(input.reason);
    if (prior && JSON.stringify(prior)===JSON.stringify(proposed)) return prior;
    if (!prior && db.prepare("SELECT count(*) n FROM local_model_groups").get().n>=50)
      throw new HubError(409,"グループは50件まで登録できます。");
    db.prepare(`INSERT INTO local_model_groups(id,name,mode,members,models,revision) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,mode=excluded.mode,members=excluded.members,models=excluded.models,revision=excluded.revision`)
      .run(proposed.id,proposed.name,proposed.mode,JSON.stringify(proposed.members),JSON.stringify(proposed.models),proposed.revision+1);
    const priorMembers=prior?.members || [];
    const added=proposed.members.filter(actor=>!priorMembers.includes(actor)).length;
    const removed=priorMembers.filter(actor=>!proposed.members.includes(actor)).length;
    const membershipChange=added || removed ? " ／ メンバー追加 "+added+" 人・除外 "+removed+" 人" : "";
    recordAdminChange(db,{operator,scope:"group",target:proposed.id,action:prior ? "グループを変更" : "グループを作成",
      before:auditGroup(prior),after:auditGroup(proposed)+membershipChange,reason});
    return {...proposed,revision:proposed.revision+1};
  });
}
