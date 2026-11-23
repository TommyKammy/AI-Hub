import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {activeMember,teamPermitsJob} from "../identity/memberships.mjs";
import {HubError,transaction} from "../operations.mjs";
import {employees} from "../fixtures.mjs";
import {usagePolicy} from "../models/usage-policy.mjs";

const desks=JSON.parse(readFileSync(new URL("./inquiry-desks.json",import.meta.url),"utf8"));
export function availableDesks(db) {
  const active=db.prepare("SELECT 1 FROM memberships WHERE actor=? AND team=? AND active=1");
  return desks.filter(d=>Object.hasOwn(employees,d.actor) && active.get(d.actor,d.team));
}

export function migrateInquiries(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS inquiry_drafts(job TEXT NOT NULL REFERENCES jobs(id),version INTEGER NOT NULL,
      phase TEXT NOT NULL,result TEXT,PRIMARY KEY(job,version),UNIQUE(job,phase));
    CREATE TABLE IF NOT EXISTS inquiries(id INTEGER PRIMARY KEY,job TEXT NOT NULL,version INTEGER NOT NULL,created INTEGER NOT NULL,
      desk TEXT NOT NULL,desk_name TEXT NOT NULL,recipient TEXT NOT NULL,recipient_team TEXT NOT NULL,
      subject TEXT NOT NULL,body TEXT NOT NULL,attachments TEXT NOT NULL,UNIQUE(job,version),
      FOREIGN KEY(job,version) REFERENCES inquiry_drafts(job,version));
    CREATE INDEX IF NOT EXISTS inquiries_received ON inquiries(recipient,recipient_team,id);
    CREATE TABLE IF NOT EXISTS inquiry_review_events(
      seq INTEGER PRIMARY KEY,job TEXT NOT NULL,version INTEGER NOT NULL,
      actor TEXT NOT NULL,action TEXT NOT NULL,content TEXT,created INTEGER NOT NULL,
      FOREIGN KEY(job,version) REFERENCES inquiry_drafts(job,version));
    CREATE INDEX IF NOT EXISTS inquiry_review_order ON inquiry_review_events(job,version,seq);
    CREATE TABLE IF NOT EXISTS inquiry_answers(
      inquiry INTEGER PRIMARY KEY REFERENCES inquiries(id), actor TEXT NOT NULL, name TEXT NOT NULL,
      body TEXT NOT NULL, created INTEGER NOT NULL, notification INTEGER NOT NULL UNIQUE REFERENCES job_notifications(seq));
    CREATE TABLE IF NOT EXISTS inquiry_followups(
      inquiry INTEGER NOT NULL REFERENCES inquiry_answers(inquiry), number INTEGER NOT NULL CHECK(number>0),
      question TEXT NOT NULL, asker TEXT NOT NULL, asked INTEGER NOT NULL,
      answer TEXT, responder TEXT, answered INTEGER, notification INTEGER UNIQUE REFERENCES job_notifications(seq),
      PRIMARY KEY(inquiry,number));
    CREATE UNIQUE INDEX IF NOT EXISTS inquiry_open_followup ON inquiry_followups(inquiry) WHERE answer IS NULL;
    CREATE TABLE IF NOT EXISTS inquiry_resolutions(
      inquiry INTEGER PRIMARY KEY REFERENCES inquiries(id),job TEXT NOT NULL,version INTEGER NOT NULL,round INTEGER NOT NULL,
      actor TEXT NOT NULL,name TEXT NOT NULL,created INTEGER NOT NULL,
      FOREIGN KEY(job,version) REFERENCES memo_versions(job_id,version),
      FOREIGN KEY(inquiry,round) REFERENCES inquiry_followups(inquiry,number));
    CREATE VIEW IF NOT EXISTS inquiry_reply_notifications AS
      SELECT inquiry,notification,NULL AS round FROM inquiry_answers
      UNION ALL SELECT inquiry,notification,number FROM inquiry_followups WHERE notification IS NOT NULL;`);
  if (!db.prepare("PRAGMA table_info(inquiry_drafts)").all().some(c=>c.name==="screenshot_review_required"))
    db.exec("ALTER TABLE inquiry_drafts ADD COLUMN screenshot_review_required INTEGER NOT NULL DEFAULT 0");
  // Reserve every legacy ticket's original citation before numbering any rounds.
  transaction(db,()=>{
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inquiry_citations'").get()) return;
    db.exec(`CREATE TABLE inquiry_citations(slot INTEGER PRIMARY KEY, inquiry INTEGER NOT NULL REFERENCES inquiries(id),
        round INTEGER NOT NULL CHECK(round>=0), UNIQUE(inquiry,round));
      INSERT INTO inquiry_citations(slot,inquiry,round) SELECT id,id,0 FROM inquiries;
      INSERT INTO inquiry_citations(inquiry,round) SELECT inquiry,number FROM inquiry_followups WHERE answer IS NOT NULL ORDER BY notification;
      CREATE TRIGGER cite_initial_answer AFTER INSERT ON inquiries BEGIN
        INSERT INTO inquiry_citations(inquiry,round) VALUES(NEW.id,0); END;
      CREATE TRIGGER cite_followup_answer AFTER UPDATE OF answer ON inquiry_followups WHEN OLD.answer IS NULL AND NEW.answer IS NOT NULL BEGIN
        INSERT INTO inquiry_citations(inquiry,round) VALUES(NEW.inquiry,NEW.number); END;`);
  });
}

export function parseInquiryDraft(output,sources) {
  let value;
  try {value=JSON.parse(output.replace(/^`{3}(?:json)?\s*|\s*`{3}$/gi,""));} catch {return null;}
  if (!validText(value?.subject,160) || !validText(value.body,4000) || !Array.isArray(value.attachments) ||
      value.attachments.some(id=>!sources.some(s=>s.id===id))) return null;
  return {subject:value.subject.trim(),body:value.body.trim(),attachments:[...new Set(value.attachments)]};
}
function validText(value,max) {return typeof value==="string" && value.trim().length>0 && value.length<=max;}
function inquiryReview(db,job,version) {
  return db.prepare("SELECT seq,action,content FROM inquiry_review_events WHERE job=? AND version=? ORDER BY seq DESC LIMIT 1")
    .get(job,version);
}
function reviewFingerprint(input) {
  return createHash("sha256").update(JSON.stringify([input.version,input.desk,input.recipient,
    input.subject.trim(),input.body.trim(),input.attachments.slice().sort((a,b)=>a-b)])).digest("hex");
}
function appendReview(db,job,version,actor,action,content) {
  return db.prepare("INSERT INTO inquiry_review_events(job,version,actor,action,content,created) VALUES(?,?,?,?,?,?) RETURNING seq,action")
    .get(job,version,actor,action,content,Date.now());
}
export function recordInquiryReview(hub,actor,jobId,input) {
  return transaction(hub.db,()=>{
    const job=hub.get(actor,jobId), version=input.version;
    if (job.team_denied || job.procedure_revoked) throw new HubError(403,"この仕事から起票できません。");
    const entry=job.inquiries.find(item=>item.version===version);
    if (!entry || entry.id) throw new HubError(409,"起票前の案を開き直してください。");
    const prior=inquiryReview(hub.db,jobId,version);
    const returning=input.action==="return";
    if (!returning && (input.action!=="preview" || !validText(input.subject,160) || !validText(input.body,4000) ||
        !Array.isArray(input.attachments) || !input.attachments.every(id=>job.sources.some(source=>source.id===id)) ||
        !availableDesks(hub.db).some(desk=>desk.id===input.desk && desk.actor===input.recipient)))
      throw new HubError(400,"宛先・件名・本文・添付資料を確認してください。");
    const content=returning ? prior?.content : reviewFingerprint(input);
    if (returning && prior?.action==="returned" || !returning && prior?.content===content && ["preview","resubmitted"].includes(prior.action))
      return {seq:prior.seq,action:prior.action};
    if ((prior?.seq ?? 0)!==input.expected || returning && !["preview","resubmitted"].includes(prior?.action))
      throw new HubError(409,"別の画面で起票案が変更されています。開き直してください。");
    return appendReview(hub.db,jobId,version,actor,returning ? "returned" : prior?.action==="returned" ? "resubmitted" : "preview",content);
  });
}

function followups(db,id) {
  return db.prepare("SELECT number,question,asker,asked,answer,responder,answered FROM inquiry_followups WHERE inquiry=? ORDER BY number").all(id);
}

function resolution(db,id) {
  return db.prepare("SELECT version,round,name,created FROM inquiry_resolutions WHERE inquiry=?").get(id) ?? null;
}

// A later edit may inherit a receipt, but it must still cite the answer in the adopted text.
export function resolutionCandidates(versions,adoptedVersion) {
  const byVersion=new Map(versions.map(v=>[v.version,v]));
  let v=byVersion.get(adoptedVersion);
  const cited=new Set(Array.from((v?.memo || "").matchAll(/\[(\d+)\]/g),m=>Number(m[1])));
  const candidates=new Map();
  while (v) {
    if (v.answer_round && cited.has(v.answer_source) && !candidates.has(v.answer_inquiry))
      candidates.set(v.answer_inquiry,{version:adoptedVersion,round:v.answer_round});
    v=byVersion.get(v.base);
  }
  return candidates;
}

export function inquiryVersions(db,job) {
  return db.prepare(`SELECT d.version,d.result,i.id,c.slot,i.desk_name,i.subject,i.body AS initial_question,i.created AS opened,a.name,a.body,a.created
    FROM inquiry_drafts d LEFT JOIN inquiries i USING(job,version) LEFT JOIN inquiry_answers a ON a.inquiry=i.id
    LEFT JOIN inquiry_citations c ON c.inquiry=i.id AND c.round=0
    WHERE d.job=? AND d.result IS NOT NULL ORDER BY d.version`).all(job)
    .map(({version,result,id,slot,desk_name,subject,initial_question,opened,name,body,created})=>({version,draft:JSON.parse(result),id,
      review_seq:inquiryReview(db,job,version)?.seq ?? 0,
      ...(body && {slot,desk:desk_name,subject,initial_question,opened,answer:{name,body,created},followups:followups(db,id),resolution:resolution(db,id)})}));
}

// The original inputs are fixed when the job is created. Receipt numbers are
// immutable, so branches of a job always give the same answer the same citation.
export function answerSourceId(originals,slot) {
  return Math.max(0,...originals.map(s=>s.id))+slot;
}

export function answerSources(db,job,version,originals) {
  if (!version) return [];
  const rows=db.prepare(`WITH RECURSIVE lineage(version,base,answer_inquiry,answer_round) AS (
      SELECT version,base,answer_inquiry,answer_round FROM memo_versions WHERE job_id=$job AND version=$version
      UNION ALL SELECT v.version,v.base,v.answer_inquiry,v.answer_round FROM lineage l JOIN memo_versions v ON v.job_id=$job AND v.version=l.base)
    SELECT DISTINCT i.id inquiry,i.subject,i.desk_name,c.slot,c.round,f.question,COALESCE(f.responder,a.name) name,
      COALESCE(f.answered,a.created) created,COALESCE(f.answer,a.body) body FROM lineage l
    JOIN inquiries i ON i.id=l.answer_inquiry AND i.job=$job JOIN inquiry_answers a ON a.inquiry=i.id
    JOIN inquiry_citations c ON c.inquiry=i.id AND c.round=COALESCE(l.answer_round,0)
    LEFT JOIN inquiry_followups f ON f.inquiry=i.id AND f.number=c.round WHERE c.round=0 OR f.answer IS NOT NULL ORDER BY c.slot`).all({job,version});
  return rows.map(r=>({id:answerSourceId(originals,r.slot),inquiry:r.inquiry,round:r.round,title:"受付票 #"+r.inquiry+" "+r.subject,
    ...(r.round && {question:r.question}),desk:r.desk_name,responder:r.name,answered_at:r.created,text:r.body}));
}

export function registerInquiry(hub,actor,jobId,input) {
  const {db}=hub;
  return transaction(db,()=>{
    const job=hub.get(actor,jobId);
    if (job.team_denied || job.procedure_revoked) throw new HubError(403,"この仕事から起票できません。");
    const {version,desk,attachments}=input;
    if (!Number.isSafeInteger(version) || typeof desk!=="string" || !validText(input.subject,160) ||
        !validText(input.body,4000) || !Array.isArray(attachments) || attachments.length>job.sources.length ||
        new Set(attachments).size!==attachments.length || attachments.some(id=>!job.sources.some(s=>s.id===id)))
      throw new HubError(400,"件名・本文・添付資料を確認してください。");
    const subject=input.subject.trim(), body=input.body.trim();
    const docs=job.sources.filter(s=>attachments.includes(s.id)).map(({id,title,text,version})=>({id,title,text,version}));
    const prior=db.prepare("SELECT * FROM inquiries WHERE job=? AND version=?").get(jobId,version);
    if (prior) {
      if (prior.desk!==desk || prior.recipient!==input.recipient || prior.subject!==subject || prior.body!==body || prior.attachments!==JSON.stringify(docs))
        throw new HubError(409,"この版は別の内容で起票済みです。元の仕事から受付票を開いてください。");
      return {id:prior.id};
    }
    if (!usagePolicy(db).settings.inquiry) throw new HubError(403,"利用ポリシーにより窓口への新規起票を停止しています。");
    const draft=db.prepare("SELECT result,screenshot_review_required FROM inquiry_drafts WHERE job=? AND version=?").get(jobId,version);
    if (!draft?.result) throw new HubError(409,"この版の起票案を先に作成してください。");
    const target=availableDesks(db).find(d=>d.id===desk);
    if (!target || target.actor!==input.recipient) throw new HubError(409,"窓口の受付状況が変わりました。画面を更新して宛先を確認してください。");
    const review=inquiryReview(db,jobId,version), fingerprint=reviewFingerprint(input);
    if ((draft.screenshot_review_required || review) &&
        (!["preview","resubmitted"].includes(review?.action) || review.seq!==input.review_seq || review.content!==fingerprint))
      throw new HubError(409,"確認した起票内容と一致しません。開き直して確認してください。");
    appendReview(db,jobId,version,actor,"approved",fingerprint);
    const row=db.prepare(`INSERT INTO inquiries(job,version,created,desk,desk_name,recipient,recipient_team,subject,body,attachments)
      VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(jobId,version,Date.now(),desk,target.name,target.actor,target.team,subject,body,JSON.stringify(docs));
    appendReview(db,jobId,version,actor,"registered",fingerprint);
    return {id:row.id};
  });
}

