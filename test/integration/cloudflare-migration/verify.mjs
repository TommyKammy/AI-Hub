import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker, openHub } from "../../../src/jobs/hub.mjs";
import { setMemberActive } from "../../../src/identity/memberships.mjs";

const require = createRequire(import.meta.url);
const wrangler = require.resolve("wrangler/package.json");
const {Miniflare,convertV4MiniflareOptions} = createRequire(wrangler)("miniflare");
const dir = await mkdtemp(join(tmpdir(),"aihub-wp08-migration-"));
const {db,create,revise,adopt,get} = openHub(join(dir,"old.sqlite"));
const actors = {sato:randomUUID(),tanaka:randomUUID()};
const sha = value => createHash("sha256").update(value).digest("hex");
const config = convertV4MiniflareOptions({
  host:"127.0.0.1",port:0,cf:false,resourcePersistencePath:join(dir,"cloudflare"),
  workers:[{
    name:"wp08-migration",modules:true,scriptPath:fileURLToPath(new URL("./worker.mjs",import.meta.url)),
    compatibilityDate:"2026-10-01",
    d1Databases:{BUSINESS:"wp08-business"},
    r2Buckets:{BODIES:"wp08-private-bodies"},
    bindings:{testActors:actors},
  }],
});
let mf;
try {
  const add = (actor,text) => create(actor,{
    company:actor==="sato" ? "A社" : "B社",kind:"meeting",ask:"会議を要約",minutes:text,
  },randomUUID());
  const first = add("sato","11月23日に保守契約を見直す。");
  const second = add("tanaka","11月25日に見積を取り寄せる。");
  const worker = createWorker(db,async (_actor,path,init)=>init?.method==="POST" ?
    {run_id:init.headers["Idempotency-Key"]} : {status:"completed",output:path.includes("revise") ? "修正版。 [1]" : "初稿。 [1]"});
  await worker();
  await worker();
  revise("sato",first,{base:1,instruction:"簡潔にする"},randomUUID());
  await worker();
  await worker();
  adopt("sato",first,1,2);
  const old = [get("sato",first),get("tanaka",second)];
  setMemberActive(db,"tanaka",{base:1,active:false,reason:"移行リハーサルの利用停止"},"aoki");
  const members = db.prepare("SELECT actor,team,active FROM memberships WHERE actor IN ('sato','tanaka') ORDER BY actor").all();
  const expected = old.map((job,index)=>{
    const objects = [
      ...job.versions.map(v=>({kind:"versions",number:v.version,content:v.memo})),
      ...job.sources.map(s=>({kind:"sources",number:s.id,content:s.text,title:s.title,edition:s.version})),
    ].map(object=>({...object,key:job.id+"/"+object.kind+"/"+object.number,digest:sha(object.content)}));
    const actor = index===0 ? "sato" : "tanaka";
    return {id:job.id,actor,team:job.scope_team,adopted_version:job.adopted_version,skill_hash:job.skill_hash,status:job.status,objects};
  });

  mf = new Miniflare(config);
  const business = await mf.getD1Database("BUSINESS");
  const bodies = await mf.getR2Bucket("BODIES");
  await business.batch([
    business.prepare("CREATE TABLE members(actor TEXT PRIMARY KEY, team TEXT NOT NULL, active INTEGER NOT NULL)"),
    business.prepare("CREATE TABLE jobs(id TEXT PRIMARY KEY, actor TEXT NOT NULL REFERENCES members(actor), team TEXT NOT NULL, adopted_version INTEGER, skill_hash TEXT NOT NULL, status TEXT NOT NULL)"),
    business.prepare("CREATE TABLE objects(job TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL, version INTEGER NOT NULL, key TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, title TEXT, edition TEXT, PRIMARY KEY(job,kind,version))"),
  ]);
  for (const job of expected) {
    for (const object of job.objects) {
      await bodies.put(object.key,object.content);
      assert.equal(sha(await (await bodies.get(object.key)).text()),object.digest);
    }
  }
  await business.batch([
    ...members.map(m=>business.prepare("INSERT INTO members VALUES(?,?,?)").bind(m.actor,m.team,m.active)),
    ...expected.flatMap(job=>[
      business.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?)").bind(job.id,job.actor,job.team,job.adopted_version,job.skill_hash,job.status),
      ...job.objects.map(o=>business.prepare("INSERT INTO objects VALUES(?,?,?,?,?,?,?)")
        .bind(job.id,o.kind,o.number,o.key,o.digest,o.title ?? null,o.edition ?? null)),
    ]),
  ]);
  const counts = await business.prepare(`SELECT (SELECT count(*) FROM jobs) AS jobs,
    (SELECT count(*) FROM objects WHERE kind='versions') AS versions,
    (SELECT count(*) FROM objects WHERE kind='sources') AS sources`).first();
  assert.deepEqual(counts,{jobs:2,versions:3,sources:2});
  assert.equal((await bodies.list()).objects.length,5);

  // Duplicate the old write direction during shadow reading without dual writing.
  const postSnapshot = add("sato","スナップショット後の新規依頼。");
  assert.equal(get("sato",postSnapshot).status,"queued");
  await mf.dispose();
  mf = new Miniflare(config);
  const http = (path,actor,headers={}) => mf.dispatchFetch("http://local.test"+path,{
    headers:{...(actor && {Authorization:"Bearer "+actors[actor]}),...headers},
  });
  const own = await http("/jobs/"+first,"sato");
  assert.equal(own.status,200);
  const read = await own.json();
  assert.equal(read.id,first);
  assert.equal(read.adopted_version,1);
  assert.equal(read.skill_hash,old[0].skill_hash);
  assert.deepEqual(read.versions.map(v=>v.version),[1,2]);
  for (const object of expected[0].objects) {
    const response = await http("/jobs/"+first+"/"+object.kind+"/"+object.number,"sato");
    assert.equal(response.status,200);
    assert.equal(sha(await response.text()),object.digest);
  }
  assert.equal((await http("/jobs/"+second,"sato",{"X-Actor":"tanaka"})).status,404);
  assert.equal((await http("/jobs/"+second+"/sources/1","tanaka")).status,403);
  assert.equal((await http("/"+expected[0].objects[0].key,"sato")).status,404);
  assert.equal((await http("/jobs/"+first+"/sources/1")).status,401);
  assert.equal((await http("/jobs/"+postSnapshot,"sato")).status,404);
  const afterRestart = await mf.getD1Database("BUSINESS");
  await afterRestart.prepare("UPDATE members SET team=? WHERE actor=?").bind("購買部","sato").run();
  assert.equal((await http("/jobs/"+first+"/sources/1","sato")).status,404);
  console.log(JSON.stringify({
    wrangler:require(wrangler).version,counts,sourceSha256:expected.map(j=>j.objects.filter(o=>o.kind==="sources").map(o=>o.digest)),
    bodySha256:expected.map(j=>j.objects.filter(o=>o.kind==="versions").map(o=>o.digest)),
    sameJobIds:true,adoptedVersion:read.adopted_version,r2Objects:5,readAfterRestart:true,
    denied:{nonOwner:404,disabled:403,rawBucketKey:404,unauthenticated:401,transferred:404},
    sqliteNewWrite:true,shadowReadNewWrite:404,
  },null,2));
} finally {
  await mf?.dispose();
  db.close();
  await rm(dir,{recursive:true,force:true});
}
