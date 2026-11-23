import { adminCredentials } from "../../support/admin-credentials.mjs";
// Local acceptance scenario. Leaves the previous standard restored and the
// emergency-stopped model disabled. Requires two distinct eligible releases.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const { chromium } = createRequire(new URL("../../", import.meta.url))(
  process.env.PLAYWRIGHT_PACKAGE || "@playwright/test",
);
const origin = "http://127.0.0.1:18733";
const browser = await chromium.launch({ channel: "chrome" });
function receipts(model) {
  const service = model.connection === "local-a" ? "model" : "model-b";
  const args = [
    "--context",
    process.env.AI_HUB_DOCKER_CONTEXT || "colima-mac-studio-solo",
    "logs",
    "ai-hub-hermes-local-" + service + "-1",
  ];
  return execFileSync("docker", args, { encoding: "utf8" })
    .split("\n")
    .filter((s) => s.startsWith('{"served_model"'))
    .map((s) => JSON.parse(s));
}
try {
  const admin = await browser.newPage({
    httpCredentials: adminCredentials(origin),
  });
  await admin.goto(origin);
  await admin.getByRole("link", { name: "管理者画面", exact: true }).click();
  const adminAreas = admin.getByRole("navigation", { name: "管理項目" });
  await adminAreas.getByRole("link", { name: "モデル設定" }).click();
  await admin.locator("[data-model]").first().waitFor();
  const read = (path) =>
    admin.evaluate(
      async (path) => (await fetch("/api/admin/models" + path)).json(),
      path,
    );
  const initial = await read("");
  const old = initial.models.find((m) => m.id === initial.current.model),
    restore = initial.models.find((m) => m.id === initial.previous?.model);
  assert.ok(
    restore && !restore.stopped && !old.stopped && old.id !== restore.id,
    "先に二つの有効なモデルを別の版として公開してください。",
  );
  const employee = await browser.newPage();
  await employee.goto("http://127.0.0.1:18731");
  async function start(p, title) {
    await p.getByLabel("依頼の種類").selectOption("renewal");
    await p.getByLabel("依頼内容").fill(title);
    await p.getByRole("button", { name: "送信", exact: true }).click();
    await p.getByLabel("Hermesへの回答").waitFor({ timeout: 60000 });
    return p.url().split("#job/")[1];
  }
  const heldId = await start(
    employee,
    "A社の更新商談を準備して（緊急停止の確認）",
  );
  const baseline = receipts(old);
  assert.ok(baseline.some((r) => r.job === heldId && r.phase === "review"));
  const card = admin.locator('[data-model="' + old.id + '"]');
  await card.getByRole("button", { name: "緊急停止", exact: true }).click();
  await admin
    .getByLabel("変更理由")
    .fill("工程3検証：提供元への新規送信を一時停止");
  await admin.getByRole("button", { name: "緊急停止を確定" }).click();
  await card.getByRole("button", { name: "停止を解除" }).waitFor();
  assert.equal(
    await card.getByRole("button", { name: "接続テスト" }).isDisabled(),
    true,
  );
  await employee
    .getByLabel("Hermesへの回答")
    .fill("日付は未確定。先方へ確認する。");
  await employee.getByRole("button", { name: /回答して作業を続ける/ }).click();
  await employee
    .getByRole("heading", { name: "モデル停止による保留" })
    .waitFor();
  assert.deepEqual(receipts(old), baseline);
  await adminAreas.getByRole("link", { name: "モデル利用記録" }).click();
  await admin.getByLabel("依頼ID").fill(heldId);
  await admin.getByRole("button", { name: "絞り込む" }).click();
  await admin
    .locator("#usageRows")
    .getByText(/メモ作成 · 送信前に停止/)
    .waitFor();
  const denied = await read("/usage?job=" + heldId);
  assert.equal(denied.rows.filter((r) => r.phase === "draft").length, 1);
  assert.equal(denied.rows[0].outcome, "blocked");
  assert.equal(denied.rows[0].served, null);
  await adminAreas.getByRole("link", { name: "モデル設定" }).click();
  await admin
    .getByRole("button", { name: "直前の標準設定に戻す", exact: true })
    .click();
  await admin.getByLabel("変更理由").fill("工程3検証：直前の稼働設定を復元");
  await admin.getByRole("button", { name: "復元を確定" }).click();
  await admin
    .locator("#standard")
    .getByText(restore.name, { exact: true })
    .waitFor();
  const current = await read("");
  assert.equal(current.current.model, restore.id);
  assert.equal(current.current.version, initial.current.version + 1);
  assert.equal(current.models.find((m) => m.id === old.id).stopped, 1);
  await adminAreas.getByRole("link", { name: "モデル利用記録" }).click();
  await admin.getByText("モデル設定の変更履歴", { exact: true }).click();
  await admin
    .locator("#changeRows")
    .getByText(/標準設定を復元/)
    .first()
    .waitFor();
  const fresh = await browser.newPage({
    viewport: { width: 390, height: 840 },
  });
  await fresh.goto("http://127.0.0.1:18732");
  const job = await start(fresh, "B社の更新商談を準備して（復元後）");
  await fresh
    .getByLabel("Hermesへの回答")
    .fill("日付は未確定として先方に確認する。");
  await fresh.getByRole("button", { name: /回答して作業を続ける/ }).click();
  await fresh.locator(".doc-body").waitFor({ timeout: 60000 });
  await admin.getByLabel("依頼ID").fill(job);
  await admin.getByRole("button", { name: "絞り込む" }).click();
  await admin
    .locator("#usageRows")
    .getByText(/メモ作成 · 応答完了/)
    .first()
    .waitFor();
  const history = (await read("/changes")).rows;
  assert.deepEqual(
    history.slice(0, 2).map((x) => x.action),
    ["restore", "stop"],
  );
  assert.equal(history[0].source_version, initial.previous.version);
  assert.equal(history[0].actor, "aoki");
  const accepted = (await read("/usage?job=" + job)).rows,
    provider = receipts(restore).filter((r) => r.job === job);
  assert.ok(
    accepted.some((r) => r.phase === "draft") &&
      accepted.some((r) => r.phase === "review"),
  );
  assert.deepEqual(
    accepted.map((r) => r.call_id).sort(),
    provider.map((r) => r.call_id).sort(),
  );
  for (const r of accepted) {
    const match = provider.find((x) => x.call_id === r.call_id);
    assert.equal(r.outcome, "ok");
    assert.equal(r.served, match.served_model);
    assert.equal(r.served, restore.model_id);
    assert.equal(r.version, current.current.version);
    assert.equal(r.phase, match.phase);
    assert.equal(r.total_tokens, 2);
  }
  assert.deepEqual(receipts(old), baseline);
  assert.equal(
    (await fetch("http://127.0.0.1:18731/api/admin/models/usage")).status,
    403,
  );
  console.log(
    JSON.stringify(
      {
        heldId,
        old: old.name,
        unchangedReceipts: baseline.length,
        afterStop: 0,
        restored: current.current,
        job,
        providerRequests: provider.length,
        history: history.slice(0, 2),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