export function receivedInquiries(db,actor) {
  const member=activeMember(db,actor);
  const assigned=availableDesks(db).filter(d=>d.actor===actor).map(d=>d.id);
  return db.prepare(`SELECT i.id,i.desk_name,i.subject,i.created,a.inquiry IS NOT NULL AS answered,f.number AS pending_followup,r.created AS resolved_at FROM inquiries i
    LEFT JOIN inquiry_resolutions r ON r.inquiry=i.id LEFT JOIN inquiry_answers a ON a.inquiry=i.id
    LEFT JOIN inquiry_followups f ON f.inquiry=i.id AND f.answer IS NULL AND r.inquiry IS NULL
    WHERE recipient=? AND recipient_team=? AND desk IN (SELECT value FROM json_each(?)) ORDER BY f.asked DESC,i.id DESC`)
    .all(actor,member.team,JSON.stringify(assigned));
}
function ticketAccess(db,actor,id) {
  const member=activeMember(db,actor);
  const row=db.prepare("SELECT i.*,j.actor FROM inquiries i JOIN jobs j ON j.id=i.job WHERE i.id=?").get(id);
  const owner=row && row.actor===actor && teamPermitsJob(db,row.job);
  const assigned=row && row.recipient===actor && row.recipient_team===member.team && availableDesks(db).some(d=>d.actor===actor && d.id===row.desk);
  if (!owner && !assigned) throw new HubError(404,"受付票が見つかりません。");
  return {row,owner,assigned};
}
export function readInquiry(db,actor,id) {
  const {row,owner,assigned}=ticketAccess(db,actor,id);
  const answer=db.prepare("SELECT name,body,created FROM inquiry_answers WHERE inquiry=?").get(id) ?? null;
  const history=followups(db,id);
  const resolved=resolution(db,id);
  return {id:row.id,desk:row.desk_name,requester:employees[row.actor]?.name ?? row.actor,subject:row.subject,body:row.body,created:row.created,
    answer,followups:history,resolution:resolved,can_answer:assigned && !answer,can_reanswer:Boolean(!resolved && assigned && history.length && !history.at(-1).answer),
    attachments:JSON.parse(row.attachments),...(owner && {job:row.job,version:row.version})};
}

