import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const { chromium } = createRequire(new URL("../../", import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const directory = await mkdtemp(join(tmpdir(), "ai-hub-standard-procedures-"));
const accounts = join(directory, "accounts");
const password = randomBytes(24).toString("hex");
const endpoint = "/api/admin/standard-procedures";
let child, browser;

async function reservePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

function assertFits(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
    .then((fits) => assert.ok(fits, "page must fit its viewport"));
}

try {
  await mkdir(accounts, { mode: 0o700 });
  for (const name of ["aoki", "mori"]) await writeFile(join(accounts, name), password, { mode: 0o600 });
  await writeFile(join(accounts, ".roles.json"), JSON.stringify({ aoki: "manager", mori: "auditor" }), { mode: 0o600 });
  const reserved = await Promise.all(Array.from({ length: 3 }, reservePort));
  const [satoPort, tanakaPort, adminPort] = reserved.map((server) => server.address().port);
  await Promise.all(reserved.map((server) => new Promise((resolve) => server.close(resolve))));
  const admin = "http://127.0.0.1:" + adminPort;
  const employee = "http://127.0.0.1:" + satoPort;
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("../../../", import.meta.url),
    env: {
      PATH: process.env.PATH, DATA_DIR: directory, ADMIN_ACCOUNTS_DIR: accounts,
      LIBRARY_ROOT: join(directory, "libraries"), SATO_PORT: String(satoPort),
      TANAKA_PORT: String(tanakaPort), ADMIN_PORT: String(adminPort),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.resume();
  let ready = false;
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    if (await fetch(admin).then((response) => response.status === 401).catch(() => false)) {
      ready = true;
      break;
    }
    await delay(50);
  }
  assert.ok(ready, "isolated Hub startup");

  browser = await chromium.launch({ channel: "chrome" });
  const manager = await browser.newPage({ httpCredentials: { username: "aoki", password }, viewport: { width: 1440, height: 850 } });
  await manager.goto(admin + "/admin.html#procedures");
  const edit = manager.locator("[data-standard-procedure]");
  await edit.nth(4).waitFor();
  assert.equal(await edit.count(), 5);
  await manager.getByRole("heading", { name: "チーム共有の手順" }).waitFor();
  await assertFits(manager);

  const baseline = await manager.evaluate(async (path) => (await fetch(path)).json(), endpoint);
  const staff = await browser.newPage({ viewport: { width: 390, height: 844 } });
  async function scheduleRenewal() {
    const response = await staff.request.post(employee + "/api/jobs", {
      headers: { Origin: employee, "Idempotency-Key": randomUUID() },
      data: { company: "A社", kind: "renewal", ask: "更新商談を準備して", scheduled_at: Date.now() + 86400000 },
    });
    assert.ok(response.ok(), await response.text());
    return (await response.json()).id;
  }
  const originalRenewal = baseline.find((item) => item.kind === "renewal");
  const originalJob = await scheduleRenewal();
  const stale = await browser.newPage({ httpCredentials: { username: "aoki", password } });
  await stale.goto(admin + "/admin.html#procedures");
  await stale.getByRole("button", { name: baseline[0].name + "を編集", exact: true }).click();
  const staleDraft = stale.locator("#editStandardProcedure");
  await staleDraft.getByLabel("手順名（必須）").fill("編集中の手順名");
  await staleDraft.getByLabel("変更理由（必須）").fill("同時編集の確認");
  const published = [];
  const status = manager.locator("#standardProcedureStatus");
  const dialog = manager.getByRole("dialog", { name: "会社標準の手順を編集" });
  const form = manager.locator("#editStandardProcedure");
  for (const [index, current] of baseline.entries()) {
    await manager.getByRole("button", { name: current.name + "を編集", exact: true }).click();
    await dialog.waitFor();
    assert.equal(await form.locator("[name=instruction]").inputValue(), current.instruction);
    const next = {
      ...current,
      version: current.version + 1,
      name: current.name + " 検証版",
      source: "検証資料 " + index,
      output: "検証成果物 " + index,
      example: "検証例 " + index,
      instruction: current.instruction + "\n\n## 検証用の追記\n確認事項 " + index,
    };
    for (const field of ["name", "source", "output", "example", "instruction"]) {
      await form.locator("[name=" + field + "]").fill(next[field]);
    }
    await form.getByLabel("変更理由（必須）").fill("隔離環境で管理画面の操作を検証");
    await form.getByRole("button", { name: "新版を公開する" }).click();
    await status.getByText(next.name + "の第" + next.version + "版を公開しました。").waitFor();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await manager.evaluate(() => document.activeElement.dataset.standardProcedure), next.id);
    published.push(next);
  }

  await staleDraft.getByRole("button", { name: "新版を公開する" }).click();
  await stale.getByRole("alert").getByText("公開版を更新", { exact: false }).waitFor();
  assert.equal(await staleDraft.getByLabel("手順名（必須）").inputValue(), "編集中の手順名");
  await stale.keyboard.press("Escape");
  await stale.getByRole("button", { name: "公開版を更新", exact: true }).click();
  await stale.getByRole("button", { name: published[0].name + "を編集", exact: true }).waitFor();

  await manager.setViewportSize({ width: 390, height: 844 });
  await manager.reload();
  for (const item of published) {
    const trigger = manager.getByRole("button", { name: item.name + "を編集", exact: true });
    await trigger.click();
    for (const field of ["name", "source", "output", "example", "instruction"]) {
      assert.equal(await form.locator("[name=" + field + "]").inputValue(), item[field]);
    }
    await assertFits(manager);
    assert.ok(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth));
    await manager.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }
  await manager.getByRole("button", { name: published[0].name + "を編集", exact: true }).click();
  await form.getByLabel("変更理由（必須）").fill("同じ内容を確認");
  await form.getByRole("button", { name: "新版を公開する" }).click();
  await status.getByText("変更はありません。現在は第" + published[0].version + "版です。").waitFor();

  await staff.goto(employee + "/#catalog");
  for (const item of published) {
    await staff.locator(".catalog-row").filter({ hasText: item.name }).click();
    const itemDialog = staff.getByRole("dialog", { name: item.name, exact: true });
    for (const content of [item.source, item.output, item.example]) await itemDialog.getByText(content, { exact: true }).waitFor();
    await itemDialog.getByText("会社標準 ・ " + item.scope + " ・ v" + item.version, { exact: true }).waitFor();
    await staff.keyboard.press("Escape");
  }
  await assertFits(staff);
  await staff.goto(employee + "/#home");
  await staff.getByRole("button", { name: "依頼の設定" }).click();
  const renewal = published.find((item) => item.kind === "renewal");
  assert.equal(await staff.locator('#request [name=kind] option[value=renewal]').textContent(), renewal.name);
  await staff.getByLabel("依頼の種類").selectOption("renewal");
  assert.equal(await staff.getByLabel("依頼内容").inputValue(), renewal.example);
  const newJob = await scheduleRenewal();
  for (const [job, procedure] of [[originalJob, originalRenewal], [newJob, renewal]]) {
    await staff.goto(employee + "/#job/" + job);
    await staff.getByText("この仕事の記録と操作", { exact: true }).click();
    await staff.locator("#jobRecord .info").getByText("手順　" + procedure.name + " v" + procedure.version, { exact: false }).waitFor();
  }

  const auditor = await browser.newPage({ httpCredentials: { username: "mori", password }, viewport: { width: 390, height: 844 } });
  await auditor.goto(admin + "/admin.html#procedures");
  await auditor.getByRole("region", { name: "ダッシュボード", exact: true }).waitFor();
  assert.equal(await auditor.getByRole("link", { name: "手順の公開", exact: true }).count(), 0);
  for (const [page, origin] of [[auditor, admin], [staff, employee]]) {
    const auth = page === auditor ? { Authorization: "Basic " + Buffer.from("mori:" + password).toString("base64") } : {};
    assert.equal((await page.request.get(origin + endpoint, { headers: auth })).status(), 403);
    assert.equal((await page.request.post(origin + endpoint + "/" + renewal.id, {
      headers: { ...auth, Origin: origin }, data: { base: renewal.version, name: "権限外の更新" },
    })).status(), 403);
  }

  console.log("会社標準手順5件の編集・公開、同時編集の保護、同内容の再保存、管理画面再読込、社員表示、予約時の版表示、権限制御、モバイル幅を確認");
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
