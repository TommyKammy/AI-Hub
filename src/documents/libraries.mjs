import {createHash} from "node:crypto";
import {closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync} from "node:fs";
import {basename, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {HubError, reasonText, transaction} from "../operations.mjs";
import {documentText} from "./document-text.mjs";

const defaultRoot=fileURLToPath(new URL("../../library-data",import.meta.url));
function entries(dir) {
  try {
    if (realpathSync(dir)!==dir) return [];
    return readdirSync(dir,{withFileTypes:true}).filter(e=>!e.name.startsWith(".")).sort((a,b)=>a.name.localeCompare(b.name,"ja"));
  } catch(error) { if (error.code==="ENOENT") return []; throw error; }
}

function libraryRoot() {
  try { return realpathSync(resolve(process.env.LIBRARY_ROOT || defaultRoot)); }
  catch (error) { if (error.code!=="ENOENT") throw error; }
}
function libraryScopes(member) {
  const safe=value=>typeof value==="string" && /^[^/\\.][^/\\]*$/u.test(value);
  const groups=[["shared","全社員"]];
  if (safe(member.team)) groups.push(["teams/"+member.team,"部門"]);
  if (safe(member.actor)) groups.push(["users/"+member.actor,"自分のみ"]);
  return groups;
}

function available(member, {includeEmpty=false, db} = {}) {
  const root=libraryRoot();
  if (!root) return [];
  const result=[];
  for (const [group,scope] of libraryScopes(member)) {
    for (const entry of entries(join(root,group)).filter(e=>e.isDirectory())) {
      const dir=join(root,group,entry.name);
      const files=entries(dir).filter(e=>e.isFile() && /\.(?:md|txt|pdf|docx)$/i.test(e.name));
      const id=group+"/"+entry.name;
      if ((files.length || includeEmpty) && (!db || libraryEnabled(db,id))) result.push({id,name:entry.name,scope,dir,files});
    }
  }
  return result;
}
export function listLibraries(member, options) {
  return available(member,options).map(({id,name,scope,files})=>({id,name,scope,count:files.length}));
}

const documentListing = (folder, file) => ({
  library:folder.id, folder:folder.name, scope:folder.scope, name:file.name,
});

export async function workspaceDocuments(member, query, db, {nameOnly=false} = {}) {
  const key = query.trim().normalize("NFKC").toLowerCase();
  if (key.length > 200) throw new HubError(400, "検索語を200文字以内にしてください。");
  const result = [];
  let remaining = 16 * 1024 * 1024;
  let skipped = 0;
  for (const folder of available(member, {db})) {
    for (const file of folder.files) {
      const item = documentListing(folder, file);
      const label = nameOnly ? file.name : folder.name + " " + file.name;
      if (label.normalize("NFKC").toLowerCase().includes(key)) {
        if (nameOnly && !arrivalDocument(member, folder.id, file.name, db)?.read) continue;
        result.push(item);
        if (nameOnly && result.length===20) return {documents:result, skipped};
        continue;
      }
      if (nameOnly) continue;
      const entry = arrivalDocument(member, folder.id, file.name, db);
      if (!entry?.read) continue;
      if (entry.size > remaining) {
        skipped++;
        continue;
      }
      try {
        const bytes = entry.read();
        remaining -= bytes.length;
        const text = await documentText(bytes, file.name.split(".").at(-1).toLowerCase(), 64 * 1024);
        if (text.normalize("NFKC").toLowerCase().includes(key) &&
            arrivalDocument(member, folder.id, file.name, db)?.token === entry.token) result.push(item);
      } catch (error) {
        if (!(error instanceof HubError) && error.code !== "ENOENT") throw error;
        skipped++;
      }
    }
  }
  return {documents:nameOnly ? result : result.filter(item => arrivalDocument(member,item.library,item.name,db)?.read), skipped};
}

export async function workspaceDocument(member, library, name, db) {
  const folder = available(member,{db}).find(item => item.id === library);
  const file = folder?.files.find(item => item.name === name);
  const entry = file && arrivalDocument(member, library, name, db);
  if (!entry?.read) throw new HubError(404, "資料が見つかりません。");
  const text = await documentText(entry.read(), name.split(".").at(-1).toLowerCase(), 64 * 1024);
  if (arrivalDocument(member, library, name, db)?.token !== entry.token) throw new HubError(409, "資料が更新されました。開き直してください。");
  return { ...documentListing(folder,file), text };
}

export async function liveLibrarySource(member, source, db) {
  const format = source.title.split(".").at(-1).toLowerCase();
  const expired = reason => {
    const { text, ...metadata } = source;
    return { ...metadata, unavailable: reason };
  };
  try {
    const document = arrivalDocument(member, source.library, source.title, db);
    if (!document) return expired("現在の所属または公開範囲では、この出典を参照できません。");
    if (!document.read) return expired("この資料の公開が終了しました。");
    const text = await documentText(document.read(), format, 64 * 1024);
    if (text !== source.text || arrivalDocument(member, source.library, source.title, db)?.token !== document.token)
      return expired("資料が更新され、この版の公開が終了しました。");
    return source;
  } catch {
    return expired("この版の本文を確認できません。");
  }
}

export function arrivalDocument(member, libraryId, name, db) {
  if (typeof name!=="string" || !name || name.startsWith(".") || /[/\\]/u.test(name)) return null;
  if (db && !libraryEnabled(db,libraryId)) return null;
  const boundary=libraryId.lastIndexOf("/");
  const group=libraryId.slice(0,boundary), folderName=libraryId.slice(boundary+1);
  if (boundary<0 || !folderName || folderName.startsWith(".") || !libraryScopes(member).some(([id])=>id===group)) return null;
  let folder;
  try {
    const root=libraryRoot();
    if (!root) return null;
    const dir=join(root,group,folderName);
    if (realpathSync(dir)!==dir || !lstatSync(dir).isDirectory()) return null;
    folder={name:folderName};
    const path=join(dir,name);
    const stat=lstatSync(path,{bigint:true});
    if (!stat.isFile() || realpathSync(path)!==path) return null;
    const identity=file=>[file.dev,file.ino,file.size,file.mtimeNs,file.ctimeNs].join(":");
    const token=identity(stat);
    return {folder,token,size:Number(stat.size),read() {
      if (stat.size>5n*1024n*1024n) throw new HubError(413,"見積書は5 MB以内にしてください。");
      if (realpathSync(path)!==path) throw new HubError(409,"見積書が更新されました。");
      const current=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        if (identity(fstatSync(current,{bigint:true}))!==token) throw new HubError(409,"見積書が更新されました。");
        return readFileSync(current);
      } finally { closeSync(current); }
    }};
  } catch (error) {
    if (["ENOENT","ENOTDIR"].includes(error.code)) return folder ? {folder} : null;
    if (error.code==="ELOOP") return null;
    if (["EACCES","EPERM"].includes(error.code)) return null;
    throw error;
  }
}
function choose(member,ids,db) {
  if (!Array.isArray(ids) || !ids.length || ids.length>12 || new Set(ids).size!==ids.length)
    throw new HubError(400,"検索する資料置き場を1〜12件選んでください。");
  const folders=available(member,{db});
  return ids.map(id=>{
    const folder=folders.find(f=>f.id===id);
    if (!folder) throw new HubError(403,"選んだ資料置き場は現在参照できません。");
    return folder;
  }).sort((a,b)=>a.id.localeCompare(b.id,"ja"));
}
export function librarySelection(member,ids,db,document) {
  const folders = choose(member,ids,db);
  if (document !== undefined && (folders.length !== 1 || !folders[0].files.some(file=>file.name===document)))
    throw new HubError(403,"選んだ資料は現在参照できません。");
  return folders.map(({id,name,scope})=>({id,name,scope,...(document !== undefined && {document})}));
}

