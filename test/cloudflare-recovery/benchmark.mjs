// Run in the dedicated lab directory, after the idle-and-resume test has finished.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const docker = (...args)=>execFileSync("rtk",["proxy","docker","--context","colima-mac-studio-solo",...args],
  {encoding:"utf8"}).trim();
const variant = process.argv[2];
assert.ok(["containers","persistent-volume"].includes(variant));
const direct = variant==="persistent-volume";
const origin = "http://127.0.0.1:"+(direct ? 19631 : 19431);
const service = "aihub-wp08-direct-sato-1";
const modelInput = {company:"A社",kind:"meeting",ask:"保守の完了を出典付きで要約する",minutes:"11月23日に保守作業を完了した。"};
let d1;
if (!direct) {
  const folder = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
  d1 = new DatabaseSync(folder+"/"+readdirSync(folder).find(f=>/^[0-9a-f]{64}\.sqlite$/.test(f)),{readOnly:true});
}
const currentContainers = ()=>docker("ps","--filter","name=workerd-cf-hermes-22-local-lab-Employee","--format","{{.Names}}")
  .split("\n").filter(name=>name && !name.endsWith("-proxy"));
async function until(read,done,interval=100) {
  const limit = Date.now()+30_000;
  while (Date.now()<limit) {
    const value = await read();
    if (done(value)) return value;
    await delay(interval);
  }
  throw Error("Benchmark sample did not complete");
}
async function one(cold) {
  if (cold && direct) docker("stop","-t","1",service);
  if (cold && !direct) {
    const [container] = currentContainers();
    if (container) {
      assert.equal(docker("exec",container,"printenv","LAB_ACTOR"),"sato");
      docker("stop","-t","1",container);
      await delay(800);
    }
  }
  const start = Date.now();
  if (cold && direct) {
    docker("start",service);
    await until(()=>docker("inspect","-f","{{.State.Health.Status}}",service),value=>value==="healthy",300);
  }
  const response = await fetch(origin+"/api/jobs",{method:"POST",headers:{
    Origin:origin,"Content-Type":"application/json","Idempotency-Key":randomUUID(),
  },body:JSON.stringify(modelInput)});
  assert.equal(response.status,201);
  const {id}=await response.json();
  const acceptedAtHub = Date.now();
  let acceptedAtHermes;
  const result = await until(async()=>{
    const status=await fetch(origin+"/api/jobs/"+id);
    assert.equal(status.status,200);
    const job=await status.json();
    if (job.run_id) acceptedAtHermes ??= Date.now();
    assert.ok(!["unknown","failed","membership_blocked"].includes(job.status),job.status);
    return job;
  },job=>job.status==="done");
  const outputAt=Date.now();
  assert.equal(result.sources[0].text,modelInput.minutes);
  assert.match(result.memo,/保守作業/);
  if (!direct) {
    const archived = await until(()=>d1.prepare("SELECT state_saved FROM archive WHERE actor='sato' AND job_phase=?").get(id+"-compose"),
      row=>row?.state_saved);
    assert.ok(archived.state_saved>=acceptedAtHub);
  }
  return {startToHubAdmissionMs:acceptedAtHub-start,startToHermesAcceptanceMs:acceptedAtHermes-start,
    startToFirstDisplayedResultMs:outputAt-start,afterHubAdmissionToResultMs:outputAt-acceptedAtHub};
}
const metrics = rows => {
  const summary = {};
  for (const name of Object.keys(rows[0])) {
    const values = rows.map(row=>row[name]).sort((a,b)=>a-b);
    summary[name] = {p50:values[Math.ceil(values.length*.5)-1],p95:values[Math.ceil(values.length*.95)-1]};
  }
  return summary;
};
try {
  let retainedAfterForcedStop;
  if (!direct) {
    const finished = JSON.parse(readFileSync("results/live-scheduled-restore.json","utf8"));
    const [container] = currentContainers();
    assert.equal(docker("inspect","-f","{{.Id}}",container),finished.container);
    docker("stop","-t","1",container);
    const key = readFileSync(".dev.vars","utf8").split("\n").find(line=>line.startsWith("SATO_KEY=")).slice(9);
    const response = await fetch("http://127.0.0.1:19474/v1/runs/"+finished.run,{headers:{Authorization:"Bearer "+key}});
    assert.equal(response.status,200);
    const archived = await response.json();
    assert.equal(archived.status,"completed");
    assert.equal(createHash("sha256").update(archived.output.trim()).digest("hex"),finished.resultHash);
    assert.deepEqual(currentContainers(),[]);
    retainedAfterForcedStop={readStatus:200,containerStarts:0,resultHash:finished.resultHash};
    await delay(800);
  }
  await one(false);
  const warm=[], cold=[];
  for (let i=0;i<5;i++) {
    warm.push(await one(false));
    cold.push(await one(true));
  }
  const concurrentStart = Date.now();
  const concurrent = await Promise.all([one(false),one(false)]);
  console.log(JSON.stringify({
    variant,fixture:"real Hermes and fixed answer model; synthetic same input",warm:{samples:warm,summary:metrics(warm)},
    cold:{samples:cold,summary:metrics(cold)},twoSameEmployee:{elapsedMs:Date.now()-concurrentStart,observations:concurrent},
    ...(retainedAfterForcedStop && {retainedAfterForcedStop}),
    resultMetric:"First completed job body returned by the Hub, observed at 100ms intervals",
  },null,2));
} finally {
  d1?.close();
}
