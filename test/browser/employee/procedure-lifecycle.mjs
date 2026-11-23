import { adminCredentials, adminHeader } from "../../support/admin-credentials.mjs";
// Use a new procedure so the previously shared employee procedure stays available.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const { chromium } = createRequire(new URL("../../", import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const local = process.argv.includes("--local");
const port = local ? 18731 : 18831;
const base = i => "http://127.0.0.1:" + (port + i);
const project = "ai-hub-hermes-" + (local ? "local" : "compare");

async function api(i, path, payload, expected) {
  const headers = { Origin: base(i), "Content-Type": "application/json", "Idempotency-Key": randomUUID() };
  if (i === 2) headers.Authorization = adminHeader(base(2));
  const res = await fetch(base(i) + "/api/" + path, { headers, method: payload ? "POST" : "GET", body: payload && JSON.stringify(payload) });
  const data = await res.json();
  if (expected) assert.equal(res.status, expected, path);
  else assert.ok(res.ok, path + " " + JSON.stringify(data));
  return data;
}
async function waitFor(i, id, status) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const j = await api(i, "jobs/" + id);
    if (j.status === status) return j;
    assert.ok(["queued", "dispatching", "running"].includes(j.status), j.status);
    await delay(200);
  }
  throw Error("状態更新のタイムアウト " + id);
}

function receipts(id) {
  const script = `import sqlite3,sys,json
d=sqlite3.connect("file:/opt/data/runs_idempotency.db?mode=ro",uri=True)
print(json.dumps(d.execute("select idempotency_key,run_id from run_idempotency where idempotency_key in (?,?) order by idempotency_key",(sys.argv[1]+"-review",sys.argv[1]+"-draft")).fetchall()))`;
  const args = ["--context", "colima-mac-studio-solo", "exec", project + "-tanaka-1", "python", "-c", script, id];
  return JSON.parse(execFileSync("docker", args, { encoding: "utf8" }));
}
async function usage(id) {
  const { rows } = await api(2, "admin/models/usage?job=" + id);
  return rows.map(c => ({ phase: c.phase, id: c.call_id, model: c.requested }));
}
const browser = await chromium.launch({ channel: "chrome" });
try {
  const aj = (await api(0, "jobs", { ask: "手順の版管理を検証するため更新商談を準備して", company: "A社" })).id;
  await waitFor(0, aj, "waiting");
  await api(0, "jobs/" + aj + "/answer", { answer: "更新日は未確定とし、次回購買部に確認する。" });
  await waitFor(0, aj, "done");
  const p = await api(0, "jobs/" + aj + "/draft", { layout: "meeting" });
  await api(0, "jobs/" + aj + "/submit-draft", { hash: p.hash });
  await api(2, "admin/procedures/" + p.id + "/publish", { hash: p.hash });
  const admin = await browser.newPage({ httpCredentials: adminCredentials(base(2)) });
  await admin.goto(base(2) + "/#procedures");
  const jobs = new Map();
  async function start(version) {
    const page = await browser.newPage();
    await page.goto(base(1) + "/#skills");
    await page.locator('[data-op="use/' + p.id + '"]').click();
    assert.match(await page.locator("#dlgbody").textContent(), new RegExp("公開版 v" + version));
    await page.getByRole("button", { name: "この手順で依頼する" }).click();
    await page.getByLabel("Hermesへの回答").waitFor({ timeout: 120000 });
    const id = page.url().split("#job/")[1];
    jobs.set(id, page);
    assert.equal((await api(1, "jobs/" + id)).skill_version, version);
    return id;
  }
  const answer = "4月15日は希望日とし、更新日は未確定。次回の調達部との調整で確認する。";
  async function finish(id, version, hash, first) {
    const page = jobs.get(id);
    await page.getByLabel("Hermesへの回答").fill(answer);
    await page.getByRole("button", { name: "回答して作業を続ける" }).click();
    await page.locator("#main .doc-body").waitFor({ timeout: 120000 });
    const j = await api(1, "jobs/" + id);
    assert.equal(j.status, "done");
    assert.equal(j.skill_hash, hash);
    assert.equal(j.skill_version, version);
    assert.equal(j.memo.match(/\[[12]\]/)?.[0], first);
    assert.ok(j.memo.includes(answer));
    assert.equal(receipts(id).length, 2);
    return { id, version, hash, memo: j.memo, model: j.model.model_id };
  }
  const oldJob = await start(1), oldWaiting = await start(1);
  await admin.locator('[data-revise="' + p.id + '"]').click();
  await admin.getByRole("button", { name: "新版を公開する" }).click();
  await admin.locator("#dialog").waitFor({ state: "hidden" });
  const v2 = (await api(1, "workspace")).procedures.find(r => r.id === p.id);
  assert.equal(v2.version, 2);
  assert.notEqual(v2.hash, p.hash);
  const old = await finish(oldJob, 1, p.hash, "[2]");
  const fresh = await finish(await start(2), 2, v2.hash, "[1]");
  const newWaiting = await start(2), waiting = [oldWaiting, newWaiting];
  await delay(1800);
  const before = await Promise.all(waiting.map(async id => ({ receipts: receipts(id), calls: await usage(id) })));
  await admin.locator('[data-revoke="' + p.id + '"]').click();
  await admin.getByRole("button", { name: "公開取消を確定する" }).click();
  await admin.locator("#dialog").waitFor({ state: "hidden" });
  assert.ok(!(await api(1, "workspace")).procedures.some(r => r.id === p.id));
  const denied = await api(1, "jobs", { ask: "再利用", company: "B社", procedure_id: p.id }, 423);
  for (const id of waiting) {
    const page = jobs.get(id);
    // Submit the already-open question, including the stale pre-revocation button.
    await page.getByLabel("Hermesへの回答").fill(answer);
    await page.locator("#answer button").click();
    await page.getByRole("heading", { name: "手順の公開取消により停止" }).waitFor();
    const j = await api(1, "jobs/" + id);
    assert.equal(j.answer, answer);
    assert.equal(j.memo, null);
    assert.equal(j.status, "procedure_revoked");
    await api(1, "jobs/" + id + "/resume", {}, 423);
  }
  await delay(1800);
  const blocked = [];
  for (const [i,id] of waiting.entries()) {
    const after = { receipts: receipts(id), calls: await usage(id) };
    assert.equal(before[i].receipts.length, 1);
    assert.equal(before[i].receipts[0][0], id + "-review");
    assert.ok(before[i].calls.length > 0 && before[i].calls.every(c => c.phase === "review"));
    assert.deepEqual(after, before[i]);
    blocked.push({ id, version: i + 1, runsBefore: before[i].receipts.length, runsAfter: after.receipts.length,
      modelCallsBefore: before[i].calls.length, modelCallsAfter: after.calls.length });
  }
  for (const j of [old, fresh]) assert.equal((await api(1, "jobs/" + j.id)).memo, j.memo);
  console.log(JSON.stringify({ project, procedure: p.id, old, fresh, denied, blocked }, null, 2));
} finally { await browser.close(); }
