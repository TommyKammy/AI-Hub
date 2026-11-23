import { adminHeader } from "./admin-credentials.mjs";
// Run only against the dedicated membership Compose project and its disposable employee accounts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = createRequire(new URL("../", import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const project = "ai-hub-hermes-membership";
const docker = ["--context", "colima-mac-studio-solo"];
const ports = { sato: 18831, tanaka: 18832, admin: 18833 };
const base = actor => "http://127.0.0.1:" + ports[actor];
assert.match(execFileSync("docker", [...docker, "port", project + "-hub-1", "18833/tcp"], { encoding: "utf8" }), /127\.0\.0\.1:18833/);
const company = { sato: "A社", tanaka: "B社" };
const local = process.argv.includes("--mlx");
const model = local ? "qwen3.8-flash-next" : "fixture-model";
const satoAnswer = "更新日は未確定とし、次回商談で購買部の承認日を確認する。";
const tanakaAnswer = "4月15日は先方の希望日として扱い、次回の調達部との調整で確認する。";

async function api(actor, path, body, expected) {
  const headers = { Origin: base(actor), "Content-Type": "application/json", "Idempotency-Key": randomUUID() };
  if (actor === "admin") headers.Authorization = adminHeader(base("admin"));
  const res = await fetch(base(actor) + "/api/" + path, {
    headers, method: body ? "POST" : "GET", body: body && JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  const data = await res.json();
  assert.ok(expected ? res.status === expected : res.ok, path + " " + res.status + " " + (data.error || ""));
  return data;
}
async function waitJob(actor, id, status) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const job = await api(actor, "jobs/" + id);
    if (job.status === status) return job;
    assert.ok(["queued", "dispatching", "running"].includes(job.status), job.status);
    await delay(250);
  }
  throw Error("依頼のタイムアウト " + id);
}
async function selectModel() {
  const path = "admin/models", catalog = await api("admin", path);
  const selected = catalog.models.find(m => m.model_id === model) ?? await api("admin", path, {
    name: "Qwen ローカル", connection: "local-mlx", model_id: model, data_class: "合成資料",
  });
  if (selected.id === catalog.current.model) return;
  assert.equal((await api("admin", path + "/" + selected.id + "/test", {})).state, "passed");
  await api("admin", path + "/" + selected.id + "/publish", { base: catalog.current.version, reason: "社員管理の検証" });
}
async function sharedProcedure() {
  const existing = (await api("sato", "workspace")).procedures.find(p => p.layout === "meeting");
  if (existing) return existing;
  const { id } = await api("sato", "jobs", { ask: "更新商談を準備して", company: company.sato });
  await waitJob("sato", id, "waiting");
  await api("sato", "jobs/" + id + "/answer", { answer: satoAnswer });
  await waitJob("sato", id, "done");
  const p = await api("sato", "jobs/" + id + "/draft", { layout: "meeting" });
  await api("sato", "jobs/" + id + "/submit-draft", { hash: p.hash });
  await api("admin", "admin/procedures/" + p.id + "/publish", { hash: p.hash });
  return p;
}
async function records(actor, id) {
  const script = `import json,sqlite3,sys
db=sqlite3.connect("file:/opt/data/runs_idempotency.db?mode=ro",uri=True)
print(json.dumps(db.execute("select idempotency_key,run_id from run_idempotency where idempotency_key in (?,?) order by idempotency_key",(sys.argv[1]+"-review",sys.argv[1]+"-draft")).fetchall()))`;
  const receipts = JSON.parse(execFileSync("docker", [...docker, "exec", project + "-" + actor + "-1", "python", "-c", script, id]));
  const path = "admin/models/usage?job=" + id;
  const deadline = Date.now() + 120000;
  let log = await api("admin", path);
  while (log.rows.some(c => c.outcome === "sending") && Date.now() < deadline) {
    await delay(250);
    log = await api("admin", path);
  }
  assert.equal(log.next, null);
  assert.ok(log.rows.length && log.rows.every(c => c.served === model && c.outcome === "ok"));
  return { receipts, calls: log.rows.map(c => ({ id: c.call_id, phase: c.phase, model: c.served })) };
}

async function select(browser, actor, p) {
  const page = await browser.newPage();
  await page.goto(base(actor) + "/#skills");
  await page.locator('[data-op="use/' + p.id + '"]').click();
  return page;
}
async function start(browser, actor, p) {
  const page = await select(browser, actor, p);
  await page.getByRole("button", { name: "この手順で依頼する" }).click();
  await page.getByLabel("Hermesへの回答").waitFor({ timeout: 180000 });
  const id = page.url().split("#job/")[1];
  const j = await api(actor, "jobs/" + id);
  assert.equal(j.status, "waiting");
  assert.equal(j.skill_hash, p.hash);
  assert.equal(j.procedure_id, p.id);
  return { page, id };
}


export { api, base, chromium, company, model, project, records, select, selectModel, sharedProcedure, start, satoAnswer, tanakaAnswer };
