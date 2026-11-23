import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { openHub } from "../../src/jobs/hub.mjs";
import { groupWork } from "../../src/jobs/work-split.mjs";

test("出典版の失効を実際の社員HTTP入口と再実行の経路で拒否する",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"aihub-split-http-")), file=join(dir,"hub.sqlite");
  const libraries=join(dir,"library"), folder=join(libraries,"shared","合成資料"), accounts=join(dir,"accounts");
  const prior=process.env.LIBRARY_ROOT;
  let server;
  t.after(async()=>{
    if (server?.exitCode===null && server.signalCode===null) {
      const stopped=once(server,"exit");
      server.kill();
      await stopped;
    }
    if (prior===undefined) delete process.env.LIBRARY_ROOT;
    else process.env.LIBRARY_ROOT=prior;
    await rm(dir,{recursive:true,force:true});
  });
  await mkdir(folder,{recursive:true});
  await mkdir(accounts);
  await writeFile(join(accounts,"aoki"),randomBytes(24).toString("hex"));
  const original=join(folder,"原文.txt"), fixtureText="元資料だけに存在する合成原文。";
  await writeFile(original,fixtureText);
  await writeFile(join(folder,"残る資料.txt"),"失効後も閲覧できる別資料。");
  process.env.LIBRARY_ROOT=libraries;
  const hub=openHub(file);
  let parent, childId, failedId;
  try {
    const origin=hub.create("sato",{company:"A社",kind:"assistant",ask:"規程の検索",library_ids:["shared/合成資料"]},randomUUID());
    hub.db.prepare("UPDATE jobs SET status='done',memo='完了 [1]',sources_json=? WHERE id=?").run(JSON.stringify([
      {id:1,title:"原文.txt",version:"検索時の版",text:fixtureText,library:"shared/合成資料"},
    ]),origin);
    const split=groupWork(hub);
    parent=split.create("sato",{origin,ask:"規程の分担",maxParallel:2,maxRuns:3,maxCalls:10,
      parts:[{name:"調査",instructions:"出典の確認"},{name:"点検",instructions:"未確認事項"}]},randomUUID()).id;
    split.pump();
    [childId,failedId]=split.summary("sato",parent).parts.map(part=>part.current_job);
    hub.db.prepare("UPDATE jobs SET status='done',memo=? WHERE id=?").run(fixtureText+" [1]",childId);
    hub.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(failedId);
  } finally { hub.close(); }
  const reservations=Array.from({length:3},()=>createServer());
  const ports=await Promise.all(reservations.map(async listener=>{
    listener.listen(0,"127.0.0.1"); await once(listener,"listening");
    return listener.address().port;
  }));
  await Promise.all(reservations.map(listener=>new Promise(resolve=>listener.close(resolve))));
  const employee="http://127.0.0.1:"+ports[0];
  server=spawn(process.execPath,["server.mjs"],{cwd:new URL("../../",import.meta.url),stdio:["ignore","pipe","inherit"],
    env:{PATH:process.env.PATH,DATA_DIR:dir,ADMIN_ACCOUNTS_DIR:accounts,LIBRARY_ROOT:libraries,
      SATO_PORT:String(ports[0]),TANAKA_PORT:String(ports[1]),ADMIN_PORT:String(ports[2])}});
  server.stdout.resume();
  for (let i=0;i<80;i++) {
    if (await fetch(employee).then(response=>response.ok).catch(()=>false)) break;
    if (server.exitCode!==null) throw Error("Hub did not start");
    await delay(50);
  }
  const endpoint=id=>employee+"/api/jobs/"+id;
  assert.equal((await fetch(endpoint(parent)).then(response=>response.json())).distribution.parts[0].summary,fixtureText+" [1]");
  assert.equal((await fetch(endpoint(childId)).then(response=>response.json())).sources[0].text,fixtureText);
  await rm(original);
  await writeFile(original,"閲覧できるようにしても以前と異なる版。");
  const workspace=await fetch(employee+"/api/workspace").then(response=>response.json());
  assert.equal(workspace.libraries[0].id,"shared/合成資料");
  assert.ok(!JSON.stringify(workspace).includes(fixtureText));
  for (const id of [parent,childId,failedId]) {
    const response=await fetch(endpoint(id));
    assert.equal(response.status,404);
    assert.ok(!(await response.text()).includes(fixtureText));
  }
  for (const [action,input] of [["retry",{position:2,generation:1}],["partial",{}]]) {
    const response=await fetch(employee+"/api/work-split/"+parent+"/"+action,{
      method:"POST",headers:{Origin:employee,"Content-Type":"application/json"},body:JSON.stringify(input),
    });
    assert.equal(response.status,404);
  }
  await delay(550);
  const snapshot=new DatabaseSync(file,{readOnly:true});
  try {
    assert.equal(snapshot.prepare("SELECT count(*) AS n FROM attempts").get().n,0);
    assert.equal(snapshot.prepare("SELECT aggregate FROM split_plans WHERE parent=?").get(parent).aggregate,null);
    assert.equal(snapshot.prepare("SELECT generation FROM split_parts WHERE parent=? AND position=2").get(parent).generation,1);
  } finally {snapshot.close();}
});
