// Run against a local AI Hub stack with the standard employee fixtures and admin accounts.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { adminCredentials, adminHeader } from "./admin-credentials.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const sato = "http://127.0.0.1:" + (process.env.SATO_PORT || 18731);
const tanaka = "http://127.0.0.1:" + (process.env.TANAKA_PORT || 18732);
const admin = "http://127.0.0.1:" + (process.env.ADMIN_PORT || 18733);
const browser = await chromium.launch({
  channel: "chrome",
  ignoreDefaultArgs: ["--disable-back-forward-cache"],
});

async function apiStatus(client, origin, path, expected, headers) {
  const response = await client.get(origin + path, { headers });
  assert.equal(response.status(), expected, path);
  return response;
}

async function waitForLogin(page) {
  await page.waitForURL(url => url.pathname === "/login");
  await page.getByRole("heading", { name: "アカウントを選択", exact: true }).waitFor();
  assert.equal(await page.locator("#employee, #adminAccount").count(), 0);
}

async function currentCookie(context, origin) {
  const name = "ai_hub_session_" + new URL(admin).port;
  const cookie = (await context.cookies(origin)).find(cookie => cookie.name === name);
  assert.ok(cookie?.httpOnly, "セッション Cookie は HttpOnly");
  return { Cookie: `${cookie.name}=${cookie.value}` };
}

async function logout(page) {
  await page.locator("#accountTrigger").click();
  await page.getByRole("menuitem", { name: "ログアウト", exact: true }).click();
  await waitForLogin(page);
}

async function deniedWithRevokedCookie(origin, path, cookie) {
  const response = await fetch(origin + path, { headers: cookie });
  assert.equal(response.status, 401, path);
}

async function checkBackAndReload(page) {
  await page.goBack();
  await waitForLogin(page);
  await page.reload();
  await waitForLogin(page);
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);

  await page.goto(sato);
  await page.locator("#employee").filter({ hasText: "佐藤 由衣" }).waitFor();
  await page.getByRole("link", { name: "依頼一覧", exact: true }).click();
  await page.waitForURL(url => url.hash === "#jobs");
  await logout(page);
  await checkBackAndReload(page);
  await apiStatus(context.request, sato, "/api/workspace", 401);
  await page.getByRole("button", { name: "佐藤 由衣" }).click();
  await page.locator("#employee").filter({ hasText: "佐藤 由衣" }).waitFor();
  const satoWorkspace = await apiStatus(context.request, sato, "/api/workspace", 200);
  const satoData = await satoWorkspace.json();
  assert.equal(satoData.employee.actor, "sato");
  const priorJob = satoData.jobs.find(job => job.id);
  const satoCookie = await currentCookie(context, sato);

  await page.locator("#accountTrigger").click();
  await page.getByRole("menuitem", { name: "Hermesが覚えていること", exact: true }).click();
  const memory = page.getByRole("dialog", { name: "Hermesが覚えていること" });
  await memory.waitFor();
  await memory.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.getByRole("link", { name: "依頼一覧", exact: true }).click();
  await page.waitForURL(url => url.hash === "#jobs");
  await logout(page);
  await checkBackAndReload(page);
  await deniedWithRevokedCookie(sato, "/api/workspace", satoCookie);
  if (priorJob) await deniedWithRevokedCookie(sato, "/api/jobs/" + priorJob.id, satoCookie);
  console.log("社員画面で Hermes の記憶とログアウトを確認し、戻る操作・再読み込み・失効済み Cookie を検証");

  await page.getByRole("button", { name: "田中 翔" }).click();
  await page.locator("#employee").filter({ hasText: "田中 翔" }).waitFor();
  const tanakaWorkspace = await apiStatus(context.request, tanaka, "/api/workspace", 200);
  assert.equal((await tanakaWorkspace.json()).employee.actor, "tanaka");
  await apiStatus(context.request, sato, "/api/workspace", 403);
  await apiStatus(context.request, admin, "/api/admin/session", 403);
  if (priorJob) {
    await apiStatus(context.request, tanaka, "/api/jobs/" + priorJob.id, 404);
    console.log("佐藤の既存依頼を田中から取得すると HTTP 404");
  }
  await page.goto(sato + "/#jobs");
  await page.waitForURL(url => url.origin === tanaka);
  await page.locator("#employee").filter({ hasText: "田中 翔" }).waitFor();
  await logout(page);
  console.log("同じブラウザで田中に切り替え、旧ポートと管理 API を拒否し、画面でも田中のセッションを確認");

  await page.setViewportSize({ width: 390, height: 850 });
  await page.goto(admin + "/admin.html#models-heading");
  await waitForLogin(page);
  const signIn = page.getByRole("button", { name: "管理者としてログイン" });
  await page.getByLabel("アカウント", { exact: true }).fill("aoki");
  await page.getByLabel("パスワード", { exact: true }).fill("invalid-local-browser-test-password");
  const failedLogin = page.waitForResponse(response => new URL(response.url()).pathname === "/api/session/login");
  await signIn.click();
  const rejected = await failedLogin;
  assert.equal(rejected.status(), 401);
  assert.equal(await rejected.headerValue("www-authenticate"), null);
  await waitForLogin(page);

  await page.getByLabel("アカウント", { exact: true }).fill("aoki");
  await page.getByLabel("パスワード", { exact: true }).fill(adminCredentials(admin).password);
  await signIn.click();
  await page.waitForURL(url => url.origin === admin && url.pathname === "/");
  await page.locator("#employee").filter({ hasText: /^aoki$/ }).waitFor();
  const workspaceMenu = page.locator("#workspaceMenu");
  if (await workspaceMenu.isVisible() && await workspaceMenu.getAttribute("aria-expanded") === "false") await workspaceMenu.click();
  await page.getByRole("link", { name: "管理者画面", exact: true }).click();
  await page.locator("#adminAccount").filter({ hasText: /^aoki$/ }).waitFor();
  assert.equal(await page.locator("#adminRole").textContent(), "管理者");
  await apiStatus(context.request, admin, "/api/admin/session", 200);
  const adminCookie = await currentCookie(context, admin);
  const accountTrigger = page.locator("#accountTrigger");
  const logoutButton = page.getByRole("menuitem", { name: "ログアウト", exact: true });
  await accountTrigger.focus();
  await page.keyboard.press("Enter");
  await logoutButton.waitFor();
  await page.waitForFunction(() => document.activeElement?.matches("#accountMenu [data-account-action]"));
  await page.keyboard.press("Escape");
  await logoutButton.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.id === "accountTrigger");
  await page.locator("#groupsTitle").click();
  await page.waitForURL(url => url.hash === "#groups");
  await page.locator("#directoryRows .panel").first().waitFor();
  await logout(page);
  await checkBackAndReload(page);
  await deniedWithRevokedCookie(admin, "/api/admin/session", adminCookie);
  await deniedWithRevokedCookie(admin, "/api/admin/models", adminCookie);
  await apiStatus(context.request, admin, "/api/admin/session", 401, { Authorization: adminHeader(admin) });
  await page.goto(admin + "/admin.html#models-heading");
  await waitForLogin(page);
  console.log("モバイル幅で管理者の誤認証・ログイン・ログアウト、メニューの Enter・Escape、戻る・再読み込み、旧 Cookie と Basic 認証を検証");
} finally {
  await browser.close();
}
