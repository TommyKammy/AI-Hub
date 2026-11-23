import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { validAdminId } from "../src/http/admin-auth.mjs";

import { adminActor } from "../src/fixtures.mjs";

const requested = process.argv.slice(2);
if (!requested.every(validAdminId)) throw Error("管理者IDは小文字英字で始まる48文字以内の英数字・ピリオド・ハイフン・アンダースコアで指定してください。admin は予約済みです。");
const dir = new URL("../.runtime/", import.meta.url);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const keys = ["SATO", "TANAKA"].map(
  (id) => id + "_KEY=" + randomBytes(32).toString("hex"),
);
try {
  writeFileSync(new URL("local.env", dir), keys.join("\n") + "\n", {
    flag: "wx",
    mode: 0o600,
  });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}

const accounts = new URL("admin-accounts/", dir);
const firstSetup = mkdirSync(accounts, { mode: 0o700, recursive: true }) !== undefined;
const ids = firstSetup && !requested.length ? ["aoki", "mori"] : requested;
for (const id of ids) {
  try {
    writeFileSync(new URL(id, accounts), randomBytes(32).toString("base64url") + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

// Create the initial role assignments once; running setup again preserves local assignments.
const roles = {};
if (existsSync(new URL("aoki", accounts))) roles.aoki = "manager";
if (existsSync(new URL("mori", accounts))) roles.mori = "auditor";
try {
  writeFileSync(new URL(".roles.json", accounts), JSON.stringify(roles, null, 2) + "\n", { flag: "wx", mode: 0o600 });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}

// Extend the existing Compose project with one private Hermes runtime per login.
const hub = { environment: {}, networks: {}, depends_on: {} };
const overlay = { services: { hub }, networks: {}, volumes: {} };
const runtimeKeys = new URL("hermes-keys/", dir);
mkdirSync(runtimeKeys, { recursive: true, mode: 0o700 });
for (const account of readdirSync(accounts).filter(id => !id.startsWith("."))) {
  if (!validAdminId(account)) throw Error("管理者IDの設定を確認してください。");
  // Account IDs can contain punctuation. Use a stable DNS-safe service name.
  const service = "hermes-" + createHash("sha256").update(account).digest("hex").slice(0, 20);
  const keyFile = new URL(account, runtimeKeys);
  try {
    writeFileSync(keyFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const key = readFileSync(keyFile, "utf8").trim();
  const prefix = adminActor(account).toUpperCase();
  hub.environment[prefix + "_URL"] = "http://" + service + ":8642";
  hub.environment[prefix + "_RECEIPTS_URL"] = "http://" + service + "-receipts:8643";
  hub.environment[prefix + "_KEY"] = key;
  hub.environment[prefix + "_GATEWAY_HOST"] = "hub-" + service;
  hub.networks[service] = { aliases: ["hub-" + service] };
  hub.depends_on[service] = { condition: "service_healthy" };
  overlay.services[service] = {
    extends: { file: "infra/compose.hermes.yaml", service: "hermes" },
    environment: { API_SERVER_KEY: key },
    volumes: [service + ":/opt/data"],
    networks: [service],
  };
  overlay.networks[service] = { internal: true };
  overlay.services[service + "-receipts"] = {
    extends: { file: "infra/compose.receipts.yaml", service: "reader" },
    environment: { API_SERVER_KEY: key },
    volumes: [service + ":/store:ro"],
    networks: [service],
  };
  overlay.volumes[service] = {};
}
const temporary = new URL("admin-workspaces-" + process.pid + ".tmp", dir);
writeFileSync(temporary, JSON.stringify(overlay, null, 2), { mode: 0o600, flag: "wx" });
renameSync(temporary, new URL("admin-workspaces.json", dir));
const localEnv = new URL("local.env", dir);
if (!/^COMPOSE_FILE=/m.test(readFileSync(localEnv, "utf8"))) {
  appendFileSync(localEnv, "\nCOMPOSE_FILE=compose.yaml:.runtime/admin-workspaces.json\n");
}
