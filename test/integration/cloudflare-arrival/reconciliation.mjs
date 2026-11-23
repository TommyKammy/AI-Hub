import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const wrangler = require.resolve("wrangler/package.json");
const {Miniflare,convertV4MiniflareOptions} = createRequire(wrangler)("miniflare");
const dir = await mkdtemp(join(tmpdir(),"aihub-wp08-arrival-"));
const key = {sato:randomUUID(),tanaka:randomUUID()};
const requests = new Map();
const accepted = new Map();
const askByJob = new Map();
const disabled = new Set();
let beforeKnownResult;
const config = convertV4MiniflareOptions({
  host:"127.0.0.1",port:0,cf:false,resourcePersistencePath:dir,unsafeTriggerHandlers:true,
  workers:[{
    name:"wp08-arrival-reconcile",modules:true,scriptPath:fileURLToPath(new URL("./worker.mjs",import.meta.url)),
    compatibilityDate:"2026-10-01",d1Databases:{DB:"arrival-db"},
    bindings:{SATO_KEY:key.sato,TANAKA_KEY:key.tanaka},
    serviceBindings:{HUB:async request=>{
      const url = new URL(request.url), actor = url.port==="19431" ? "sato" : "tanaka";
      const token = request.headers.get("Idempotency-Key");
      if (disabled.has(actor)) return new Response(null,{status:403});
      if (url.pathname==="/api/jobs/receipt" && request.method==="GET") {
        const result = accepted.get(actor+":"+token);
        return result ? Response.json({id:result}) : new Response(null,{status:404});
      }
      if (url.pathname==="/api/jobs" && request.method==="POST") {
        requests.set(token,(requests.get(token) ?? 0)+1);
        const {ask,company,kind,contract,second_attachment} = await request.json();
        if (ask==="claim-only") throw Error("connection lost before Hub received it");
        const job = randomUUID();
        accepted.set(actor+":"+token,job);
        askByJob.set(job,{ask,company,kind,sources:[contract,second_attachment].map(source=>({title:source.name,text:source.text}))});
        if (ask==="accepted-but-no-response") throw Error("connection lost after Hub accepted it");
        return Response.json({id:job},{status:201});
      }
      const job = url.pathname.split("/").at(-1);
      const saved = askByJob.get(job);
      if (!saved) return new Response(null,{status:404});
      if (saved.ask==="known-result" && beforeKnownResult) await beforeKnownResult();
      return Response.json({id:job,status:"done",memo:"合成結果。",...saved,versions:[{version:1,memo:"合成結果。"}]});
    }},
  }],
});
let mf = new Miniflare(config);
const api = (path,actor="sato",data) => mf.dispatchFetch("http://local.test"+path,{
  method:data===undefined ? "GET" : "POST",
  headers:{Authorization:"Bearer "+key[actor],...(data!==undefined && {"Content-Type":"application/json"})},
  ...(data!==undefined && {body:JSON.stringify(data)}),
});
const consultation = async (ask,actor="sato")=>{
  const response = await api("/consultations",actor,{attached:"a",expected:"b",ask,deadline:Date.now()+60_000});
  assert.equal(response.status,201);
  return "/consultations/"+(await response.json()).id;
};
const deliver = (path,actor="sato") => api(path+"/arrival",actor,{document:"b"});
const stats = (db,path) => db.prepare(`SELECT c.state,c.job,(SELECT count(*) FROM source_reads WHERE consultation=c.id) AS reads,
  (SELECT count(*) FROM inbox WHERE consultation=c.id) AS notices FROM consultations c WHERE id=?`)
  .bind(path.split("/").at(-1)).first();
const count = path => requests.get(path.split("/").at(-1)) ?? 0;

