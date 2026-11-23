import { employees } from "../fixtures.mjs";
import { recordAdminChange } from "../identity/memberships.mjs";
import { HubError, reasonText, transaction } from "../operations.mjs";

function trustedUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw Error("本人用ランタイムの接続設定を確認してください。");
  return url.href;
}

export function runtimeAssignments(db, env = process.env) {
  db.exec(`CREATE TABLE IF NOT EXISTS runtime_assignments (
    actor TEXT PRIMARY KEY, runtime TEXT NOT NULL, revision INTEGER NOT NULL
  )`);
  const configured = JSON.parse(env.AI_HUB_RUNTIME_ALIASES || "{}");
  const routes = new Map();
  const owners = new Map();
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) throw Error("ランタイム一覧の形式を確認してください。");
  for (const actor of Object.keys(employees)) {
    const prefix = actor.toUpperCase() + "_";
    const base = env[prefix + "URL"] && env[prefix + "KEY"] ? {
      id: env[prefix + "RUNTIME_ID"] || actor, url: trustedUrl(env[prefix + "URL"]),
      receipts: env[prefix + "RECEIPTS_URL"] ? trustedUrl(env[prefix + "RECEIPTS_URL"]) : null,
      token: env[prefix + "KEY"],
    } : null;
    const extras = configured[actor] ?? [];
    if (!Array.isArray(extras)) throw Error("社員別のランタイム一覧を確認してください。");
    const candidates = [base, ...extras.map(entry => {
      if (!entry || typeof entry.key_ref !== "string" || !entry.key_ref.startsWith(prefix) ||
          !/^[A-Z][A-Z0-9_]{1,127}$/.test(entry.key_ref) || !env[entry.key_ref])
        throw Error("社員別のランタイム認証参照を確認してください。");
      return {id:entry.id, url:trustedUrl(entry.url), receipts:entry.receipts ? trustedUrl(entry.receipts) : null, token:env[entry.key_ref]};
    })].filter(Boolean);
    for (const runtime of candidates) {
      if (typeof runtime.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(runtime.id) || owners.has(runtime.id))
        throw Error("社員別のランタイムIDは重複のない半角小文字・数字・ハイフンで指定してください。");
      owners.set(runtime.id, actor);
    }
    routes.set(actor, {base, candidates});
  }
  if (Object.keys(configured).some(actor => !routes.has(actor))) throw Error("ランタイム一覧に未登録の社員が含まれています。");

  function details(actor) {
    const {base, candidates} = routes.get(actor) ?? {candidates:[]};
    const assignment = db.prepare("SELECT runtime,revision FROM runtime_assignments WHERE actor=?").get(actor);
    const runtime = assignment?.runtime ?? base?.id ?? null;
    return {runtime, revision:assignment?.revision ?? 0, configured:candidates.some(candidate=>candidate.id===runtime), aliases:candidates.map(candidate=>candidate.id)};
  }
  return {
    details,
    selected(actor) {
      return details(actor).runtime;
    },
    save(actor, input, operator) {
      const {runtime, revision} = input || {};
      const reason = reasonText(input?.reason);
      return transaction(db, () => {
        const member = db.prepare("SELECT 1 FROM memberships WHERE actor=?").get(actor);
        if (!member) throw new HubError(404,"社員が見つかりません。");
        const prior = details(actor);
        if (prior.revision !== revision) throw new HubError(409,"実行先が変更されました。開き直してください。");
        if (!prior.aliases.includes(runtime)) throw new HubError(400,"この社員に設定されたランタイムを選択してください。");
        if (prior.runtime === runtime) return prior;
        db.prepare(`INSERT INTO runtime_assignments(actor,runtime,revision) VALUES(?,?,?)
          ON CONFLICT(actor) DO UPDATE SET runtime=excluded.runtime,revision=excluded.revision`).run(actor,runtime,revision+1);
        recordAdminChange(db,{operator,scope:"employee",target:actor,action:"runtime-change",before:prior.runtime ?? "未設定",after:runtime,reason});
        return details(actor);
      });
    },
    async call(actor, path, options = {}, assignedId = null, receipt = false) {
      const choices = routes.get(actor);
      const runtime = assignedId === null ? choices?.base : choices?.candidates.find(item=>item.id===assignedId);
      const endpoint = receipt ? runtime?.receipts : runtime?.url;
      if (!endpoint) throw Error("runtime configuration missing");
      const response = await fetch(new URL(path,endpoint), {
        ...options, redirect:"error", signal:AbortSignal.timeout(8000),
        headers:{"Content-Type":"application/json",...options.headers,Authorization:"Bearer "+runtime.token},
      });
      if (!response.ok) throw new HubError(response.status, "Hermes HTTP " + response.status);
      return response.json();
    },
  };
}
