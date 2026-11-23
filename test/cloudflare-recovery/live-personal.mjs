import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const home = "http://127.0.0.1:19431";
const peer = "http://127.0.0.1:19432";
const admin = "http://127.0.0.1:19433";
const archiveUrl = "http://127.0.0.1:19474";
const hub = "cf-hermes-22-lab-hub-1";
const env = Object.fromEntries(readFileSync(".dev.vars","utf8").trim().split("\n").map(s=>s.split("=")));
const adminPass = readFileSync("hub/.runtime/admin-accounts/aoki","utf8").trim();
const auth = "Basic "+Buffer.from("aoki:"+adminPass).toString("base64");
const d1dir = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";
const db = new DatabaseSync(d1dir+"/"+readdirSync(d1dir).find(f=>/^[0-9a-f]{64}\.sqlite$/.test(f)),{readOnly:true});
const docker = (...args) => execFileSync("rtk",["proxy","docker","--context","colima-mac-studio-solo",...args],{encoding:"utf8"}).trim();
const sha = text => createHash("sha256").update(text).digest("hex");
const current = () => db.prepare("SELECT version,snapshot FROM personal_state WHERE actor='sato'").get();
const archived = job => db.prepare("SELECT * FROM archive WHERE actor='sato' AND job_phase=?").get(job+"-compose");
const profile = "結論を先に。\n", skill = "# 本人の見積基準\n- 納期に注意\n";
const skillName = "hub-quote-39ec3482-8c0a-4178-afe0-bc6b03170a1f";
const active = () => docker("ps","--filter","name=workerd-cf-hermes-22-local-lab-Employee","--format","{{.Names}}")
  .split("\n").filter(name=>name && !name.endsWith("-proxy"));
const write = (filename,data) => writeFileSync("results/"+filename,JSON.stringify(data,null,2)+"\n");
const side = (actor,path,opts={}) => fetch(archiveUrl+path,{...opts,headers:{...opts.headers,Authorization:"Bearer "+env[actor.toUpperCase()+"_KEY"]}});
const post = (origin,path,input,headers={}) => fetch(origin+path,{method:"POST",
  headers:{Origin:origin,"Content-Type":"application/json",...headers},body:JSON.stringify(input)});
async function until(check, timeout=30_000) {
  const end = Date.now()+timeout;
  while (Date.now()<end) {
    const result = await check();
    if (result) return result;
    await delay(500);
  }
  throw Error("条件待ちが時間切れになりました。");
}
async function submit(ask, more={}) {
  const result = await post(home,"/api/jobs",{company:"A社",kind:"meeting",ask,minutes:"11月23日に保守作業を完了した。",...more},
    {"Idempotency-Key":randomUUID()});
  assert.equal(result.status,201);
  return (await result.json()).id;
}

assert.equal(docker("port",hub,"19431/tcp"),"127.0.0.1:19431");
assert.deepEqual(active(),[]);
assert.equal((await side("sato","/health")).status,200);
const [initial] = active();
assert.equal(docker("exec",initial,"printenv","LAB_ACTOR"),"sato");
const oldId = docker("inspect","-f","{{.Id}}",initial);
docker("exec",initial,"python","-c",`
from pathlib import Path
import sys
root = Path("/opt/data")
(root/"memories"/"USER.md").write_text(sys.argv[1],encoding="utf-8")
(root/"memories"/"MEMORY.md").write_text("後で削除する記憶。",encoding="utf-8")
skill = root/"skills"/sys.argv[2]/"SKILL.md"
skill.parent.mkdir(parents=True,exist_ok=True)
skill.write_text(sys.argv[3],encoding="utf-8")
`,profile,skillName,skill);
const first = await submit("保守作業の最初の確認");
const firstRecord = await until(()=>archived(first)?.state_saved && archived(first));
assert.equal(JSON.parse(firstRecord.result).status,"completed");
assert.equal(current().version,1);
assert.equal(JSON.parse(current().snapshot).memory["MEMORY.md"],"後で削除する記憶。");
docker("exec",initial,"rm","/opt/data/memories/MEMORY.md");
const second = await submit("保守作業の再確認");
const secondRecord = await until(()=>archived(second)?.state_saved && archived(second));
assert.equal(JSON.parse(secondRecord.result).status,"completed");
assert.equal(current().version,2);
assert.equal(JSON.parse(current().snapshot).memory["MEMORY.md"],null);
assert.equal((await side("tanaka","/v1/runs/"+secondRecord.run)).status,404);
write("live-state-before-stop.json",{
  employee:"sato",firstRun:firstRecord.run,secondRun:secondRecord.run,container:oldId,
  profileVersion:2,profileHash:sha(profile),skillHash:sha(skill),
  firstSaved:firstRecord.state_saved,lastSaved:secondRecord.state_saved,
  resultHash:sha(JSON.parse(secondRecord.result).output),otherEmployeeStatus:404,
});

