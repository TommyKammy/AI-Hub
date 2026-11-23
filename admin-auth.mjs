import { createHash, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function validAdminId(id) {
  return typeof id === "string" && id !== "admin" && /^[a-z][a-z0-9._-]{0,47}$/.test(id);
}

const digest = value => createHash("sha256").update(value).digest();

export function loadAdminAuth(directory) {
  let roles = {};
  try {
    roles = JSON.parse(readFileSync(join(directory, ".roles.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!roles || typeof roles !== "object" || Array.isArray(roles) ||
      !Object.entries(roles).every(([id, role]) => validAdminId(id) && ["manager", "auditor"].includes(role)))
    throw Error("管理者の権限設定を確認してください。");
  const accounts = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isFile() || !validAdminId(entry.name)) throw Error("管理者IDの設定を確認してください。");
    const password = readFileSync(join(directory, entry.name), "utf8").trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw Error("管理者パスワードの初期化が必要です。");
    const token = Buffer.from(entry.name + ":" + password).toString("base64");
    const role = Object.hasOwn(roles, entry.name) ? roles[entry.name] : "auditor";
    accounts.push({ principal: Object.freeze({ account: entry.name, role }), hash: digest(token) });
  }
  if (!accounts.length) throw Error("個人別の管理者アカウントを初期化してください。");
  function authenticate(authorization) {
    const match = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(authorization ?? "");
    if (!match) return null;
    const hash = digest(match[1]);
    return accounts.find(account => timingSafeEqual(hash, account.hash))?.principal ?? null;
  }
  return { authenticate, accountIds: accounts.map(({ principal }) => principal.account),
    accountRoles: Object.fromEntries(accounts.map(({ principal }) => [principal.account, principal.role])) };
}
