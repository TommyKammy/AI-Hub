// Loopback-only integration fixture. Each Hub origin is an existing, isolated employee entry.
const entries = {sato:["http://127.0.0.1:19431","A社"], tanaka:["http://127.0.0.1:19432","B社"]};
const json = Response.json.bind(Response);
const accessible = `SELECT d.id FROM documents d JOIN grants g ON g.document=d.id WHERE g.actor=consultations.actor`;
const authorizedSources = `attached IN (${accessible}) AND expected IN (${accessible})`;

function hub(env, actor, path, options) {
  const request = new Request(entries[actor][0]+path,options);
  return env.HUB ? env.HUB.fetch(request) : fetch(request);
}

function findReceipt(env,actor,id) {
  return hub(env,actor,"/api/jobs/receipt",{headers:{"Idempotency-Key":id}});
}

async function requestHash(company,ask,documents) {
  if (typeof ask!=="string" || typeof company!=="string" || documents?.length!==2 ||
      !documents.every(doc=>typeof doc?.name==="string" && typeof doc.text==="string")) return null;
  const input = JSON.stringify([company,ask.trim(),documents.map(doc=>[doc.name.trim(),doc.text.trim()])]);
  const hash = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("");
}

async function expire(db) {
  await db.prepare("UPDATE consultations SET state='expired' WHERE state='waiting' AND deadline<=?").bind(Date.now()).run();
}
async function arrival(env, actor, id, document) {
  const db = env.DB;
  // Check the owner's current Hub access before taking up the event or reading either source.
  try {
    const employee = await findReceipt(env,actor,id);
    if (employee.status===403) return json({submitted:false},{status:403});
    if (![200,404].includes(employee.status)) return new Response(null,{status:503});
  } catch { return new Response(null,{status:503}); }

  const claim = crypto.randomUUID();
  const now = Date.now();
  const [,reservation,metadata,reads] = await db.batch([
    db.prepare(`UPDATE consultations SET state='denied' WHERE actor=? AND id=? AND expected=? AND state='waiting'
      AND deadline>? AND EXISTS(SELECT 1 FROM documents WHERE id=expected)
      AND (attached NOT IN (${accessible}) OR expected NOT IN (${accessible}))`)
      .bind(actor,id,document,now),
    db.prepare(`UPDATE consultations SET claim=?,state='submitting' WHERE actor=? AND id=?
      AND expected=? AND state='waiting' AND deadline>? AND ${authorizedSources}`)
      .bind(claim,actor,id,document,now),
    db.prepare("SELECT ask FROM consultations WHERE claim=?").bind(claim),
    db.prepare(`SELECT d.title AS name,d.body AS text FROM consultations c JOIN documents d ON d.id IN(c.attached,c.expected)
      JOIN grants g ON g.document=d.id AND g.actor=c.actor WHERE c.claim=? ORDER BY d.id=c.expected`).bind(claim),
    db.prepare(`INSERT INTO source_reads SELECT c.id,d.id FROM consultations c JOIN documents d ON d.id IN(c.attached,c.expected)
      JOIN grants g ON g.document=d.id AND g.actor=c.actor WHERE c.claim=?`).bind(claim)
  ]);
  if (!reservation.meta.changes) return json({submitted:false});
  if (reads.results.length!==2) throw Error("Source snapshot incomplete");
  const [origin,company] = entries[actor];
  const ask = metadata.results[0].ask;
  await db.prepare("UPDATE consultations SET request_hash=? WHERE claim=?")
    .bind(await requestHash(company,ask,reads.results),claim).run();
  // Keep an uncertain submission held. Duplicate event deliveries cannot acquire the claim.
  try {
    const reply=await hub(env,actor,"/api/jobs",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","Idempotency-Key":id},
      body:JSON.stringify({kind:"assistant",company,ask,contract:reads.results[0],second_attachment:reads.results[1]})});
    if (reply.ok) {
      const {id:job}=await reply.json();
      if (typeof job==="string" && job) {
        await db.prepare("UPDATE consultations SET job=?,state='submitted' WHERE claim=?").bind(job,claim).run();
        return json({submitted:true});
      }
    }
  } catch { /* The reconciliation path uses a receipt lookup, never a second POST. */ }
  return json({submitted:false,state:"submitting"},{status:202});
}

