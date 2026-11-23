import { randomUUID } from "node:crypto";
import { recordAdminChange } from "../identity/memberships.mjs";
import { HubError, transaction } from "../operations.mjs";

const providers = new Map([
  ["openai", {direct:"https://api.openai.com/v1", gateway:"openai"}],
  ["anthropic", {direct:"https://api.anthropic.com", gateway:"anthropic"}],
  ["gemini", {direct:"https://generativelanguage.googleapis.com", gateway:"google-ai-studio"}],
]);
const routes = new Map([
  ["direct", ["provider", "key_ref"]],
  ["cloudflare", ["provider", "account", "gateway", "token_ref", "alias"]],
  ["bedrock", ["region", "role"]],
  ["compatible", ["base_url", "key_ref"]],
]);
const secretRef = /^[A-Z][A-Z0-9_]{1,127}$/;

export function migrateModelProfiles(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS model_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    route TEXT NOT NULL,
    model_id TEXT NOT NULL,
    configuration TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated INTEGER NOT NULL
  )`);
}

function requireText(value, valid, message) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!valid.test(text)) throw new HubError(400, message);
  return text;
}

function httpsBase(input) {
  const base = requireText(input, /^https:\/\/[^\s?#]{1,290}$/, "HTTPSベースURLを確認してください。");
  let url;
  try { url = new URL(base); }
  catch { throw new HubError(400, "HTTPSベースURLを確認してください。"); }
  if (url.protocol !== "https:" || url.username || url.password || base.includes("\\"))
    throw new HubError(400, "認証情報を含まないHTTPSのURLを指定してください。");
  return url.href;
}

function targetOf(route, config) {
  if (route === "direct") return providers.get(config.provider).direct;
  if (route === "cloudflare") return "https://gateway.ai.cloudflare.com/v1/" + config.account + "/" + config.gateway + "/" + providers.get(config.provider).gateway;
  if (route === "bedrock") return "Bedrock Runtime · " + config.region + " · Converse";
  return config.base_url;
}

export function checkModelProfile(input) {
  const fields = routes.get(input?.route);
  if (!fields || !input.config || typeof input.config !== "object" || Array.isArray(input.config) ||
      Object.keys(input.config).some(key => !fields.includes(key)) ||
      Object.keys(input).some(key => !["name", "route", "model_id", "config", "id", "revision"].includes(key)))
    throw new HubError(400, "接続方式と設定項目を確認してください。");
  const {route} = input;
  const name = requireText(input.name, /^[^\p{Cc}\p{Cf}]{1,80}$/u, "表示名を1〜80文字で入力してください。");
  const model_id = requireText(input.model_id, /^[-a-zA-Z0-9._/:]{1,300}$/, "モデルまたは推論プロファイルのID・ARNを確認してください。");
  const fieldsIn = input.config;
  const config = {};
  if (route === "direct" || route === "cloudflare") {
    if (!providers.has(fieldsIn.provider)) throw new HubError(400, "プロバイダーを選択してください。");
    config.provider = fieldsIn.provider;
  }
  if (route === "direct" || route === "compatible")
    config.key_ref = requireText(fieldsIn.key_ref, secretRef, "APIキーの参照名を英大文字、数字、アンダースコアで指定してください。");
  if (route === "compatible") config.base_url = httpsBase(fieldsIn.base_url);
  if (route === "cloudflare") {
    config.account = requireText(fieldsIn.account, /^[a-fA-F0-9]{32}$/, "Cloudflare アカウントIDを32桁の16進数で入力してください。").toLowerCase();
    config.gateway = requireText(fieldsIn.gateway, /^[a-z0-9][a-z0-9-]{0,62}$/, "Gateway IDを確認してください。");
    config.token_ref = requireText(fieldsIn.token_ref, secretRef, "Gatewayトークンの参照名を英大文字、数字、アンダースコアで指定してください。");
    config.alias = requireText(fieldsIn.alias, /^[a-zA-Z0-9_.-]{1,128}$/, "BYOKエイリアスを確認してください。");
  }
  if (route === "bedrock") {
    config.region = requireText(fieldsIn.region, /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/, "AWS リージョンを確認してください。");
    config.role = requireText(fieldsIn.role, /^arn:aws(?:-[a-z0-9-]+)?:iam::\d{12}:role\/[a-zA-Z0-9+=,.@_/-]{1,200}$/, "引き受ける IAM ロール ARN を確認してください。");
  }
  return {name, route, model_id, config, target:targetOf(route, config)};
}

export function modelProfiles(db) {
  return db.prepare("SELECT id,name,route,model_id,configuration,revision,updated FROM model_profiles ORDER BY updated DESC, id").all()
    .map(({configuration, ...row}) => {
      const config = JSON.parse(configuration);
      return {...row, config, target:targetOf(row.route, config)};
    });
}

export function saveModelProfile(db, input, operator) {
  const {name, route, model_id, config} = checkModelProfile(input);
  if ((input.id === undefined) !== (input.revision === undefined) ||
      (input.id !== undefined && (typeof input.id !== "string" || !/^[a-f0-9-]{36}$/.test(input.id) || !Number.isSafeInteger(input.revision))))
    throw new HubError(400, "編集する接続設定と版を確認してください。");
  return transaction(db, () => {
    const id = input.id ?? randomUUID();
    const previous = input.id && db.prepare("SELECT route,revision FROM model_profiles WHERE id=?").get(id);
    if (input.id && !previous) throw new HubError(404, "接続設定が見つかりません。");
    if (previous && previous.revision !== input.revision)
      throw new HubError(409, "接続設定が更新されました。一覧を更新して開き直してください。");
    if (db.prepare("SELECT 1 FROM model_profiles WHERE name=? AND id<>?").get(name, id))
      throw new HubError(409, "この表示名の接続設定は登録済みです。");
    const revision = (previous?.revision ?? 0) + 1;
    db.prepare(`INSERT INTO model_profiles(id,name,route,model_id,configuration,revision,updated)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,route=excluded.route,
      model_id=excluded.model_id,configuration=excluded.configuration,revision=excluded.revision,updated=excluded.updated`)
      .run(id, name, route, model_id, JSON.stringify(config), revision, Date.now());
    recordAdminChange(db, {operator, scope:"model", target:id, action:previous ? "connection-profile-edit" : "connection-profile-create",
      before:previous ? `${previous.route} v${previous.revision}` : "", after:`${route} v${revision}`, reason:"モデル接続の下書き"});
    return {id, revision};
  });
}
