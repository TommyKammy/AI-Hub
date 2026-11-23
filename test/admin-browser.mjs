import { adminCredentials } from "./admin-credentials.mjs";
// Mutates the local synthetic workspace: publishes the other fixture model.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_PACKAGE || "@playwright/test",
);
const adminOrigin = "http://127.0.0.1:18733",
  employeePorts = [18731, 18732];
const browser = await chromium.launch({ channel: "chrome" });
try {
  const adminContext = await browser.newContext({
    httpCredentials: adminCredentials(adminOrigin),
  });
  const admin = await adminContext.newPage();
  await admin.goto(adminOrigin);
  await admin.getByRole("link", { name: "管理者画面", exact: true }).click();
  await admin.getByRole("navigation", { name: "管理項目" }).getByRole("link", { name: "モデル設定" }).click();
  await admin.locator("[data-model]").first().waitFor();
  const before = await admin.evaluate(
    async () => await (await fetch("/api/admin/models")).json(),
  );
  const original = before.models.find((m) => m.id === before.current.model);
  const previousTag = original.model_id === "fixture-model" ? "A" : "B";
  const tag = previousTag === "A" ? "B" : "A",
    name = "合成モデル " + tag;
  const target = tag === "B" ? "fixture-model-b" : "fixture-model";
  if (!before.models.some((m) => m.model_id === target)) {
    await admin.getByRole("button", { name: "モデルを登録" }).click();
    await admin.getByLabel("表示名").fill(name);
    await admin
      .getByLabel("提供元・接続先")
      .selectOption(tag === "A" ? "local-a" : "local-b");
    await admin.getByLabel("モデルID").fill(target);
    await admin.getByRole("button", { name: "台帳に登録" }).click();
  }
  const tile = admin
    .locator("[data-model]")
    .filter({ has: admin.getByRole("heading", { name, exact: true }) });
  await tile.getByRole("button", { name: "接続テスト" }).click();
  await tile.getByText("テスト成功", { exact: true }).waitFor();
  await tile.getByText("テスト結果を見る").click();
  assert.match(await tile.innerText(), /12月15日/);
  const pages = await Promise.all(
    employeePorts.map(async (port) => {
      const p = await browser.newPage({
        viewport: { width: port === 18731 ? 1280 : 390, height: 880 },
      });
      await p.goto("http://127.0.0.1:" + port);
      return p;
    }),
  );
  const jobId = (p) => p.url().split("#job/")[1];
  async function start(p, company, label) {
    await p.locator('#workspaceNav a[href="#home"]').click();
    await p.getByLabel("依頼の種類").selectOption("renewal");
    await p
      .getByLabel("依頼内容")
      .fill(company + "の更新商談を準備して（" + label + "）");
    await p.getByRole("button", { name: "送信", exact: true }).click();
    await p.getByLabel("Hermesへの回答").waitFor({ timeout: 60000 });
    return jobId(p);
  }
  async function finish(p, expected, version) {
    await p
      .getByLabel("Hermesへの回答")
      .fill("日付は未確定として先方に確認する。");
    await p.getByRole("button", { name: /回答して作業を続ける/ }).click();
    await p.locator(".doc-body").waitFor({ timeout: 60000 });
    const id = jobId(p);
    const data = await p.evaluate(
      async (id) => await (await fetch("/api/jobs/" + id)).json(),
      id,
    );
    assert.equal(data.model_version, version);
    assert.match(data.question, new RegExp("【モデル" + expected + "】"));
    const calls = await admin.evaluate(async id =>
      (await (await fetch("/api/admin/models/usage?job=" + id)).json()).rows, id);
    const expectedId = expected === "A" ? "fixture-model" : "fixture-model-b";
    for (const phase of ["review", "draft"]) {
      assert.ok(calls.some(c => c.phase === phase && c.outcome === "ok" && c.served === expectedId));
    }
    assert.ok(data.memo.includes("社員の判断"));
    assert.equal(data.status, "done");
    console.log(
      JSON.stringify({
        id,
        model: data.model.model_id,
        version,
        state: data.status,
      }),
    );
  }
  await start(pages[0], "A社", "公開前");
  await tile.getByRole("button", { name: "公開内容を確認" }).click();
  await admin.getByRole("button", { name: "全社員に公開する" }).click();
  await admin.getByText("全社員の標準モデルを変更しました。").waitFor();
  assert.equal(await admin.locator("#standard").textContent(), name);
  await finish(pages[0], previousTag, before.current.version);
  await Promise.all(
    pages.map(async (p, index) => {
      await start(p, index === 0 ? "A社" : "B社", "公開後");
      await finish(p, tag, before.current.version + 1);
    }),
  );
  for (const port of employeePorts) {
    const origin = "http://127.0.0.1:" + port;
    assert.equal((await fetch(origin + "/api/admin/models")).status, 403);
    assert.equal(
      (
        await fetch(origin + "/api/admin/models/legacy/publish", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: '{"base":2}',
        })
      ).status,
      403,
    );
  }
  assert.equal((await fetch(adminOrigin + "/api/admin/models")).status, 401);
  console.log("管理画面の公開、全社員への適用、確認待ちの版固定、権限を確認");
} finally {
  await browser.close();
}
