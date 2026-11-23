// Creates synthetic meeting and weekly jobs using an ordinary employee's browser.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../../", import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const origin = process.env.WORKSPACE_ORIGIN || "http://127.0.0.1:18731";
const browser = await chromium.launch({channel:"chrome"});
try {
  const page = await browser.newPage(), inbox = await browser.newPage();
  page.setDefaultTimeout(20000); inbox.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await Promise.all([page.goto(origin), inbox.goto(origin)]);
  for (const [kind, label, ask, text, expected] of [
    ["meeting", "会議の記録", "欠席した同僚に共有したい。決定事項と宿題を分けて、宿題には担当者と締切を書いて。",
      "青葉会議でシステムの移行日を7月8日に決定した。\n田中が7月3日までに見積書を提出する。",
      ["決定","宿題","田中","7月3日","見積","7月8日"]],
    ["weekly", "週の進捗記録", "部長に送る週報を下書きして。完了・課題・来週の予定の3つに分けて短く書いて。",
      "青葉支店の棚卸しが完了した。\n課題は納品ラベルの不足。\n来週は予備ラベルを発注する予定。",
      ["完了","課題","来週","棚卸","納品ラベル","予備ラベル"]],
    ["general", "参考資料の本文", "説明会の日付が一目で分かる社内向けの告知を書いて。", "社内説明会は8月3日に開催する。", ["8月3日"]],
  ]) {
    await page.goto(origin);
    if (kind === "meeting") {
      await page.locator('#workspaceNav a[href="#jobs"]').click();
      await page.getByRole("button", { name: "新しく依頼", exact: true }).click();
    }
    await page.getByLabel("依頼の種類").selectOption(kind);
    await page.getByLabel("依頼内容", {exact:true}).fill(ask);
    await page.getByText("自分の資料を使う",{exact:true}).click();
    await page.getByLabel(label, {exact:true}).fill(text);
    await page.getByText("今回使う資料を確認",{exact:true}).click();
    assert.equal(await page.locator("[data-preview-minutes]").innerText(), text);
    assert.equal(await page.locator("[data-preview-meeting]").innerText(), "[1] " + label);
    await page.getByRole("button",{name:"送信",exact:true}).click();
    await page.locator('#memoText, #main h2:text-is("要確認")').first().waitFor({timeout:180000});
    assert.equal(await page.locator("#memoText").count(),1,"成果物が表示されませんでした " + page.url());
    const memo = await page.locator("#memoText").innerText();
    expected.forEach(word => assert.ok(memo.includes(word), memo));
    assert.ok(!memo.includes("更新商談"));
    if (kind === "general") assert.doesNotMatch(memo,/AI活用/);
    const job = page.url();
    const jobAsk = page.locator("#main section").filter({has:page.getByRole("heading",{name:"依頼内容",exact:true})}).locator("p").first();
    assert.equal(await jobAsk.innerText(), ask);
    if (process.env.WORKSPACE_SCREENSHOTS && kind !== "general") {
      await page.locator("#memoText").scrollIntoViewIfNeeded();
      await page.screenshot({path: join(process.env.WORKSPACE_SCREENSHOTS, kind + "-memo.png")});
    }
    await page.locator("#memoText").getByRole("button",{name:"出典1を開く",exact:true}).first().click();
    assert.equal(await page.locator("#dlgtitle").innerText(), label);
    assert.equal(await page.locator("#dlgbody .note").textContent(), text);
    await page.getByRole("button",{name:"閉じる",exact:true}).click();
    await inbox.locator("#notifications").click();
    const events = await (await inbox.request.get(origin + "/api/notifications")).json();
    const completed = events.find(event => event.job === job.split("#job/")[1] && event.status === "done");
    assert.ok(completed, "completed job has a notification");
    await inbox.locator('#eventList [data-op="event/' + completed.seq + '"]').click();
    await inbox.waitForURL(job);
    await page.locator('#workspaceNav a[href="#jobs"]').click();
    await page.getByLabel("仕事を検索").fill(expected.at(-1));
    const hit = page.locator('#jobResults [data-op="job/' + job.split("#job/")[1] + '"]');
    await hit.click();
    await page.getByRole("button",{name:"この依頼を再利用"}).click();
    assert.equal(await page.getByLabel("新しい依頼内容").inputValue(), await inbox.locator("#main section").filter({has:inbox.getByRole("heading",{name:"依頼内容",exact:true})}).locator("p").first().innerText());
    assert.equal(await page.locator("#repeat [name=minutes]").inputValue(),"");
    if (kind === "meeting") {
      const dialog = page.locator("#dialog");
      await dialog.getByText("自分の資料を使う",{exact:true}).click();
      await dialog.getByLabel("会議の記録").fill("新しい会議で次回納品を9月6日と決定。宿題は鈴木が手順書を提出。");
      await dialog.getByLabel("引き継ぐ出力形式").fill("決定事項と宿題を箇条書きにする");
      await dialog.getByRole("button",{name:"新しい仕事として依頼"}).click();
      await page.waitForURL(url=>url.hash.startsWith("#job/") && url.href!==job);
      await page.locator("#memoText").waitFor({timeout:180000});
      const nextMemo = await page.locator("#memoText").innerText();
      assert.match(nextMemo,/9月6日/);
      assert.doesNotMatch(nextMemo,/7月8日/);
      assert.doesNotMatch(nextMemo,/締切[：:は\s]*9月6日|9月6日までに.*提出/);
    } else await page.getByRole("button",{name:"閉じる",exact:true}).click();
    console.log(kind, job);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