async function reconcile(env,actor,consult) {
  if (!["submitting","submitted"].includes(consult.state)) return new Response(null,{status:409});
  const {DB:db} = env;
  const allowed = () => db.prepare(`SELECT id FROM consultations WHERE id=? AND actor=? AND ${authorizedSources}`).bind(consult.id,actor).first();
  if (!await allowed()) return new Response(null,{status:403});
  let reply;
  try { reply = await findReceipt(env,actor,consult.id); }
  catch { return new Response(null,{status:503}); }
  if (reply.status===404 && consult.state==="submitting") return json({state:"submitting"},{status:202});
  if (reply.status===403) return new Response(null,{status:403});
  if (!reply.ok) return new Response(null,{status:503});
  const {id:job} = await reply.json();
  if (!job || (consult.job && consult.job!==job)) return new Response(null,{status:409});
  let stored;
  try {
    const result = await hub(env,actor,"/api/jobs/"+job);
    if ([403,404].includes(result.status)) return new Response(null,{status:result.status});
    if (!result.ok) return new Response(null,{status:503});
    stored = await result.json();
  } catch { return new Response(null,{status:503}); }
  const sources = stored.sources?.map(item=>({name:item.title,text:item.text}));
  if (stored.kind!=="assistant" || !consult.request_hash ||
      await requestHash(stored.company,stored.ask,sources)!==consult.request_hash)
    return new Response(null,{status:409});
  const resolved = await db.prepare(`UPDATE consultations SET job=?,state='submitted' WHERE id=? AND actor=?
    AND state IN ('submitting','submitted') AND (job IS NULL OR job=?) AND ${authorizedSources} RETURNING id`)
    .bind(job,consult.id,actor,job).first();
  return resolved ? json({state:"submitted",job}) : new Response(null,{status:403});
}
export default {
  async scheduled(event,env) {await expire(env.DB);},
  async fetch(req,env) {
    const actor=Object.keys(entries).find(a=>env[a.toUpperCase()+"_KEY"] && req.headers.get("Authorization")==="Bearer "+env[a.toUpperCase()+"_KEY"]);
    if (!actor) return new Response(null,{status:403});
    const db=env.DB, path=new URL(req.url).pathname;
    if (req.method==="GET" && path==="/inbox") return json((await db.prepare("SELECT consultation,created FROM inbox WHERE actor=?").bind(actor).all()).results);
    if (req.method==="POST" && path==="/consultations") {
      const {attached,expected,ask,deadline}=await req.json(), id=crypto.randomUUID();
      if (typeof ask!=="string" || !ask.trim() || attached===expected || !Number.isSafeInteger(deadline) || deadline<=Date.now()) return new Response(null,{status:400});
      const row=await db.prepare(`INSERT INTO consultations(id,actor,attached,expected,ask,deadline)
        SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM documents d JOIN grants g ON g.document=d.id WHERE d.id=? AND g.actor=?)`)
        .bind(id,actor,attached,expected,ask,deadline,attached,actor).run();
      return row.meta.changes ? json({id},{status:201}) : new Response(null,{status:403});
    }
    const match=path.match(/^\/consultations\/([\w-]+)(\/arrival|\/reconcile)?$/);
    if (!match) return new Response(null,{status:404});
    const [,id,action]=match;
    const consult=await db.prepare("SELECT id,ask,state,job,request_hash FROM consultations WHERE id=? AND actor=?").bind(id,actor).first();
    if (!consult) return new Response(null,{status:404});
    if (action==="/arrival" && req.method==="POST" && consult.state==="waiting")
      return arrival(env,actor,id,(await req.json()).document);
    if (action==="/arrival" && req.method==="POST") return json({submitted:false});
    if (action==="/reconcile" && req.method==="POST") return reconcile(env,actor,consult);
    if (action || req.method!=="GET") return new Response(null,{status:405});
    delete consult.request_hash;
    if (consult.job) {
      const permitted=db.prepare(`SELECT id FROM consultations WHERE id=? AND actor=? AND ${authorizedSources}`).bind(id,actor);
      if (!await permitted.first()) return new Response(null,{status:403});
      const result=await hub(env,actor,"/api/jobs/"+consult.job);
      if (!result.ok) return new Response(null,{status:result.status});
      const completed=await result.json();
      if (!await permitted.first()) return new Response(null,{status:403});
      consult.result=completed;
      consult.state=consult.result.status;
    }
    return json(consult);
  }
};