// Japanese compounds also match when the question adds particles or changes word order.
function terms(value) {
  const words=value.normalize("NFKC").toLowerCase().match(/[一-龯々]+|[ァ-ヺー]+|[a-z0-9]+/gu) || [];
  return [...new Set(words.flatMap(w=>w.length<3 || !/^[一-龯々]+$/u.test(w) ? [w] :
    [w,...Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2))]))];
}
export async function searchLibraries(member, ids, query, attached, passages, db, document) {
  if (typeof query!=="string" || !query.trim() || query.length>500) throw new HubError(400,"検索語を確認してください。");
  const docs=[...attached];
  let total=0;
  for (const folder of choose(member,ids,db)) {
    for (const entry of folder.files) {
      if (document !== undefined && entry.name !== document) continue;
      const path=join(folder.dir,entry.name);
      if (realpathSync(path)!==path) throw new HubError(409,"資料が変更されました。");
      const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      let bytes;
      try {
        const stat=fstatSync(fd);
        if (!stat.isFile() || stat.size>5*1024*1024 || (total+=stat.size)>16*1024*1024 || docs.length>=500)
          throw new HubError(413,"検索範囲が大きすぎます。資料置き場を絞ってください。");
        bytes=readFileSync(fd);
      } finally { closeSync(fd); }
      const text=await documentText(bytes,entry.name.split(".").at(-1).toLowerCase(),64*1024);
      const textHash=createHash("sha256").update(text).digest("hex");
      docs.push({id:docs.length+1,title:basename(path),library:folder.id,library_name:folder.name,
        document_id:createHash("sha256").update(folder.id+"\0"+entry.name).digest("hex"),
        document_version:textHash, version:"検索時の版 "+textHash.slice(0,12),text});
    }
  }
  const needles=terms(query);
  const ranked=passages(docs).map(p=>{
    const line=p.text.normalize("NFKC").toLowerCase();
    const score=needles.reduce((sum,t)=>sum+(line.includes(t)?Math.min(t.length,8):0),0);
    return {p,score};
  }).filter(hit=>hit.score>0).sort((a,b)=>b.score-a.score);
  const sources=[...attached], matches=[], numbers=new Map(attached.map(s=>[s.id,s.id]));
  for (const {p} of ranked) {
    if (matches.length===12) break;
    const doc=docs[p.source-1];
    if (!numbers.has(doc.id)) {
      if (sources.length>=8) continue;
      numbers.set(doc.id,sources.length+1);
      sources.push({...doc,id:sources.length+1});
    }
    const id=numbers.get(doc.id);
    matches.push({...p,source:id,ref:id+p.ref.slice(p.ref.indexOf(".")),library_name:doc.library_name});
  }
  return {sources,matches};
}

