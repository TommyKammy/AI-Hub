// Exercises the ordinary employee UI and leaves one synthetic renewal job in the selected stack.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const port = process.argv.includes("--compare") ? 18831 : 18731;
const origin = "http://127.0.0.1:" + port;
const minutes = "先方は1月22日の更新を希望。\n次回は青葉支店の調達責任者が同席する。";
const answer = "1月22日は希望日として扱い、青葉支店と正式な日程を確認する。";
const attach = process.argv.includes("--attach");
const browser = await chromium.launch({ channel: "chrome" });
try {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(origin);
  await page.getByLabel("依頼の種類").selectOption("renewal");
  await page.getByText("自分の資料を使う", { exact: true }).click();
  await page.getByLabel("議事録の本文").focus();
  await page.evaluate(text => navigator.clipboard.writeText(text), minutes);
  await page.keyboard.press("ControlOrMeta+v");
  assert.equal(await page.getByLabel("議事録の本文").inputValue(), minutes);
  await page.getByText("今回使う資料を確認", { exact: true }).click();
  assert.equal(await page.locator("[data-preview-minutes]").innerText(), minutes);
  if (attach) {
    const file = page.getByLabel("契約書を添付");
    const word = execFileSync("python3", ["-c", `import io,sys,zipfile
buf=io.BytesIO()
with zipfile.ZipFile(buf,"w") as z:
 z.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 z.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第七条　契約満了日は2月28日。</w:t></w:r></w:p></w:body></w:document>')
sys.stdout.buffer.write(buf.getvalue())`]);
    await file.setInputFiles({name:"契約条件.docx", mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer:word});
    await page.getByText("契約条件.docx を読み込みました。", {exact:true}).waitFor();
    assert.match(await page.locator("[data-preview-contract]").innerText(), /第七条/);
    await page.getByRole("button", {name:"添付を外す"}).click();
    assert.match(await page.locator("[data-preview-contract]").innerText(), /12月31日/);
    const printable = await context.newPage();
    await printable.setContent('<html lang="ja"><p>第七条　契約満了日は2月28日。</p></html>');
    const pdf = await printable.pdf();
    await printable.close();
    await file.setInputFiles({name:"更新契約.pdf", mimeType:"application/pdf", buffer:pdf});
    await page.getByText("更新契約.pdf を読み込みました。", {exact:true}).waitFor();
    assert.match(await page.locator("[data-preview-contract]").innerText(), /2月28日/);
  }
  await page.getByLabel("依頼内容").fill("A社の契約台帳と今回の議事録で更新商談を準備して");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await page.getByLabel("Hermesへの回答").waitFor({ timeout: 180000 });
  const jobURL = page.url(), id = jobURL.split("#job/")[1];
  let responder = page;
  if (attach) {
    responder = await context.newPage();
    await responder.goto(origin + "/#skills");
    await responder.locator("#notifications").click();
    const waiting = responder.locator("#eventList button").filter({hasText:"確認待ち"}).first();
    await waiting.click(); await responder.waitForURL(jobURL);
  }
  await responder.getByLabel("Hermesへの回答").fill(answer);
  await responder.getByRole("button", { name: "回答して作業を続ける" }).click();
  if (responder !== page) { await responder.locator("#memoText").waitFor({timeout:180000}); await responder.close(); await page.reload(); }
  const memo = page.locator("#memoText");
  await memo.waitFor({ timeout: 180000 });
  const initial = await memo.innerText();
  assert.match(initial, /1月22日/);
  assert.match(initial, /青葉支店/);
  if (attach) { assert.match(initial, /2月28日/); assert.doesNotMatch(initial, /12月31日/); }
  assert.doesNotMatch(initial, /12月15日/);
  await memo.getByRole("button", { name: "出典2を開く" }).first().click();
  assert.equal(await page.locator("#dlgbody .note").textContent(), minutes);
  if (attach) {
    assert.ok((await page.locator("#dialog mark").first().innerText()).includes("1月22日"));
    await page.locator("#dialog").getByRole("button",{name:"資料を並べて比較"}).click();
    assert.equal(await page.locator(".source-columns section").count(),2);
    assert.match(await page.locator(".source-columns mark").innerText(), /1月22日/);
    assert.match(await page.locator(".source-columns").innerText(),/2月28日/);
    assert.match(await page.locator(".source-columns").innerText(),/1月22日/);
  }
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await page.getByLabel("修正内容").fill("上司向けに3行にして。契約、先方希望、対応方針を各1行とし、見出しや空行は省く。");
  await page.getByRole("button", { name: "修正を依頼する" }).click();
  const versions = page.getByLabel("表示する版");
  await versions.waitFor({ timeout: 180000 });
  assert.equal(await versions.inputValue(), "2");
  const revised = await memo.innerText();
  assert.notEqual(initial, revised);
  assert.equal(revised.trim().split(/\n+/).length, 3, revised);
  assert.match(revised, /1月22日/);
  assert.match(revised, /\[1\]/);
  assert.match(revised, /\[2\]/);
  assert.equal(page.url(), jobURL);
  await page.reload();
  await versions.selectOption("1");
  assert.equal(await memo.innerText(), initial);
  await page.setViewportSize({ width: 390, height: 844 });
  await versions.selectOption("2");
  await page.getByRole("button", { name: "出典付きでコピー" }).click();
  await page.getByText("出典付きでコピーしました。", { exact: true }).waitFor();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  if (process.env.MEMO_SCREENSHOT) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await memo.scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.MEMO_SCREENSHOT });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  const firstRef = attach ? "更新契約.pdf（添付時の本文）" : "A社 契約台帳（11月10日版・更新条件 §2）";
  assert.equal(clipboard, revised + "\n\n出典\n[1] " + firstRef + "\n[2] 貼り付けた議事録（依頼時の原文）");
  if (attach) {
    await page.getByText("第1版と見比べる", {exact:true}).click();
    assert.equal(await page.locator(".previous-memo .note").innerText(), initial);
    const download = page.waitForEvent("download");
    await page.getByRole("button", {name:"Markdownで保存"}).click();
    assert.equal(await readFile(await (await download).path(), "utf8"), "# A社 更新商談メモ（第2版）\n\n" + clipboard + "\n");
    await page.getByLabel("このメモについて質問").fill("1月22日の根拠は？");
    await page.getByRole("button", {name:"質問する",exact:true}).click();
    await page.locator(".memo-questions article .citation").first().waitFor({timeout:180000});
    assert.match(await page.locator(".memo-questions article .note").innerText(), /1月22日.*|先方は/);
    assert.equal(await memo.innerText(), revised);
    await versions.selectOption("1");
    await page.getByRole("button", {name:"この版を採用"}).click();
    await page.getByText("表示中の版を採用しました。").waitFor();
    await page.reload();
    await page.locator("#memoVersion").waitFor();
    assert.equal(await versions.inputValue(), "1");
    assert.equal(await memo.innerText(), initial);
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const other = await context.request.get("http://127.0.0.1:" + (port + 1) + "/api/jobs/" + id);
  assert.equal(other.status(), 404);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ jobURL, revised, clipboardMatches: true }));
} finally {
  await browser.close();
}
