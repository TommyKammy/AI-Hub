import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {tmpdir} from "node:os";
import {dirname,join,relative} from "node:path";
import test from "node:test";
import {createArrivalScanner} from "../../src/jobs/arrival-waits.mjs";
import {createWorker,openHub} from "../../src/jobs/hub.mjs";
import {transfer} from "../../src/identity/memberships.mjs";

const now=Date.UTC(2028,1,1);
const a={name:"見積A.txt",text:"金額は120,000円。"};
const b={name:"見積B.txt",text:"金額は128,700円。"};

function setup(t){
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"hub-material-wait-")));
  const dbPath=join(root,"hub.sqlite");
  let hub=openHub(dbPath), clock=now;
  const previous=process.env.LIBRARY_ROOT;
  process.env.LIBRARY_ROOT=root;
  t.mock.timers.enable({apis:["Date"],now});
  const tracked=new Set(), reads=[], descriptors=new Map(), calls=[];
  const open=fs.openSync, read=fs.readFileSync, close=fs.closeSync;
  t.mock.method(fs,"openSync",(path,...args)=>{
    const fd=open(path,...args);
    if(tracked.has(path)) descriptors.set(fd,path);
    return fd;
  });
  t.mock.method(fs,"readFileSync",(path,...args)=>{
    if(tracked.has(path) || descriptors.has(path)) reads.push(descriptors.get(path) || path);
    return read(path,...args);
  });
  t.mock.method(fs,"closeSync",fd=>{
    descriptors.delete(fd);
    return close(fd);
  });
  syncBuiltinESMExports();
  t.after(()=>{
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if(previous===undefined) delete process.env.LIBRARY_ROOT;
    else process.env.LIBRARY_ROOT=previous;
    hub.close();
    fs.rmSync(root,{recursive:true,force:true});
  });
  let scan, tick;
  function connect(){
    scan=createArrivalScanner(hub.db,()=>clock);
    tick=createWorker(hub.db,async(actor,path,options)=>{
      calls.push({actor,path,options});
      return options ? {run_id:"receipt-1"} : {status:"running"};
    });
  }
  connect();
  function folder(scope,name){
    const id=scope+"/"+name, dir=join(root,id), path=join(dir,b.name);
    fs.mkdirSync(dir,{recursive:true});
    tracked.add(path);
    return {id,dir,path};
  }
  function create(library,deadline=now+5000){
    const request={kind:"assistant",company:"A社",ask:"2社の見積を比較してください",contract:a,
      arrival_wait:{library_id:library.id,name:b.name,deadline}};
    const key=randomUUID(), id=hub.create("sato",request,key);
    return {id,key,request};
  }
  return {
    get hub(){return hub;}, create, folder, reads, calls,
    time(next){ clock=next; t.mock.timers.setTime(next); },
    restart(){ hub.close(); hub=openHub(dbPath); connect(); },
    async scan(){ await scan(); },
    async tick(){ await tick(); },
    deliver(target){ fs.writeFileSync(target.path,b.text); },
    state(id){ return hub.get("sato",id); },
    attempts(id){ return hub.db.prepare("SELECT count(*) count FROM attempts WHERE job_id=?").get(id).count; },
  };
}

test("資料が揃うまで本文の読取もHermes送信もなく、再起動と到着の再検出をまたいで元の相談を1回送信する",async t=>{
  const lab=setup(t), inbox=lab.folder("users/sato","見積");
  const {id,key,request}=lab.create(inbox);
  assert.equal(lab.state(id).status,"source_waiting");
  assert.deepEqual(lab.state(id).sources.map(s=>s.text),[a.text]);
  assert.throws(()=>lab.hub.get("tanaka",id),{status:404});
  await lab.scan();
  await lab.tick();
  assert.deepEqual(lab.reads,[]);
  assert.deepEqual(lab.calls,[]);
  lab.restart();
  assert.equal(lab.hub.create("sato",request,key),id);
  lab.deliver(inbox);
  await Promise.all([lab.scan(),lab.scan()]);
  await lab.scan();
  assert.deepEqual(lab.reads,[inbox.path]);
  assert.deepEqual(lab.state(id).sources.map(s=>[s.title,s.text]),[[a.name,a.text],[b.name,b.text]]);
  assert.equal(lab.hub.create("sato",request,key),id);
  assert.throws(()=>lab.hub.create("sato",{...request,arrival_wait:{...request.arrival_wait,name:"別見積.txt"}},key),{status:409});
  await lab.tick();
  lab.restart();
  await lab.scan();
  await lab.tick();
  assert.equal(lab.attempts(id),1);
  const [sent,...others]=lab.calls.filter(c=>c.options?.method==="POST");
  assert.equal(others.length,0);
  assert.equal(sent.options.headers["Idempotency-Key"],id+"-compose");
  assert.match(sent.options.body,/120,000円/);
  assert.match(sent.options.body,/128,700円/);
  assert.deepEqual(lab.reads,[inbox.path]);
});

