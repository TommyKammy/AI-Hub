import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { adminHeader } from "../../support/admin-credentials.mjs";

const live = process.argv.includes("--live");
const firstPort = live ? 18731 : 18831;
const ownerHost = `http://127.0.0.1:${firstPort}`;
const deskHost = `http://127.0.0.1:${firstPort + 1}`;
const adminHost = `http://127.0.0.1:${firstPort + 2}`;
const model = live ? "qwen3.8-flash-next" : "fixture-model";
const browser = await chromium.launch({channel:"chrome"});

async function post(page, path, data, extraHeaders = {}) {
  return page.request.post(path, {data, headers:{Origin:new URL(path).origin, ...extraHeaders}});
}

async function screenshot(browser, code) {
  const page = await browser.newPage({viewport:{width:720,height:350}});
  try {
    await page.setContent(`<main style="font:25px Arial;color:#192030;padding:28px">
      <h1 style="font-size:34px">Synthetic expense portal</h1>
      <p style="border:2px solid #9c1717;color:#8a1515;padding:15px;font-size:34px">Upload failed</p>
      <p>Error code: <strong>${code}</strong></p>
    </main>`);
    return await page.screenshot();
  } finally { await page.close(); }
}

async function paste(target, image) {
  await target.evaluate((element, bytes) => {
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([Uint8Array.from(bytes)], "synthetic-error.png", {type:"image/png"}));
    element.dispatchEvent(new ClipboardEvent("paste", {bubbles:true,cancelable:true,clipboardData}));
  }, Array.from(image));
}

