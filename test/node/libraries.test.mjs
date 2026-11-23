import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openHub, workPassages} from "../../src/jobs/hub.mjs";
import {listLibraries, librarySelection, searchLibraries, workspaceDocument, workspaceDocuments} from "../../src/documents/libraries.mjs";
import {transfer} from "../../src/identity/memberships.mjs";

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),"hermes-library-")), previous=process.env.LIBRARY_ROOT;
  process.env.LIBRARY_ROOT=root;
  t.after(()=>{
    if (previous===undefined) delete process.env.LIBRARY_ROOT;
    else process.env.LIBRARY_ROOT=previous;
    rmSync(root,{recursive:true,force:true});
  });
  for (const dir of ["shared/規程","teams/営業企画部/案内","users/sato/草案","users/tanaka/私用"]) {
    mkdirSync(join(root,dir),{recursive:true});
    writeFileSync(join(root,dir,"資料.md"),"第1条　出張には承認を要する。");
  }
  return {root,member:{actor:"sato",team:"営業企画部"}};
}

test("本人が選んだ置き場に検索を限定し、添付と検索時の版・引用位置を保持する",async t=>{
  const {root,member}=fixture(t);
  symlinkSync(join(root,"users/tanaka/私用"),join(root,"shared/別名"));
  symlinkSync(join(root,"users/tanaka/私用/資料.md"),join(root,"shared/規程/外部.md"));
  assert.deepEqual(listLibraries(member).map(l=>[l.id,l.count]),[["shared/規程",1],["teams/営業企画部/案内",1],["users/sato/草案",1]]);
  assert.throws(()=>librarySelection(member,["users/tanaka/私用"]),{status:403});
  const ids=["shared/規程"], attachment={id:1,title:"質問票",text:"国内出張について"};
  const search=query=>searchLibraries(member,ids,query,[attachment],workPassages);
  const before=await search("出張");
  assert.deepEqual(before.sources.map(s=>s.id),[1,2]);
  assert.equal(before.sources[1].library,ids[0]);
  for (const hit of before.matches) assert.equal(before.sources[hit.source-1].text.slice(hit.offset,hit.offset+hit.text.length),hit.text);
  writeFileSync(join(root,ids[0],"資料.md"),"第1条　出張は経費ポータルに申請する。");
  const after=await search("出張");
  assert.notEqual(after.sources[1].version,before.sources[1].version);
  assert.match(before.sources[1].text,/承認/);
  assert.deepEqual((await search("量子コンピュータの冷却温度")).matches,[]);
});

test("受付後に資料が移動しても再送は同じ仕事になり、異動した本人は保留中の原文を参照できない",async t=>{
  const {root}=fixture(t), hub=openHub(":memory:");
  t.after(()=>hub.close());
  const input={kind:"assistant",company:"A社",ask:"出張の手続きは？",library_ids:["teams/営業企画部/案内"]};
  const key=randomUUID(), id=hub.create("sato",input,key), other=hub.create("tanaka",{...input,company:"B社"},randomUUID());
  assert.throws(()=>hub.create("sato",{...input,library_ids:["shared/規程"]},key),{status:409});
  assert.throws(()=>hub.get("tanaka",id),{status:404});
  rmSync(join(root,input.library_ids[0]),{recursive:true});
  assert.equal(hub.create("sato",input,key),id);
  assert.throws(()=>hub.create("sato",input,randomUUID()),{status:403});
  transfer(hub.db,"sato",{base:1,team:"営業二部",reason:"異動"},"aoki");
  assert.throws(()=>hub.get("sato",id),{status:404});
  assert.deepEqual(hub.search("sato","出張"),[]);
  assert.throws(()=>hub.create("sato",input,key),{status:404});
  assert.equal(hub.get("tanaka",other).status,"queued");
  assert.equal(hub.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status,"membership_blocked");
});

test("業務スペースは本人が開ける原文を検索し、この資料への質問を同名の別資料に広げない",async t=>{
  const {root,member}=fixture(t), hub=openHub(":memory:");
  t.after(()=>hub.close());
  const folder="shared/規程", file="別の規程.md";
  writeFileSync(join(root,folder,file),"第2条　出張の承認先は直属上長です。");
  writeFileSync(join(root,folder,"読めない.txt"),Buffer.from([255]));
  const {documents:found,skipped}=await workspaceDocuments(member,"直属上長",hub.db);
  assert.equal(skipped,1);
  assert.deepEqual(found.map(doc=>[doc.library,doc.name]),[[folder,file]]);
  assert.match((await workspaceDocument(member,folder,file,hub.db)).text,/直属上長/);
  await assert.rejects(workspaceDocument(member,"users/tanaka/私用","資料.md",hub.db),{status:404});
  const input={kind:"assistant",company:"A社",ask:"出張の承認先は？",library_ids:[folder],library_document:file};
  const key=randomUUID(), job=hub.create("sato",input,key);
  assert.equal(hub.get("sato",job).library_selection[0].document,file);
  const {sources}=await searchLibraries(member,[folder],"出張",[],workPassages,hub.db,file);
  assert.deepEqual(sources.map(source=>source.title),[file]);
  assert.throws(()=>hub.create("sato",{...input,library_document:"資料.md"},key),{status:409});
  rmSync(join(root,folder,file));
  assert.throws(()=>hub.create("sato",input,randomUUID()),{status:403});
});