export function resolveInquiry(hub,actor,id,input) {
  const {db}=hub;
  return transaction(db,()=>{
    const {row,owner}=ticketAccess(db,actor,id);
    if (!owner) throw new HubError(403,"この受付票を解決済みにできるのは依頼者だけです。");
    if (!Number.isSafeInteger(input?.version) || input.version<1) throw new HubError(400,"採用版を指定してください。");
    const previous=resolution(db,id);
    if (previous) return previous;
    const ticket=hub.get(actor,row.job).inquiries.find(t=>t.id===id);
    const candidate=ticket?.resolution_candidate;
    if (!candidate || candidate.version!==input.version)
      throw new HubError(409,"この受付票の再回答を反映した現在の採用版を確認してください。");
    const last=ticket.followups.at(-1);
    if (input.last_round!==undefined && (input.last_round!==last.number || input.last_answered!==last.answered))
      throw new HubError(409,"窓口とのやり取りが更新されました。履歴を確認してください。");
    db.prepare("INSERT INTO inquiry_resolutions(inquiry,job,version,round,actor,name,created) VALUES(?,?,?,?,?,?,?)")
      .run(id,row.job,candidate.version,candidate.round,actor,employees[actor].name,Date.now());
    return resolution(db,id);
  });
}

export function postInquiryFollowup(db,actor,id,number,reply,input) {
  return transaction(db,()=>{
    const {row,owner,assigned}=ticketAccess(db,actor,id);
    if (reply ? !assigned : !owner) throw new HubError(403,reply ? "担当窓口だけが再回答できます。" : "依頼者だけが追加質問できます。");
    if (!Number.isSafeInteger(number) || number<1 || !validText(input?.body,4000))
      throw new HubError(400,"質問または回答を1〜4,000文字で入力してください。");
    const body=input.body.trim(), now=Date.now(), name=employees[actor].name;
    const turn=db.prepare("SELECT question,answer FROM inquiry_followups WHERE inquiry=? AND number=?").get(id,number);
    const prior=reply ? turn?.answer : turn?.question;
    if (prior!=null) {
      if (body!==prior) throw new HubError(409,"このやり取りは送信済みです。最新の受付票を確認してください。");
      return {id,number};
    }
    if (resolution(db,id)) throw new HubError(409,"この受付票は解決済みです。やり取りは履歴から確認できます。");
    if (reply) {
      if (!turn) throw new HubError(409,"回答する追加質問が見つかりません。");
      const {seq}=db.prepare("INSERT INTO job_notifications(job,phase,status,created) VALUES(?,'inquiry','inquiry_answered',?) RETURNING seq").get(row.job,now);
      db.prepare("UPDATE inquiry_followups SET answer=?,responder=?,answered=?,notification=? WHERE inquiry=? AND number=?")
        .run(body,name,now,seq,id,number);
    } else {
      if (!db.prepare("SELECT 1 FROM inquiry_answers WHERE inquiry=?").get(id)) throw new HubError(409,"窓口の初回回答をお待ちください。");
      if (!availableDesks(db).some(d=>d.id===row.desk && d.actor===row.recipient && d.team===row.recipient_team))
        throw new HubError(409,"現在、この受付票の担当窓口は追加質問を受け付けていません。");
      const last=db.prepare("SELECT number,answer FROM inquiry_followups WHERE inquiry=? ORDER BY number DESC LIMIT 1").get(id);
      if (number!==(last?.number ?? 0)+1 || (last && !last.answer)) throw new HubError(409,"前の質問への回答を確認してから追加質問してください。");
      db.prepare("INSERT INTO inquiry_followups(inquiry,number,question,asker,asked) VALUES(?,?,?,?,?)").run(id,number,body,name,now);
    }
    return {id,number};
  });
}

export function answerInquiry(db,actor,id,input) {
  return transaction(db,()=>{
    const {row,assigned}=ticketAccess(db,actor,id);
    if (!assigned) throw new HubError(403,"この受付票に回答できるのは担当窓口です。");
    if (!validText(input?.body,4000)) throw new HubError(400,"回答を1〜4,000文字で入力してください。");
    const body=input.body.trim();
    const prior=db.prepare("SELECT actor,body FROM inquiry_answers WHERE inquiry=?").get(id);
    if (prior) {
      if (prior.actor!==actor || prior.body!==body) throw new HubError(409,"この受付票には回答済みです。受付票を開き直してください。");
      return {id};
    }
    const now=Date.now();
    const {seq}=db.prepare("INSERT INTO job_notifications(job,phase,status,created) VALUES(?,'inquiry','inquiry_answered',?) RETURNING seq").get(row.job,now);
    db.prepare("INSERT INTO inquiry_answers(inquiry,actor,name,body,created,notification) VALUES(?,?,?,?,?,?)")
      .run(id,actor,employees[actor].name,body,now,seq);
    return {id};
  });
}
