import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyDirectorySync, configureLocalDirectory, directorySyncPreview, employeeGroupAllows, employeeModelChoices, groupOverview, localDirectoryOverview,
  migrateEnterpriseDirectory, previewLocalGroup, resolveVerifiedEmployee, saveLocalGroup } from "../enterprise-directory.mjs";
import { directMessages, receivePersonalMessage } from "../direct-messages.mjs";
import { createWorker, openHub, reconcileRun } from "../hub.mjs";
import { adminMember, setMemberActive } from "../memberships.mjs";
import { changeUsagePolicy, usagePolicy } from "../usage-policy.mjs";

const tenant=randomUUID(), sato=randomUUID(), tanaka=randomUUID(), bad=randomUUID();
const binding={tenant,bindings:[{actor:"sato",objectId:sato},{actor:"tanaka",objectId:tanaka}]};
const verified=oid=>({tid:tenant,oid});
const sharedName="同じ 氏名", sharedEmail="same@example.invalid";
const data=(externalId,active=true)=>({tenant,externalId,active,displayName:sharedName,email:sharedEmail,reason:"同期の試験"});
function prepare(hub,config=binding) {
  migrateEnterpriseDirectory(hub.db);
  configureLocalDirectory(hub.db,config);
}
function sync(db,input,operator="aoki") {
  return applyDirectorySync(db,{...input,preview:directorySyncPreview(db,input).preview},operator);
}

test("同じ氏名とメールでも object ID を区別し、同期と管理者の停止を原子的に反映する",async t=>{
  const hub=openHub(":memory:"),{db}=hub;
  t.after(()=>hub.close());
  prepare(hub);
  sync(db,data(sato)); sync(db,data(tanaka));
  assert.equal(resolveVerifiedEmployee(db,verified(sato)).actor,"sato");
  assert.equal(resolveVerifiedEmployee(db,verified(tanaka)).actor,"tanaka");
  assert.equal(resolveVerifiedEmployee(db,{...verified(sato),acct:0}).actor,"sato");
  for (const acct of [1,"1"])
    assert.throws(()=>resolveVerifiedEmployee(db,{...verified(sato),acct}),{status:403});
  for (const claims of [{...verified(bad),preferred_username:sharedEmail},{tid:bad,oid:sato},{tid:tenant,email:sharedEmail}])
    assert.throws(()=>resolveVerifiedEmployee(db,claims),{status:403});
  assert.throws(()=>configureLocalDirectory(db,{tenant,bindings:[{actor:"sato",objectId:bad}]}),{status:409});
  assert.equal(sync(db,data(tanaka)).changed,false);
  assert.deepEqual(localDirectoryOverview(db).people.map(person=>person.email),[sharedEmail,sharedEmail]);
  const waiting=hub.create("tanaka",{kind:"weekly",company:"B社",ask:"予約を停止します",scheduled_at:Date.now()+60000},randomUUID());
  const before=directorySyncPreview(db,data(tanaka,false));
  assert.equal(before.before.models.length,1);
  assert.equal(before.after.models.length,0);
  assert.equal(sync(db,data(tanaka,false)).version,3);
  assert.throws(()=>hub.get("tanaka",waiting),{status:403});
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(waiting).status,"account_blocked");
  assert.throws(()=>resolveVerifiedEmployee(db,verified(tanaka)),{status:403});
  await createWorker(db,assert.fail)();
  const current=adminMember(db,"tanaka");
  setMemberActive(db,"tanaka",{base:current.revision,active:false,reason:"担当者が緊急停止"},"aoki");
  const enabled=sync(db,data(tanaka,true));
  assert.equal(enabled.operatorLock,true);
  assert.equal(enabled.after.eligible,false);
  assert.equal(enabled.after.models.length,0);
  assert.throws(()=>resolveVerifiedEmployee(db,verified(tanaka)),{status:403});
  setMemberActive(db,"tanaka",{base:adminMember(db,"tanaka").revision,active:true,reason:"担当者がロックを解除"},"aoki");
  assert.equal(resolveVerifiedEmployee(db,verified(tanaka)).actor,"tanaka");
  assert.equal(hub.get("tanaka",waiting).status,"account_blocked");
  assert.equal(localDirectoryOverview(db).history.length,4);
});

