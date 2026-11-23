import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const project = "ai-hub-memory-check";
// Run the normal comparison Compose overlay under this dedicated project name.
const ownerPort = Number(process.env.MEMORY_CHECK_PORT || 18831);
const otherPort = ownerPort + 1;
const docker = (...args) => execFileSync("docker", ["--context","colima-mac-studio-solo",...args], {encoding:"utf8"}).trim();
for (const port of [ownerPort,otherPort]) assert.equal(docker("port", project+"-hub-1", port+"/tcp"), "127.0.0.1:"+port);
const savedProfile = actor => docker("exec", project+"-"+actor+"-1", "sh", "-c",
  "if test -f /opt/data/memories/USER.md; then cat /opt/data/memories/USER.md; fi");
const browser = await chromium.launch({channel:"chrome"});
const question = "この規程で、備品購入の申請期限はいつですか？";
const rule = "第1条　申請には社内ポータルを使う。\n第2条　備品購入の申請期限は毎月20日です。";
const preference = "次回から結論を先に書いて";

async function submit(port, ask, attachment, capture) {
  const base = "http://127.0.0.1:"+port;
  const page = await browser.newPage();
  try {
    await page.goto(base);
    const form = page.locator("#request");
    await form.getByLabel("依頼内容").fill(ask);
    if (attachment) {
      await form.locator("summary",{hasText:"自分の資料を使う"}).click();
      await form.locator("[type=file]").setInputFiles({name:"備品規程.txt", mimeType:"text/plain", buffer:Buffer.from(rule)});
      await form.getByText("備品規程.txt を読み込みました。").waitFor();
    }
    await form.getByRole("button",{name:"送信",exact:true}).click();
    await page.waitForURL("**/#job/*");
    const id = page.url().split("#job/")[1];
    const memo = page.locator("#memoText");
    await memo.waitFor({timeout:180000});
    await page.reload();
    const body = await memo.innerText();
    const job = await (await page.request.get(base+"/api/jobs/"+id)).json();
    assert.ok(job.run_id);
    console.log(job.model.model_id, capture, id, body);
    if (attachment) {
      assert.match(body,/20日/);
      assert.match(body,/\[1\]/);
      assert.equal(job.work_tool.tool,"read_passages");
    }
    if (process.env.CAPTURE_WORK) {
      await memo.scrollIntoViewIfNeeded();
      await page.screenshot({path:"evidence/profile-"+capture+".png"});
    }
    return body;
  } finally { await page.close(); }
}

try {
  const other = savedProfile("tanaka");
  assert.doesNotMatch(other,/結論/);
  assert.match(await submit(ownerPort, preference, false, "saved"),/保存しました/);
  assert.match(savedProfile("sato"),/結論/);
  const first = await submit(ownerPort, question, true, "owner");
  assert.match(first,/^[\s#*【]*結論/);
  const control = await submit(otherPort, question, true, "other");
  assert.doesNotMatch(control,/^[\s#*【]*結論/);
  assert.equal(savedProfile("tanaka"), other);
} finally { await browser.close(); }