const disabled = await post(admin,"/api/admin/memberships/tanaka/access",{active:false,base:1,reason:"予約起動の試験"},{Authorization:auth});
assert.equal(disabled.status,200);
const peerSubmission = await post(peer,"/api/jobs",{company:"B社",kind:"weekly",ask:"停止社員の週報",scheduled_at:Date.now()+650_000},
  {"Idempotency-Key":randomUUID()});
assert.equal(peerSubmission.status,403);
const schedule = Date.now()+630_000;
const week = await submit("保存した進捗から週報を作る",{kind:"weekly",minutes:"11月23日の保守作業が完了した。",scheduled_at:schedule});
console.log("Waiting for the Docker idle stop before the scheduled run.",week);
await until(()=>!active().includes(initial),625_000);
const observed = Date.now();
assert.ok(observed<schedule);
assert.equal((await side("sato","/v1/runs/"+secondRecord.run)).status,200);
assert.deepEqual(active(),[]);
assert.equal((await (await fetch(home+"/api/jobs/"+week)).json()).status,"scheduled");
write("live-idle-stop.json",{observed,schedule,container:oldId,secondsSinceStateCapture:(observed-secondRecord.state_saved)/1000,
  archiveReadDidNotStart:true});

const weekly = await until(()=>archived(week)?.state_saved && archived(week),90_000);
const [restored] = active();
assert.notEqual(docker("inspect","-f","{{.Id}}",restored),oldId);
assert.equal(docker("exec",restored,"printenv","LAB_ACTOR"),"sato");
const exact = (path) => docker("exec",restored,"python","-c",
  "from pathlib import Path;import hashlib,sys;print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())",path);
assert.equal(exact("/opt/data/memories/USER.md"),sha(profile));
assert.equal(exact("/opt/data/skills/"+skillName+"/SKILL.md"),sha(skill));
docker("exec",restored,"test","!","-e","/opt/data/memories/MEMORY.md");
assert.equal(current().version,2);
const finished = await until(async()=>{
  const result = await (await fetch(home+"/api/jobs/"+week)).json();
  return result.status==="done" && result;
});
assert.equal(finished.sources[0].text,"11月23日の保守作業が完了した。");
assert.match(finished.memo,/完了/);
const count = docker("exec",hub,"cat","/data/test-wire.ndjson").split("\n").map(line=>JSON.parse(line))
  .filter(line=>line.key===week+"-compose" && line.type==="outbound-post").length;
assert.equal(count,1);
assert.equal(db.prepare("SELECT count(*) AS n FROM archive WHERE actor='tanaka'").get().n,0);
write("live-scheduled-restore.json",{job:week,run:weekly.run,hubPosts:count,archiveRows:1,completedBody:true,peerRuns:0,
  container:docker("inspect","-f","{{.Id}}",restored),profileVersion:2,profileHash:sha(profile),skillHash:sha(skill),
  resultHash:sha(finished.memo),deletedMemoryReturned:false,originalSourceVerified:true,scheduledAt:schedule,confirmedAt:weekly.confirmed});
db.close();