test("管理画面のグループ一覧には人数と許可モデルだけを公開する", t => {
  const hub = openHub(":memory:"), { db } = hub;
  t.after(() => hub.close());
  migrateEnterpriseDirectory(db);
  assert.deepEqual(groupOverview(db), { configured: false, groups: [] });
  const group = randomUUID();
  const models = [{ connection: "local-a", modelId: "fixture-model" }];
  configureLocalDirectory(db, { tenant, groups: [{ id: group, name: "営業", models }],
    bindings: [{ actor: "sato", objectId: sato, groups: [group] }] });
  const expected = { configured: true, groups: [{ id: group, name: "営業", memberCount: 1, models }] };
  assert.deepEqual(JSON.parse(JSON.stringify(groupOverview(db))), expected);
  sync(db, { ...data(sato), groups: [] });
  assert.equal(groupOverview(db).groups[0].memberCount, 0);
});

test("ローカルグループのプレビュー・保存は同期と資料区分の利用制限を保つ", t => {
  const hub=openHub(":memory:"),{db}=hub;
  t.after(()=>hub.close());
  const directoryGroup=randomUUID();
  prepare(hub,{tenant,groups:[{id:directoryGroup,name:"同期済み",models:[{connection:"local-a",modelId:"fixture-model"}]}],
    bindings:[{actor:"sato",objectId:sato,groups:[directoryGroup]}]});
  db.exec(`INSERT INTO models(id,name,connection,model_id,data_class)
    VALUES('second','合成モデル B','local-b','fixture-model-b','合成資料');
    INSERT INTO model_releases VALUES(2,'second',1)`);
  const settings=usagePolicy(db).settings;
  changeUsagePolicy(db,{base:1,reason:"限定資料は合成モデル Aのみ",
    settings:{...settings,restricted:{...settings.restricted,models:["legacy"]}}},"publish","aoki",["local-a","local-b"]);
  const input={id:randomUUID(),name:"ローカル検証",mode:"approved",models:["legacy","second"],
    members:["sato","tanaka"],revision:0,employee:"tanaka",reason:"試行を許可"};
  const plans=previewLocalGroup(db,input);
  assert.deepEqual(plans.before.general.map(model=>model.id),["second"]);
  assert.deepEqual(plans.after.general.map(model=>model.id),["second","legacy"]);
  assert.deepEqual(plans.after.restricted.map(model=>model.id),["legacy"]);
  assert.equal(groupOverview(db).groups.length,1);
  assert.throws(()=>saveLocalGroup(db,{...input,name:"プレビュー後に変更",preview:plans.preview},"aoki"),{status:409});
  const saved=saveLocalGroup(db,{...input,preview:plans.preview},"aoki");
  assert.equal(saved.revision,1);
  assert.deepEqual(employeeModelChoices(db,"sato").general.map(model=>model.id),["legacy"]);
  assert.equal(employeeGroupAllows(db,"sato",{connection:"local-b",model_id:"fixture-model-b"}),false);
  assert.deepEqual(employeeModelChoices(db,"tanaka").general.map(model=>model.id),["second","legacy"]);
  assert.ok(!Object.hasOwn(groupOverview(db).groups.find(row=>row.id===saved.id),"members"));
  assert.throws(()=>saveLocalGroup(db,{...input,preview:plans.preview},"aoki"),{status:409});
  const edit={...input,mode:"inherit",models:[],revision:1,reason:"既定値に戻す"};
  saveLocalGroup(db,{...edit,preview:previewLocalGroup(db,edit).preview},"aoki");
  assert.deepEqual(employeeModelChoices(db,"tanaka").general.map(model=>model.id),["second"]);
  assert.equal(db.prepare("SELECT count(*) n FROM admin_audit WHERE scope='group' AND target=?").get(saved.id).n,2);
});

test("退職者と停止後の到着待ち・成果物リンクを拒否する",async t=>{
  const hub=openHub(":memory:"),{db}=hub;
  t.after(()=>hub.close());
  prepare(hub,{tenant,bindings:[{actor:"sato",objectId:sato,retired:true},{actor:"tanaka",objectId:tanaka}]});
  assert.throws(()=>resolveVerifiedEmployee(db,verified(sato)),{status:403});
  assert.throws(()=>directorySyncPreview(db,data(sato)),{status:403});
  const attachment=hub.create("tanaka",{kind:"assistant",company:"B社",ask:"相見積を比較する",
    contract:{name:"届いた見積.txt",text:"項目　試験"},
    arrival_wait:{name:"未着の見積-"+randomUUID()+".txt",library_id:"shared/社内規程",deadline:Date.now()+30000}},randomUUID());
  const prior=hub.create("tanaka",{kind:"general",company:"B社",ask:"期日の確認"},randomUUID());
  db.prepare("UPDATE jobs SET status='done',memo='完了成果物' WHERE id=?").run(prior);
  assert.equal(hub.get("tanaka",attachment).status,"source_waiting");
  assert.equal(hub.get("tanaka",prior).memo,"完了成果物");
  sync(db,data(tanaka,false));
  assert.throws(()=>hub.get("tanaka",attachment),{status:403});
  assert.throws(()=>hub.get("tanaka",prior),{status:403});
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id=?").get(attachment).status,"account_blocked");
  await createWorker(db,assert.fail)();
});

