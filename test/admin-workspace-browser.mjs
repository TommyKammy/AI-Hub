// Runs two synthetic jobs on the local stack, one per authenticated admin.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { adminCredentials } from "./admin-credentials.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const origin = "http://127.0.0.1:18733";
const browser = await chromium.launch({ channel: "chrome" });
async function useWorkspace(username, width) {
  const page = await browser.newPage({
    httpCredentials: adminCredentials(origin, username),
    viewport: { width, height: 850 },
  });
  await page.goto(origin);
  await page.locator("#request").waitFor();
  assert.equal(await page.locator("#employee").textContent(), username);
  async function openWorkspaceMenu() {
    const menu = page.locator("#workspaceMenu");
    if (await menu.isVisible() && await menu.getAttribute("aria-expanded") === "false") await menu.click();
  }
  await openWorkspaceMenu();
  const admin = page.getByRole("navigation", { name: "管理者メニュー" });
  await admin.getByRole("link", { name: "管理者画面" }).click();
  await page.getByText(username, { exact: true }).first().waitFor();
  assert.equal(await page.locator("#adminRole").textContent(), username === "aoki" ? "管理者" : "閲覧専用管理者");
  await page.getByRole("region", { name: "ダッシュボード", exact: true }).waitFor();
  const models = page.getByRole("navigation", { name: "管理項目" }).getByRole("link", { name: "モデル設定" });
  if (username === "aoki") {
    await models.click();
    await page.getByRole("button", { name: "モデルを登録" }).waitFor();
  } else assert.equal(await models.count(), 0);
  await page.getByRole("link", { name: "AI Hub に戻る" }).click();
  await openWorkspaceMenu();
  await page.locator('#workspaceNav a[href="#catalog"]').click();
  await page.locator("#catalogSearch").waitFor();
  await openWorkspaceMenu();
  await page.locator('#workspaceNav a[href="#home"]').click();
  await page.getByRole("button", { name: "依頼の設定" }).click();
  await page.getByLabel("依頼の種類").selectOption("renewal");
  await page.getByLabel("依頼内容").fill("A社の更新商談を準備して（管理者ワークスペースの確認）");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  const answer = username + " は更新日を未確定として先方に確認する。";
  await page.getByLabel("Hermesへの回答").fill(answer, { timeout: 150000 });
  await page.getByRole("button", { name: "回答して作業を続ける" }).click();
  await page.locator(".doc-body").waitFor({ timeout: 150000 });
  assert.ok((await page.locator(".doc-body").textContent()).includes(answer));
  const id = page.url().split("#job/")[1];
  await openWorkspaceMenu();
  await page.locator('#workspaceNav a[href="#jobs"]').click();
  await page.locator('[data-op="job/' + id + '"]').waitFor();
  return { page, id };
}
try {
  const employee = await browser.newPage({ viewport: { width: 390, height: 850 } });
  await employee.goto("http://127.0.0.1:18731");
  await employee.getByLabel("依頼内容").waitFor();
  assert.equal(await employee.getByRole("link", { name: "管理者画面" }).count(), 0);
  for (const path of ["/admin.html", "/api/admin/session"]) {
    assert.equal((await employee.request.get("http://127.0.0.1:18731" + path)).status(), 403);
    assert.equal((await fetch(origin + path)).status, 401);
  }
  const [manager, auditor] = await Promise.all([useWorkspace("aoki", 1280), useWorkspace("mori", 390)]);
  for (const [viewer, id] of [[manager.page, auditor.id], [auditor.page, manager.id], [employee, manager.id]]) {
    assert.equal(await viewer.locator('[data-op="job/' + id + '"]').count(), 0);
    assert.equal(await viewer.evaluate(async id => (await fetch("/api/jobs/" + id)).status, id), 404);
  }
  console.log("管理操作・閲覧専用のホーム、管理画面の往復、Hermes 依頼完了、個人別の履歴とアクセス制御を確認");
} finally {
  await browser.close();
}
