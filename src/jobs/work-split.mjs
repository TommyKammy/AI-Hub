import { activeMember, teamPermitsJob } from "../identity/memberships.mjs";
import { arrivalDocument, librarySelection } from "../documents/libraries.mjs";
import { HubError, transaction } from "../operations.mjs";

export function migrateSplitWork(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS split_plans(
    parent TEXT PRIMARY KEY REFERENCES jobs(id), owner TEXT NOT NULL, revision INTEGER NOT NULL,
    origin TEXT NOT NULL REFERENCES jobs(id), sources TEXT NOT NULL, max_parallel INTEGER NOT NULL,
    max_runs INTEGER NOT NULL, max_calls INTEGER NOT NULL, aggregate TEXT,
    UNIQUE(owner,parent));
    CREATE TABLE IF NOT EXISTS split_parts(
    parent TEXT NOT NULL REFERENCES split_plans(parent), position INTEGER NOT NULL,
    name TEXT NOT NULL, instructions TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, current_job TEXT REFERENCES jobs(id),
    PRIMARY KEY(parent,position));
    CREATE TABLE IF NOT EXISTS split_runs(
    job TEXT PRIMARY KEY REFERENCES jobs(id), parent TEXT NOT NULL REFERENCES split_plans(parent),
    position INTEGER, generation INTEGER NOT NULL,
    UNIQUE(parent,position,generation));
    CREATE INDEX IF NOT EXISTS split_runs_parent ON split_runs(parent);`);
  if (!db.prepare("PRAGMA table_info(split_parts)").all().some(column=>column.name==="source_ids"))
    db.exec("ALTER TABLE split_parts ADD COLUMN source_ids TEXT");
}

function line(value,max) {
  if (typeof value!=="string" || !value.trim() || value.length>max) throw new HubError(400,"依頼と作業ごとの指示を確認してください。");
  return value.trim();
}
const activeStatuses=["queued","dispatching","running","held","held_dispatched","unknown","waiting"];
export function splitJobPermitted(db,job,actor) {
  const plan=db.prepare(`SELECT p.*,m.revision current,m.team,j.library_selection,j.procedure_id,s.revoked_at
    FROM split_runs r JOIN split_plans p ON p.parent=r.parent JOIN memberships m ON m.actor=p.owner
    JOIN jobs j ON j.id=p.origin LEFT JOIN procedures s ON s.id=j.procedure_id WHERE r.job=?`).get(job);
  if (!plan) return true;
  if (plan.owner!==actor || plan.revision!==plan.current || !teamPermitsJob(db,plan.origin) || plan.revoked_at!==null) return false;
  if (plan.library_selection) {
    const folders=JSON.parse(plan.library_selection).map(source=>source.id);
    if (folders.length) {
      try { librarySelection({actor,team:plan.team},folders,db); }
      catch(error) { if (error instanceof HubError) return false; throw error; }
    }
  }
  if (JSON.parse(plan.sources).some(source=>source.library &&
      (!source.token || arrivalDocument({actor,team:plan.team},source.library,source.title,db)?.token!==source.token))) return false;
  return true;
}

export function splitCallDenial(db,job) {
  if (!job) return null;
  const budget=db.prepare(`SELECT p.max_calls,(SELECT count(*) FROM model_calls c JOIN split_runs r ON r.job=c.job
    WHERE r.parent=p.parent AND c.outcome<>'blocked') spent
    FROM split_plans p JOIN split_runs r ON r.parent=p.parent WHERE r.job=?`).get(job);
  return budget && budget.spent>=budget.max_calls ? "作業分担のモデル呼び出し上限に達しました。" : null;
}

export function groupWork(hub) {
  const {db}=hub;
  function authorized(actor,id) {
    const owner=activeMember(db,actor);
    const plan=db.prepare("SELECT * FROM split_plans WHERE parent=? AND owner=? AND revision=?").get(id,actor,owner.revision);
    if (!plan || !teamPermitsJob(db,id) || !splitJobPermitted(db,id,actor))
      throw new HubError(404,"この作業分担または元の資料を現在参照できません。");
    const origin=hub.get(actor,plan.origin);
    if (origin.team_denied || origin.procedure_revoked) throw new HubError(403,"元の依頼の資料範囲を確認してください。");
    const folders=origin.library_selection.map(source=>source.id);
    if (folders.length) librarySelection(owner,folders,db);
    return {plan,owner};
  }
  function parts(parent) {
    return db.prepare(`SELECT p.*,j.status,j.memo FROM split_parts p LEFT JOIN jobs j ON j.id=p.current_job
      WHERE p.parent=? ORDER BY p.position`).all(parent);
  }
  function spent(parent) {
    return db.prepare("SELECT count(*) AS n FROM split_runs WHERE parent=? AND position IS NOT NULL").get(parent).n;
  }
  function closePlan(plan,rows,partial) {
    const completed=rows.filter(row=>row.status==="done");
    if (!completed.length) throw new HubError(409,"集約に使える完了済みの作業がありません。");
    const inputs=completed.map((row,index)=>{
      const job=hub.get(plan.owner,row.current_job), version=job.adopted_version ?? job.versions.findLast(item=>item.memo)?.version ?? 1;
      const memo=job.versions.find(item=>item.version===version)?.memo ?? job.memo;
      return { id:index+1,title:row.name,version:"子作業 第"+version+"版",text:memo.replace(/\[\d+\]/g,""),
        job:row.current_job,memo_version:version };
    });
    const changed=db.prepare("UPDATE split_plans SET aggregate=? WHERE parent=? AND aggregate IS NULL")
      .run(partial ? "partial" : "complete",plan.parent);
    if (!changed.changes) return;
    db.prepare("UPDATE jobs SET sources_json=?,status='queued' WHERE id=? AND status='split_waiting'")
      .run(JSON.stringify(inputs),plan.parent);
  }
  return {
    create(actor,input,key,visibleOrigin) {
      if (!/^[a-zA-Z0-9-]{12,100}$/.test(key ?? "")) throw new HubError(400,"作業分担の受付キーが必要です。");
      const ask=line(input.ask,400);
      if (!Array.isArray(input.parts) || input.parts.length<2 || input.parts.length>5 ||
          !Number.isInteger(input.maxParallel) || input.maxParallel<1 || input.maxParallel>3 ||
          !Number.isInteger(input.maxRuns) || input.maxRuns<input.parts.length || input.maxRuns>12 ||
          !Number.isInteger(input.maxCalls) || input.maxCalls<input.parts.length+1 || input.maxCalls>50)
        throw new HubError(400,"子作業2〜5件、同時実行数1〜3件、実行上限とモデル呼び出し上限を確認してください。");
      const owner=activeMember(db,actor);
      if (typeof input.origin!=="string" || !/^[0-9a-f-]{36}$/i.test(input.origin))
        throw new HubError(400,"元の仕事を選んでください。");
      const origin=visibleOrigin?.id===input.origin ? visibleOrigin : hub.get(actor,input.origin);
      if (origin.status!=="done" || origin.team_denied || origin.procedure_revoked || !origin.sources.length)
        throw new HubError(409,"出典を開ける完了済みの仕事を選んでください。");
      const libraries=origin.library_selection.map(source=>source.id);
      if (libraries.length) librarySelection(owner,libraries,db);
      const sources=origin.sources.filter(source=>typeof source.text==="string" && !source.unavailable).slice(0,8)
        .map(source=>source.library ? {...source,token:arrivalDocument(owner,source.library,source.title,db)?.token} : source)
        .filter(source=>!source.library || source.token);
      if (!sources.length || JSON.stringify(sources).length>32000) throw new HubError(400,"分担する資料の範囲を絞ってください。");
      const sourceIds=new Set(sources.map(source=>source.id));
      const tasks=input.parts.map(task=>{
        const ids=task?.sourceIds ?? [...sourceIds];
        if (!Array.isArray(ids) || !ids.length || new Set(ids).size!==ids.length || ids.some(id=>!sourceIds.has(id)))
          throw new HubError(400,"各作業の資料を元の仕事から選んでください。");
        return {name:line(task.name,48),instructions:line(task.instructions,300),sourceIds:[...ids].sort((a,b)=>a-b)};
      });
      return transaction(db,()=>{
        const prior=db.prepare("SELECT p.*,j.ask FROM split_plans p JOIN jobs j ON j.id=p.parent WHERE p.owner=? AND j.request_key=?")
          .get(actor,key);
        if (prior) {
          authorized(actor,prior.parent);
          const persisted=parts(prior.parent).map(({name,instructions,source_ids})=>({name,instructions,sourceIds:JSON.parse(source_ids || "null") ?? [...sourceIds]}));
          if (prior.ask!==ask || prior.origin!==input.origin || prior.max_parallel!==input.maxParallel || prior.max_runs!==input.maxRuns ||
              prior.max_calls!==input.maxCalls || JSON.stringify(persisted)!==JSON.stringify(tasks))
            throw new HubError(409,"受付済みの分担条件が変わりました。");
          return {id:prior.parent};
        }
        const parent=hub.create(actor,{company:owner.company,kind:"general",ask,data_class:"限定合成資料",minutes:"子作業の結果を集約します。"},key);
        const parked=db.prepare("UPDATE jobs SET status='split_waiting' WHERE id=? AND status='queued'").run(parent);
        if (!parked.changes) throw new HubError(409,"この依頼は分担として登録できません。");
        db.prepare("INSERT INTO split_plans(parent,owner,revision,origin,sources,max_parallel,max_runs,max_calls) VALUES(?,?,?,?,?,?,?,?)")
          .run(parent,actor,owner.revision,input.origin,JSON.stringify(sources),input.maxParallel,input.maxRuns,input.maxCalls);
        const insert=db.prepare("INSERT INTO split_parts(parent,position,name,instructions,source_ids) VALUES(?,?,?,?,?)");
        tasks.forEach((task,index)=>insert.run(parent,index+1,task.name,task.instructions,JSON.stringify(task.sourceIds)));
        db.prepare("INSERT INTO split_runs(job,parent,generation) VALUES(?,?,1)").run(parent,parent);
        return {id:parent};
      });
    },
    summary(actor,id) {
      const exists=db.prepare("SELECT 1 FROM split_plans WHERE parent=? AND owner=?").get(id,actor);
      if (!exists) return null;
      const {plan}=authorized(actor,id);
      const rows=parts(id).map(row=>{
        const {parent,memo,source_ids,...metadata}=row;
        const chosen=JSON.parse(source_ids || "null");
        return {...metadata,sourceTitles:JSON.parse(plan.sources).filter(source=>!chosen || chosen.includes(source.id)).map(source=>source.title),
          summary:row.status==="done" ? memo : null};
      });
      return { origin:plan.origin, sourceTitles:JSON.parse(plan.sources).map(source=>source.title), aggregate:plan.aggregate,
        maxParallel:plan.max_parallel,maxRuns:plan.max_runs,maxCalls:plan.max_calls,runsUsed:spent(id),parts:rows };
    },
    retry(actor,id,position,generation) {
      return transaction(db,()=>{
        const {plan}=authorized(actor,id);
        const row=parts(id).find(item=>item.position===position);
        if (!row || row.generation!==generation || !["failed","cancelled"].includes(row.status) || spent(id)>=plan.max_runs)
          throw new HubError(409,"再実行できる失敗済みの子作業を選んでください。");
        db.prepare("UPDATE split_parts SET current_job=NULL,generation=generation+1 WHERE parent=? AND position=?").run(id,position);
        return {ok:true};
      });
    },
    acceptPartial(actor,id) {
      return transaction(db,()=>{
        const {plan}=authorized(actor,id);
        const rows=parts(id);
        if (rows.every(row=>row.status==="done")) throw new HubError(409,"すべての作業が終了しています。");
        closePlan(plan,rows,true);
        return {ok:true};
      });
    },
    pump() {
      for (const {parent,owner} of db.prepare(`SELECT parent,owner FROM split_plans p WHERE p.aggregate IS NULL OR
        EXISTS(SELECT 1 FROM split_parts c WHERE c.parent=p.parent AND c.generation>1 AND c.current_job IS NULL)`).all()) {
        try {
          transaction(db,()=>{
            const {plan,owner:person}=authorized(owner,parent), rows=parts(parent);
            if (!plan.aggregate && rows.every(row=>row.status==="done")) return closePlan(plan,rows,false);
            const inflight=rows.filter(row=>activeStatuses.includes(row.status)).length;
            const ready=rows.filter(row=>!row.current_job && (!plan.aggregate || row.generation>1))
              .slice(0,Math.max(0,Math.min(plan.max_parallel-inflight,plan.max_runs-spent(parent))));
            for (const row of ready) {
              const key="split-"+parent+"-"+row.position+"-"+row.generation;
              const job=hub.create(owner,{company:person.company,kind:"general",data_class:"限定合成資料",
                ask:row.name+"。"+row.instructions,minutes:"親の作業分担で許可された資料。"},key);
              const chosen=JSON.parse(row.source_ids || "null");
              const sources=JSON.parse(plan.sources).filter(source=>!chosen || chosen.includes(source.id))
                .map(({token,...source})=>source);
              db.prepare("UPDATE jobs SET sources_json=? WHERE id=?").run(JSON.stringify(sources),job);
              db.prepare("INSERT INTO split_runs VALUES(?,?,?,?)").run(job,parent,row.position,row.generation);
              db.prepare("UPDATE split_parts SET current_job=? WHERE parent=? AND position=?").run(job,parent,row.position);
            }
          });
        } catch(error) {
          if (!(error instanceof HubError) || ![403,404,423].includes(error.status)) throw error;
        }
      }
    },
  };
}