test("グループ利用権が結果取得中に失効すると、通常監視と手動照合は旧結果を保存しない",async t=>{
  const hub=openHub(":memory:"), {db}=hub;
  t.after(()=>hub.close());
  const group=randomUUID();
  prepare(hub,{tenant,groups:[{id:group,name:"検証グループ",models:[{connection:"local-a",modelId:"fixture-model"}]}],
    bindings:[{actor:"sato",objectId:sato,groups:[group]}]});
  const input={company:"A社",kind:"general",ask:"検証用の結果を作成",data_class:"合成資料",model_release:1};
  let requested, respond;
  let reading=new Promise(resolve=>{requested=resolve;});
  const read=()=>{
    requested();
    return new Promise(resolve=>{respond=resolve;});
  };
  const worker=createWorker(db,(_actor,_path,options)=>options ? {run_id:randomUUID()} : read());
  const pending=hub.create("sato",input,randomUUID());
  await worker();
  const finishing=worker();
  await reading;
  sync(db,{...data(sato),groups:[]});
  respond({status:"completed",output:"古い結果を反映 [1]"});
  await finishing;
  assert.equal(hub.get("sato",pending).status,"membership_blocked");
  assert.equal(hub.get("sato",pending).memo,null);

  sync(db,{...data(sato),groups:[group]});
  const manual=hub.create("sato",input,randomUUID());
  await worker();
  const job=hub.get("sato",manual);
  db.prepare("UPDATE jobs SET status='unknown' WHERE id=?").run(manual);
  reading=new Promise(resolve=>{requested=resolve;});
  const recovery=reconcileRun(db,read,manual,{phase:job.phase,run_id:job.run_id},"aoki");
  await reading;
  sync(db,{...data(sato),groups:[]});
  respond({status:"completed",output:"照合中に失効した結果 [1]"});
  await assert.rejects(recovery,{status:409});
  assert.equal(hub.get("sato",manual).memo,null);
});

const fixtureSecret=randomBytes(32);
const signature=(identity,body)=>createHmac("sha256",fixtureSecret).update(identity).update("\n").update(body).digest();
function verifyFixture(headers,body) {
  const identity=headers.get("Fixture-Identity"), proof=headers.get("Fixture-Signature");
  if (!identity || !proof || !/^[a-f0-9]{64}$/.test(proof) || !timingSafeEqual(signature(identity,body),Buffer.from(proof,"hex"))) return null;
  return JSON.parse(identity);
}
function fixtureRequest(event,claims,signed=true) {
  const body=JSON.stringify(event), identity=JSON.stringify(claims);
  return new Request("http://local-fixture.invalid/activities",{method:"POST",headers:{
    "Fixture-Identity":identity,"Fixture-Signature":signed ? signature(identity,body).toString("hex") : "0".repeat(64),
  },body});
}
function message(activity,operation="new",overrides={}) {
  return {type:"message",scope:"personal",reference:"ref-fixture",conversation:"same-seeming-chat",
    activity,operation,text:"棚卸しは12月4日。",...overrides};
}
function fixtureRuntime() {
  const posts=[];
  return {
    posts,
    worker:db=>createWorker(db,async(actor,path,options)=>{
      if (!options) return {status:"completed",output:"棚卸しは12月4日。 [1]"};
      posts.push({actor,key:options.headers["Idempotency-Key"]});
      return {run_id:randomUUID()};
    }),
  };
}

