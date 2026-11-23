import { createHash } from "node:crypto";
import { resolveVerifiedEmployee } from "./enterprise-directory.mjs";
import { activeMember } from "./memberships.mjs";
import { HubError, transaction } from "./operations.mjs";

const fingerprint=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function identifier(value) {
  if (typeof value!=="string" || !value || value.length>240 || /[\u0000-\u001f\u007f]/u.test(value))
    throw new HubError(400,"会話とアクティビティの識別子を確認してください。");
  return value;
}

export function directMessages(hub,{transport,publicOrigin,delivery,clock=Date.now}) {
  const {db}=hub;
  const root=new URL(publicOrigin);
  if (root.protocol!=="https:" || root.username || root.password || root.search || root.hash)
    throw new HubError(400,"本人用リンクの公開元を指定してください。");
  db.exec(`CREATE TABLE IF NOT EXISTS message_inbox(
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, tenant TEXT NOT NULL, conversation TEXT NOT NULL, activity TEXT NOT NULL,
    reference TEXT NOT NULL, text TEXT NOT NULL, operation TEXT NOT NULL,
    work TEXT REFERENCES jobs(id), version INTEGER, user_question INTEGER,
    hash TEXT NOT NULL, accepted INTEGER NOT NULL, membership_revision INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'accepted',
    UNIQUE(tenant,actor,conversation,activity));
    CREATE INDEX IF NOT EXISTS messages_by_conversation ON message_inbox(actor,tenant,conversation,work);
    CREATE TABLE IF NOT EXISTS message_outbox(
    id TEXT PRIMARY KEY REFERENCES message_inbox(id), summary TEXT NOT NULL, link TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'ready', next_attempt INTEGER NOT NULL,
    receipt TEXT); UPDATE message_outbox SET state='unknown' WHERE state='sending'`);

  function accept(event,verifiedClaims,channel) {
    if (channel!==transport || !["direct","relay"].includes(channel))
      throw new HubError(403,"現在選ばれている会話の受信経路と一致しません。");
    if (event?.type!=="message" || event.scope!=="personal" || !["new","followup"].includes(event.operation) ||
        typeof event.text!=="string" || !event.text.trim() || event.text.length>500)
      throw new HubError(400,"個人DMの依頼方法と本文を確認してください。");
    const person=resolveVerifiedEmployee(db,verifiedClaims);
    const tenant=verifiedClaims.tid.toLowerCase(), conversation=identifier(event.conversation), activity=identifier(event.activity);
    const reference=identifier(event.reference);
    const text=event.text.trim(), target=event.targetWork ?? null;
    if (target!==null && (typeof target!=="string" || !/^[a-f0-9-]{36}$/i.test(target)))
      throw new HubError(400,"追記する仕事を選んでください。");
    const key=fingerprint([tenant,person.actor,conversation,activity]),
      hash=fingerprint([reference,text,event.operation,target]);
    return transaction(db,()=>{
      const prior=db.prepare("SELECT hash FROM message_inbox WHERE id=?").get(key);
      if (prior) {
        if (prior.hash!==hash) throw new HubError(409,"同じアクティビティの受信内容が変わりました。");
        return {id:key};
      }
      let work=null, version=null;
      if (event.operation==="followup") {
        const works=db.prepare(`SELECT DISTINCT work FROM message_inbox WHERE actor=? AND tenant=? AND conversation=?
          AND work IS NOT NULL ORDER BY work`).all(person.actor,tenant,conversation);
        if (!target && works.length!==1) throw new HubError(409,"この会話で続ける仕事を1件選んでください。");
        work=target || works[0].work;
        if (!works.some(row=>row.work===work)) throw new HubError(404,"この会話に対応する仕事がありません。");
        const job=hub.get(person.actor,work);
        if (job.team_denied || job.procedure_revoked) throw new HubError(403,"現在、この仕事への追記を受け付けられません。");
        version=job.adopted_version ?? job.versions.findLast(row=>row.memo)?.version;
        if (!version || job.status!=="done") throw new HubError(409,"仕事の結果がそろってから追記できます。");
      }
      db.prepare(`INSERT INTO message_inbox(id,actor,tenant,conversation,activity,reference,text,operation,work,version,hash,accepted,membership_revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(key,person.actor,tenant,conversation,activity,reference,text,event.operation,work,version,hash,clock(),person.revision);
      return {id:key};
    });
  }

  function executeAccepted() {
    for (const event of db.prepare("SELECT * FROM message_inbox WHERE state='accepted' ORDER BY accepted,rowid LIMIT 20").all()) {
      try {
        const person=currentEmployee(event);
        if (event.operation==="followup") {
          hub.ask(event.actor,event.work,{question:event.text,version:event.version},event.id);
          const question=db.prepare("SELECT number FROM job_questions WHERE job_id=? AND request_key=?").get(event.work,event.id);
          db.prepare("UPDATE message_inbox SET user_question=?,state='working' WHERE id=?").run(question.number,event.id);
        } else {
          const job=hub.create(event.actor,{company:person.company,kind:"general",ask:event.text},event.id);
          db.prepare("UPDATE message_inbox SET work=?,state='working' WHERE id=?").run(job,event.id);
        }
      } catch(error) {
        if (error instanceof HubError && [400,403,404,409].includes(error.status))
          db.prepare("UPDATE message_inbox SET state='blocked' WHERE id=?").run(event.id);
        else if (!(error instanceof HubError) || error.status!==423) throw error;
      }
    }
  }

  function currentEmployee(event) {
    const person=activeMember(db,event.actor);
    if (person.revision!==event.membership_revision) throw new HubError(403,"受付時の利用資格が変更されています。");
    return person;
  }

  function finalize() {
    for (const event of db.prepare("SELECT * FROM message_inbox WHERE state='working'").all()) {
      try {
        currentEmployee(event);
        const job=hub.get(event.actor,event.work);
        if (job.team_denied || job.procedure_revoked) throw new HubError(403,"現在この仕事を参照できません。");
        const summary=event.user_question ? job.questions.find(question=>question.number===event.user_question)?.answer
          : job.memo ?? job.versions.find(row=>row.version===1)?.memo;
        if (!summary || job.status!=="done") continue;
        const link=new URL("/#job/"+job.id,root).href;
        transaction(db,()=>{
          db.prepare("INSERT OR IGNORE INTO message_outbox(id,summary,link,next_attempt) VALUES(?,?,?,?)")
            .run(event.id,summary.trim().slice(0,250),link,clock());
          db.prepare("UPDATE message_inbox SET state='reply' WHERE id=?").run(event.id);
        });
      } catch(error) {
        if (!(error instanceof HubError) || ![403,404].includes(error.status)) throw error;
        db.prepare("UPDATE message_inbox SET state='blocked' WHERE id=?").run(event.id);
      }
    }
  }

  let busy=false;
  return { accept, async pump() {
    if (busy) return;
    busy=true;
    try {
      executeAccepted();
      finalize();
      const queued=db.prepare(`SELECT o.*,i.actor,i.conversation,i.reference,i.work,i.membership_revision FROM message_outbox o
        JOIN message_inbox i ON i.id=o.id WHERE o.state IN ('ready','unknown')
        AND o.next_attempt<=? ORDER BY o.rowid LIMIT 20`).all(clock());
      for (const job of queued) {
        const args={key:job.id,actor:job.actor,conversation:job.conversation,reference:job.reference};
        try {
          currentEmployee(job);
          const work=hub.get(job.actor,job.work);
          if (work.team_denied || work.procedure_revoked) throw new HubError(403,"現在この仕事を配信できません。");
        } catch(error) {
          if (!(error instanceof HubError) || ![403,404].includes(error.status)) throw error;
          db.prepare("UPDATE message_outbox SET state='blocked' WHERE id=?").run(job.id);
          continue;
        }
        if (job.state==="unknown") {
          let result;
          try { result=await delivery.lookup(args); } catch {}
          if (result?.state==="sent") {
            db.prepare("UPDATE message_outbox SET state='sent',receipt=? WHERE id=?").run(identifier(result.receipt),job.id);
          } else if (result?.state==="not_sent") {
            db.prepare("UPDATE message_outbox SET state='ready' WHERE id=?").run(job.id);
          }
          continue;
        }
        const claimed=db.prepare("UPDATE message_outbox SET state='sending',attempts=attempts+1 WHERE id=? AND state='ready'").run(job.id);
        if (!claimed.changes) continue;
        let outcome;
        try { outcome=await delivery.send({...args,summary:job.summary,link:job.link}); } catch {}
        if (outcome?.state==="sent" && outcome.receipt) {
          db.prepare("UPDATE message_outbox SET state='sent',receipt=? WHERE id=?").run(identifier(outcome.receipt),job.id);
        } else {
          const retry=outcome?.state==="not_sent";
          const next=clock()+1000*Math.min(60,2**Math.min(6,job.attempts));
          db.prepare("UPDATE message_outbox SET state=?,next_attempt=? WHERE id=?").run(retry ? "ready" : "unknown",next,job.id);
        }
      }
    } finally { busy=false; }
  } };
}

export async function receivePersonalMessage(request,receiver,verify,transport) {
  try {
    if (request.method!=="POST") return new Response(null,{status:405});
    const reader=request.body?.getReader();
    if (!reader) return new Response(null,{status:400});
    const chunks=[];
    let length=0;
    try {
      while (true) {
        const part=await reader.read();
        if (part.done) break;
        length+=part.value.length;
        if (length>16000) {
          await reader.cancel();
          return new Response(null,{status:413});
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const body=new Uint8Array(length);
    let offset=0;
    for (const chunk of chunks) {body.set(chunk,offset);offset+=chunk.length;}
    const claims=await verify(request.headers,body);
    if (!claims) return new Response(null,{status:401});
    let event;
    try { event=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body)); } catch { return new Response(null,{status:400}); }
    return Response.json(receiver.accept(event,claims,transport),{status:202});
  } catch(error) {
    if (!(error instanceof HubError)) throw error;
    return Response.json({error:error.message},{status:error.status});
  }
}
