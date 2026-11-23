import { adminHeader } from "./admin-credentials.mjs";
// Only the isolated Compose project publishes these evaluation ports.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const admin = "http://127.0.0.1:18833";
const employee = "http://127.0.0.1:18831";
const modelId = "qwen3.8-flash-next";
const input = { company: "A社", ask: "A社の更新商談を準備して。契約条件と先方への確認事項をまとめてください。" };
const answer = "更新日は未確定とし、12月15日は先方の希望日として扱う。次回商談で購買部の承認日を確認する。";
const output = new URL("../.runtime/compare-" + Date.now() + ".json", import.meta.url);
const report = { started: new Date().toISOString(), input, answer, runs: [] };

async function api(base, path, body, headers = {}) {
  if (base === admin) headers.Authorization = adminHeader(admin);
  const response = await fetch(base + path, {
    redirect: "error",
    method: body ? "POST" : "GET",
    headers: { Origin: base, "Content-Type": "application/json", ...headers },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(270_000),
  });
  const value = await response.json();
  assert.ok(response.ok, path + " " + response.status + " " + (value.error || ""));
  return value;
}

const models = "/api/admin/models";
async function waitJob(path, status) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const job = await api(employee, path);
    if (job.status === status) return job;
    assert.ok(["queued", "running", "dispatching"].includes(job.status), path + " " + job.status);
    await delay(100);
  }
  throw Error(path + " timed out");
}

let catalog = await api(admin, models);
const local = catalog.models.find(m => m.connection === "local-mlx" && m.model_id === modelId)
  ?? await api(admin, models, { name: "Qwen ローカル", connection: "local-mlx", model_id: modelId, data_class: "合成資料" });
for (const id of ["legacy", local.id]) {
  const probe = await api(admin, models + "/" + id + "/test", {});
  assert.equal(probe.state, "passed", JSON.stringify(probe.result));
}
for (let round = 1; round <= 3; round++) {
  const order = round % 2 ? ["legacy", local.id] : [local.id, "legacy"];
  for (const id of order) {
    if (catalog.current.model !== id) {
      catalog = await api(admin, models + "/" + id + "/publish", {
        base: catalog.current.version, reason: "工程4 同一案件の比較",
      });
    }
    const start = performance.now();
    const { id: jobId } = await api(employee, "/api/jobs", input, { "Idempotency-Key": randomUUID() });
    const path = "/api/jobs/" + jobId;
    const question = await waitJob(path, "waiting");
    const reviewMs = Math.round(performance.now() - start);
    const answered = performance.now();
    await api(employee, path + "/answer", { answer });
    const job = await waitJob(path, "done");
    const draftMs = Math.round(performance.now() - answered);
    // Hermes can finish the employee response while an auxiliary call is still open.
    const usagePath = models + "/usage?job=" + jobId;
    let usage = await api(admin, usagePath);
    const deadline = Date.now() + 125_000;
    while (usage.rows.some(row => row.outcome === "sending") && Date.now() < deadline) {
      await delay(100);
      usage = await api(admin, usagePath);
    }
    const { rows, next } = usage;
    assert.equal(next, null);
    for (const phase of ["review", "draft"])
      assert.ok(rows.some(row => row.phase === phase));
    const expected = id === "legacy" ? "fixture-model" : modelId;
    assert.ok(rows.every(row => row.requested === expected && row.served === expected && row.outcome === "ok"), JSON.stringify(rows));
    assert.equal(job.answer, answer);
    report.runs.push({ round, job: jobId, model: expected, version: job.model_version,
      skill: job.skill_hash, sources: job.sources, question: question.question, memo: job.memo,
      reviewMs, draftMs, calls: rows });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(round, expected, reviewMs, draftMs, output.pathname);
  }
}