try {
  const owner = await browser.newPage({viewport:{width:390,height:844}});
  const desk = await browser.newPage({viewport:{width:1280,height:940}});
  const admin = await browser.newPage({extraHTTPHeaders:{Authorization:adminHeader(adminHost)}});
  const catalog = await (await admin.request.get(adminHost+"/api/admin/models")).json();
  assert.equal(catalog.models.find(entry => entry.id === catalog.current.model)?.model_id, model);
  const job = await post(owner, ownerHost+"/api/jobs", {kind:"general",company:"A社",
    ask:"合成検証。架空の経費申請で窓口に確認する内容を1文でまとめてください。",skip_profile:true},
    {"Idempotency-Key":randomUUID()});
  assert.ok(job.ok(), await job.text());
  const {id} = await job.json(), jobApi = ownerHost+"/api/jobs/"+id;
  console.log("synthetic job", id, model);
  await owner.goto(ownerHost+"/#job/"+id);
  await owner.getByRole("button", {name:"問い合わせの起票案を作る"}).click({timeout:150000});
  await owner.getByRole("button", {name:"起票案を確認",exact:true}).click({timeout:150000});
  const dialog = owner.getByRole("dialog");
  const body = dialog.getByLabel("本文", {exact:true});
  const image = dialog.getByRole("img", {name:"選択したスクリーンショット"});
  const analyze = dialog.getByRole("button", {name:"画像から下書きを作る"});
  const filePicker = dialog.getByLabel("画像を選択・差し替え");
  const steps = "利用者の追記。申請内容を入力してからアップロードを1回押しました。";
  await dialog.getByLabel("ご自身が行った操作（任意）").fill(steps);
  await paste(body, await screenshot(browser, "OLD-IMAGE-137"));
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(720);
  const initial = await image.getAttribute("src");
  await filePicker.setInputFiles({name:"bad.svg",mimeType:"image/svg+xml",buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')});
  await expect(dialog.getByRole("status")).toContainText("PNGまたはJPEG");
  await filePicker.setInputFiles({name:"big.png",mimeType:"image/png",buffer:Buffer.alloc(4*1024*1024+1)});
  await expect(dialog.getByRole("status")).toContainText("4 MB以下");
  assert.equal(await image.getAttribute("src"), initial);
  await dialog.getByRole("button", {name:"画像を取り除く"}).click();
  await expect(image).toHaveCount(0);
  await paste(body, await screenshot(browser, "OLD-IMAGE-238"));
  await expect(image).toBeVisible();
  const beforeReplacement = await image.getAttribute("src");
  const code = "SYN-IMAGE-947", png = await screenshot(browser, code);
  await paste(body, png);
  await expect.poll(() => image.getAttribute("src")).not.toBe(beforeReplacement);
  assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
    document.querySelector("dialog").scrollWidth <= document.querySelector("dialog").clientWidth));

  const draft = (await (await owner.request.get(jobApi)).json()).inquiries[0];
  const imagePath = jobApi+"/inquiry/"+draft.version+"/screenshot";
  const rejected = await post(desk, imagePath.replace(ownerHost, deskHost), png, {"Content-Type":"image/png"});
  assert.equal(rejected.status(),404);
  assert.equal((await post(owner, imagePath, Buffer.from("fake SVG"), {"Content-Type":"image/svg+xml"})).status(),415);
  assert.equal((await post(owner, imagePath, Buffer.alloc(4*1024*1024+1), {"Content-Type":"image/png"})).status(),413);
  if (live) assert.equal((await post(owner, imagePath, Buffer.from("fake PNG"), {"Content-Type":"image/png"})).status(),400);
  const status = dialog.getByRole("status");
  await analyze.click();
  const findings = dialog.getByLabel("画像から読み取った表示");
  if (live) {
    await expect(findings).toBeVisible({timeout:130000});
    assert.match(await findings.inputValue(),new RegExp(code));
    assert.doesNotMatch(await findings.inputValue(), /OLD-IMAGE|利用者の追記|アップロードを1回/);
    console.log("live screenshot findings", await findings.inputValue());
    const early = await post(owner, jobApi+"/inquiry/register", {version:draft.version,desk:"operations",recipient:"tanaka",
      subject:"合成画像のテスト",body:await findings.inputValue(),attachments:[]});
    assert.equal(early.status(),409);
  } else {
    await expect(status).toContainText("現在のモデルでは画像を読み取れません");
    await expect(findings).toBeHidden();
  }
  const subject = `合成検証 ${id.slice(0,8)}`;
  const deskInbox = async () => (await (await desk.request.get(deskHost+"/api/workspace")).json()).received_inquiries;
  await dialog.getByLabel("担当窓口").selectOption("operations");
  await dialog.getByLabel("件名", {exact:true}).fill(subject);
  await body.fill("画面にアップロードエラーが出たため、手順を確認してください。");
  await dialog.getByRole("button", {name:"登録内容を確認"}).click();
  const preview = dialog.locator("[data-ticket-preview]");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("【ご自身が行った操作】");
  await expect(preview).toContainText(steps);
  if (live) {
    await expect(preview).toContainText("【画像から読み取った表示】");
    await expect(preview).toContainText(code);
  }
  assert.ok(!(await deskInbox()).some(ticket => ticket.subject === subject));
  await dialog.getByRole("button", {name:"編集に戻る"}).click();
  await expect(dialog.getByLabel("ご自身が行った操作（任意）")).toHaveValue(steps);
  await expect(image).toBeVisible();
  if (live) await expect(findings).toHaveValue(new RegExp(code));
  await dialog.getByRole("button", {name:"登録内容を確認"}).click();
  await dialog.getByRole("button", {name:"この内容で起票"}).click();
  await owner.waitForURL("**/#inquiry/*");
  const ticketId = Number(owner.url().split("#inquiry/")[1]);
  assert.ok((await deskInbox()).some(ticket => ticket.subject === subject && ticket.id === ticketId));
  const receipt = await (await desk.request.get(deskHost+"/api/inquiries/"+ticketId)).json();
  assert.deepEqual(receipt.attachments,[]);
  assert.match(receipt.body,/【ご自身が行った操作】\n利用者の追記/);
  if (live) assert.match(receipt.body,new RegExp("【画像から読み取った表示】[\\s\\S]*"+code));
  const log = await (await admin.request.get(adminHost+"/api/admin/models/usage?job="+id)).json();
  const calls = log.rows.filter(call => call.phase === "inquiry-screenshot");
  assert.deepEqual(calls.map(({served,outcome}) => ({served,outcome})), live ? [{served:model,outcome:"ok"}] : []);
  console.log(live ? "live screenshot receipt" : "text fallback receipt", ticketId, id);
} finally { await browser.close(); }
