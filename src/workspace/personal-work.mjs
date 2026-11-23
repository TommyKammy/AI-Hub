import { createHash, randomUUID } from "node:crypto";
import { activeMember, recordAdminChange, teamPermitsJob } from "../identity/memberships.mjs";
import { employees, renewalTeam } from "../fixtures.mjs";
import { HubError, reasonText, transaction } from "../operations.mjs";
import { standardWorkflows, workspaceTasks } from "../../skills/workspace-tasks.mjs";
import { publishedFor } from "../procedures/procedures.mjs";
import {librarySelection} from "../documents/libraries.mjs";
import {checkCsvColumns, csvSkillRelease} from "../procedures/csv-skill.mjs";
import {nextWeekday,recentWeekday} from "../jobs/reservation-plan.mjs";
import {assertDraftSources} from "../jobs/recurring-drafts.mjs";

const day = 86400000, week = 7 * day, japan = 9 * 3600000;
function field(value, limit) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new HubError(400, "入力内容を確認してください。");
  return value.trim();
}
export function nextWeekly(now, weekday, time) {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new HubError(400, "曜日と時刻を確認してください。");
  const local = new Date(now + japan);
  const [hour, minute] = time.split(":").map(Number);
  local.setUTCHours(hour, minute, 0, 0);
  const target = local.valueOf() - japan + ((weekday - local.getUTCDay() + 7) % 7) * day;
  return target > now ? target : target + week;
}
function monthlySlot(now,monthDay,time,offset) {
  const local = new Date(now+japan);
  const month = local.getUTCMonth()+offset, year = local.getUTCFullYear();
  const last = new Date(Date.UTC(year,month+1,0)).getUTCDate();
  const [hour,minute] = time.split(":").map(Number);
  return Date.UTC(year,month,Math.min(monthDay || last,last),hour,minute)-japan;
}
function nextSlot(now,s) {
  if (s.frequency==="weekdays") return nextWeekday(now,s.time);
  if (s.frequency==="daily") {
    const date = new Date(now+japan);
    const [hour,minute] = s.time.split(":").map(Number);
    const due = date.setUTCHours(hour,minute,0,0)-japan;
    return due > now ? due : due+day;
  }
  if (s.frequency !== "monthly") return nextWeekly(now,s.weekday,s.time);
  const due = monthlySlot(now,s.month_day,s.time,0);
  return due > now ? due : monthlySlot(now,s.month_day,s.time,1);
}
const adminScheduleKey = schedule => createHash("sha256").update(JSON.stringify(schedule)).digest("hex");
function scheduleAuditSummary(row) {
  const cadence = row.frequency === "weekly" ? "毎週" + "日月火水木金土"[row.weekday] + "曜" :
    row.frequency === "monthly" ? (row.month_day ? "毎月" + row.month_day + "日" : "毎月末日") :
    row.frequency === "weekdays" ? "平日" : "毎日";
  return [cadence, row.time + " JST", row.enabled ? "有効" : "一時停止"].join(" ／ ");
}
export function personalWork(hub) {
  const {db} = hub;
  db.exec(`CREATE TABLE IF NOT EXISTS personal_templates(
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, ask TEXT NOT NULL, output_format TEXT, UNIQUE(actor,name));
    CREATE TABLE IF NOT EXISTS personal_csv_releases(
      template TEXT NOT NULL REFERENCES personal_templates(id),version INTEGER NOT NULL,
      recipe TEXT NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(template,version));
    CREATE TABLE IF NOT EXISTS personal_workflow_releases(
      template TEXT NOT NULL REFERENCES personal_templates(id),version INTEGER NOT NULL,
      workflow TEXT NOT NULL,hash TEXT NOT NULL,ask TEXT NOT NULL,output_format TEXT,PRIMARY KEY(template,version));
    CREATE TABLE IF NOT EXISTS meeting_actions(
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, job TEXT NOT NULL REFERENCES jobs(id), version INTEGER NOT NULL,
      line TEXT NOT NULL, assignee TEXT NOT NULL, due TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      UNIQUE(job,version,line));
    CREATE TABLE IF NOT EXISTS work_projects(id TEXT PRIMARY KEY,actor TEXT NOT NULL,team TEXT NOT NULL,name TEXT NOT NULL,UNIQUE(actor,team,name));
    CREATE TABLE IF NOT EXISTS project_jobs(project TEXT NOT NULL REFERENCES work_projects(id),job TEXT NOT NULL REFERENCES jobs(id),PRIMARY KEY(project,job));
    CREATE TABLE IF NOT EXISTS project_members(project TEXT NOT NULL REFERENCES work_projects(id),actor TEXT NOT NULL,
      member_revision INTEGER NOT NULL,PRIMARY KEY(project,actor));
    CREATE TABLE IF NOT EXISTS project_handoffs(id INTEGER PRIMARY KEY,project TEXT NOT NULL REFERENCES work_projects(id),
      previous TEXT NOT NULL,next TEXT NOT NULL,operator TEXT NOT NULL,reason TEXT NOT NULL,occurred_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS procedure_favorites(actor TEXT NOT NULL,entry TEXT NOT NULL,PRIMARY KEY(actor,entry));
    CREATE TABLE IF NOT EXISTS schedule_occurrences(schedule TEXT NOT NULL REFERENCES weekly_schedules(id),slot INTEGER NOT NULL,
      run_at INTEGER NOT NULL,excluded TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(schedule,slot));
    CREATE INDEX IF NOT EXISTS occurrences_due ON schedule_occurrences(run_at);
    CREATE TABLE IF NOT EXISTS request_drafts(
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, team TEXT NOT NULL, revision INTEGER NOT NULL,
      content TEXT NOT NULL, updated INTEGER NOT NULL, submitted_job TEXT REFERENCES jobs(id));
    CREATE INDEX IF NOT EXISTS drafts_by_owner ON request_drafts(actor,team,updated);
    CREATE TABLE IF NOT EXISTS shared_memos(
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), sender TEXT NOT NULL, recipient TEXT NOT NULL,
    version INTEGER NOT NULL, title TEXT NOT NULL, memo TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(job_id,version,recipient));
    CREATE INDEX IF NOT EXISTS shared_recipient ON shared_memos(recipient,created);
    CREATE TABLE IF NOT EXISTS weekly_schedules(
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, team TEXT NOT NULL, name TEXT NOT NULL, ask TEXT NOT NULL,
    output_format TEXT, weekday INTEGER NOT NULL, time TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    next_run INTEGER NOT NULL, last_job TEXT REFERENCES jobs(id), UNIQUE(actor,name));
    CREATE TABLE IF NOT EXISTS scheduled_jobs(job TEXT PRIMARY KEY REFERENCES jobs(id),schedule TEXT NOT NULL, due INTEGER NOT NULL, UNIQUE(schedule,due));`);
  transaction(db, () => {
    if (!db.prepare("PRAGMA table_info(work_projects)").all().some(c=>c.name==="revision"))
      db.exec("ALTER TABLE work_projects ADD COLUMN responsible TEXT; ALTER TABLE work_projects ADD COLUMN due TEXT; ALTER TABLE work_projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    if (!db.prepare("PRAGMA table_info(project_jobs)").all().some(c=>c.name==="version"))
      db.exec("ALTER TABLE project_jobs ADD COLUMN version INTEGER");
    if (!db.prepare("PRAGMA table_info(shared_memos)").all().some(c=>c.name==="recipient_revision")) {
      db.exec(`ALTER TABLE shared_memos ADD COLUMN recipient_revision INTEGER;
        ALTER TABLE shared_memos ADD COLUMN revoked_at INTEGER; ALTER TABLE shared_memos ADD COLUMN seen INTEGER NOT NULL DEFAULT 0;
        UPDATE shared_memos SET recipient_revision=(SELECT revision FROM memberships WHERE actor=shared_memos.recipient)`);
    }
    if (!db.prepare("PRAGMA table_info(schedule_occurrences)").all().some(c=>c.name==="csv_input"))
      db.exec("ALTER TABLE schedule_occurrences ADD COLUMN csv_input TEXT");
    if (!db.prepare("PRAGMA table_info(schedule_occurrences)").all().some(c=>c.name==="quote_inputs"))
      db.exec("ALTER TABLE schedule_occurrences ADD COLUMN quote_inputs TEXT");
    if (!db.prepare("PRAGMA table_info(personal_templates)").all().some(c=>c.name==="recipe"))
      db.exec("ALTER TABLE personal_templates ADD COLUMN recipe TEXT; ALTER TABLE personal_templates ADD COLUMN team TEXT");
    if (!db.prepare("PRAGMA table_info(personal_templates)").all().some(c=>c.name==="version"))
      db.exec("ALTER TABLE personal_templates ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    if (!db.prepare("PRAGMA table_info(personal_templates)").all().some(c=>c.name==="standard_workflow"))
      db.exec("ALTER TABLE personal_templates ADD COLUMN standard_workflow TEXT; ALTER TABLE personal_templates ADD COLUMN standard_hash TEXT");
    const release=db.prepare("INSERT OR IGNORE INTO personal_csv_releases VALUES(?,?,?,?,?)");
    for (const template of db.prepare("SELECT id,version,recipe FROM personal_templates WHERE recipe IS NOT NULL AND id NOT IN (SELECT template FROM personal_csv_releases)").all()) {
      const {hash,body}=csvSkillRelease(template.id,template.version,JSON.parse(template.recipe));
      release.run(template.id,template.version,template.recipe,hash,body);
    }
    if (!db.prepare("PRAGMA table_info(weekly_schedules)").all().some(c => c.name === "template_id"))
      db.exec(`ALTER TABLE weekly_schedules ADD COLUMN template_id TEXT;
        ALTER TABLE weekly_schedules ADD COLUMN kind TEXT NOT NULL DEFAULT 'weekly';
        ALTER TABLE weekly_schedules ADD COLUMN frequency TEXT NOT NULL DEFAULT 'weekly';
        ALTER TABLE weekly_schedules ADD COLUMN month_day INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE weekly_schedules ADD COLUMN window_days INTEGER NOT NULL DEFAULT 7;
        ALTER TABLE weekly_schedules ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'all'`);
    if (!db.prepare("PRAGMA table_info(weekly_schedules)").all().some(c=>c.name==="planned_libraries"))
      db.exec("ALTER TABLE weekly_schedules ADD COLUMN planned_libraries TEXT; ALTER TABLE weekly_schedules ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo'");
    if (!db.prepare("PRAGMA table_info(weekly_schedules)").all().some(c=>c.name==="draft_origin"))
      db.exec("ALTER TABLE weekly_schedules ADD COLUMN draft_origin TEXT; ALTER TABLE weekly_schedules ADD COLUMN blocked_reason TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS scheduled_provenance(
      job TEXT PRIMARY KEY REFERENCES scheduled_jobs(job), period_from INTEGER, period_to INTEGER, timezone TEXT NOT NULL)`);
  });
  const projectScope=`p.team=$team AND ((p.revision=0 AND p.actor=$actor) OR EXISTS(SELECT 1 FROM project_members m
    WHERE m.project=p.id AND m.actor=$actor AND m.member_revision=$revision))`;
  const sharedScope=`s.revoked_at IS NULL AND s.recipient=$actor AND s.recipient_revision=$revision
    AND s.job_id IN (SELECT id FROM permitted_job_teams)`;
  function projectAccess(actor,id) {
    const member=activeMember(db,actor);
    const project=db.prepare(`SELECT p.* FROM work_projects p WHERE p.id=$id AND ${projectScope}`)
      .get({id,actor,team:member.team,revision:member.revision});
    if (!project) throw new HubError(404,"案件が見つかりません。");
    return {member,project};
  }
  function scheduleFor(actor,id) {
    const member=activeMember(db,actor);
    const s=db.prepare("SELECT * FROM weekly_schedules WHERE actor=? AND id=? AND team=?").get(actor,id,member.team);
    if (!s) throw new HubError(404,"定期実行が見つかりません。");
    return s;
  }
  function nextOccurrence(s) {
    const o=db.prepare("SELECT * FROM schedule_occurrences WHERE schedule=? AND run_at<=? ORDER BY run_at,slot LIMIT 1").get(s.id,s.next_run);
    return o ? {...o,excluded:JSON.parse(o.excluded)} : {slot:s.next_run,run_at:s.next_run,excluded:[],revision:0};
  }
  function scheduleSources(s,due) {
    return db.prepare(`SELECT j.id,j.ask,COALESCE(v.memo,j.memo) memo,COALESCE(j.adopted_version,
      (SELECT max(version) FROM memo_versions last WHERE last.job_id=j.id AND last.memo IS NOT NULL),1) version
      FROM jobs j LEFT JOIN memo_versions v ON v.job_id=j.id AND v.version=j.adopted_version
      WHERE j.actor=? AND j.id NOT IN (SELECT job FROM deleted_jobs) AND j.memo IS NOT NULL AND (?='all' OR j.kind=?) AND j.id IN (SELECT id FROM permitted_job_teams)
      AND j.id NOT IN (SELECT job FROM scheduled_jobs)
      AND COALESCE((SELECT MIN(created) FROM job_notifications n WHERE n.job=j.id AND n.status='done'),j.created)
      BETWEEN ? AND ? ORDER BY j.created DESC,j.rowid DESC LIMIT 40`).all(s.actor,s.source_kind,s.source_kind,due-s.window_days*day+1,due);
  }
  function validateDraftScheduleSource(s,member) {
    const draft=JSON.parse(s.draft_origin);
    const libraries=JSON.parse(s.planned_libraries || "[]");
    assertDraftSources(db,member,{template:draft.template,quote:draft.quote,jobs:draft.job ? [draft.job] : [],libraries});
    const names=libraries.length ? librarySelection(member,libraries,db).map(folder=>folder.name) : [];
    if (draft.job) names.push(hub.get(member.actor,draft.job).ask+"（採用時の第"+draft.version+"版）");
    return names;
  }
  function dispatchOccurrence(s,slot,due,excluded,{csv_input,quote_inputs}={}) {
    const draft=JSON.parse(s.draft_origin || "null");
    let source, permissions;
    if (draft) {
      const libraries=JSON.parse(s.planned_libraries || "[]");
      const rows=["csv","quote"].includes(s.source_kind) || libraries.length ? [] :
        scheduleSources(s,due).filter(j=>!excluded.includes(j.id) && j.id!==draft.job).slice(0,draft.job ? 11 : 12);
      permissions={template:draft.template,quote:draft.quote,libraries,jobs:[...(draft.job ? [draft.job] : []),...rows.map(j=>j.id)]};
      try { assertDraftSources(db,activeMember(db,s.actor),permissions); }
      catch (error) {
        if (!(error instanceof HubError) || error.status!==403) throw error;
        db.prepare("UPDATE weekly_schedules SET enabled=0,blocked_reason=? WHERE id=?").run(error.message,s.id);
        db.prepare("DELETE FROM schedule_occurrences WHERE schedule=?").run(s.id);
        return false;
      }
      if (libraries.length) source={library_ids:libraries};
      else if (!["csv","quote"].includes(s.source_kind)) {
        const refs=rows.map(({id,version})=>({job:id,version}));
        if (draft.job) refs.unshift({job:draft.job,version:draft.version});
        source=refs.length && !draft.workflow ? {work_refs:refs} :
          {minutes:rows.map(j=>j.ask+"\n"+j.memo.replace(/\[\d+\]/g,"")).join("\n\n").slice(0,6000) || "この期間に完了した仕事の記録はありません。"};
      }
      if (draft.template && s.source_kind!=="csv" && !draft.renewal) source.personal_template=draft.template;
    }
    if (s.source_kind==="csv") {
      if (!csv_input) return;
      source={csv_template_id:s.template_id,contract:JSON.parse(csv_input)};
    } else if (s.source_kind==="quote") {
      if (!quote_inputs) return;
      const [contract,second_attachment]=JSON.parse(quote_inputs);
      source={quote_skill_id:draft.quote.id,contract,second_attachment};
    } else if (!draft && s.source_kind==="plan") {
      const libraries=JSON.parse(s.planned_libraries || "[]");
      source=libraries.length ? {library_ids:libraries} : {};
      if (libraries.length) {
        try { librarySelection(activeMember(db,s.actor),libraries,db); }
        catch(error) {
          if (!(error instanceof HubError) || error.status!==403) throw error;
          db.prepare("UPDATE weekly_schedules SET enabled=0 WHERE id=?").run(s.id);
          db.prepare("DELETE FROM schedule_occurrences WHERE schedule=?").run(s.id);
          return false;
        }
      }
    } else if (!draft) {
      const rows=scheduleSources(s,due).filter(j=>!excluded.includes(j.id));
      source=s.planned_libraries && rows.length ? {work_refs:rows.slice(0,12).map(({id,version})=>({job:id,version}))} :
        {minutes:rows.map(j=>j.ask+"\n"+j.memo.replace(/\[\d+\]/g,"")).join("\n\n").slice(0,6000) || "この期間に完了した仕事の記録はありません。"};
    }
    const job=hub.create(s.actor,{company:employees[s.actor].company,kind:s.kind,ask:s.ask,...source,
      ...(draft && {skip_profile:true}),
      ...(s.output_format && {output_format:s.output_format})},"weekly-"+s.id+"-"+slot);
    if (draft) db.prepare("UPDATE jobs SET recurring_draft=? WHERE id=?").run(JSON.stringify(permissions),job);
    db.prepare("INSERT INTO scheduled_jobs VALUES(?,?,?)").run(job,s.id,slot);
    if (!["csv","quote","plan"].includes(s.source_kind))
      db.prepare("INSERT INTO scheduled_provenance VALUES(?,?,?,?)").run(job,due-s.window_days*day+1,due,s.timezone);
    db.prepare("UPDATE weekly_schedules SET last_job=? WHERE id=?").run(job,s.id);
  }
  function deleteJob(actor,id,selected) {
    const job=hub.get(actor,id);
    const dependents=db.prepare("SELECT parent FROM split_plans WHERE origin=? AND parent NOT IN (SELECT job FROM deleted_jobs)").all(id);
    if (dependents.some(row=>!selected.has(row.parent)))
      throw new HubError(409,"この依頼を使った作業分担があります。作業分担の依頼も一緒に選択してください。");
    if (db.prepare(`SELECT 1 FROM split_plans p JOIN split_parts s ON s.parent=p.parent
      WHERE p.aggregate IS NULL AND s.current_job=?`).get(id))
      throw new HubError(409,"作業分担の集約が終了してから子作業を削除してください。");
    if (job.status==="held") {
      const changed=db.prepare(`UPDATE jobs SET status='cancelled' WHERE id=? AND status='held'
        AND NOT EXISTS (SELECT 1 FROM attempts WHERE job_id=jobs.id AND phase=jobs.phase)`).run(id);
      if (!changed.changes) throw new HubError(409,"実行結果を確認してから削除してください。");
    } else if (["scheduled","queued","source_waiting"].includes(job.status)) hub.cancel(actor,id);
    else if (!["done","failed","cancelled","waiting","membership_blocked","procedure_revoked","source_expired","source_blocked","closed_unconfirmed","account_blocked"].includes(job.status))
      throw new HubError(409,"処理中の依頼があります。処理が終了してから削除してください。");
    if (db.prepare("SELECT 1 FROM shared_memos WHERE job_id=? AND revoked_at IS NULL").get(id))
      throw new HubError(409,"共有中の依頼があります。成果物の共有を解除してから削除してください。");
    db.prepare("DELETE FROM question_reminders WHERE job=?").run(id);
    db.prepare("INSERT INTO deleted_jobs VALUES(?)").run(id);
  }
  function deleteProcedure(actor,id,team) {
    const template=db.prepare("SELECT id FROM personal_templates WHERE actor=? AND id=? AND (team IS NULL OR team=?)").get(actor,id,team);
    if (template) {
      if (db.prepare("SELECT 1 FROM weekly_schedules WHERE template_id=? AND source_kind='csv' AND enabled=1").get(id))
        throw new HubError(409,"CSV手順の定期実行を一時停止してから削除してください。");
      if (db.prepare(`SELECT 1 FROM memo_versions v JOIN jobs j ON j.id=v.job_id
        WHERE json_extract(v.applied_procedure,'$.key')=? AND j.phase='revise-'||v.version
        AND j.status NOT IN ('done','failed','cancelled')`).get("personal:"+id))
        throw new HubError(409,"この手順を使用中の依頼があります。改訂が終了してから削除してください。");
      db.prepare("DELETE FROM personal_csv_releases WHERE template=?").run(id);
      db.prepare("DELETE FROM personal_workflow_releases WHERE template=?").run(id);
      db.prepare("DELETE FROM personal_templates WHERE id=?").run(id);
    } else {
      if (!hub.quoteSkills(actor).some(skill=>skill.id===id)) throw new HubError(404,"自分の手順が見つかりません。");
      db.prepare("INSERT INTO deleted_quote_skills VALUES(?)").run(id);
    }
    db.prepare("DELETE FROM procedure_favorites WHERE actor=? AND entry=?").run(actor,"personal:"+id);
  }
  return {
    overview(actor) {
      const member = activeMember(db, actor);
      return {
        actions: db.prepare(`SELECT a.*,j.ask FROM meeting_actions a JOIN jobs j ON j.id=a.job
          WHERE a.actor=? AND j.id NOT IN (SELECT job FROM deleted_jobs) AND j.id IN (SELECT id FROM permitted_job_teams) ORDER BY done,due,line`).all(actor),
        projects: db.prepare(`SELECT p.id,p.name,p.due,COALESCE(p.responsible,p.actor) responsible
          FROM work_projects p WHERE ${projectScope} ORDER BY p.name`).all({actor,team:member.team,revision:member.revision}),
        drafts: db.prepare("SELECT id,updated,json_extract(content,'$.ask') ask FROM request_drafts WHERE actor=? AND team=? AND submitted_job IS NULL ORDER BY updated DESC")
          .all(actor,member.team),
        templates: db.prepare("SELECT id,name,kind,ask,output_format,recipe,version,standard_workflow,standard_hash FROM personal_templates WHERE actor=? AND (team IS NULL OR team=?) ORDER BY name")
          .all(actor,member.team).map(t=>({...t,recipe:JSON.parse(t.recipe || "null")})),
        shared: this.sharedItems(actor),
        favorites: db.prepare("SELECT entry FROM procedure_favorites WHERE actor=? ORDER BY rowid DESC").all(actor).map(row=>row.entry),
        schedules: db.prepare(`SELECT id,name,weekday,time,enabled,next_run,last_job,frequency,month_day,window_days,source_kind,template_id,
          draft_origin IS NOT NULL AS recurring_draft,blocked_reason FROM weekly_schedules WHERE actor=?
          AND ((source_kind<>'csv' AND draft_origin IS NULL) OR team=?) ORDER BY name`).all(actor,member.team).map(s=>({...s,next_run:nextOccurrence(s).run_at})),
      };
    },
    deleteItems(actor,kind,ids) {
      if (!Array.isArray(ids) || !ids.length || !ids.every(id=>typeof id==="string" && id.length>0 && id.length<=80))
        throw new HubError(400,"削除する項目を選んでください。");
      return transaction(db,()=>{
        const member=activeMember(db,actor);
        const unique=new Set(ids);
        for (const id of unique) {
          if (kind==="jobs") deleteJob(actor,id,unique);
          else deleteProcedure(actor,id,member.team);
        }
        return {deleted:unique.size};
      });
    },
    favorite(actor,input) {
      const member=activeMember(db,actor);
      const [category,id]=typeof input.entry==="string" ? input.entry.split(":") : [];
      if (typeof input.selected!=="boolean" || !id) throw new HubError(400,"対象の手順を選び直してください。");
      if (input.selected) {
        const allowed=category==="standard" ? standardWorkflows.has(id) || (id==="renewal-brief" && renewalTeam===member.team) :
          category==="team" ? publishedFor(db,actor).some(procedure=>procedure.id===id) : category==="personal" ?
            this.overview(actor).templates.some(template=>template.id===id) || hub.quoteSkills(actor).some(skill=>skill.id===id) : false;
        if (!allowed) throw new HubError(404,"この手順を利用できません。");
        db.prepare("INSERT OR IGNORE INTO procedure_favorites VALUES(?,?)").run(actor,input.entry);
      } else db.prepare("DELETE FROM procedure_favorites WHERE actor=? AND entry=?").run(actor,input.entry);
      return {entry:input.entry,selected:input.selected};
    },
    fileInProject(actor,jobId,input) {
      return transaction(db, () => {
        const member=activeMember(db,actor);
        const j=hub.get(actor,jobId);
        if (!teamPermitsJob(db,jobId)) throw new HubError(403,"この仕事を現在の案件に追加できません。");
        let project;
        if (input.project) {
          const {id}=projectAccess(actor,input.project).project;
          project={id};
        }
        else {
          const name=field(input.name,80);
          db.prepare("INSERT OR IGNORE INTO work_projects(id,actor,team,name) VALUES(?,?,?,?)").run(randomUUID(),actor,member.team,name);
          project=db.prepare("SELECT id FROM work_projects WHERE actor=? AND team=? AND name=?").get(actor,member.team,name);
        }
        if (!project) throw new HubError(404,"案件が見つかりません。");
        const version=j.adopted_version ?? j.versions.at(-1)?.version ?? null;
        db.prepare(`INSERT INTO project_jobs(project,job,version) VALUES(?,?,?)
          ON CONFLICT(project,job) DO UPDATE SET version=COALESCE(excluded.version,project_jobs.version)`).run(project.id,jobId,version);
        return project;
      });
    },
    project(actor,id) {
      const {member,project}=projectAccess(actor,id);
      const responsible=project.responsible ?? project.actor;
      const links=db.prepare(`SELECT j.id,p.version FROM project_jobs p JOIN jobs j ON j.id=p.job WHERE p.project=? AND j.id NOT IN (SELECT job FROM deleted_jobs) AND j.actor=?
        AND j.id IN (SELECT id FROM permitted_job_teams) ORDER BY j.created DESC,j.rowid DESC`).all(id,actor);
      const jobs=links.map(link=>{
        const j=hub.get(actor,link.id);
        const v=j.versions.find(v=>v.version===(link.version ?? j.adopted_version)) ?? j.versions.at(-1);
        return {id:j.id,ask:j.ask,kind:j.kind,version:v?.version, memo:j.kind==="meeting" ? v?.memo : null,
          sources:j.sources.map(s=>({id:s.id,title:s.title}))};
      });
      const actions=db.prepare(`SELECT a.* FROM meeting_actions a JOIN project_jobs p ON p.job=a.job
        WHERE p.project=? AND a.job NOT IN (SELECT job FROM deleted_jobs) AND a.actor=? AND a.done=0 AND a.job IN (SELECT id FROM permitted_job_teams) ORDER BY due,line`).all(id,actor);
      const shares=db.prepare(`SELECT s.id,s.sender,s.title,s.version FROM shared_memos s JOIN project_jobs p ON p.job=s.job_id
        WHERE p.project=$id AND (p.version IS NULL OR p.version=s.version) AND ${sharedScope} ORDER BY s.created DESC`)
        .all({id,actor,revision:member.revision});
      const roster=responsible===actor ? db.prepare(`SELECT actor FROM memberships WHERE team=? AND active=1`).all(member.team)
        .filter(row=>Object.hasOwn(employees,row.actor)).map(row=>({actor:row.actor,name:employees[row.actor].name})) : [];
      const members=project.revision===0 ? [project.actor] : db.prepare("SELECT actor FROM project_members WHERE project=?")
        .all(id).map(row=>row.actor);
      return {id,name:project.name,due:project.due,revision:project.revision,responsible,responsible_name:employees[responsible]?.name ?? responsible,
        can_manage:responsible===actor,roster,members,jobs,actions,shares};
    },
    updateProject(actor,id,input) {
      return transaction(db,() => {
        const {member,project}=projectAccess(actor,id);
        if ((project.responsible ?? project.actor)!==actor) throw new HubError(403,"案件を更新できるのは現在の責任者です。");
        if (project.revision!==input.revision) throw new HubError(409,"案件が更新されました。開き直してください。");
        if (!Array.isArray(input.members) || !input.members.length || input.members.length>50 ||
            new Set(input.members).size!==input.members.length || !input.members.includes(input.responsible))
          throw new HubError(400,"責任者を含めた閲覧メンバーを選んでください。");
        const roster=input.members.map(id=>activeMember(db,id));
        if (roster.some(recipient=>recipient.team!==member.team))
          throw new HubError(403,"いま同じ部門に所属する社員を選んでください。");
        const due=input.due || null;
        if (due!==null && (typeof due!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(due) ||
          !Number.isFinite(Date.parse(due)) || new Date(due).toISOString().slice(0,10)!==due))
          throw new HubError(400,"期限の日付を確認してください。");
        if (input.responsible!==actor) {
          const reason=field(input.reason,400);
          db.prepare("INSERT INTO project_handoffs(project,previous,next,operator,reason,occurred_at) VALUES(?,?,?,?,?,?)")
            .run(id,actor,input.responsible,actor,reason,Date.now());
        }
        db.prepare("UPDATE work_projects SET due=?,responsible=?,revision=revision+1 WHERE id=?").run(due,input.responsible,id);
        db.prepare("DELETE FROM project_members WHERE project=?").run(id);
        const add=db.prepare("INSERT INTO project_members VALUES(?,?,?)");
        for (const recipient of roster) add.run(id,recipient.actor,recipient.revision);
        return {id,revision:project.revision+1};
      });
    },
    projectsForAdmin() {
      return db.prepare(`SELECT p.id,p.name,p.team,p.due,COALESCE(p.responsible,p.actor) responsible,
        p.revision,(SELECT count(*) FROM project_jobs k WHERE k.project=p.id) jobs,
        (SELECT count(*) FROM meeting_actions a JOIN project_jobs k ON k.job=a.job WHERE k.project=p.id AND a.done=0) open_items
        FROM work_projects p ORDER BY p.name`).all().map(project=>({...project,handoffs:db.prepare(`SELECT previous,next,operator,reason,occurred_at
          FROM project_handoffs WHERE project=? ORDER BY id DESC`).all(project.id),
        pending_items:db.prepare(`SELECT a.assignee,a.due FROM meeting_actions a JOIN project_jobs k ON k.job=a.job
          WHERE k.project=? AND a.done=0 ORDER BY a.due,a.assignee`).all(project.id)}));
    },
    registerCandidates(actor,id,input) {
      return transaction(db, () => {
        const j = hub.get(actor,id), set = j.candidate_sets.find(s => s.version === input.version);
        if (!set || !Array.isArray(input.items) || !input.items.length || input.items.length > set.items.length)
          throw new HubError(400,"登録する宿題を選んでください。");
        for (const item of input.items) {
          const candidate = item && Number.isInteger(item.index) && set.items[item.index];
          if (!candidate) throw new HubError(400,"候補を選び直してください。");
          this.trackAction(actor,id,{line:candidate.line,version:input.version,assignee:item.assignee,due:item.due},true);
        }
        return {ok:true};
      });
    },
    trackAction(actor,id,input,optionalFields=false) {
      const j = hub.get(actor,id);
      if (j.kind !== "meeting" || j.team_denied) throw new HubError(403,"この会議メモから宿題を登録できません。");
      const memo = j.versions.find(v => v.version === input.version)?.memo;
      const line = input.line;
      if (!memo || !memo.split("\n").map(s => s.trim()).includes(line) || !line)
        throw new HubError(400,"元のメモから宿題を選んでください。");
      const assignee = optionalFields && input.assignee === '' ? '' : field(input.assignee,80);
      const due = input.due;
      if (!(optionalFields && due === "") && (typeof due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due)) || new Date(due).toISOString().slice(0,10) !== due))
        throw new HubError(400,"有効な期限日を指定してください。");
      db.prepare(`INSERT INTO meeting_actions(id,actor,job,version,line,assignee,due) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(job,version,line) DO UPDATE SET assignee=excluded.assignee,due=excluded.due`).run(randomUUID(),actor,id,input.version,line,assignee,due);
      return {ok:true};
    },
    completeAction(actor,id,done) {
      activeMember(db,actor);
      if (typeof done !== "boolean") throw new HubError(400,"完了状態を指定してください。");
      const result = db.prepare("UPDATE meeting_actions SET done=? WHERE id=? AND actor=? AND job IN (SELECT id FROM permitted_job_teams)").run(Number(done),id,actor);
      if (!result.changes) throw new HubError(404,"宿題が見つかりません。");
      return {ok:true};
    },
    readDraft(actor,id) {
      const member = activeMember(db,actor);
      const row = db.prepare("SELECT revision,content FROM request_drafts WHERE actor=? AND team=? AND id=? AND submitted_job IS NULL").get(actor,member.team,id);
      if (!row) throw new HubError(404,"下書きが見つかりません。");
      return {id,revision:row.revision,...JSON.parse(row.content)};
    },
    saveDraft(actor,id,input) {
      const member = activeMember(db,actor), c = input.content;
      if (!c || !(workspaceTasks.has(c.kind) || c.kind === "renewal") || typeof c.ask !== "string" || c.ask.length > 4000)
        throw new HubError(400,"下書きの内容を確認してください。");
      const content = {kind:c.kind, ask:c.ask};
      if (c.library_document!==undefined && (c.library_ids===undefined || typeof c.library_document!=="string"))
        throw new HubError(400,"下書きで使う資料を確認してください。");
      if (c.library_ids!==undefined) {
        if (c.kind!=="assistant") throw new HubError(400,"資料置き場の検索には「Hermesにおまかせ」を使ってください。");
        content.library_ids=librarySelection(member,c.library_ids,db,c.library_document).map(l=>l.id);
        if (c.library_document!==undefined) {
          content.library_document=c.library_document;
          content.standard_workflow="source-answer";
        }
      }
      for (const [key,max] of [["minutes",6000],["output_format",500],["procedure_id",80],["planned_time",16]]) {
        if (c[key]) content[key] = field(c[key],max);
      }
      if (c.contract) content.contract = {name:field(c.contract.name,200),text:field(c.contract.text,12000)};
      if (c.second_attachment !== undefined) {
        if (!content.contract || c.kind !== "assistant") throw new HubError(400,"2件の添付資料を確認してください。");
        content.second_attachment={name:field(c.second_attachment?.name,200),text:field(c.second_attachment?.text,12000)};
      }
      const saved = JSON.stringify(content);
      return transaction(db, () => {
        const prior = db.prepare("SELECT * FROM request_drafts WHERE id=?").get(id);
        if (prior && (prior.actor !== actor || prior.team !== member.team)) throw new HubError(404,"下書きが見つかりません。");
        if (prior?.submitted_job) throw new HubError(409,"この下書きは依頼済みです。");
        if (prior?.content === saved) return {id,revision:prior.revision};
        if ((prior?.revision ?? 0) !== input.revision) throw new HubError(409,"下書きが更新されています。開き直してください。");
        const revision = input.revision + 1;
        db.prepare(`INSERT INTO request_drafts(id,actor,team,revision,content,updated) VALUES(?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,content=excluded.content,updated=excluded.updated`).run(id,actor,member.team,revision,saved,Date.now());
        return {id,revision};
      });
    },
    submitDraft(actor,input) {
      return transaction(db, () => {
        const m = activeMember(db,actor);
        const d = db.prepare("SELECT revision,submitted_job FROM request_drafts WHERE actor=? AND team=? AND id=?").get(actor,m.team,input.draft_id);
        if (!d) throw new HubError(404,"下書きが見つかりません。");
        if (d.revision !== input.draft_revision) throw new HubError(409,"下書きが更新されています。開き直してください。");
        const id = hub.create(actor,input,"draft-" + input.draft_id);
        if (!d.submitted_job) db.prepare("UPDATE request_drafts SET submitted_job=?,content='{}' WHERE id=?").run(id,input.draft_id);
        return id;
      });
    },
    saveTemplate(actor, input) {
      return transaction(db,()=>{
        const member=activeMember(db,actor);
        const base=input.base===undefined || input.base==="" ? null : Number(input.base);
        let recipe=null, workflow=null;
        if (input.source_job!==undefined) {
          const job=hub.get(actor,field(input.source_job,80));
          const adopted=job.adopted_version ?? (job.versions.length===1 ? 1 : null);
          if (!adopted || input.source_version!==undefined && Number(input.source_version)!==adopted)
            throw new HubError(409,"現在の採用版から手順を選んでください。");
          const tool=adopted===1 ? job.work_tool : job.versions.find(version=>version.version===adopted)?.work_tool;
          if (job.team_denied || job.status!=="done") throw new HubError(400,"完了して採用した成果物を選んでください。");
          if (input.source_workflow) {
            const name=input.source_workflow;
            if (!["source-answer","document-draft"].includes(name) || tool?.workflow?.name!==name)
              throw new HubError(400,"採用した規程調査または文章作成の手順を選んでください。");
            workflow={id:name,hash:tool.workflow.hash};
            input={...input,kind:"assistant"};
          } else {
            if (tool?.tool!=="aggregate_csv" || !tool.recipe) throw new HubError(400,"採用したCSV集計から保存してください。");
            recipe=JSON.stringify(tool.recipe);
            input={name:input.name,kind:"assistant",ask:"保存した条件でCSVを集計してください。"};
          }
        }
        const name=field(input.name,80), ask=field(input.ask,4000);
        const format=input.output_format ? field(input.output_format,500) : null;
        if (!workspaceTasks.has(input.kind) && input.kind!=="renewal") throw new HubError(400,"依頼の種類を選んでください。");
        const prior=db.prepare("SELECT * FROM personal_templates WHERE actor=? AND name=?").get(actor,name);
        const scope=recipe || workflow ? member.team : null;
        const workflowId=workflow?.id ?? null, workflowHash=workflow?.hash ?? null;
        if (prior && prior.kind===input.kind && prior.ask===ask && prior.output_format===format && prior.recipe===recipe &&
            prior.standard_workflow===workflowId && prior.standard_hash===workflowHash && prior.team===scope)
          return {id:prior.id,version:prior.version};
        if (prior && (prior.team!==scope || prior.version!==base ||
            !((recipe && prior.recipe) || (workflow && prior.standard_workflow===workflowId))))
          throw new HubError(409,"既存の手順を選び直すか、別の手順名で保存してください。");
        const id=prior?.id ?? randomUUID(), version=(prior?.version ?? 0)+1;
        if (prior) {
          db.prepare("UPDATE personal_templates SET version=?,recipe=?,ask=?,output_format=?,standard_hash=? WHERE id=?")
            .run(version,recipe,ask,format,workflowHash,id);
        } else {
          db.prepare(`INSERT INTO personal_templates(id,actor,name,kind,ask,output_format,recipe,team,version,standard_workflow,standard_hash)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,actor,name,input.kind,ask,format,recipe,scope,version,workflowId,workflowHash);
        }
        if (recipe) {
          const release=csvSkillRelease(id,version,JSON.parse(recipe));
          db.prepare("INSERT INTO personal_csv_releases VALUES(?,?,?,?,?)").run(id,version,recipe,release.hash,release.body);
          return {id,version,hash:release.hash};
        }
        if (workflow)
          db.prepare("INSERT INTO personal_workflow_releases VALUES(?,?,?,?,?,?)").run(id,version,workflowId,workflowHash,ask,format);
        return {id,version,...(workflowHash && {hash:workflowHash})};
      });
    },
    recipients(actor) {
      activeMember(db, actor);
      return db.prepare("SELECT actor FROM memberships WHERE active=1 AND actor<>? ORDER BY actor").all(actor)
        .filter(m => Object.hasOwn(employees, m.actor)).map(m => ({actor:m.actor, name:employees[m.actor].name}));
    },
    share(actor,id,input) {
      return transaction(db, () => {
        const j = hub.get(actor,id);
        if (j.recurring_draft) throw new HubError(403,"定期下書きは本人の依頼一覧で確認してください。");
        if (actor === input.recipient || !Object.hasOwn(employees,input.recipient)) throw new HubError(400, "共有する相手を選んでください。");
        const recipient=activeMember(db,input.recipient);
        if (!teamPermitsJob(db,id)) throw new HubError(403,"現在の所属ではこの成果物を共有できません。");
        const selected = j.versions.find(v => v.version === input.version);
        if (!selected) throw new HubError(409,"共有する版を確認してください。");
        const title = j.kind === "renewal" ? j.company + " 更新商談メモ" : j.skill_name;
        const prior=db.prepare("SELECT id,revoked_at,recipient_revision FROM shared_memos WHERE job_id=? AND version=? AND recipient=?")
          .get(id,input.version,input.recipient);
        if (prior && prior.revoked_at===null && prior.recipient_revision===recipient.revision) return {ok:true,id:prior.id};
        if (prior) db.prepare("DELETE FROM shared_memos WHERE id=?").run(prior.id);
        const shareId=randomUUID();
        db.prepare(`INSERT INTO shared_memos(id,job_id,sender,recipient,version,title,memo,created,recipient_revision)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(shareId,id,actor,input.recipient,input.version,title,selected.memo,Date.now(),recipient.revision);
        return {ok:true,id:shareId};
      });
    },
    readShare(actor,id) {
      const member=activeMember(db,actor);
      const snapshot = db.prepare(`SELECT s.sender,s.title,s.memo,s.version,s.created FROM shared_memos s WHERE s.id=$id AND ${sharedScope}`)
        .get({id,actor,revision:member.revision});
      if (!snapshot) throw new HubError(404,"共有された成果物が見つかりません。");
      return snapshot;
    },
    sharedItems(actor) {
      const member=activeMember(db,actor);
      return db.prepare(`SELECT s.id,s.sender,s.title,s.version,s.created,s.seen FROM shared_memos s WHERE ${sharedScope}
        ORDER BY s.created DESC`).all({actor,revision:member.revision});
    },
    sentShares(actor,id) {
      hub.get(actor,id);
      return db.prepare("SELECT id,version,recipient,created FROM shared_memos WHERE job_id=? AND sender=? AND revoked_at IS NULL")
        .all(id,actor);
    },
    revokeShare(actor,id) {
      activeMember(db,actor);
      const updated=db.prepare("UPDATE shared_memos SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND sender=?")
        .run(Date.now(),id,actor);
      if (!updated.changes) throw new HubError(404,"共有が見つかりません。");
      return {ok:true};
    },
    viewShare(actor,id) {
      const share=this.readShare(actor,id);
      db.prepare("UPDATE shared_memos SET seen=1 WHERE id=? AND recipient=?").run(id,actor);
      return share;
    },
    previewDraftSchedule(actor,input,now=Date.now()) {
      const member=activeMember(db,actor);
      const {job,version,template:templateId,quote:quoteId}=input?.origin || {};
      if ([job,templateId,quoteId].filter(id=>typeof id==="string" && id).length!==1 ||
          [job,templateId,quoteId].some(id=>id!==undefined && (typeof id!=="string" || !id)) ||
          job && (!Number.isSafeInteger(version) || version<1)) throw new HubError(400,"採用版または個人手順を指定してください。");
      const original=job && hub.get(actor,job);
      const adopted=original && (original.adopted_version ?? (original.versions.length===1 ? 1 : null));
      const originVersion=original && original.versions.find(v=>v.version===version);
      if (original && (original.kind!=="weekly" || original.status!=="done" || adopted!==version || !originVersion?.memo))
        throw new HubError(409,"完了した週報の採用版を開き直してください。");
      const template=templateId && db.prepare("SELECT * FROM personal_templates WHERE id=? AND actor=? AND (team IS NULL OR team=?)")
        .get(templateId,actor,member.team);
      if (templateId && !template) throw new HubError(404,"個人手順が見つかりません。");
      const quote=quoteId && hub.quoteSkills(actor).find(skill=>skill.id===quoteId);
      if (quoteId && !quote) throw new HubError(404,"個人の見積比較スキルが見つかりません。");
      const kind=quote ? "assistant" : template?.kind==="renewal" ? "general" : template?.kind ?? original.kind;
      const {frequency,weekday=0,month_day=0,time,window_days=7,source_kind="all"}=input;
      if (!["weekly","monthly"].includes(frequency) || !Number.isInteger(month_day) || month_day<0 || month_day>31 ||
          ![7,30].includes(window_days) || !["all","renewal",...workspaceTasks.keys()].includes(source_kind))
        throw new HubError(400,"繰り返しと資料の範囲を確認してください。");
      nextWeekly(now,weekday,time);
      const inputLibraries=input.libraries ?? [];
      if (!Array.isArray(inputLibraries) || inputLibraries.length &&
          (!template || kind!=="assistant" || template.recipe || template.standard_workflow==="document-draft"))
        throw new HubError(400,"この手順で使う資料の種類を確認してください。");
      const libraries=inputLibraries.length ? librarySelection(member,inputLibraries,db) : [];
      const origin=original ? {job,version} : quote ? {quote:{id:quote.id,hash:quote.hash}} : {template:{id:template.id,version:template.version},
        workflow:template.standard_workflow,renewal:template.kind==="renewal"};
      assertDraftSources(db,member,{template:origin.template,quote:origin.quote,jobs:original ? [job] : []});
      const nextRun=nextSlot(now,{frequency,weekday,month_day,time});
      const configuration={name:field(input.name,80),kind,ask:quote ? "新しい見積2件を個人スキルで比較してください。" : template?.ask ?? original.ask,
        output_format:quote?.output_format ?? template?.output_format ?? originVersion?.instruction?.slice(0,500) ?? original?.output_format ?? "",
        ...(template && {template_id:template.id}),frequency,weekday,month_day,time,window_days,
        source_kind:quote ? "quote" : libraries.length ? "plan" : source_kind,expected_at:nextRun,planned_libraries:libraries.map(library=>library.id)};
      const sourceTitle=original ? original.ask+"（採用版・第"+version+"版）" : quote ?
        "個人の見積比較スキル（第"+quote.skill_version+"版）" : template.name+"（第"+template.version+"版）";
      const token=adminScheduleKey([actor,member.revision,origin,configuration,libraries]);
      return {token,origin,configuration,nextRun,sourceTitle,libraries,csv:Boolean(template?.recipe),quote:Boolean(quote)};
    },
    confirmDraftSchedule(actor,input,now=Date.now()) {
      return transaction(db,()=>{
        const plan=this.previewDraftSchedule(actor,input,now);
        if (input.token!==plan.token) throw new HubError(409,"資料、手順または次回日時が変わりました。予約を確認し直してください。");
        return {...this.schedule(actor,plan.configuration,now,true,plan.origin),nextRun:plan.nextRun};
      });
    },
    schedule(actor,input,now=Date.now(),confirmed=false,draft=null) {
      const member = activeMember(db,actor);
      const template = input.template_id && db.prepare("SELECT * FROM personal_templates WHERE id=? AND actor=?").get(input.template_id,actor);
      if (input.template_id && !template) throw new HubError(404,"自分用の手順が見つかりません。");
      if (template?.recipe && template.team!==member.team) throw new HubError(404,"集計手順が見つかりません。");
      const name = field(input.name,80), ask = template ? template.ask : field(input.ask,4000);
      const format = template ? template.output_format : input.output_format ? field(input.output_format,500) : null;
      const libraries=confirmed && Array.isArray(input.planned_libraries) ? input.planned_libraries : null;
      const config = {template_id:template?.id ?? null, kind:draft?.renewal ? "general" : template?.kind ?? (confirmed ? input.kind : "weekly"),frequency:input.frequency ?? "weekly",
        month_day:input.month_day ?? 0,window_days:input.window_days ?? 7,source_kind:template?.recipe ? "csv" : input.source_kind ?? "all"};
      if (!["weekly","monthly","weekdays","daily"].includes(config.frequency) || !Number.isInteger(config.month_day) || config.month_day < 0 || config.month_day > 31 ||
          ![7,30].includes(config.window_days) || (!template?.recipe && !["all","renewal",...workspaceTasks.keys(),...(confirmed ? ["plan"] : []),...(draft?.quote ? ["quote"] : [])].includes(config.source_kind)))
        throw new HubError(400,"繰り返しと資料の範囲を確認してください。");
      nextWeekly(now,input.weekday,input.time);
      const next = nextSlot(now,{...input,...config});
      if (confirmed && next!==input.expected_at) throw new HubError(409,"次回日時が変わりました。予約を再確認してください。");
      if (libraries?.length) librarySelection(member,libraries,db);
      const prior = db.prepare("SELECT * FROM weekly_schedules WHERE actor=? AND name=?").get(actor,name);
      const draftOrigin=draft && JSON.stringify(draft);
      if (prior) {
        if (prior.ask !== ask || prior.output_format !== format || prior.weekday !== input.weekday || prior.time !== input.time ||
            prior.draft_origin!==draftOrigin || draft && prior.team!==member.team ||
            prior.planned_libraries !== (libraries && JSON.stringify(libraries)) || Object.keys(config).some(k => prior[k] !== config[k]))
          throw new HubError(409,"別の名前で登録してください。");
        return {id:prior.id};
      }
      const id = randomUUID();
      db.prepare("INSERT INTO weekly_schedules(id,actor,team,name,ask,output_format,weekday,time,next_run,template_id,kind,frequency,month_day,window_days,source_kind,planned_libraries,draft_origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id,actor,member.team,name,ask,format,input.weekday,input.time,next,config.template_id,config.kind,config.frequency,config.month_day,config.window_days,config.source_kind,libraries && JSON.stringify(libraries),draftOrigin);
      return {id};
    },
    adminSchedules(actor) {
      const member = db.prepare("SELECT team,active FROM memberships WHERE actor=?").get(actor);
      if (!member) throw new HubError(404,"社員が見つかりません。");
      return db.prepare("SELECT * FROM weekly_schedules WHERE actor=? AND team=? ORDER BY name,id").all(actor,member.team).map(schedule=>({
        id:schedule.id, name:schedule.name, ask:schedule.ask, enabled:Boolean(schedule.enabled), frequency:schedule.frequency,
        weekday:schedule.weekday, month_day:schedule.month_day, time:schedule.time, timezone:schedule.timezone,
        next_run:nextOccurrence(schedule).run_at, template:Boolean(schedule.template_id || schedule.draft_origin), base:adminScheduleKey(schedule),
      }));
    },
    saveAdminSchedule(actor,input,operator,now=Date.now()) {
      const name = field(input?.name,80), reason = reasonText(input?.reason);
      const {frequency,time,enabled,id,base} = input;
      if ((id === undefined) !== (base === undefined) ||
          (id !== undefined && (typeof id!=="string" || !/^[a-z0-9-]{1,128}$/i.test(id) || typeof base!=="string" || !/^[a-f0-9]{64}$/.test(base))))
        throw new HubError(400,"編集する予約とその状態を確認してください。");
      const weekday = frequency==="weekly" ? input.weekday : 0;
      const month_day = frequency==="monthly" ? input.month_day : 0;
      nextWeekly(now,weekday,time);
      if (!["weekly","monthly","weekdays","daily"].includes(frequency) || !Number.isInteger(month_day) || month_day < 0 || month_day > 31 || typeof enabled!=="boolean")
        throw new HubError(400,"繰り返しと有効状態を確認してください。");
      return transaction(db, () => {
        const member = activeMember(db,actor);
        const next = nextSlot(now,{frequency,weekday,month_day,time});
        const prior = id && scheduleFor(actor,id);
        const ask = prior?.template_id || prior?.draft_origin ? prior.ask : field(input.ask, prior && input.ask===prior.ask ? 4000 : 500);
        const duplicate = db.prepare("SELECT * FROM weekly_schedules WHERE actor=? AND name=?").get(actor,name);
        if (duplicate && duplicate.id!==prior?.id) {
          if (!prior && duplicate.team===member.team && duplicate.source_kind==="plan" && duplicate.ask===ask &&
              duplicate.frequency===frequency && duplicate.weekday===weekday && duplicate.month_day===month_day &&
              duplicate.time===time && Boolean(duplicate.enabled)===enabled) return {id:duplicate.id};
          throw new HubError(409,"同じ社員に同名の予約が登録されています。");
        }
        if (prior && adminScheduleKey(prior)!==base) throw new HubError(409,"予約が変わりました。社員詳細を開き直してください。");
        let scheduleId = id;
        const timingChanged = prior && (prior.frequency!==frequency || prior.weekday!==weekday || prior.month_day!==month_day || prior.time!==time);
        const toggle = prior && Boolean(prior.enabled)!==enabled;
        if (prior) {
          if (prior.draft_origin && toggle && enabled) validateDraftScheduleSource(prior,member);
          if ((timingChanged || toggle) && db.prepare("SELECT 1 FROM schedule_occurrences WHERE schedule=?").get(id))
            throw new HubError(409,"次回分に個別設定があります。本人が次回分の確認をしてから変更してください。");
          if (!timingChanged && !toggle && name===prior.name && ask===prior.ask) return {id};
          db.prepare(`UPDATE weekly_schedules SET name=?,ask=?,frequency=?,weekday=?,month_day=?,time=?,enabled=?,next_run=?,blocked_reason=NULL WHERE actor=? AND id=? AND team=?`)
            .run(name,ask,frequency,weekday,month_day,time,Number(enabled),timingChanged || toggle ? next : prior.next_run,actor,id,member.team);
        } else {
          scheduleId = this.schedule(actor,{name,ask,frequency,weekday,month_day,time,kind:"assistant",source_kind:"plan",planned_libraries:[],expected_at:next},now,true).id;
          if (!enabled) db.prepare("UPDATE weekly_schedules SET enabled=0 WHERE id=?").run(scheduleId);
        }
        recordAdminChange(db,{operator,scope:"employee",target:actor,action:prior ? "schedule-edit" : "schedule-create",
          before:prior ? scheduleAuditSummary(prior) : "",after:scheduleAuditSummary({frequency,weekday,month_day,time,enabled}),reason});
        return {id:scheduleId};
      });
    },
    previousReports(actor,id) {
      const j=hub.get(actor,id);
      if (j.team_denied) throw new HubError(403,"この報告を比較できません。");
      return db.prepare(`SELECT p.id,p.ask,p.created,COALESCE(p.adopted_version,
        (SELECT MAX(version) FROM memo_versions v WHERE v.job_id=p.id AND v.memo IS NOT NULL),1) AS memo_version,
        COALESCE(last.schedule=current.schedule,0) AS same_schedule FROM jobs p JOIN jobs origin ON origin.id=?
        LEFT JOIN scheduled_jobs current ON current.job=origin.id LEFT JOIN scheduled_jobs last ON last.job=p.id
        WHERE p.actor=? AND p.id NOT IN (SELECT job FROM deleted_jobs) AND p.status='done' AND p.memo IS NOT NULL AND p.id IN (SELECT id FROM permitted_job_teams)
        AND json_extract(p.sources_json,'$[0].period') IS NULL AND (p.created,p.rowid)<(origin.created,origin.rowid)
        ORDER BY same_schedule DESC,(p.kind=origin.kind) DESC,p.created DESC,p.rowid DESC`).all(id,actor);
    },
    reservationDetails(job) {
      return db.prepare(`SELECT s.name,k.due,s.timezone,p.period_from,p.period_to,s.draft_origin IS NOT NULL AS recurring_draft FROM scheduled_jobs k
        JOIN weekly_schedules s ON s.id=k.schedule LEFT JOIN scheduled_provenance p ON p.job=k.job WHERE k.job=?`).get(job) ?? null;
    },
    previewOccurrence(actor,id,at=null) {
      const s=scheduleFor(actor,id), next=nextOccurrence(s);
      if (at !== null && (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).valueOf()))) throw new HubError(400,"日時を確認してください。");
      const draft=JSON.parse(s.draft_origin || "null");
      const member=draft && activeMember(db,actor);
      const fixedSources=draft ? validateDraftScheduleSource(s,member) : [];
      if (s.source_kind==="csv") {
        return {slot:next.slot,run_at:next.run_at,revision:next.revision,name:s.name,csv:true,file:JSON.parse(next.csv_input || "null")?.name};
      }
      if (s.source_kind==="quote") return {slot:next.slot,run_at:next.run_at,revision:next.revision,name:s.name,quote:true,
        files:JSON.parse(next.quote_inputs || "[]").map(file=>file.name)};
      return {...next,name:s.name,fixedSources,sources:scheduleSources(s,at ?? next.run_at)
        .filter(j=>j.id!==draft?.job).map(j=>({id:j.id,ask:j.ask}))};
    },
    editOccurrence(actor,id,input,now=Date.now()) {
      return transaction(db, () => {
        const s=scheduleFor(actor,id), next=nextOccurrence(s);
        if (!s.enabled || next.slot !== input.slot || next.revision !== input.revision || next.run_at<=now)
          throw new HubError(409,"次回の予定が変わりました。開き直してください。");
        if (!["skip","change"].includes(input.action)) throw new HubError(400,"操作を選んでください。");
        if (s.draft_origin && input.action==="change") validateDraftScheduleSource(s,activeMember(db,actor));
        if (!next.revision) db.prepare("UPDATE weekly_schedules SET next_run=? WHERE id=?").run(nextSlot(next.slot,s),id);
        if (input.action === "skip") db.prepare("DELETE FROM schedule_occurrences WHERE schedule=? AND slot=?").run(id,next.slot);
        else {
          if (!Number.isSafeInteger(input.run_at) || input.run_at<=now || !Number.isFinite(new Date(input.run_at).valueOf()) ||
              !Array.isArray(input.excluded) || input.excluded.length>40) throw new HubError(400,"日時と資料を確認してください。");
          let csvInput=null,quoteInputs=null;
          if (s.source_kind==="csv") {
            const doc=input.contract || JSON.parse(next.csv_input || "null");
            const name=field(doc?.name,200), text=field(doc?.text,12000);
            if (!/\.csv$/i.test(name)) throw new HubError(400,"今回集計するCSVを選んでください。");
            const template=db.prepare("SELECT recipe FROM personal_templates WHERE id=? AND actor=? AND team=?").get(s.template_id,actor,s.team);
            if (!template) throw new HubError(404,"集計手順が見つかりません。");
            checkCsvColumns(text,JSON.parse(template.recipe));
            csvInput=JSON.stringify({name,text});
          } else if (s.source_kind==="quote") {
            const docs=input.quotes ?? JSON.parse(next.quote_inputs || "null");
            if (!Array.isArray(docs) || docs.length!==2) throw new HubError(400,"この回の見積書を2件選んでください。");
            const files=docs.map(doc=>({name:field(doc?.name,200),text:field(doc?.text,12000)}));
            if (files[0].text===files[1].text) throw new HubError(400,"内容の異なる見積書を2件選んでください。");
            quoteInputs=JSON.stringify(files);
          } else {
            const allowed=new Set([...next.excluded,...scheduleSources(s,next.run_at).map(j=>j.id),...scheduleSources(s,input.run_at).map(j=>j.id)]);
            if (input.excluded.some(job=>!allowed.has(job))) throw new HubError(400,"除外する資料を選び直してください。");
          }
          db.prepare(`INSERT INTO schedule_occurrences(schedule,slot,run_at,excluded,revision,csv_input,quote_inputs) VALUES(?,?,?,?,?,?,?) ON CONFLICT(schedule,slot) DO UPDATE SET
            run_at=excluded.run_at,excluded=excluded.excluded,revision=excluded.revision,csv_input=excluded.csv_input,quote_inputs=excluded.quote_inputs`)
            .run(id,next.slot,input.run_at,JSON.stringify([...new Set(input.excluded)]),next.revision+1,csvInput,quoteInputs);
        }
        return {ok:true};
      });
    },
    enableSchedule(actor,id,enabled,now=Date.now()) {
      const member = activeMember(db,actor);
      const schedule = db.prepare("SELECT * FROM weekly_schedules WHERE actor=? AND id=?").get(actor,id);
      if (!schedule || ((schedule.source_kind==="csv" || schedule.planned_libraries!==null) && schedule.team!==member.team)) throw new HubError(404,"定期実行が見つかりません。");
      if (enabled && schedule.source_kind==="csv" && !db.prepare("SELECT 1 FROM personal_templates WHERE id=?").get(schedule.template_id))
        throw new HubError(409,"この定期実行の集計手順は削除されています。");
      if (typeof enabled !== "boolean") throw new HubError(400,"利用状態を指定してください。");
      if (Boolean(schedule.enabled) !== enabled) transaction(db, () => {
        if (enabled && schedule.draft_origin) validateDraftScheduleSource(schedule,member);
        db.prepare("DELETE FROM schedule_occurrences WHERE schedule=?").run(id);
        db.prepare("UPDATE weekly_schedules SET enabled=?,team=?,next_run=?,blocked_reason=NULL WHERE id=?").run(Number(enabled),member.team,nextSlot(now,schedule),id);
      });
      return {ok:true};
    },
    runDue(now=Date.now()) {
      for (const row of db.prepare("SELECT id FROM weekly_schedules s WHERE enabled=1 AND (next_run<=? OR EXISTS(SELECT 1 FROM schedule_occurrences o WHERE o.schedule=s.id AND o.run_at<=?))").all(now,now)) {
        try {
          transaction(db, () => {
            const s = db.prepare("SELECT * FROM weekly_schedules WHERE id=? AND enabled=1").get(row.id);
            if (!s) return;
            const m = db.prepare("SELECT team,active FROM memberships WHERE actor=?").get(s.actor);
            if (!m?.active || m.team !== s.team || !Object.hasOwn(employees,s.actor)) {
              db.prepare("UPDATE weekly_schedules SET enabled=0 WHERE id=?").run(s.id);
              return;
            }
            for (const o of db.prepare("SELECT * FROM schedule_occurrences WHERE schedule=? AND run_at<=? ORDER BY run_at,slot").all(s.id,now)) {
              if (dispatchOccurrence(s,o.slot,o.run_at,JSON.parse(o.excluded),o)===false) return;
              db.prepare("DELETE FROM schedule_occurrences WHERE schedule=? AND slot=?").run(s.id,o.slot);
            }
            if (s.next_run>now) return;
            let due = s.next_run + Math.floor((now-s.next_run)/week)*week;
            if (s.frequency === "monthly") {
              due = monthlySlot(now,s.month_day,s.time,0);
              if (due > now) due = monthlySlot(now,s.month_day,s.time,-1);
            }
            if (s.frequency==="weekdays") due=recentWeekday(now,s.time);
            if (s.frequency==="daily") due=s.next_run + Math.floor((now-s.next_run)/day)*day;
            if (dispatchOccurrence(s,due,due,[])===false) return;
            db.prepare("UPDATE weekly_schedules SET next_run=? WHERE id=?").run(nextSlot(due,s),s.id);
          });
        } catch (e) { if (!(e instanceof HubError && e.status === 423)) console.error("定期実行の受付に失敗しました。",row.id); }
      }
    },
  };
}
