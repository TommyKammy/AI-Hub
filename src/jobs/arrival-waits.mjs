import {createHash} from "node:crypto";
import {documentText} from "../documents/document-text.mjs";
import {arrivalDocument} from "../documents/libraries.mjs";
import {HubError, transaction} from "../operations.mjs";

export function migrateArrivalWaits(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS arrival_waits(
    job TEXT PRIMARY KEY REFERENCES jobs(id), library_id TEXT NOT NULL, library_name TEXT NOT NULL,
    name TEXT NOT NULL, deadline INTEGER NOT NULL, member_revision INTEGER NOT NULL,
    accepted_token TEXT, started_at INTEGER, reason TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS source_deadline_once ON job_notifications(job)
      WHERE status='source_deadline';`);
}

export function arrivalSpec(input) {
  if (!input || typeof input.name!=="string" || input.name.length>200 ||
      !/^(?!\.)[^/\\\u0000-\u001f\u007f]+\.(txt|md|pdf|docx)$/i.test(input.name) ||
      typeof input.library_id!=="string" || input.library_id.length>250 ||
      !Number.isSafeInteger(input.deadline) || !Number.isFinite(new Date(input.deadline).valueOf()))
    throw new HubError(400,"到着先、ファイル名、待機期限を確認してください。");
  return {library_id:input.library_id,name:input.name,deadline:input.deadline};
}

export function registerArrivalWait(db, id, employee, spec, now=Date.now()) {
  if (spec.deadline<=now) throw new HubError(400,"これから先の待機期限を指定してください。");
  const target=arrivalDocument(employee,spec.library_id,spec.name,db);
  if (!target) throw new HubError(403,"到着先の資料置き場は現在参照できません。");
  if (target.token) throw new HubError(409,"指定した資料はすでに届いています。");
  db.prepare(`INSERT INTO arrival_waits(job,library_id,library_name,name,deadline,member_revision) VALUES(?,?,?,?,?,?)`)
    .run(id,spec.library_id,target.folder.name,spec.name,spec.deadline,employee.revision);
}

const waitFor=(db,id)=>db.prepare("SELECT * FROM arrival_waits WHERE job=?").get(id);

export function arrivalWait(db, job) {
  const wait=waitFor(db,job.id);
  if (!wait) return null;
  const {library_id,library_name,name,deadline,started_at,reason}=wait;
  const attachmentBlocked=["membership_blocked","account_blocked"].includes(job.status);
  return {library_id,library_name,name,deadline,started_at,reason:reason || (attachmentBlocked ? "attachment_access" : null)};
}

export function canDisplayArrival(db,job) {
  const wait=waitFor(db,job.id);
  if (wait.started_at!==null) return true;
  if (!wait.accepted_token) return false;
  const check=access(db,job,wait);
  return !check.reason && wait.accepted_token===check.target.token;
}

function access(db, job, wait) {
  const owner=db.prepare("SELECT actor,team,revision,active FROM memberships WHERE actor=?").get(job.actor);
  if (!owner?.active || owner.team!==job.scope_team || owner.revision!==wait.member_revision)
    return {reason:"attachment_access"};
  const target=arrivalDocument(owner,wait.library_id,wait.name,db);
  return target ? {target} : {reason:"arrival_access"};
}

function stop(db, job, reason, now, status=job.status) {
  const expired=reason==="deadline";
  const changed=db.prepare(`UPDATE jobs SET status=?,sources_json=json_remove(sources_json,'$[1]')
    WHERE id=? AND status=? AND phase='compose'`)
    .run(expired ? "source_expired" : "source_blocked",job.id,status);
  if (!changed.changes) return;
  db.prepare("UPDATE arrival_waits SET reason=? WHERE job=?").run(reason,job.id);
  if (expired) db.prepare(`INSERT INTO job_notifications(job,phase,status,created)
    VALUES(?,'compose','source_deadline',?) ON CONFLICT DO NOTHING`).run(job.id,now);
}

export function claimArrival(db, job, now=Date.now()) {
  const wait=waitFor(db,job.id);
  if (!wait || wait.started_at!==null || job.phase!=="compose") return true;
  const check=access(db,job,wait);
  if (check.reason || !wait.accepted_token || wait.accepted_token!==check.target.token) {
    stop(db,job,check.reason || "arrival_changed",now);
    return false;
  }
  return true;
}

export function markArrivalStarted(db,id,now) {
  db.prepare("UPDATE arrival_waits SET started_at=? WHERE job=? AND started_at IS NULL").run(now,id);
}

export function confirmArrivalSend(db,job) {
  return transaction(db,()=>{
    if (!db.prepare("SELECT 1 FROM jobs WHERE id=? AND status='dispatching'").get(job.id)) return false;
    const wait=waitFor(db,job.id), check=access(db,job,wait), now=Date.now();
    const reason=check.reason || (wait.accepted_token!==check.target.token ? "arrival_changed" : null);
    if (!reason) return true;
    stop(db,job,reason,now,"dispatching");
    db.prepare("DELETE FROM attempts WHERE job_id=? AND phase='compose' AND hermes_run_id IS NULL").run(job.id);
    db.prepare("DELETE FROM work_tool_results WHERE job=?").run(job.id);
    db.prepare("UPDATE arrival_waits SET started_at=NULL WHERE job=?").run(job.id);
    return false;
  });
}

export function createArrivalScanner(db, clock=Date.now) {
  let busy=false;
  return async function scan() {
    if (busy) return;
    busy=true;
    try {
      const pending=db.prepare(`SELECT j.id,j.actor,j.scope_team,j.status,j.phase,a.library_id,a.name,a.deadline,a.member_revision
        FROM arrival_waits a JOIN jobs j ON j.id=a.job
        WHERE j.phase='compose' AND a.started_at IS NULL AND j.status IN ('source_waiting','queued','held')
        ORDER BY a.deadline`).all();
      for (const job of pending) {
        const current=transaction(db,()=>{
          if (job.status!=="source_waiting") {
            claimArrival(db,job,clock());
            return null;
          }
          if (!db.prepare("SELECT 1 FROM jobs WHERE id=? AND status='source_waiting'").get(job.id)) return null;
          const check=access(db,job,job);
          const now=clock();
          if (check.reason || job.deadline<=now) {
            stop(db,job,check.reason || "deadline",now);
            return null;
          }
          return check.target;
        });
        if (!current?.token) continue;
        let text;
        try {
          text=await documentText(current.read(),job.name.split(".").at(-1).toLowerCase());
        } catch (error) {
          if (!(error instanceof HubError) && !["ENOENT","ENOTDIR","ELOOP","EACCES","EPERM"].includes(error.code)) throw error;
          transaction(db,()=>{
            const check=access(db,job,job);
            const checked=clock();
            if (check.reason) stop(db,job,check.reason,checked);
            else if (check.target.token===current.token) stop(db,job,"arrival_unreadable",checked);
          });
          continue;
        }
        transaction(db,()=>{
          if (!db.prepare("SELECT 1 FROM jobs WHERE id=? AND status='source_waiting'").get(job.id)) return;
          const check=access(db,job,job);
          if (check.reason) {
            stop(db,job,check.reason,clock());
            return;
          }
          if (check.target.token!==current.token) return;
          const version=createHash("sha256").update(text).digest("hex").slice(0,12);
          const source={id:2,title:job.name,version:"到着時の版 "+version,text,attached:true,library:job.library_id,library_name:current.folder.name};
          db.prepare("UPDATE jobs SET sources_json=json_insert(sources_json,'$[#]',json(?)),status='queued' WHERE id=?")
            .run(JSON.stringify(source),job.id);
          db.prepare("UPDATE arrival_waits SET accepted_token=? WHERE job=?").run(current.token,job.id);
        });
      }
    } finally { busy=false; }
  };
}