export function migrateLibraryManagement(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS library_management(
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
    version TEXT, error TEXT, operator TEXT NOT NULL, time INTEGER NOT NULL, reason TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS library_changes(
    id TEXT NOT NULL, revision INTEGER NOT NULL, action TEXT NOT NULL, operator TEXT NOT NULL,
    time INTEGER NOT NULL, reason TEXT NOT NULL, version TEXT, error TEXT,
    PRIMARY KEY(id,revision));`);
}

export function libraryEnabled(db,id) {
  const state=db.prepare("SELECT paused,error FROM library_management WHERE id=?").get(id);
  return !state || !state.paused && !state.error;
}

function adminFolders() {
  const root=libraryRoot();
  if (!root) return new Map();
  const groups=["shared", ...entries(join(root,"teams")).filter(entry=>entry.isDirectory()).map(entry=>"teams/"+entry.name)];
  const folders=new Map();
  for (const group of groups) {
    for (const entry of entries(join(root,group)).filter(entry=>entry.isDirectory())) {
      const id=group+"/"+entry.name;
      folders.set(id,{id,name:entry.name,group,dir:join(root,id)});
    }
  }
  return folders;
}

export function managedLibraries(db) {
  const folders=adminFolders();
  const states=new Map(db.prepare("SELECT * FROM library_management ORDER BY id").all().map(row=>[row.id,row]));
  const ids=new Set([...folders.keys(),...states.keys()]);
  return [...ids].map(id=>{
    const source=folders.get(id), state=states.get(id);
    const initial={ id, revision:0, paused:0, version:null, error:null };
    return { ...initial, ...state, name:source?.name ?? basename(id), scope:id.startsWith("shared/") ? "全社員" : id.split("/")[1],
      online:Boolean(source), status:state?.paused ? "paused" : state?.error || !source ? "failed" : state?.version ? "synced" : "live",
      history:db.prepare("SELECT revision,action,operator,time,reason,version,error FROM library_changes WHERE id=? ORDER BY revision DESC LIMIT 10").all(id) };
  });
}

function libraryManifest(folder) {
  if (!folder || realpathSync(folder.dir)!==folder.dir) throw Error("missing source");
  const manifest=entries(folder.dir).filter(entry=>entry.isFile() && /\.(md|txt|pdf|docx)$/i.test(entry.name))
    .map(entry=>{
      const file=join(folder.dir,entry.name), stat=lstatSync(file,{bigint:true});
      if (!stat.isFile() || realpathSync(file)!==file) throw Error("source changed");
      return [entry.name,String(stat.size),String(stat.mtimeNs),String(stat.ctimeNs)];
    });
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function updateManagedLibrary(db,input,operator) {
  const {id,action,base}=input;
  if (typeof id!=="string" || id.length>250 || !["pause","resume","sync"].includes(action) || !Number.isSafeInteger(base))
    throw new HubError(400,"資料接続と操作を確認してください。");
  const reason=reasonText(input.reason);
  return transaction(db,()=>{
    const prior=db.prepare("SELECT * FROM library_management WHERE id=?").get(id);
    let source;
    try { source=adminFolders().get(id); }
    catch (error) { if (!prior) throw error; }
    if (!source && !prior) throw new HubError(404,"資料接続が見つかりません。");
    if (base!==(prior?.revision ?? 0)) throw new HubError(409,"接続状態が更新されました。再読み込みしてください。");
    const paused=action==="pause" ? 1 : action==="resume" ? 0 : prior?.paused ?? 0;
    let version=prior?.version ?? null, error=prior?.error ?? null;
    if (action!=="pause") {
      try { version=libraryManifest(source); error=null; }
      catch { error="資料置き場の現在の版を読み取れません。"; }
    }
    const time=Date.now(), revision=base+1;
    db.prepare(`INSERT INTO library_management(id,revision,paused,version,error,operator,time,reason) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,paused=excluded.paused,version=excluded.version,error=excluded.error,
      operator=excluded.operator,time=excluded.time,reason=excluded.reason`).run(id,revision,paused,version,error,operator,time,reason);
    db.prepare("INSERT INTO library_changes(id,revision,action,operator,time,reason,version,error) VALUES(?,?,?,?,?,?,?,?)")
      .run(id,revision,action,operator,time,reason,version,error);
    return {revision,paused:Boolean(paused),version,error};
  });
}
