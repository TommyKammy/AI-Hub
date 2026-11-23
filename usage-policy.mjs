import { HubError, reasonText, transaction } from "./operations.mjs";

export const generalSynthetic = "合成資料";
export const restrictedSynthetic = "限定合成資料";
const retentionFields=["attachments","outputs","audit"];
const retained=Object.fromEntries(retentionFields.map(field=>[field,null]));
const initial = {
  classification: generalSynthetic, models: null, destinations: null,
  inquiry: true, memory: true, stopped: false, budget: null, rates: [], retention:retained,
  restricted:{ enabled:true,models:null,destinations:null },
};
const japanOffset = 9 * 3600000;
const minorUnit = 1_000_000;

export function migrateUsagePolicy(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS usage_policy_releases(
    version INTEGER PRIMARY KEY, settings TEXT NOT NULL, operator TEXT, time INTEGER,
    action TEXT NOT NULL, reason TEXT, source INTEGER);
    CREATE TABLE IF NOT EXISTS model_reservations(
    call TEXT PRIMARY KEY REFERENCES model_calls(call_id), month TEXT NOT NULL, policy INTEGER NOT NULL,
    reserved INTEGER NOT NULL, actual INTEGER, requested TEXT NOT NULL,
    rate_input INTEGER NOT NULL, rate_output INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS reservations_by_month ON model_reservations(month);
    CREATE TABLE IF NOT EXISTS usage_threshold_alerts(
    month TEXT NOT NULL, policy INTEGER NOT NULL, time INTEGER NOT NULL, amount INTEGER NOT NULL,
    PRIMARY KEY(month,policy));`);
  db.prepare("INSERT OR IGNORE INTO usage_policy_releases(version,settings,action) VALUES(1,?,'initial')").run(JSON.stringify(initial));
  if (!db.prepare("PRAGMA table_info(model_calls)").all().some(column=>column.name==="block_reason"))
    db.exec("ALTER TABLE model_calls ADD COLUMN block_reason TEXT; ALTER TABLE model_calls ADD COLUMN policy_version INTEGER");
  if (!db.prepare("PRAGMA table_info(model_calls)").all().some(column=>column.name==="data_class"))
    db.exec("ALTER TABLE model_calls ADD COLUMN data_class TEXT");
}

export function usagePolicy(db) {
  const row=db.prepare("SELECT * FROM usage_policy_releases ORDER BY version DESC LIMIT 1").get();
  return { ...row, settings:{...initial,...JSON.parse(row.settings)} };
}

export function usagePolicyHistory(db) {
  return db.prepare("SELECT version,operator,time,action,reason,source FROM usage_policy_releases ORDER BY version DESC LIMIT 25").all();
}

function finiteUnits(value,max=100_000*minorUnit) {
  return Number.isSafeInteger(value) && value>=0 && value<=max;
}

function validateList(value,known) {
  if (value===null) return null;
  if (!Array.isArray(value) || value.length>known.size || new Set(value).size!==value.length || !value.every(id=>known.has(id)))
    throw new HubError(400,"登録済みのモデルと推論先を選んでください。");
  return value;
}

function validateSettings(db,input,destinations) {
  if (!input || input.classification!==generalSynthetic || typeof input.inquiry!=="boolean" || typeof input.memory!=="boolean")
    throw new HubError(400,"対象を合成資料に設定し、窓口と記憶の利用可否を選んでください。");
  const known=new Set(db.prepare("SELECT id FROM models").all().map(row=>row.id));
  const models=validateList(input.models,known);
  const routes=validateList(input.destinations,new Set(destinations));
  const restricted=input.restricted ?? initial.restricted;
  if (typeof restricted.enabled!=="boolean") throw new HubError(400,"限定合成資料の利用可否を選んでください。");
  const restrictedModels=validateList(restricted.models,known);
  const restrictedRoutes=validateList(restricted.destinations,new Set(destinations));
  const budget=input.budget;
  if (budget!==null && (!finiteUnits(budget?.limit) || budget.limit===0 ||
      !Number.isInteger(budget.threshold) || budget.threshold<1 || budget.threshold>100))
    throw new HubError(400,"予算上限と通知しきい値（1〜100%）を確認してください。");
  if (!Array.isArray(input.rates) || input.rates.length>known.size ||
      new Set(input.rates.map(rate=>rate?.model)).size!==input.rates.length ||
      input.rates.some(rate=>!known.has(rate?.model) || !finiteUnits(rate.input) ||
        !finiteUnits(rate.output) || !finiteUnits(rate.reserve) || rate.reserve===0))
    throw new HubError(400,"モデルの単価と呼び出しごとの予約額を確認してください。");
  const retention=input.retention ?? retained;
  if (retentionFields.some(field=>retention[field]!==null &&
      (!Number.isInteger(retention[field]) || retention[field]<1 || retention[field]>3650)))
    throw new HubError(400,"保持期間を1〜3650日で指定してください。");
  return { classification:generalSynthetic, models, destinations:routes, inquiry:input.inquiry, memory:input.memory,
    restricted:{enabled:restricted.enabled,models:restrictedModels,destinations:restrictedRoutes},
    stopped:false, budget:budget && {limit:budget.limit,threshold:budget.threshold},
    rates:input.rates.map(rate=>({model:rate.model,input:rate.input,output:rate.output,reserve:rate.reserve})),
    retention:Object.fromEntries(retentionFields.map(field=>[field,retention[field]])) };
}

export function changeUsagePolicy(db,input,action,operator,destinations) {
  const reason=reasonText(input.reason);
  return transaction(db,()=>{
    const current=usagePolicy(db);
    if (input.base!==current.version) throw new HubError(409,"利用ポリシーが変更されました。再読み込みしてください。");
    let settings, source=null;
    if (action==="publish") {
      if (current.settings.stopped) throw new HubError(409,"緊急停止中は、停止前の版を復元してから公開してください。");
      settings=validateSettings(db,input.settings,destinations);
    } else if (action==="stop") {
      if (current.settings.stopped) return current;
      settings={...current.settings,stopped:true};
    } else if (action==="restore") {
      const previous=db.prepare("SELECT version,settings FROM usage_policy_releases WHERE version=? AND version<?").get(input.version ?? null,current.version);
      if (!previous || JSON.parse(previous.settings).stopped) throw new HubError(409,"復元できる公開版を選んでください。");
      settings=validateSettings(db,JSON.parse(previous.settings),destinations);
      source=previous.version;
    } else throw new HubError(400,"ポリシーに対する操作を確認してください。");
    db.prepare("INSERT INTO usage_policy_releases(version,settings,operator,time,action,reason,source) VALUES(?,?,?,?,?,?,?)")
      .run(current.version+1,JSON.stringify(settings),operator,Date.now(),action,reason,source);
    const published=usagePolicy(db);
    checkUsageThreshold(db,published,monthFor(Date.now()));
    return published;
  });
}

export function modelPolicyDenial(policy,model,dataClass=generalSynthetic) {
  const {settings}=policy;
  if (settings.stopped) return "利用ポリシーの緊急停止中です。";
  if (![generalSynthetic,restrictedSynthetic].includes(dataClass)) return "この機密区分はローカルの利用対象外です。";
  if (model.data_class!==settings.classification ||
      (settings.models && !settings.models.includes(model.id)) ||
      (settings.destinations && !settings.destinations.includes(model.connection)))
    return "利用ポリシーで許可されたモデルまたは推論先を選んでください。";
  if (dataClass===restrictedSynthetic && (!settings.restricted.enabled ||
      (settings.restricted.models && !settings.restricted.models.includes(model.id)) ||
      (settings.restricted.destinations && !settings.restricted.destinations.includes(model.connection))))
    return "限定合成資料には現在のモデルまたは推論先を利用できません。";
  return null;
}

function monthFor(now) {
  return new Date(now+japanOffset).toISOString().slice(0,7);
}

function monthlyTotals(db,month) {
  return db.prepare(`SELECT COALESCE(sum(actual),0) AS settled,
    count(actual) AS settled_calls,
    COALESCE(sum(CASE WHEN actual IS NULL THEN reserved ELSE 0 END),0) AS pending,
    COALESCE(sum(actual IS NULL),0) AS pending_calls FROM model_reservations WHERE month=?`).get(month);
}

function checkUsageThreshold(db,policy,month) {
  if (!policy.settings.budget) return;
  const {limit,threshold}=policy.settings.budget;
  const {settled,pending}=monthlyTotals(db,month);
  if ((settled+pending)*100<limit*threshold) return;
  db.prepare("INSERT OR IGNORE INTO usage_threshold_alerts(month,policy,time,amount) VALUES(?,?,?,?)")
    .run(month,policy.version,Date.now(),settled+pending);
}

export function reserveUsage(db,policy,model,call) {
  const {settings}=policy, rate=settings.rates.find(entry=>entry.model===model.id);
  const month=monthFor(Date.now());
  if (settings.budget) {
    const {settled,pending}=monthlyTotals(db,month);
    if (!rate || settled+pending+rate.reserve>settings.budget.limit)
      throw new HubError(423,rate ? "利用予算に予約できる残額がありません。" : "このモデルの料金設定がありません。");
  }
  if (rate) {
    db.prepare("INSERT INTO model_reservations(call,month,policy,reserved,requested,rate_input,rate_output) VALUES(?,?,?,?,?,?,?)")
      .run(call,month,policy.version,rate.reserve,model.model_id,rate.input,rate.output);
    checkUsageThreshold(db,policy,month);
  }
}

export function settleUsage(db,call,served,usage) {
  const entry=db.prepare("SELECT * FROM model_reservations WHERE call=? AND actual IS NULL").get(call);
  if (!entry || served!==entry.requested || !usage ||
      !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens<0 ||
      !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens<0) return;
  const actual=entry.rate_input*usage.prompt_tokens+entry.rate_output*usage.completion_tokens;
  if (!Number.isSafeInteger(actual)) return;
  db.prepare("UPDATE model_reservations SET actual=? WHERE call=? AND actual IS NULL").run(actual,call);
  checkUsageThreshold(db,usagePolicy(db),entry.month);
}

export function usageSnapshot(db,now=Date.now()) {
  const month=monthFor(now), start=Date.parse(month+"-01T00:00:00+09:00");
  const policy=usagePolicy(db);
  const byModel=db.prepare(`SELECT m.id,m.name,count(DISTINCT c.job) AS requests,
    count(c.call_id) FILTER(WHERE c.outcome<>'blocked') AS calls,
    count(c.call_id) FILTER(WHERE c.outcome='blocked') AS blocked,
    count(c.call_id) FILTER(WHERE c.outcome<>'blocked' AND (c.total_tokens IS NULL OR c.outcome='unknown')) AS unreported
    FROM models m LEFT JOIN model_calls c ON c.model=m.id AND c.started>=? GROUP BY m.id ORDER BY m.name`).all(start);
  const coverage = db.prepare(`SELECT count(*) AS calls, count(*) FILTER(WHERE r.call IS NULL) AS unpriced
    FROM model_calls c LEFT JOIN model_reservations r ON r.call=c.call_id
    WHERE c.started>=? AND c.started<=? AND c.outcome<>'blocked'`).get(start,now);
  return {month,policy:policy.version,budget:policy.settings.budget,...monthlyTotals(db,month),...coverage,byModel,
    requests:db.prepare("SELECT count(*) AS n FROM jobs WHERE created>=?").get(start).n,
    alerts:db.prepare("SELECT time,policy,amount FROM usage_threshold_alerts WHERE month=? ORDER BY time DESC").all(month) };
}

export function retentionEstimate(db,policy,now=Date.now()) {
  const conditions={
    attachments:"SELECT count(*) AS n FROM jobs WHERE created<=? AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(sources_json) THEN sources_json END) WHERE json_extract(value,'$.attached')=1)",
    outputs:"SELECT count(*) AS n FROM jobs WHERE created<=? AND (memo IS NOT NULL OR EXISTS(SELECT 1 FROM memo_versions v WHERE v.job_id=jobs.id AND v.memo IS NOT NULL))",
    audit:"SELECT count(*) AS n FROM admin_audit WHERE time<=?",
  };
  return Object.fromEntries(retentionFields.map(field=>{
    const days=policy.settings.retention[field];
    const cutoff=days===null ? null : now-days*86400000;
    return [field,{ days, cutoff, candidates:cutoff===null ? null : db.prepare(conditions[field]).get(cutoff).n }];
  }));
}
