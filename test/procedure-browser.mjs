import { adminCredentials } from "./admin-credentials.mjs";
// Creates a draft, a publication and two synthetic jobs in the selected local stack.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { sourcesFor } from "../fixtures.mjs";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const port = process.argv.includes("--local") ? 18731 : 18831;
const origins = [0, 1, 2].map(n => "http://127.0.0.1:" + (port + n));
const suffix = randomUUID().slice(0, 8);
const aAnswer = "購買部の確認を待つ。佐藤専用の照合番号は青葉-" + suffix + "。";
const bAnswer = "更新日は未確定とし、次回は調達部と確認する。田中の照合番号は白樺-" + suffix + "。";
const excluded = ["A社", "12月31日", "12月15日", "毎月報告", "購買部", "青葉-", aAnswer, ...sourcesFor("sato", "A社").map(s => s.version)];
const isolated = text => excluded.forEach(term => assert.ok(!text.includes(term), term));
const browser = await chromium.launch({ channel: "chrome" });
try {
  const sato = await browser.newPage(), tanaka = await browser.newPage();
  const admin = await browser.newPage({ httpCredentials: adminCredentials(origins[2]) });
  await Promise.all([sato, tanaka, admin].map((p,i) => p.goto(origins[i])));
  await admin.getByRole("link", { name: "管理者画面", exact: true }).click();
  const json = (p, path) => p.evaluate(async url => (await fetch(url)).json(), path);
  async function finish(page, answer) {
    await page.getByLabel("Hermesへの回答").fill(answer, { timeout: 120000 });
    await page.getByRole("button", { name: "回答して作業を続ける" }).click();
    await page.locator("#main .doc-body").waitFor({ timeout: 120000 });
    const id = page.url().split("#job/")[1];
    return json(page, "/api/jobs/" + id);
  }
  await sato.getByLabel("依頼の種類").selectOption("renewal");
  await sato.getByLabel("依頼内容").fill("A社の更新商談を準備して");
  await sato.getByRole("button", { name: "送信", exact: true }).click();
  const a = await finish(sato, aAnswer);
  assert.ok(a.memo.includes(aAnswer));
  await sato.getByRole("button", { name: "手順の草案を作る" }).click();
  await sato.getByLabel("メモの並び順").selectOption("meeting");
  await sato.getByRole("button", { name: "個人の草案に保存" }).click();
  await sato.getByRole("button", { name: "管理者に公開を申請する" }).waitFor();
  const draft = (await json(sato, "/api/jobs/" + a.id)).draft;
  const before = async () => assert.ok(!(await json(tanaka, "/api/workspace")).procedures.some(p => p.id === draft.id));
  await before();
  assert.ok(!(await json(admin, "/api/admin/procedures")).some(p => p.id === draft.id));
  await sato.getByRole("button", { name: "管理者に公開を申請する" }).click();
  await sato.getByRole("button", { name: "申請中の手順を確認" }).waitFor();
  await before();
  await admin.getByRole("link", { name: "手順の公開" }).click();
  await admin.locator('[data-procedure="' + draft.id + '"]').click();
  const reviewed = await admin.locator("#dialogContent .doc-body").textContent();
  assert.equal(reviewed, draft.instruction);
  isolated(reviewed);
  await admin.getByRole("button", { name: "確認した手順を公開する" }).click();
  await admin.locator("#dialog").waitFor({ state: "hidden" });
  await tanaka.locator('#workspaceNav a[href="#catalog"]').click();
  await tanaka.locator('[data-op="use/' + draft.id + '"]').click();
  assert.equal(await tanaka.getByLabel("対象案件").inputValue(), "B社");
  const p = (await json(tanaka, "/api/workspace")).procedures.find(p => p.id === draft.id);
  assert.equal(p.hash, draft.hash);
  isolated(JSON.stringify(p));
  assert.ok(!("source_job" in p || "author" in p));
  await tanaka.getByRole("button", { name: "この手順で依頼する" }).click();
  const b = await finish(tanaka, bAnswer);
  assert.equal(b.procedure_id, draft.id);
  assert.equal(b.skill_hash, draft.hash);
  assert.deepEqual(b.sources, sourcesFor("tanaka", "B社"));
  isolated(JSON.stringify(b));
  assert.ok(b.question.includes("3月31日") && b.question.includes("4月15日"));
  assert.ok(b.memo.includes(bAnswer));
  assert.ok(b.memo.indexOf("[2]") >= 0 && b.memo.indexOf("[2]") < b.memo.indexOf("[1]"));
  for (const source of b.sources) {
    for (const sentence of source.text.match(/[^。]+。/g)) {
      assert.ok(b.memo.includes(sentence + " [" + source.id + "]"), sentence);
    }
    await tanaka.getByRole("button", { name: "[" + source.id + "] " + source.title }).click();
    assert.equal(await tanaka.locator("#dlgbody .note").textContent(), source.text);
    assert.equal(await tanaka.locator("#dlgbody .meta").textContent(), source.version);
    await tanaka.getByRole("button", { name: "閉じる" }).click();
  }
  assert.equal(await tanaka.evaluate(async id => (await fetch("/api/jobs/" + id)).status, a.id), 404);
  console.log(JSON.stringify({ model: b.model.model_id, source: a.id, reused: b.id, procedure: p.id,
    hash: p.hash, version: p.version, name: p.name, question: b.question, memo: b.memo }, null, 2));
} finally {
  await browser.close();
}
