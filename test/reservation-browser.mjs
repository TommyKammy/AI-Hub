// Use the dedicated stack so a restart only affects this workflow.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const {chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const docker = (...args) => execFileSync("docker", ["--context","colima-mac-studio-solo", ...args], {encoding:"utf8"});
const hub = "ai-hub-daily-work-hub-1", base = "http://127.0.0.1:18831";
assert.match(docker("port",hub,"18831/tcp"), /127\.0\.0\.1:18831/);
const browser = await chromium.launch({channel:"chrome"});
try {
  const page = await browser.newPage({timezoneId:"America/New_York"});
  const tag = String(Date.now());
  const notes = "青葉支店は棚卸しを完了。来週は予備ラベルを発注する。";
  const when = minutes => new Date(Date.now()+minutes*60000+9*3600000).toISOString().slice(0,16);
  async function reserve() {
    await page.goto(base);
    await page.getByRole("button",{name:"依頼の設定"}).click();
    await page.getByLabel("依頼の種類").selectOption("weekly");
    await page.getByLabel("依頼内容",{exact:true}).fill("予約週報 " + tag);
    await page.getByText("資料の本文を貼り付ける",{exact:true}).click();
    await page.getByLabel("週の進捗記録").fill(notes);
    await page.getByLabel("実行のタイミング").selectOption("once");
    await page.getByLabel("実行予定日時（日本時間）").fill(when(6));
    await page.getByRole("button",{name:"送信",exact:true}).dblclick();
    await page.getByRole("heading",{name:"実行予約済み"}).waitFor();
    return page.url().split("#job/")[1];
  }
  const cancelled = await reserve();
  await page.getByRole("button",{name:"依頼を取り消す"}).click();
  await page.getByRole("heading",{name:"依頼を取り消しました"}).waitFor();
  const id = await reserve();
  await page.goto(base+"/#work/actions");
  await page.getByRole("heading",{name:"今日の実行予約"}).waitFor();
  await page.locator('[data-op="job/'+id+'"]').first().click();
  await page.getByRole("button",{name:"予約日時を変更"}).click();
  await page.getByLabel("実行予定日時（日本時間）").fill(when(1));
  await page.getByRole("button",{name:"変更を保存"}).click();
  await page.locator("#dialog").waitFor({state:"hidden"});
  docker("restart",hub);
  await page.waitForFunction(async () => {
    try { return (await fetch("/api/workspace")).ok; } catch { return false; }
  }, null, {timeout:30000});
  await page.locator("#memoText").waitFor({timeout:180000});
  assert.equal(page.url(),base+"/#job/"+id);
  await page.locator("#notifications").click();
  await page.locator("#eventList button").filter({hasText:"仕事が完了"}).filter({hasText:tag}).first().click();
  assert.equal(page.url(),base+"/#job/"+id);
  await page.locator("#memoText .citation").first().click();
  assert.ok((await page.locator("#dialog").innerText()).includes(notes));
  for (const [job, expected] of [[id,1],[cancelled,0]]) {
    const count = docker("exec","ai-hub-daily-work-sato-1","python","-c",
      "import sqlite3,sys; print(sqlite3.connect('file:/opt/data/runs_idempotency.db?mode=ro',uri=True).execute('select count(*) from run_idempotency where idempotency_key=?',(sys.argv[1],)).fetchone()[0])",job+"-compose");
    assert.equal(Number(count),expected);
  }
  console.log(JSON.stringify({completed:id,cancelled,completedRuns:1,cancelledRuns:0}));
} finally { await browser.close(); }