test("DMを確定応答から分離し、二社員・追記・返信再試行で元の実行を再作成しない",async t=>{
  const directory=mkdtempSync(join(tmpdir(),"ai-hub-direct-")), file=join(directory,"hub.sqlite");
  let hub=openHub(file);
  t.after(()=>{hub.close();rmSync(directory,{recursive:true,force:true});});
  prepare(hub);
  let now=10000, firstSend=true, secondResponseLost=true;
  const delivered=new Map(), invocations=[];
  const options={transport:"direct",publicOrigin:"https://hub.example.invalid",clock:()=>now,delivery:{
    async send(payload) {
      invocations.push(payload);
      if (firstSend) {firstSend=false;return {state:"not_sent"};}
      const receipt="sent-"+payload.key;
      delivered.set(payload.key,receipt);
      if (secondResponseLost) {secondResponseLost=false;throw Error("reply lost after send");}
      return {state:"sent",receipt};
    },
    async lookup({key}) {return delivered.has(key) ? {state:"sent",receipt:delivered.get(key)} : {state:"not_sent"};},
  }};
  let receiver=directMessages(hub,options);
  const runtime=fixtureRuntime();
  let work=runtime.worker(hub.db);
  const accept=(event,claims,channel="direct",signed=true)=>receivePersonalMessage(fixtureRequest(event,claims,signed),receiver,verifyFixture,channel);
  assert.equal((await accept(message("bad-proof"),verified(sato),"direct",false)).status,401);
  assert.equal((await accept(message("bad-tenant"),{tid:bad,oid:sato})).status,403);
  assert.equal((await accept(message("bad-id"),{tid:tenant,oid:bad,email:sharedEmail})).status,403);
  assert.equal((await accept(message("public-chat","new",{scope:"channel"}),verified(sato))).status,400);
  assert.equal((await accept(message("relay-input"),verified(sato),"relay")).status,403);
  const first=await accept(message("activity-1"),verified(sato));
  const second=await accept(message("activity-1"),verified(tanaka));
  assert.equal(first.status,202);assert.equal(second.status,202);
  const one=(await first.json()).id,two=(await second.json()).id;
  assert.notEqual(one,two);
  assert.equal((await (await accept(message("activity-1"),verified(sato))).json()).id,one);
  assert.equal((await accept(message("activity-1","new",{text:"別の本文"}),verified(sato))).status,409);
  assert.equal(hub.db.prepare("SELECT count(*) AS n FROM jobs").get().n,0);
  await receiver.pump(); await work(); await work(); await receiver.pump();
  const find=id=>hub.db.prepare("SELECT work,state FROM message_inbox WHERE id=?").get(id);
  const firstJob=find(one).work, secondJob=find(two).work;
  assert.equal(runtime.posts.length,2);
  assert.notEqual(firstJob,secondJob);
  assert.throws(()=>hub.get("tanaka",firstJob),{status:404});
  assert.equal(delivered.size,1);
  hub.close(); hub=openHub(file);
  receiver=directMessages(hub,options); work=runtime.worker(hub.db);
  now+=2000; await receiver.pump();
  assert.equal(delivered.size,2);
  assert.equal(runtime.posts.length,2);
  assert.deepEqual(hub.db.prepare("SELECT state,attempts FROM message_outbox ORDER BY rowid").all().map(row=>[row.state,row.attempts]),
    [["sent",2],["sent",1]]);
  assert.equal(invocations.find(entry=>entry.actor==="sato").link,"https://hub.example.invalid/#job/"+firstJob);
  assert.equal((await accept(message("wrong-owner","followup",{targetWork:firstJob}),verified(tanaka))).status,404);
  const follow=await accept(message("continued","followup",{text:"棚卸しの日付をもう一度教えて。"}),verified(sato));
  assert.equal(follow.status,202);
  const continuation=(await follow.json()).id;
  await receiver.pump(); await work(); await work(); await receiver.pump();
  assert.equal(find(continuation).work,firstJob);
  assert.equal(hub.get("sato",firstJob).questions.length,1);
  assert.equal(runtime.posts.length,3);
  await accept(message("second-sato-work"),verified(sato));
  await receiver.pump(); await work(); await work(); await receiver.pump();
  assert.equal((await accept(message("pick-one","followup"),verified(sato))).status,409);
  const waiting=await accept(message("before-disable"),verified(tanaka));
  assert.equal(waiting.status,202);
  sync(hub.db,data(tanaka,false));
  assert.equal((await accept(message("after-disable"),verified(tanaka))).status,403);
  sync(hub.db,data(tanaka,true));
  const prior=runtime.posts.length;
  await receiver.pump(); await work(); await work(); await receiver.pump();
  assert.equal(runtime.posts.length,prior);
  assert.equal(find((await waiting.json()).id).state,"blocked");
});