test("添付Aの共有範囲を離れた本人は、到着したBを読まずHermesを起動しない",async t=>{
  const lab=setup(t), inbox=lab.folder("shared","添付閲覧");
  const {id}=lab.create(inbox);
  transfer(lab.hub.db,"sato",{base:1,team:"別部門",reason:"検証用の異動"},"aoki");
  lab.deliver(inbox);
  await lab.scan();
  await lab.tick();
  const blocked=lab.state(id);
  assert.ok(["source_blocked","membership_blocked"].includes(blocked.status));
  assert.equal(blocked.arrival_wait.reason,"attachment_access");
  assert.deepEqual(blocked.sources,[]);
  assert.ok(!JSON.stringify(blocked).includes(a.name));
  assert.ok(!JSON.stringify(blocked).includes(a.text));
  assert.deepEqual(lab.reads,[]);
  assert.deepEqual(lab.calls,[]);
  assert.equal(lab.attempts(id),0);
});

test("到着先を他の社員のフォルダへ差し替えるとBを読まずHermesを起動しない",async t=>{
  const lab=setup(t), inbox=lab.folder("shared","共通"), privateFolder=lab.folder("users/tanaka","個人資料");
  const {id}=lab.create(inbox);
  lab.deliver(privateFolder);
  fs.rmdirSync(inbox.dir);
  fs.symlinkSync(relative(dirname(inbox.dir),privateFolder.dir),inbox.dir,"dir");
  await lab.scan();
  await lab.tick();
  const blocked=lab.state(id);
  assert.equal(blocked.status,"source_blocked");
  assert.equal(blocked.arrival_wait.reason,"arrival_access");
  assert.ok(blocked.sources.every(s=>s.title!==b.name));
  assert.deepEqual(lab.reads,[]);
  assert.deepEqual(lab.calls,[]);
  assert.equal(lab.attempts(id),0);
});

test("停止中に期限を過ぎてBが届いても読取と実行をせず、再起動の後も元の相談を指す通知を1件だけ返す",async t=>{
  const lab=setup(t), inbox=lab.folder("shared","期限付き");
  const deadline=now+2500, {id}=lab.create(inbox,deadline);
  lab.time(deadline+1);
  lab.deliver(inbox);
  lab.restart();
  await lab.scan();
  await lab.tick();
  lab.restart();
  await lab.scan();
  await lab.tick();
  const job=lab.state(id);
  assert.equal(job.status,"source_expired");
  assert.equal(job.arrival_wait.reason,"deadline");
  const notifications=lab.hub.notifications("sato");
  assert.equal(notifications.length,1);
  assert.equal(notifications[0].status,"source_deadline");
  assert.equal(notifications[0].job,id);
  assert.deepEqual(lab.hub.readNotification("sato",notifications[0].seq),{job:id});
  assert.deepEqual(lab.hub.notifications("tanaka"),[]);
  assert.deepEqual(lab.reads,[]);
  assert.deepEqual(lab.calls,[]);
  assert.equal(lab.attempts(id),0);
  transfer(lab.hub.db,"sato",{base:1,team:"別部門",reason:"確認後に異動"},"aoki");
  lab.restart();
  assert.deepEqual(lab.state(id).sources,[]);
  assert.ok(!JSON.stringify(lab.state(id)).includes(a.text));
});

test("実行保留中に到着先を失効したら、受領済みBの原文を破棄して復元しても実行しない",async t=>{
  const lab=setup(t), inbox=lab.folder("shared","保留中");
  const {id}=lab.create(inbox);
  lab.deliver(inbox);
  await lab.scan();
  assert.deepEqual(lab.reads,[inbox.path]);
  lab.hub.db.prepare("UPDATE models SET stopped=1 WHERE id='legacy'").run();
  await lab.tick();
  assert.equal(lab.state(id).status,"held");
  fs.renameSync(inbox.dir,inbox.dir+"-権限失効");
  await lab.scan();
  lab.hub.db.prepare("UPDATE models SET stopped=0 WHERE id='legacy'").run();
  lab.restart();
  await lab.tick();
  const job=lab.state(id);
  assert.equal(job.status,"source_blocked");
  assert.equal(job.arrival_wait.reason,"arrival_access");
  assert.deepEqual(job.sources.map(s=>s.text),[a.text]);
  assert.ok(!JSON.stringify(job).includes(b.text));
  assert.deepEqual(lab.reads,[inbox.path]);
  assert.deepEqual(lab.calls,[]);
  assert.equal(lab.attempts(id),0);
});

test("期限内に揃った見積は、実行待ちのまま期限を過ぎても未着通知を出さず一度だけ比較する",async t=>{
  const lab=setup(t), inbox=lab.folder("shared","実行待ち");
  const deadline=now+2500, {id}=lab.create(inbox,deadline);
  lab.time(deadline-1);
  lab.deliver(inbox);
  await lab.scan();
  assert.equal(lab.state(id).status,"queued");
  assert.equal(lab.attempts(id),0);

  lab.time(deadline+1);
  lab.restart();
  await lab.scan();
  await lab.tick();
  await lab.tick();
  assert.equal(lab.attempts(id),1);
  assert.equal(lab.calls.filter(call=>call.options?.method==="POST").length,1);
  assert.deepEqual(lab.reads,[inbox.path]);
  assert.deepEqual(lab.hub.notifications("sato"),[]);
});
