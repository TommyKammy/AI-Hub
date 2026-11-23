import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { openHub } from "../../../src/jobs/hub.mjs";

const native = process.argv.includes("--native");
const dir = await mkdtemp(join(tmpdir(), "ai-hub-answer-speech-"));
const first = "第一版です。";
const second = "第二版です。今日は端末の音声で回答を読み上げています。最後まで読み上げます。";
let hubProcess, browser;
try {
  const hub = openHub(join(dir, "hub.sqlite"));
  let id;
  try {
    id = hub.create("sato", {kind:"general", company:"A社", ask:"試験用の依頼タイトル"}, randomUUID());
    hub.db.prepare("UPDATE jobs SET memo=?,status='done',adopted_version=2 WHERE id=?").run(first, id);
    hub.db.prepare("INSERT INTO memo_versions(job_id,version,memo) VALUES(?,1,?),(?,2,?)").run(id, first, id, second);
  } finally {
    hub.close();
  }
  const sockets = await Promise.all(Array.from({length:3}, async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    return server;
  }));
  const [sato, tanaka, admin] = sockets.map(socket => String(socket.address().port));
  await Promise.all(sockets.map(socket => new Promise(resolve => socket.close(resolve))));
  const base = "http://127.0.0.1:" + sato;
  const accounts = join(dir, "admins");
  await mkdir(accounts);
  await writeFile(join(accounts, "aoki"), randomUUID(), {mode:0o600});
  hubProcess = spawn(process.execPath, ["server.mjs"], {
    env:{...process.env, DATA_DIR:dir, LISTEN_ADDR:"127.0.0.1", ADMIN_ACCOUNTS_DIR:accounts,
      SATO_PORT:sato, TANAKA_PORT:tanaka, ADMIN_PORT:admin}, stdio:["ignore", "ignore", "inherit"],
  });
  const deadline = Date.now() + 10000;
  while (true) {
    try { if ((await fetch(base + "/api/workspace")).ok) break; } catch {}
    assert.ok(hubProcess.exitCode === null && Date.now() < deadline, "Hub did not start");
    await delay(100);
  }

  browser = await chromium.launch({channel:"chrome", headless:!native});
  const context = await browser.newContext({viewport:{width:390,height:844}});
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(native => {
    const synth = window.speechSynthesis;
    const events = window.speechEvents = [];
    if (native) {
      const speak = synth.speak.bind(synth);
      synth.speak = utterance => {
        const {text, voice:{name, lang, voiceURI, localService}} = utterance;
        events.push({type:"speak", text, name, lang, voiceURI, localService, at:Date.now()});
        for (const type of ["start", "boundary", "end", "error"]) utterance.addEventListener(type, event => {
          events.push({type, at:Date.now(), elapsedTime:event.elapsedTime, charIndex:event.charIndex, error:event.error, trusted:event.isTrusted});
        });
        speak(utterance);
      };
      return;
    }
    const local = {name:"端末内の音声", lang:"ja-JP", voiceURI:"native", localService:true};
    const remote = {name:"外部の音声", lang:"ja-JP", voiceURI:"remote", localService:false, default:true};
    window.speechVoices = [remote, local];
    synth.getVoices = () => window.speechVoices;
    window.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text; }
    };
    synth.speak = utterance => {
      window.lastUtterance = utterance;
      events.push({type:"speak", text:utterance.text, voice:utterance.voice});
      if (window.failSpeech) utterance.onerror();
      else utterance.onstart();
    };
    synth.cancel = () => {
      events.push({type:"cancel"});
      window.lastUtterance?.onerror();
    };
  }, native);

  await page.goto(base + "/#job/" + id + "/version/1");
  const play = page.getByRole("button", {name:"読み上げ", exact:true});
  const stop = page.getByRole("button", {name:"読み上げを停止"});
  const status = page.locator("#answerSpeech [role=status]");
  const memo = page.locator("#memoText");
  const versions = page.locator("#memoVersion");
  const events = () => page.evaluate(() => window.speechEvents.splice(0));
  await expect(play).toHaveAccessibleDescription("端末内で処理 · 第1版の本文のみ");
  await expect(memo).toHaveText(first);
  await play.evaluate(button => button.click());
  assert.deepEqual(await events(), []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  if (native) {
    await page.bringToFront();
    await page.waitForFunction(() => speechSynthesis.getVoices().some(voice => voice.localService && /^ja\b/i.test(voice.lang)));
    const requests = [];
    page.on("request", request => requests.push(request));
    await context.setOffline(true);
    await play.click();
    await expect(status).toContainText("読み上げが完了しました");
    const playback = await events();
    assert.equal(playback.find(event => event.type === "speak").text, first);
    assert.ok(playback.some(event => event.type === "start" && event.trusted));
    assert.ok(playback.some(event => event.type === "end" && event.trusted && event.elapsedTime > 0));
    assert.ok(playback.filter(event => event.type === "speak").every(event => event.localService));
    await versions.selectOption("2");
    await expect(play).toHaveAccessibleDescription("端末内で処理 · 第2版の本文のみ");
    await play.press("Enter");
    await expect(status).toContainText("読み上げが完了しました", {timeout:15000});
    const completeRevision = await events();
    assert.equal(completeRevision.filter(event => event.type === "speak").map(event => event.text).join(""), second);
    assert.equal(completeRevision.filter(event => event.type === "end" && event.trusted).length, 3);
    for (const request of requests) {
      const url = new URL(request.url());
      assert.equal(url.origin, base);
      assert.match(url.pathname, /^\/api\/(?:session|notifications|shared)$/);
      assert.equal(request.method(), "GET");
      assert.equal(request.postData(), null);
      assert.ok(!decodeURIComponent(url.href).includes(first) && !decodeURIComponent(url.href).includes(second));
    }
    const backgroundReads = requests.length;
    await play.press("Enter");
    await expect(status).toContainText("読み上げ中");
    await stop.click();
    await expect(status).toHaveText("読み上げを停止しました。");
    await page.waitForFunction(() => !speechSynthesis.speaking && !speechSynthesis.pending);
    const cancelled = await events();
    assert.ok(cancelled.some(event => event.type === "start" && event.trusted));
    assert.ok(cancelled.every(event => event.type !== "end"));
    await context.setOffline(false);
    await play.click();
    await expect(status).toContainText("読み上げ中");
    await page.locator(".job-chat-head .back").click();
    await expect(memo).toHaveCount(0);
    await page.waitForFunction(() => !speechSynthesis.speaking && !speechSynthesis.pending);
    console.log(JSON.stringify({chrome:browser.version(), playback, revisionNativeEnds:3, cancelled, backgroundReads, speechRequests:0}));
  } else {
    await play.press("Enter");
    await expect(status).toHaveText("読み上げ中 · 端末内の音声");
    const [initial] = await events();
    assert.equal(initial.text, first);
    assert.equal(initial.voice.localService, true);
    await versions.selectOption("2");
    assert.deepEqual(await events(), [{type:"cancel"}]);
    await expect(play).toBeVisible();
    await expect(memo).toHaveText(second);
    await play.click();
    await page.evaluate(() => {
      for (let i = 0; i < 3; i++) window.lastUtterance.onend();
    });
    const chunks = await events();
    assert.equal(chunks.map(event => event.text).join(""), second);
    await expect(status).toHaveText("読み上げが完了しました · 端末内の音声");
    await play.click();
    await page.locator(".job-chat-head .back").click();
    await expect(memo).toHaveCount(0);
    assert.deepEqual((await events()).map(event => event.type), ["speak", "cancel"]);
    await page.goto(base + "/#job/" + id + "/version/2");
    await play.click();
    await stop.click();
    await expect(status).toHaveText("読み上げを停止しました。");
    assert.deepEqual((await events()).map(event => event.type), ["speak", "cancel"]);
    await page.evaluate(() => window.failSpeech = true);
    await play.click();
    await expect(status).toContainText("読み上げを開始または継続できませんでした");
    assert.deepEqual((await events()).map(event => event.type), ["speak", "cancel"]);
    await page.evaluate(() => window.speechVoices = window.speechVoices.filter(voice => !voice.localService));
    await play.click();
    await expect(status).toContainText("端末内の読み上げを利用できません");
    await expect(memo).toBeVisible();
    assert.deepEqual(await events(), []);
    console.log("選んだ版の本文のみ、停止、版変更、画面遷移、音声エラー、外部音声のみの端末を確認");
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  if (hubProcess && hubProcess.exitCode === null) {
    hubProcess.kill();
    await once(hubProcess, "exit");
  }
  await rm(dir, {recursive:true, force:true});
}