test("Relay の停止 ACK、起動通知の失敗、再接続時の未ACK配達を限定通知で再現する",async t=>{
  const directory=mkdtempSync(join(tmpdir(),"ai-hub-relay-contract-")), file=join(directory,"hub.sqlite");
  let hub=openHub(file);
  t.after(()=>{hub.close();rmSync(directory,{recursive:true,force:true});});
  prepare(hub);
  const options={transport:"relay",publicOrigin:"https://hub.example.invalid",
    delivery:{send:async()=>({state:"sent",receipt:"accepted"}),lookup:async()=>({state:"unknown"})}};
  let receiver=directMessages(hub,options);
  // The connector below is a fixture for the fixed-version wire contract, not Hermes Relay itself.
  function connector(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS relay_fixture_instances(
      actor TEXT PRIMARY KEY, state TEXT NOT NULL, wake_pending INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS relay_fixture_buffer(
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, identity TEXT NOT NULL, event TEXT NOT NULL);
      INSERT OR IGNORE INTO relay_fixture_instances(actor,state) VALUES('sato','online'),('tanaka','online')`);
    const state=actor=>db.prepare("SELECT * FROM relay_fixture_instances WHERE actor=?").get(actor);
    return {
      goingIdle(actor) { db.prepare("UPDATE relay_fixture_instances SET state='awaiting_ack' WHERE actor=?").run(actor); },
      acknowledgeIdle(actor) { db.prepare("UPDATE relay_fixture_instances SET state='buffered' WHERE actor=? AND state='awaiting_ack'").run(actor); },
      canStop(actor) { return state(actor).state==="buffered"; },
      inbound(actor,event,claims) {
        if (state(actor).state!=="buffered") return receiver.accept(event,claims,"relay");
        db.prepare("INSERT OR IGNORE INTO relay_fixture_buffer VALUES(?,?,?,?)").run(event.activity,actor,JSON.stringify(claims),JSON.stringify(event));
        db.prepare("UPDATE relay_fixture_instances SET wake_pending=1 WHERE actor=?").run(actor);
      },
      async wake(actor,notify) {
        if (!state(actor).wake_pending) return;
        try {
          await notify("https://wake.example.invalid/instances/"+actor);
          db.prepare("UPDATE relay_fixture_instances SET wake_pending=0 WHERE actor=?").run(actor);
        } catch { /* The failed notice remains visible for a targeted retry. */ }
      },
      replay(actor,ack) {
        for (const row of db.prepare("SELECT * FROM relay_fixture_buffer WHERE actor=? ORDER BY rowid").all(actor)) {
          receiver.accept(JSON.parse(row.event),JSON.parse(row.identity),"relay");
          if (ack) db.prepare("DELETE FROM relay_fixture_buffer WHERE id=?").run(row.id);
        }
      },
    };
  }
  const runtime=fixtureRuntime();
  let relay=connector(hub.db);
  relay.goingIdle("sato");
  assert.equal(relay.canStop("sato"),false);
  relay.inbound("sato",message("before-suspend"),verified(sato));
  relay.acknowledgeIdle("sato");
  assert.equal(relay.canStop("sato"),true);
  relay.inbound("sato",message("after-suspend"),verified(sato));
  relay.inbound("tanaka",message("remains-online"),verified(tanaka));
  const missed=[];
  await relay.wake("sato",async url=>{missed.push(url);throw Error("wake lost");});
  assert.deepEqual(missed,["https://wake.example.invalid/instances/sato"]);
  assert.equal(hub.db.prepare("SELECT count(*) AS n FROM relay_fixture_buffer").get().n,1);
  hub.close(); hub=openHub(file);
  receiver=directMessages(hub,options);
  relay=connector(hub.db);
  const retried=[];
  const notice=async url=>retried.push(url);
  await relay.wake("tanaka",notice); await relay.wake("sato",notice);
  assert.deepEqual(retried,missed);
  relay.replay("sato",false);
  assert.equal(hub.db.prepare("SELECT count(*) AS n FROM relay_fixture_buffer").get().n,1);
  relay.replay("sato",true);
  assert.equal(hub.db.prepare("SELECT count(*) AS n FROM relay_fixture_buffer").get().n,0);
  assert.throws(()=>receiver.accept(message("after-suspend"),verified(sato),"direct"),{status:403});
  const work=runtime.worker(hub.db);
  for (let i=0;i<4;i++) {
    await receiver.pump(); await work();
  }
  assert.deepEqual(runtime.posts.map(row=>row.actor).sort(),["sato","sato","tanaka"]);
  assert.equal(hub.db.prepare("SELECT count(*) AS n FROM message_inbox WHERE activity='after-suspend'").get().n,1);
});
