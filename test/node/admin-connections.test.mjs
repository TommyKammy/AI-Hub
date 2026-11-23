import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorker, openHub } from "../../src/jobs/hub.mjs";
import { checkModelProfile, migrateModelProfiles, modelProfiles, saveModelProfile } from "../../src/models/model-profiles.mjs";
import { personalWork } from "../../src/workspace/personal-work.mjs";
import { runtimeAssignments } from "../../src/hermes/runtime-assignments.mjs";

const profiles = [
  {name:"Direct", route:"direct", model_id:"demo", config:{provider:"openai", key_ref:"HUB_DIRECT_KEY"}},
  {name:"Gateway", route:"cloudflare", model_id:"demo", config:{provider:"anthropic", account:"0".repeat(32), gateway:"hub-test", token_ref:"HUB_GATEWAY_TOKEN", alias:"sample"}},
  {name:"Bedrock", route:"bedrock", model_id:"arn:aws:bedrock:ap-northeast-1:123456789012:inference-profile/demo", config:{region:"ap-northeast-1", role:"arn:aws:iam::123456789012:role/HubTest"}},
  {name:"Compatible", route:"compatible", model_id:"demo", config:{base_url:"https://demo.invalid/v1", key_ref:"HUB_COMPATIBLE_KEY"}},
];

test("model route profiles validate and keep audited drafts separate from runnable models", () => {
  const hub = openHub(":memory:");
  const {db} = hub;
  try {
    migrateModelProfiles(db);
    const modelCount = db.prepare("SELECT count(*) n FROM models").get().n;
    for (const profile of profiles) assert.ok(checkModelProfile(profile).target);
    assert.equal(modelProfiles(db).length,0);
    const saved = profiles.map(profile=>saveModelProfile(db,profile,"manager"));
    const gateway = profiles[1];
    saveModelProfile(db,{...gateway,...saved[1],config:{...gateway.config,alias:"changed"}},"manager");
    assert.throws(()=>saveModelProfile(db,{...gateway,...saved[1]},"manager"),{status:409});
    assert.throws(()=>saveModelProfile(db,gateway,"manager"),{status:409});
    assert.throws(()=>checkModelProfile({...profiles[0],config:{...profiles[0].config,api_key:"token-example"}}),{status:400});
    assert.throws(()=>checkModelProfile({...profiles[3],config:{...profiles[3].config,base_url:"https://user:pass@demo.invalid/v1"}}),{status:400});
    assert.equal(modelProfiles(db).length,4);
    assert.equal(modelProfiles(db).find(row=>row.route==="cloudflare").config.alias,"changed");
    assert.equal(db.prepare("SELECT count(*) n FROM models").get().n,modelCount);
    assert.equal(db.prepare("SELECT count(*) n FROM model_calls").get().n,0);
    assert.deepEqual(db.prepare("SELECT after_value FROM admin_audit ORDER BY seq").all().map(row=>row.after_value),
      ["direct v1","cloudflare v1","bedrock v1","compatible v1","cloudflare v2"]);
  } finally {
    hub.close();
  }
});

test("changing a user's runtime preserves admitted attempts and sends one scheduled job to the new runtime", async () => {
  const hub = openHub(":memory:");
  const {db} = hub;
  try {
    const personal = personalWork(hub);
    const runtimes = runtimeAssignments(db, {
      SATO_URL:"http://sato.invalid", SATO_KEY:"default-synthetic-key", SATO_BACKUP_KEY:"backup-synthetic-key", TANAKA_BACKUP_KEY:"tanaka-synthetic-key",
      AI_HUB_RUNTIME_ALIASES:JSON.stringify({
        sato:[{id:"sato-backup",url:"http://sato-backup.invalid",key_ref:"SATO_BACKUP_KEY"}],
        tanaka:[{id:"tanaka-backup",url:"http://tanaka-backup.invalid",key_ref:"TANAKA_BACKUP_KEY"}],
      }),
    });
    const calls = [];
    const worker = createWorker(db,async (actor,path,options,alias)=>{
      calls.push({actor,alias,method:options?.method ?? "GET"});
      if (path === "/v1/runs") return {run_id:"synthetic-"+calls.length};
      return {status:"failed"};
    },runtimes.selected);
    const old = hub.create("sato",{company:"A社",kind:"general",ask:"切替前の合成依頼"},"synthetic-original-job");
    await worker();
    assert.equal(hub.get("sato",old).status,"running");
    assert.throws(()=>runtimes.save("sato",{runtime:"tanaka-backup",revision:0,reason:"試験"},"manager"),{status:400});
    runtimes.save("sato",{runtime:"sato-backup",revision:0,reason:"合成環境での切替"},"manager");
    assert.throws(()=>runtimes.save("sato",{runtime:"sato",revision:0,reason:"試験"},"manager"),{status:409});
    await worker();
    assert.deepEqual(calls,[{actor:"sato",alias:"sato",method:"POST"},{actor:"sato",alias:"sato",method:"GET"}]);

    const now = Date.parse("2026-11-23T00:00:00Z");
    const input = {name:"合成の日次予約",ask:"作業予定を整理して",frequency:"daily",time:"09:01",enabled:false,reason:"日次の確認"};
    const {id} = personal.saveAdminSchedule("sato",input,"manager",now);
    const prior = personal.adminSchedules("sato")[0];
    const edit = {...input,id,base:prior.base,enabled:true};
    assert.equal(prior.enabled,false);
    assert.throws(()=>personal.saveAdminSchedule("tanaka",edit,"manager",now),{status:404});
    personal.saveAdminSchedule("sato",edit,"manager",now);
    assert.throws(()=>personal.saveAdminSchedule("sato",edit,"manager",now),{status:409});
    assert.deepEqual(personal.adminSchedules("tanaka"),[]);
    const due = now+60_000;
    assert.equal(personal.adminSchedules("sato")[0].next_run,due);
    personal.runDue(due);
    personal.runDue(due);
    const jobs = db.prepare("SELECT j.id,j.actor FROM scheduled_jobs s JOIN jobs j ON j.id=s.job WHERE s.schedule=?").all(id);
    assert.equal(jobs.length,1);
    assert.equal(jobs[0].actor,"sato");
    await worker();
    assert.deepEqual(calls.at(-1),{actor:"sato",alias:"sato-backup",method:"POST"});
    const attempts = db.prepare("SELECT runtime_id FROM attempts WHERE job_id IN (?,?) ORDER BY rowid").all(old,jobs[0].id);
    assert.deepEqual(attempts.map(row=>row.runtime_id),["sato","sato-backup"]);
    assert.deepEqual(db.prepare("SELECT action FROM admin_audit ORDER BY seq").all().map(row=>row.action),
      ["runtime-change","schedule-create","schedule-edit"]);
  } finally {
    hub.close();
  }
});
