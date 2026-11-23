import { createHash, randomUUID } from "node:crypto";
import { activeMember, member, teamPermitsJob } from "./memberships.mjs";
import { current } from "./skills/renewal-brief/releases.mjs";
import { standardProcedureVersion } from "./standard-procedures.mjs";
import { HubError, reasonText, transaction } from "./operations.mjs";
import { sourcesFor } from "./fixtures.mjs";

const layouts = {
  contract: { name: "契約条件から確認する更新商談", first: "契約台帳" },
  meeting: { name: "先方の希望から確認する更新商談", first: "商談議事録" },
};
const fields = "id,name,scope,version,hash,instruction,layout";
const visibleState = "CASE WHEN revoked_at IS NOT NULL THEN 'revoked' ELSE state END AS state";
const orderRule = "\n\n「資料の事実」では";
const digest = p => createHash("sha256")
  .update(JSON.stringify([p.name, p.scope, p.version, p.layout, p.instruction])).digest("hex");

export function quoteProcedure(procedure) {
  return procedure?.layout==="quote-comparison" ? JSON.parse(procedure.instruction) : null;
}

export function migrateProcedures(db) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS procedures (
      id TEXT PRIMARY KEY, source_job TEXT NOT NULL UNIQUE REFERENCES jobs(id), author TEXT NOT NULL,
      scope TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, layout TEXT NOT NULL,
      instruction TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','pending','published')),
      published_at INTEGER, published_by TEXT)`);
    if (!db.prepare("PRAGMA table_info(jobs)").all().some(c => c.name === "procedure_id"))
      db.exec("ALTER TABLE jobs ADD COLUMN procedure_id TEXT REFERENCES procedures(id)");
    if (!db.prepare("PRAGMA table_info(procedures)").all().some(c => c.name === "revoked_at"))
      db.exec("ALTER TABLE procedures ADD COLUMN revoked_at INTEGER");
    db.exec(`CREATE TABLE IF NOT EXISTS procedure_history (
      id TEXT NOT NULL REFERENCES procedures(id), version INTEGER NOT NULL, hash TEXT NOT NULL,
      name TEXT NOT NULL, scope TEXT NOT NULL, instruction TEXT NOT NULL, layout TEXT NOT NULL,
      published_at INTEGER NOT NULL, PRIMARY KEY(id,version), UNIQUE(id,hash))`);
    db.exec(`CREATE TABLE IF NOT EXISTS procedure_delivery(
      procedure TEXT PRIMARY KEY REFERENCES procedures(id), revision INTEGER NOT NULL,
      teams TEXT NOT NULL, recommended TEXT NOT NULL, trials TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS procedure_admin_changes(
        seq INTEGER PRIMARY KEY, procedure TEXT NOT NULL REFERENCES procedures(id), action TEXT NOT NULL,
        version INTEGER NOT NULL, operator TEXT NOT NULL, time INTEGER NOT NULL, reason TEXT, detail TEXT);`);
  });
}

export function draftForJob(db, actor, job) {
  return db.prepare(`SELECT ${fields},${visibleState} FROM procedures WHERE source_job=? AND author=? AND scope=?`)
    .get(job, actor, activeMember(db, actor).team) ?? null;
}

export function makeDraft(db, actor, job, layout) {
  if (layout!=="quote-comparison" && !Object.hasOwn(layouts, layout)) throw new HubError(400, "メモの並び順を選んでください。");
  return transaction(db, () => {
    const scope = activeMember(db, actor).team;
    // Read only workflow metadata. Job text, documents and answers never enter the shared artifact.
    const source = db.prepare("SELECT status,kind,skill_hash,procedure_id,adopted_version FROM jobs WHERE id=? AND actor=?").get(job, actor);
    if (!source) throw new HubError(404, "依頼が見つかりません。");
    if (source.status !== "done") throw new HubError(409, "完了した依頼から草案を作成できます。");
    if (!teamPermitsJob(db, job)) throw new HubError(403, "現在の所属ではこの手順を利用できません。");
    const existing = draftForJob(db, actor, job);
    if (existing) {
      if (existing.layout !== layout) throw new HubError(409, "この依頼には作成済みの草案があります。");
      return existing;
    }
    if (layout==="quote-comparison") {
      const saved=db.prepare("SELECT criteria,rules FROM quote_skills WHERE job=? AND version=? AND hash IS NOT NULL")
        .get(job,source.adopted_version);
      if (source.kind!=="assistant" || !saved) throw new HubError(400,"採用した見積比較の基準を本人専用に保存してから共有してください。");
      const name="2社見積比較のチーム手順", version=1;
      const generic=/^(?:価格|金額|料金|初期費用|月額費用|月額|年額|期間|契約期間|保守|年間保守|保守費|サポート|保証|納期|支払条件|更新条件|解約条件|含まれる作業|対応範囲|税区分|税抜金額|税込金額)(?:[（(](?:税込|税抜|別途)[）)])?$/u;
      const criteria=JSON.parse(saved.criteria).filter(label=>generic.test(label));
      if (!criteria.length) throw new HubError(400,"公開用の見積比較に使う共通の項目が見つかりません。");
      const instruction=JSON.stringify({criteria,rules:[]});
      const hash=digest({name,scope,version,layout,instruction});
      db.prepare(`INSERT INTO procedures(id,source_job,author,scope,name,version,layout,instruction,hash,state)
        VALUES(?,?,?,?,?,?,?,?,?,'draft')`).run(randomUUID(),job,actor,scope,name,version,layout,instruction,hash);
      return draftForJob(db,actor,job);
    }
    if (source.kind !== "renewal") throw new HubError(400, "この依頼は更新商談手順の公開対象外です。");
    const { name, first } = layouts[layout];
    const version = 1;
    const executed = source.procedure_id ? resolvePublished(db, actor, source.procedure_id, source.skill_hash)
      : standardProcedureVersion(db,"renewal-brief",source.skill_hash);
    if (!executed || executed.hash !== source.skill_hash) throw new HubError(409, "実行した手順版を確認してください。");
    // Preserve a shared workflow on re-drafting. Normalize legacy v1's memo to the two-section format.
    const base = source.procedure_id ? executed.instruction.split(orderRule)[0]
      : (executed.version === 1 ? current : executed).instruction.replace(/^[\s\S]*?^# 更新商談の準備\s*/m, "").trim();
    const instruction = base + orderRule + first + "の文を先に並べる。資料番号は入力の id に合わせる。";
    const hash = digest({ name, scope, version, layout, instruction });
    db.prepare(`INSERT INTO procedures(id,source_job,author,scope,name,version,layout,instruction,hash,state)
      VALUES(?,?,?,?,?,?,?,?,?,'draft')`).run(randomUUID(), job, actor, scope, name, version, layout, instruction, hash);
    return draftForJob(db, actor, job);
  });
}

export function submitDraft(db, actor, job, hash) {
  const p = draftForJob(db, actor, job);
  if (!p) throw new HubError(404, "草案が見つかりません。");
  if (p.hash !== hash || digest(p) !== hash) throw new HubError(409, "草案を再確認してください。");
  db.prepare("UPDATE procedures SET state='pending' WHERE id=? AND state='draft'").run(p.id);
  return draftForJob(db, actor, job);
}

export function reviewList(db) {
  return db.prepare(`SELECT ${fields},${visibleState},author,published_at,revoked_at FROM procedures
    WHERE state IN ('pending','published') ORDER BY state,rowid DESC`).all();
}

export function publishProcedure(db, id, hash, operator) {
  const p = db.prepare(`SELECT ${fields},${visibleState} FROM procedures WHERE id=?`).get(id);
  if (!p || p.state === "draft") throw new HubError(404, "公開申請が見つかりません。");
  if (p.state === "revoked") throw new HubError(409, "公開取消済みです。");
  if (hash !== p.hash || digest(p) !== hash) throw new HubError(409, "申請内容を再確認してください。");
  transaction(db,()=>{
    const changed=db.prepare("UPDATE procedures SET state='published',published_by=?,published_at=? WHERE id=? AND state='pending' AND hash=?")
      .run(operator, Date.now(), id, hash);
    if (changed.changes) recordProcedureChange(db,p,"publish",operator,null);
  });
}

export function publishedFor(db, actor) {
  const team=activeMember(db, actor).team;
  return db.prepare(`SELECT ${fields} FROM procedures WHERE state='published' AND revoked_at IS NULL ORDER BY published_at DESC,rowid DESC`)
    .all().flatMap(p=>{
      const policy=deliveryFor(db,p);
      return policy.teams.includes(team) ? [{...p,delivery_team:team,recommended:policy.recommended.includes(team)}] : [];
    });
}
// Historical metadata lookup for an already owner-checked job. Execution uses resolvePublished.
export function procedureVersion(db, id, hash) {
  let p = db.prepare(`SELECT ${fields},revoked_at FROM procedures WHERE id=? AND state='published'`).get(id);
  if (!p) throw new HubError(404, "利用できる公開手順が見つかりません。");
  if (hash && hash !== p.hash) {
    const archived = db.prepare(`SELECT ${fields} FROM procedure_history WHERE id=? AND hash=? AND scope=?`).get(id, hash, p.scope);
    if (!archived) throw new HubError(409, "受付時の手順版を確認できません。");
    p = { ...archived, revoked_at: p.revoked_at };
  }
  if (digest(p) !== p.hash) throw new HubError(409, "公開版の内容を確認してください。");
  return p;
}
export function resolvePublished(db, actor, id, hash) {
  const p = procedureVersion(db, id, hash);
  if (!deliveredTo(db,p,activeMember(db, actor).team)) throw new HubError(403, "現在の所属ではこの手順を利用できません。");
  if (p.revoked_at !== null) throw new HubError(423, "この手順は公開取消済みです。");
  return p;
}

function adminVersion(db, id, hash) {
  const p = db.prepare(`SELECT ${fields},revoked_at FROM procedures WHERE id=? AND state='published'`).get(id);
  if (!p) throw new HubError(404, "公開手順が見つかりません。");
  if (p.hash !== hash || digest(p) !== hash) throw new HubError(409, "公開版が変わりました。最新の内容を確認してください。");
  return p;
}

export function previewRevision(db, id, input) {
  const p = adminVersion(db, id, input.base);
  if (p.revoked_at !== null) throw new HubError(423, "この手順は公開取消済みです。");
  if (p.layout==="quote-comparison") {
    const original=quoteProcedure(p), criteria=input.criteria;
    if (!Array.isArray(criteria) || !criteria.length || new Set(criteria).size!==criteria.length ||
      !criteria.every(item=>original.criteria.includes(item)) || JSON.stringify(criteria)===JSON.stringify(original.criteria))
      throw new HubError(400,"残す比較項目と並び順を確かめてください。");
    const next={id,scope:p.scope,name:p.name,version:p.version+1,layout:p.layout,instruction:JSON.stringify({...original,criteria})};
    return {...next,hash:digest(next)};
  }
  if (!Object.hasOwn(layouts, input.layout) || p.layout === input.layout)
    throw new HubError(400, "改訂するメモの並び順を選んでください。");
  const layout = layouts[input.layout];
  const next = { id, scope: p.scope, name: layout.name, version: p.version + 1, layout: input.layout,
    instruction: p.instruction.split(orderRule)[0] + orderRule + layout.first + "の文を先に並べる。資料番号は入力の id に合わせる。" };
  return { ...next, hash: digest(next) };
}

export function publishRevision(db, id, input, operator) {
  return transaction(db, () => {
    const next = previewRevision(db, id, input);
    if (next.hash !== input.hash) throw new HubError(409, "改訂内容を再確認してください。");
    promote(db,next,operator);
    recordProcedureChange(db,next,"publish",operator,null);
  });
}

function promote(db,next,operator) {
  db.prepare(`INSERT INTO procedure_history(${fields},published_at)
    SELECT ${fields},published_at FROM procedures WHERE id=?`).run(next.id);
  db.prepare("UPDATE procedures SET name=?,version=?,hash=?,instruction=?,layout=?,published_at=?,published_by=? WHERE id=?")
    .run(next.name,next.version,next.hash,next.instruction,next.layout,Date.now(),operator,next.id);
}

function recordProcedureChange(db,p,action,operator,reason,details=null) {
  db.prepare("INSERT INTO procedure_admin_changes(procedure,action,version,operator,time,reason,detail) VALUES(?,?,?,?,?,?,?)")
    .run(p.id,action,p.version,operator,Date.now(),reason,details && JSON.stringify(details));
}

function deliveryFor(db,p) {
  const row=db.prepare("SELECT revision,teams,recommended,trials FROM procedure_delivery WHERE procedure=?").get(p.id);
  return row ? {revision:row.revision,teams:JSON.parse(row.teams),recommended:JSON.parse(row.recommended),trials:JSON.parse(row.trials)}
    : {revision:0,teams:[p.scope],recommended:[],trials:[]};
}

export function deliveredTo(db,p,team) {
  return deliveryFor(db,p).teams.includes(team);
}

export function procedureAdministration(db,id) {
  const p=db.prepare(`SELECT ${fields},${visibleState} FROM procedures WHERE id=? AND state!='draft'`).get(id);
  if (!p) throw new HubError(404,"承認待ちまたは公開済みの手順が見つかりません。");
  const versions=db.prepare(`SELECT ${fields},published_at FROM procedure_history WHERE id=? ORDER BY version DESC`).all(id);
  const history=db.prepare("SELECT action,version,operator,time,reason,detail FROM procedure_admin_changes WHERE procedure=? ORDER BY seq DESC LIMIT 20").all(id);
  return { ...p, versions, history, delivery:deliveryFor(db,p), teams:db.prepare("SELECT DISTINCT team FROM memberships WHERE active=1 ORDER BY team").all().map(row=>row.team),
    example:p.layout==="quote-comparison" ? {prompt:"比較のため新しい2社の見積書を添付する。",sources:[]} :
      { prompt:"次の更新商談に向けて、契約期限と先方の希望日を確認する。", sources:sourcesFor("sato","A社") } };
}

function requestedDelivery(p,input) {
  if (input.base !== p.hash || input.revision !== p.delivery.revision)
    throw new HubError(409,"手順または配布設定が更新されました。最新の設定を確認してください。");
  for (const field of ["teams","recommended","trials"]) {
    const values=input[field];
    if (!Array.isArray(values) || values.length>p.teams.length || new Set(values).size!==values.length ||
        values.some(value=>!p.teams.includes(value)))
      throw new HubError(400,"登録されている所属部門を選んでください。");
  }
  const {teams,recommended,trials}=input;
  if (recommended.length && (p.state!=="published" || recommended.some(team=>!teams.includes(team))))
    throw new HubError(409,"公開され、配布先に指定された部門だけに推奨できます。");
  return {teams,recommended,trials};
}

export function previewProcedureDelivery(db,id,input) {
  const p=procedureAdministration(db,id);
  const policy=requestedDelivery(p,input);
  if (typeof input.employee!=="string") throw new HubError(400,"表示を確認する社員を選んでください。");
  const employee=member(db,input.employee);
  const visible=employee.active && p.state==="published" && policy.teams.includes(employee.team);
  return {employee:employee.name,team:employee.team,active:employee.active,visible,
    recommended:visible && policy.recommended.includes(employee.team),
    trial:employee.active && p.state!=="revoked" && policy.trials.includes(employee.team),version:p.version};
}

export function changeProcedureDelivery(db,id,input,operator) {
  const reason=reasonText(input.reason);
  return transaction(db,()=>{
    const p=procedureAdministration(db,id);
    if (p.state==="revoked") throw new HubError(409,"公開取消済みの手順です。");
    const policy=requestedDelivery(p,input);
    const revision=p.delivery.revision+1;
    db.prepare(`INSERT INTO procedure_delivery(procedure,revision,teams,recommended,trials) VALUES(?,?,?,?,?)
      ON CONFLICT(procedure) DO UPDATE SET revision=excluded.revision,teams=excluded.teams,recommended=excluded.recommended,trials=excluded.trials`)
      .run(id,revision,JSON.stringify(policy.teams),JSON.stringify(policy.recommended),JSON.stringify(policy.trials));
    if (p.state==="published") {
      db.prepare(`UPDATE jobs SET status='procedure_revoked' WHERE procedure_id=?
        AND status IN ('scheduled','queued','dispatching','running','held','held_dispatched')
        AND COALESCE(scope_team,?) NOT IN (SELECT value FROM json_each(?))`).run(id,p.scope,JSON.stringify(policy.teams));
    }
    recordProcedureChange(db,p,"delivery",operator,reason,{before:p.delivery,after:{...policy,revision}});
    return { ...policy,revision };
  });
}

export function rollbackProcedure(db,id,input,operator) {
  const reason=reasonText(input.reason);
  return transaction(db,()=>{
    const p=adminVersion(db,id,input.base);
    if (p.revoked_at!==null) throw new HubError(423,"公開取消済みの手順です。");
    const archived=db.prepare(`SELECT ${fields} FROM procedure_history WHERE id=? AND version=?`).get(id,input.version ?? null);
    if (!archived || archived.hash!==input.hash || digest(archived)!==archived.hash) throw new HubError(409,"巻き戻す版を確認してください。");
    const next={...archived,version:p.version+1};
    next.hash=digest(next);
    promote(db,next,operator);
    recordProcedureChange(db,next,"rollback",operator,reason,{version:archived.version,hash:archived.hash});
    return next;
  });
}

export function revokeProcedure(db, id, hash, operator) {
  transaction(db, () => {
    const p = adminVersion(db, id, hash);
    if (p.revoked_at !== null) return;
    db.prepare("UPDATE procedures SET revoked_at=? WHERE id=?").run(Date.now(), id);
    db.prepare(`UPDATE jobs SET status='procedure_revoked' WHERE procedure_id=?
      AND status IN ('scheduled','queued','dispatching','running','held','held_dispatched')`).run(id);
    if (operator) recordProcedureChange(db,p,"revoke",operator,null);
  });
}

// A provider may quote an entire source paragraph with one trailing citation.
// Split only verbatim paragraphs whose citation matches. Keep the employee's words intact.
export function formatSharedMemo(text, sources) {
  const separator = "\n\n社員の判断\n";
  const end = text.indexOf(separator);
  if (end < 0 || !text.startsWith("資料の事実\n")) return text;
  const facts = text.slice(0, end).split("\n").map(line => {
    const source = sources.find(s => line === s.text + " [" + s.id + "]");
    if (!source) return line;
    return source.text.split(/(?<=。)/u).filter(Boolean).map(s => s + " [" + source.id + "]").join("\n");
  });
  return facts.join("\n") + text.slice(end);
}