try {
  const db = await mf.getD1Database("DB");
  const schema = await readFile(new URL("./schema.sql",import.meta.url),"utf8");
  await db.batch(schema.trim().split(/(?<=;)\n(?=CREATE)/).map(sql=>db.prepare(sql)));
  await db.batch([
    db.prepare("INSERT INTO documents VALUES('a','A社見積','納期は10営業日'),('b','B社見積','納期は20営業日')"),
    db.prepare("INSERT INTO grants VALUES('sato','a'),('sato','b'),('tanaka','a'),('tanaka','b')"),
  ]);

  const race = await consultation("due-race");
  await db.prepare("UPDATE consultations SET deadline=? WHERE id=?").bind(Date.now(),race.split("/").at(-1)).run();
  const raceReplies = await Promise.all([
    ...Array.from({length:4},()=>deliver(race)),
    ...Array.from({length:4},()=>api("/cdn-cgi/local/scheduled?format=json")),
  ]);
  assert.ok(raceReplies.every(reply=>reply.ok));
  const expired = await stats(db,race);
  assert.deepEqual(expired,{state:"expired",job:null,reads:0,notices:1});
  assert.equal(count(race),0);
  const beforeDeadline = await consultation("arrival-before-deadline");
  const activeRace = await Promise.all([
    ...Array.from({length:4},()=>deliver(beforeDeadline)),
    ...Array.from({length:4},()=>api("/cdn-cgi/local/scheduled?format=json")),
  ]);
  assert.ok(activeRace.every(reply=>reply.ok));
  const started = await stats(db,beforeDeadline);
  assert.equal(started.state,"submitted");
  assert.equal(started.notices,0);
  assert.equal(started.reads,2);
  assert.equal(count(beforeDeadline),1);

  const inactive = await consultation("inactive","tanaka");
  disabled.add("tanaka");
  assert.equal((await deliver(inactive,"tanaka")).status,403);
  assert.equal((await stats(db,inactive)).reads,0);
  assert.equal(count(inactive),0);
  const [unknown,received,known] = await Promise.all([
    consultation("claim-only"),consultation("accepted-but-no-response"),consultation("known-result"),
  ]);
  assert.equal((await deliver(unknown)).status,202);
  assert.equal((await deliver(received)).status,202);
  const valid = await deliver(known);
  assert.deepEqual(await valid.json(),{submitted:true});
  assert.equal((await stats(db,unknown)).state,"submitting");
  assert.equal((await stats(db,received)).state,"submitting");

  await mf.dispose();
  mf = new Miniflare(config);
  assert.equal((await api(unknown+"/reconcile","sato",{})).status,202);
  assert.equal((await api(received+"/reconcile","tanaka",{})).status,404);
  const saved = accepted.get("sato:"+received.split("/").at(-1));
  const original = askByJob.get(saved);
  askByJob.set(saved,{...original,ask:"別の依頼"});
  assert.equal((await api(received+"/reconcile","sato",{})).status,409);
  askByJob.set(saved,original);
  const retries = await Promise.all(Array.from({length:8},()=>deliver(received)));
  assert.deepEqual(await Promise.all(retries.map(r=>r.json())),Array.from({length:8},()=>({submitted:false})));
  const reconciled = await Promise.all([1,2].map(()=>api(received+"/reconcile","sato",{})));
  const recovered = await Promise.all(reconciled.map(r=>r.json()));
  assert.ok(recovered.every(r=>r.state==="submitted" && r.job===recovered[0].job));
  const results = await Promise.all([known,received].map(async path=>(await api(path)).json()));
  assert.ok(results.every(r=>r.state==="done" && r.result.versions.length===1));
  assert.deepEqual([unknown,received,known].map(count),[1,1,1]);
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  beforeKnownResult = ()=>{entered.resolve(); return resume.promise;};
  const duringRevocation = api(known);
  try {
    await Promise.race([entered.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error("Expected a pending result read")),5000).unref())]);
    const restoredDb = await mf.getD1Database("DB");
    await restoredDb.prepare("DELETE FROM grants WHERE actor='sato' AND document='b'").run();
  } finally {
    resume.resolve();
  }
  assert.equal((await duringRevocation).status,403);
  console.log(JSON.stringify({
    wrangler:require(wrangler).version,arrivalDeadlineRace:{
      due:{state:expired.state,availabilityNotices:expired.notices,sourceReads:0,hubAccepted:0},
      inTime:{state:started.state,availabilityNotices:started.notices,sourceReads:started.reads,hubAccepted:1},
    },
    disabled:{status:403,sourceReads:0,hubAccepted:0},
    restart:{unknown:{submitted:1,accepted:0,state:"submitting"},recovered:{submitted:1,accepted:1,state:"done",duplicateDeliveries:8},
      known:{submitted:1,accepted:1,state:"done"},mismatchedEmployee:404,mismatchedRequestHash:409,revokedWhileReading:403},
    transport:"Local Worker and D1 with an injected Hub transport and synthetic results",
  },null,2));
} finally {
  await mf.dispose();
  await rm(dir,{recursive:true,force:true});
}
