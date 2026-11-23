import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {verifyDocumentMentions} from "../../support/document-mentions-scenario.mjs";
import { listenGateway } from "../../../src/hermes/gateway.mjs";
import { seedLegacyWorkspace, verifyLegacyWorkspace } from "../../support/legacy-workspace-fixture.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { chromium } = createRequire(new URL("../../", import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
async function openJobOperation(page,name) {
  const record=page.locator("#jobRecord");
  await record.waitFor();
  if (await record.getAttribute("open") === null) await record.locator("summary").click();
  await record.getByRole("button",{name,exact:true}).click();
}
const dir = await mkdtemp(join(tmpdir(), "aihub-wp03-"));
const accounts = join(dir, "accounts");
const password = randomBytes(24).toString("hex");
const key = randomBytes(24).toString("hex");
const output = process.env.WP03_EVIDENCE_DIRECTORY;
const runs = new Map();
const runOutput = new Map();
const firstMemo = "改善点：開始日は8月22日。 [1]\n共有先は仙台支店。 [2]";
const workflowHashes = Object.fromEntries(await Promise.all(["source-answer", "csv-summary", "quote-comparison", "document-draft"].map(async name =>
  [name, createHash("sha256").update(await readFile(join(root, "skills", name, "SKILL.md"))).digest("hex")])));
const libraryRoot = join(dir, "library");
process.env.LIBRARY_ROOT = libraryRoot;
let workGateway, peerGateway, gatewayDb, fixtureError;
async function workTool(ticket, result, actor="sato") {
  const gateway=actor==="tanaka" ? peerGateway : workGateway;
  const response = await fetch(address(gateway.address().port) + "/work-tool", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket, result }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function toolResult(name, args, data, hermesHome=join(dir,"hermes-sato")) {
  const python = spawn("python3", ["-c", [
    "import json, sys",
    "from pathlib import Path",
    "from types import SimpleNamespace",
    "from infra import work_tools",
    "name, args, data, home = json.load(sys.stdin)",
    "sys.modules['hermes_constants'] = SimpleNamespace(get_hermes_home=lambda: Path(home))",
    "results = []",
    "def hub_tool(work, result=None):",
    "    if result is None: return data",
    "    results.append(result)",
    "    return {}",
    "work_tools.hub = hub_tool",
    "getattr(work_tools, name)('fixture', **args)",
    "json.dump(results[0], sys.stdout, ensure_ascii=False)",
  ].join("\n")], { cwd:root, stdio:["pipe","pipe","pipe"] });
  let body = "", stderr = "";
  python.stdout.setEncoding("utf8").on("data", chunk => { body += chunk; });
  python.stderr.on("data", chunk => { stderr += String(chunk); });
  python.stdin.end(JSON.stringify([name, args, data, hermesHome]));
  const [exit] = await once(python, "close");
  assert.equal(exit, 0, stderr);
  return JSON.parse(body);
}
async function simulateHermes(context, actor) {
  const work=(result)=>workTool(context.work,result,actor);
  if (context.phase==="learn_quote") {
    const result=await work({tool:"prepare_quote_skill",criteria:["料金","期間"],rules:[]});
    await work({tool:"confirm_quote_skill",hash:createHash("sha256").update(JSON.stringify(result)).digest("hex")});
    return "比較基準を保存しました。";
  }
  if (context.phase === "inquiry") return JSON.stringify({subject:"精算手続きの確認",body:"領収書の添付方法を確認したいです。",attachments:[1]});
  if (context.phase === "question") return "共有先は仙台支店です。 [2]";
  if (context.phase === "revise" && context.answer_source)
    return "開始：8月22日。 [1]\n共有先は仙台支店。 [2]\n領収書ごとに分ける。 ["+context.answer_source+"]";
  if (context.phase === "revise" && !context.work) return context.ask.includes("見積比較") ? "料金・期間を比較します。 [1] [2]" : "開始：8月22日。 [1]";
  if (!context.work) return context.ask + " [1]";
  const announce = context.ask.includes("制度案内");
  const quote = context.ask.includes("見積比較") || context.standard_workflow==="quote-comparison" || context.team_quote;
  const csv = context.sources.some(doc => doc.title.endsWith(".csv"));
  const name=context.standard_workflow || (csv ? "csv-summary" : announce ? "document-draft" : quote ? "quote-comparison" : "source-answer");
  const installed=name==="quote-comparison" ? (await work(null)).quote_skill : null;
  await work({tool:"load_workflow",name,title:name,hash:installed?.hash ?? workflowHashes[name]});
  const libraryQuery=context.libraries || (context.may_search_libraries && /精算|RXP|MZT/.test(context.ask)) ?
    context.ask.includes("RXP") ? "RXP" : context.ask.includes("MZT") ? "MZT" : "精算 取消" : null;
  if (libraryQuery)
    await work({tool:"search_libraries",query:libraryQuery});
  const data = await work(null);
  if (name==="csv-summary" && data.csv_skill)
    await toolResult("load_workflow",{name},data,join(dir,"hermes-"+actor));
  const result = csv ? await toolResult("aggregate_csv", { amount_column:"金額", group_column:"品名",
    ...(context.phase === "revise" && {filter_column:"状態", exclude_value:"返品"}) }, data) :
    name==="document-draft" ? await toolResult("draft_document", { refs:[], audience_ref:"1.1", start_ref:"1.2" }, data) :
    name==="quote-comparison" ? await toolResult("compare_quotes", { rows:[{label:"料金",left_ref:"1.1",right_ref:"2.1"},{label:"期間",left_ref:"1.2",right_ref:""}]
      .filter(row=>!data.team_quote || data.team_quote.criteria.includes(row.label)) }, data) :
    { tool: "read_passages", memo: context.sources.length>1 ? firstMemo : (data.passages[0]?.text || "資料に記載がありません。")+" [1]",
      evidence: data.passages, conditions: [] };
  if (libraryQuery) {
    const conflicting=context.ask.includes("食い違い");
    result.evidence=conflicting ? [...new Map(data.passages.map(item=>[item.source,item])).values()].slice(0,2) : data.passages.slice(0,1);
    result.memo = result.evidence.map(item=>item.text+" ["+item.source+"]").join("\n")+(conflicting ? "\n要確認（資料で条件が食い違います）" : "");
  }
  await work(result);
  return result.memo;
}
const runsServer = createServer(async (req, res) => {
  const receipt = req.headers["idempotency-key"];
  let result;
  if (req.headers.authorization === "Bearer " + key) {
    if (req.method === "POST" && req.url === "/v1/runs") {
      try {
        const parts = [];
        for await (const part of req) parts.push(part);
        const { input,session_id } = JSON.parse(Buffer.concat(parts));
        const context = JSON.parse(input.match(/AI_HUB_INPUT\n([^\n]+)\nEND_AI_HUB_INPUT/)[1]);
        const actor=gatewayDb.prepare("SELECT actor FROM jobs WHERE id=?").get(session_id.slice(4,40)).actor;
        runOutput.set(receipt, await simulateHermes(context,actor));
      } catch (error) {
        fixtureError = error;
        res.writeHead(500).end();
        return;
      }
      runs.set(receipt, (runs.get(receipt) || 0) + 1);
      result = { run_id: receipt };
    } else if (runs.has(req.url.slice(9))) {
      result = { status: "completed", output: runOutput.get(req.url.slice(9)) };
    }
  }
  res.writeHead(result ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(result || {}));
});
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
const address = port => "http://127.0.0.1:" + port;
const reservations = Array.from({ length: 3 }, () => createServer());
const ports = await Promise.all(reservations.map(listen));
await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
const [sato, tanaka, admin] = ports.map(address);
let child, browser;

async function pressUntil(page, selector, maximum = 26) {
  for (let i = 0; i < maximum; i++) {
    if (await page.evaluate(value => document.activeElement.matches(value), selector)) return;
    await page.keyboard.press("Tab");
  }
  throw Error("キーボードフォーカスを移せません: " + selector);
}
async function screenshot(page, name) {
  if (output) await page.screenshot({ path: join(output, name + ".png"), fullPage: true });
}
const jobRequest = path => response => new URL(response.url()).pathname === path;
const file = (name, text) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });

async function runScenario() {
  await mkdir(accounts, { mode: 0o700 });
  const legacyId = seedLegacyWorkspace(join(dir,"hub.sqlite"));
  const library = join(libraryRoot, "shared", "規程");
  await mkdir(library, { recursive:true });
  const privateLibrary=join(libraryRoot,"teams","営業企画部","限定規程");
  await mkdir(privateLibrary,{recursive:true});
  await writeFile(join(privateLibrary,"限定原文.md"),"MZT：営業企画部でのみ扱う合成識別子。");
  const regulation = join(library, "精算規程.md");
  await writeFile(regulation, "第8条 精算の取消には理由書が必要。");
  await writeFile(join(library, "略語集.md"), "RXP：研修費用の精算申請。");
  if (output) await mkdir(output, { recursive: true });
  for (const actor of ["mori", "aoki"]) await writeFile(join(accounts, actor), password, { mode: 0o600 });
  await writeFile(join(accounts, ".roles.json"), '{"mori":"auditor","aoki":"manager"}', { mode: 0o600 });
  const fixture = address(await listen(runsServer));
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, DATA_DIR: dir, ADMIN_ACCOUNTS_DIR: accounts, LISTEN_ADDR: "127.0.0.1", LIBRARY_ROOT:libraryRoot,
      SATO_PORT: String(ports[0]), TANAKA_PORT: String(ports[1]), ADMIN_PORT: String(ports[2]),
      SATO_URL: fixture, SATO_KEY: key, TANAKA_URL: fixture, TANAKA_KEY: key },
  });
  let stderr = "";
  child.stderr.on("data", bytes => { stderr += String(bytes); });
  child.stdout.resume();
  for (let i = 0; i < 100; i++) {
    if ((await fetch(sato).catch(() => null))?.ok) break;
    if (i === 99 || child.exitCode !== null) throw Error(stderr);
    await delay(50);
  }
  await verifyLegacyWorkspace(sato,legacyId);
  browser = await chromium.launch({ channel: "chrome" });
  gatewayDb = new DatabaseSync(join(dir, "hub.sqlite"));
  workGateway = listenGateway(gatewayDb, "sato", "127.0.0.1", 0);
  peerGateway = listenGateway(gatewayDb, "tanaka", "127.0.0.1", 0);
  await Promise.all([once(workGateway, "listening"),once(peerGateway,"listening")]);
  const auth="Basic "+Buffer.from("aoki:"+password).toString("base64");
  const mentions=()=>verifyDocumentMentions({browser,sato,tanaka,admin,auth,libraryRoot,db:gatewayDb});
  if (process.argv.includes("--document-mentions")) return mentions();
  const wide = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await wide.goto(sato);
  await wide.locator("#request").waitFor();
  assert.equal(await wide.locator("#requestOptions").isVisible(), false);
  assert.equal(await wide.locator("#adminMenu").isVisible(), false);
  await screenshot(wide, "1440-sato-home");

  const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await narrow.goto(sato);
  await narrow.locator("#request").waitFor();
  await pressUntil(narrow, "#workspaceMenu");
  await narrow.keyboard.press("Enter");
  assert.equal(await narrow.locator("#workspaceMenu").getAttribute("aria-expanded"), "true");
  await narrow.keyboard.press("Escape");
  assert.equal(await narrow.locator("#workspaceMenu").getAttribute("aria-expanded"), "false");
  await pressUntil(narrow, "#request [name=ask]");
  await narrow.keyboard.insertText("青葉研修の改善案を記録して");
  await pressUntil(narrow, '[data-op="request-settings"]');
  await narrow.keyboard.press("Enter");
  assert.equal(await narrow.locator("#requestOptions").isVisible(), true);
  const input = narrow.locator("#request [name=contractFile]");
  await input.setInputFiles(file("blank.txt", " "));
  await narrow.getByText(/blank.txt：文字を読み取れません/).waitFor();
  await narrow.getByRole("button", { name: "blank.txt を取り外す" }).click();
  await input.setInputFiles(file("large.txt", "x".repeat(5*1024*1024 + 1)));
  await narrow.getByText(/large.txt：5 MB/).waitFor();
  await narrow.getByRole("button", { name: "large.txt を取り外す" }).click();
  await input.setInputFiles([file("概要.txt", "開始日は8月22日。"), file("差し替え前.txt", "共有先は東京支店。")]);
  await narrow.getByText("差し替え前.txt を読み込みました。").waitFor();
  await narrow.getByRole("button", { name: "差し替え前.txt を取り外す" }).click();
  await input.setInputFiles(file("配布先.txt", "共有先は仙台支店。"));
  await narrow.getByText("配布先.txt を読み込みました。").waitFor();
  await narrow.getByLabel("配布先.txt の抽出本文を確認").click();
  assert.equal(await narrow.locator("[data-file-previews]").getByText("共有先は仙台支店。", { exact: true }).isVisible(), true);
  await screenshot(narrow, "390-sato-attachments");

  let accepted, receiptHeader, posts = 0;
  await narrow.route(sato + "/api/jobs", async route => {
    posts++;
    receiptHeader = route.request().headers()["idempotency-key"];
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    accepted = await response.json();
    await route.abort();
  });
  const lookedUp = narrow.waitForResponse(jobRequest("/api/jobs/receipt"));
  await pressUntil(narrow, '#request [type="submit"]');
  await narrow.keyboard.press("Enter");
  await narrow.keyboard.press("Enter");
  assert.equal((await lookedUp).status(), 200);
  assert.equal(posts, 1);
  await narrow.waitForURL("**/#job/" + accepted.id);
  const memo = narrow.locator("#memoText");
  try { await memo.waitFor({ timeout: 12000 }); }
  catch (error) { throw fixtureError || error; }
  const source = memo.getByRole("button", { name: "出典2を開く" });
  await source.click();
  await narrow.locator("#dialog").getByText("共有先は仙台支店。", { exact: false }).first().waitFor();
  await screenshot(narrow, "390-sato-source");
  await narrow.keyboard.press("Escape");
  assert.equal(await source.evaluate(el => el === document.activeElement), true);

  await wide.goto(sato + "/#job/" + accepted.id);
  await wide.locator("#memoText").waitFor();
  await screenshot(wide, "1440-sato-deep-link");
  const narrowJob = narrow.url();
  await pressUntil(narrow, "#crumbRoot");
  await narrow.keyboard.press("Enter");
  await narrow.locator("#jobSearch").waitFor();
  await pressUntil(narrow, "#jobSearch");
  await narrow.keyboard.insertText("青葉研修");
  await narrow.locator('#jobResults [data-op="job/'+accepted.id+'"]').waitFor();
  await pressUntil(narrow, '[data-op="job/' + accepted.id + '"]');
  await narrow.keyboard.press("Enter");
  await narrow.waitForURL(narrowJob);
  await narrow.goBack();
  await narrow.locator("#jobSearch").waitFor();
  assert.equal(new URL(narrow.url()).hash, "#jobs");

  for (const actor of ["mori", "aoki"]) {
    const page = await browser.newPage({ httpCredentials: { username: actor, password } });
    await page.goto(admin);
    await page.locator("#request").waitFor();
    assert.equal(await page.getByRole("link", { name: "管理者画面" }).isVisible(), true);
    await page.close();
  }
  const isolated = await fetch(tanaka + "/api/jobs/receipt", { headers: {"Idempotency-Key": receiptHeader} });
  assert.equal(isolated.status, 404);
  const db = new DatabaseSync(join(dir, "hub.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT id,actor,ask,sources_json FROM jobs").all().filter(row=>row.id!==legacyId);
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].sources_json).map(source => [source.title, source.text]), [
      ["概要.txt", "開始日は8月22日。"], ["配布先.txt", "共有先は仙台支店。"],
    ]);
    assert.equal(runs.size, 1);
    assert.equal([...runs.values()][0], 1);
    assert.equal(await narrow.evaluate(() => document.documentElement.scrollWidth), 390);
    console.log(JSON.stringify({ chrome: browser.version(), viewports: [1440, 390], work: rows[0].id, jobPosts: posts,
      runnerAcceptances: [...runs.values()][0], receiptStatus: 200, otherEmployeeReceiptStatus: isolated.status,
      finalFiles: JSON.parse(rows[0].sources_json).map(source => source.title), keyboard: ["menu", "request", "submit", "search", "open-result", "escape-to-source"],
      adminEmployeeHome: ["mori", "aoki"], browserBack: new URL(narrow.url()).hash }, null, 2));
  } finally {
    db.close();
  }
  await narrow.unroute(sato + "/api/jobs");
  await narrow.goto(narrowJob);
  const revise = narrow.locator("#revise");
  await revise.getByLabel("修正範囲").selectOption("0");
  await revise.getByLabel("修正内容").fill("開始日を短くしてください");
  await revise.getByRole("button", { name:"修正を依頼する" }).click();
  await narrow.locator('#memoVersion option[value="2"]').waitFor({ state:"attached" });
  await narrow.locator("#memoVersion").selectOption("2");
  await narrow.getByText("現在の採用版（第1版）と見比べる", { exact:true }).click();
  assert.match(await narrow.locator(".version-comparison").innerText(), /第1版 ・ 採用版/);
  assert.match(await narrow.locator("#memoText").innerText(), /開始：8月22日。.*\n共有先は仙台支店。/);
  await screenshot(narrow, "390-sato-version-comparison");
  await narrow.getByRole("button", { name:"この版を採用", exact:true }).click();
  await narrow.locator('#memoVersion option[value="2"]').filter({ hasText:"採用版" }).waitFor({state:"attached"});
  const stale = await fetch(sato + "/api/jobs/" + accepted.id + "/adopt", {
    method:"POST", headers:{Origin:sato,"Content-Type":"application/json"}, body:JSON.stringify({version:1,expected:1}),
  });
  assert.equal(stale.status,409);
  await narrow.goto(sato);
  await narrow.locator('.home-recent a[href="#job/'+accepted.id+'"]')
    .filter({hasText:"青葉研修の改善案"}).click();
  await narrow.reload();
  await narrow.locator('#memoVersion option[value="2"]').filter({ hasText:"採用版" }).waitFor({state:"attached"});
  await narrow.getByLabel("このメモについて質問").fill("共有先はどこですか？");
  await narrow.getByRole("button", { name:"質問する", exact:true }).click();
  await narrow.getByText("共有先は仙台支店です。", {exact:false}).first().waitFor();
  await screenshot(narrow,"390-sato-restored-thread");
  const history = await (await fetch(sato + "/api/jobs/" + accepted.id)).json();
  assert.equal(history.adopted_version,2);
  assert.equal(history.questions[0].version,2);
  assert.equal((await fetch(tanaka + "/api/jobs/" + accepted.id)).status,404);
  assert.equal((await (await fetch(tanaka + "/api/workspace")).json()).jobs.length,0);

  async function newRequest(ask, docs, configure) {
    await wide.goto(sato);
    const form = wide.locator("#request");
    await form.getByLabel("依頼内容").fill(ask);
    if (docs.length) {
      await form.locator("[name=contractFile]").setInputFiles(docs);
      await form.getByText(docs.at(-1).name+" を読み込みました。", { exact:true }).waitFor();
    }
    if (configure) await configure(form);
    const response = wide.waitForResponse(r => jobRequest("/api/jobs")(r) && r.request().method()==="POST");
    await form.getByRole("button",{name:"送信",exact:true}).click();
    const { id } = await (await response).json();
    try { await wide.locator("#memoText").waitFor({ timeout:12000 }); }
    catch (error) { throw fixtureError || error; }
    return id;
  }
  const csv = await newRequest("商品別の売上を集計して", [file("新規売上.csv","品名,状態,金額\nノート,販売,120\nノート,返品,25\nペン,販売,70")]);
  assert.match(await wide.locator("#memoText").innerText(), /合計\s+215/);
  await wide.getByLabel("修正内容").fill("返品を除いて");
  await wide.getByRole("button",{name:"修正を依頼する"}).click();
  await wide.locator('#memoVersion option[value="2"]').waitFor({state:"attached"});
  await wide.locator("#memoVersion").selectOption("2");
  assert.match(await wide.locator("#memoText").innerText(), /合計\s+190/);
  await wide.getByText("集計条件と元の行",{exact:true}).click();
  assert.match(await wide.getByText("除外 ・ 3行目").locator("..").innerText(), /ノート,返品,25/);
  await screenshot(wide,"1440-sato-csv-revision");
  await wide.getByRole("button",{name:"この版を採用",exact:true}).click();
  await wide.locator('#memoVersion option[value="2"]').filter({hasText:"採用版"}).waitFor({state:"attached"});
  await wide.reload();
  await wide.locator("#memoText").waitFor();
  assert.match(await wide.locator("#memoText").innerText(), /合計\s+190/);

  const notice = await newRequest("新しい制度案内を作成", [file("制度資料.txt","対象は総務部。\n開始日は9月6日。")]);
  await wide.getByText("案内に使った原文", {exact:true}).click();
  const needed = wide.getByText("必要な行動", {exact:true}).locator("..");
  assert.match(await needed.innerText(), /要確認（記載なし）/);
  assert.match(await wide.locator("#memoText").innerText(), /総務部.*\n\n開始日.*9月6日/);
  await screenshot(wide, "1440-sato-notice");
  await wide.context().grantPermissions(["clipboard-read","clipboard-write"]);
  await wide.getByRole("button",{name:"出典付きでコピー",exact:true}).click();
  assert.match(await wide.evaluate(() => navigator.clipboard.readText()), /総務部。 \[1\]/);

  const quotes = await newRequest("見積比較を作成", [file("甲社見積.txt","料金は1700円。\n期間は1年。"),file("乙社見積.txt","料金は2200円。")]);
  await wide.getByRole("button", { name:"[2.1]",exact:true }).click();
  await wide.locator("#dialog mark").waitFor();
  assert.equal(await wide.locator("#dialog mark").innerText(),"料金は2200円。");
  await wide.keyboard.press("Escape");
  const download = wide.waitForEvent("download");
  await wide.getByRole("link", { name:"比較表をCSVで保存" }).click();
  const comparisonCsv=await readFile(await (await download).path(),"utf8");
  assert.match(comparisonCsv, /2200円.*2\.1/);
  assert.match(comparisonCsv, /要確認（記載なし）/);
  await screenshot(wide, "1440-sato-quotes");

  const policy = await newRequest("精算の取消には何が必要？", [], async form => {
    await form.getByRole("button",{name:"依頼の設定"}).click();
    await form.getByText("社内の資料置き場を選ぶ",{exact:true}).click();
    await form.getByRole("checkbox",{name:/規程（全社員/}).check();
  });
  await wide.locator("#memoText").getByRole("button", {name:"出典1を開く"}).click();
  await wide.locator("#dialog mark").waitFor();
  assert.match(await wide.locator("#dialog mark").innerText(), /第8条.*理由書/);
  await wide.keyboard.press("Escape");
  await writeFile(regulation, "第9条 精算の取消には承認番号が必要。");
  await wide.locator("#memoText").getByRole("button", {name:"出典1を開く"}).click();
  await wide.getByText("資料が更新され、この版の公開が終了しました。").waitFor();
  assert.doesNotMatch(await wide.locator("#dialog").innerText(), /理由書|承認番号/);
  await screenshot(wide,"1440-sato-source-expired");
  const expired = await (await fetch(sato+"/api/jobs/"+policy)).json();
  assert.equal(expired.sources[0].text,undefined);
  assert.equal(expired.work_tool.evidence[0].text,undefined);
  console.log(JSON.stringify({ versionFlow:{job:accepted.id,adopted:history.adopted_version,questionVersion:history.questions[0].version,staleAdopt:stale.status},
    csv:{job:csv,initialTotal:215,adoptedTotal:190,excluded:"ノート,返品,25"}, notice, quotes, policy, sourceExpired:true },null,2));

  // With four newer jobs, the original work is beyond the home list. Search uses a question unique to its history.
  await wide.goto(sato);
  await wide.locator("#request").waitFor();
  assert.equal(await wide.locator('[data-op="job/'+accepted.id+'"]').count(),0);
  await wide.goto(sato+"/#jobs");
  await wide.locator("#jobSearch").fill("共有先はどこですか");
  await wide.getByText("検索結果 1件",{exact:true}).waitFor();
  assert.equal(await wide.locator('#jobResults [data-op="job/'+accepted.id+'"]').count(),1);
  assert.equal(await wide.locator("#jobResults mark").innerText(),"共有先はどこですか");
  await wide.locator("#jobSearch").fill("該当なし検証用");
  await wide.getByText("一致する依頼はありません。別のキーワードで検索してください。",{exact:true}).waitFor();
  await wide.locator("#jobSearch").fill("");
  await wide.locator('#jobResults [data-op="job/'+csv+'"]').waitFor();
  const oldCsv=await (await fetch(sato+"/api/jobs/"+csv)).json();
  await wide.locator('#jobResults [data-op="repeat/'+csv+'"]').click();
  await wide.locator("#dialog").waitFor();
  assert.match(await wide.locator("#dialog").innerText(), /状態 が「返品」の行を除外/);
  await wide.getByLabel("今回のCSV").setInputFiles(file("翌月売上.csv","品名,状態,金額\nハサミ,販売,440\nハサミ,返品,32"));
  const newCsvResponse=wide.waitForResponse(r=>jobRequest("/api/jobs")(r) && r.request().method()==="POST");
  await wide.getByRole("button",{name:"このCSVで集計する"}).click();
  const {id:newCsv}=await (await newCsvResponse).json();
  await wide.waitForURL("**/#job/"+newCsv);
  await wide.locator("#memoText").waitFor();
  assert.match(await wide.locator("#memoText").innerText(), /合計\s+440/);
  const savedNew=await (await fetch(sato+"/api/jobs/"+newCsv)).json();
  assert.deepEqual(savedNew.sources.map(source=>source.title), ["翌月売上.csv"]);
  assert.deepEqual((await (await fetch(sato+"/api/jobs/"+csv)).json()).versions,oldCsv.versions);
  assert.equal((await (await fetch(sato+"/api/jobs/"+csv)).json()).adopted_version,oldCsv.adopted_version);
  const autoPolicy=await newRequest("精算の取消にはどの条が必要？",[]);
  await wide.locator("#memoText").getByRole("button",{name:"出典1を開く"}).click();
  await wide.locator("#dialog mark").waitFor();
  assert.match(await wide.locator("#dialog mark").innerText(), /第9条.*承認番号/);
  await wide.keyboard.press("Escape");
  const glossary=await newRequest("社内の略語 RXP の意味は？",[]);
  await wide.locator("#memoText").getByRole("button",{name:"出典1を開く"}).click();
  await wide.locator("#dialog mark").waitFor();
  assert.match(await wide.locator("#dialog mark").innerText(), /RXP.*研修費用の精算申請/);
  await writeFile(join(library,"精算補足.md"),"第3条 精算の取消には届出書が必要。");
  const conflicting=await newRequest("精算の取消には資料間で食い違いがありますか？",[]);
  assert.match(await wide.locator("#memoText").innerText(), /承認番号/);
  assert.match(await wide.locator("#memoText").innerText(), /届出書/);
  assert.match(await wide.locator("#memoText").innerText(), /要確認/);
  assert.equal(await wide.locator("#memoText").getByRole("button",{name:/出典\dを開く/}).count(),2);

  await wide.goto(sato);
  await wide.locator("#request [name=ask]").fill("保留してから再開する下書き");
  await wide.getByRole("button",{name:"依頼の設定"}).click();
  await wide.getByRole("button",{name:"下書きを保存"}).click();
  await wide.getByRole("button",{name:"保留してから再開する下書き",exact:true}).click();
  assert.equal(await wide.getByLabel("新しい依頼内容").inputValue(),"保留してから再開する下書き");
  await wide.keyboard.press("Escape");
  await wide.goto(sato);
  await wide.locator("#request [name=ask]").fill("未着手の予約を取り消す");
  await wide.getByRole("button",{name:"依頼の設定"}).click();
  await wide.getByLabel("実行のタイミング").selectOption("once");
  await wide.getByLabel(/実行予定日時/).fill(new Date(Date.now()+86400000+9*3600000).toISOString().slice(0,16));
  const planned=wide.waitForResponse(r=>jobRequest("/api/jobs")(r) && r.request().method()==="POST");
  await wide.getByRole("button",{name:"送信",exact:true}).click();
  const cancelledJob=(await (await planned).json()).id;
  await wide.waitForURL("**/#job/"+cancelledJob);
  await wide.getByRole("button",{name:"依頼を取り消す",exact:true}).click();
  await wide.getByRole("heading",{name:"依頼を取り消しました"}).waitFor();
  assert.equal(gatewayDb.prepare("SELECT COUNT(*) total FROM attempts WHERE job_id=?").get(cancelledJob).total,0);
  const crossUser=await (await fetch(tanaka+"/api/jobs/search?q="+encodeURIComponent("共有先はどこですか"))).json();
  assert.deepEqual(crossUser,[]);
  console.log(JSON.stringify({ conversationSearch:accepted.id,newCsv:{job:newCsv,total:440,original:csv},autoPolicy,glossary,conflicting,cancelledJob,cancelledDispatches:0,crossUserSearch:0 },null,2));

  await wide.goto(sato+"/#job/"+accepted.id);
  await openJobOperation(wide,"案件に整理");
  await wide.getByLabel("新しい案件名").fill("青葉研修案件");
  await wide.getByRole("button",{name:"案件に追加"}).click();
  await wide.locator('#workspaceNav a[href="#work"]').click();
  await wide.locator('#work-nav-projects').click();
  await wide.getByRole("button",{name:"青葉研修案件",exact:true}).click();
  await wide.getByText("責任者・期限・閲覧メンバーを変更",{exact:true}).click();
  const projectForm=wide.locator("#projectSettings");
  const projectId=await projectForm.getAttribute("data-project");
  await projectForm.getByLabel("期限").fill("2027-01-20");
  await projectForm.getByRole("checkbox",{name:"田中 翔"}).check();
  await projectForm.getByRole("button",{name:"案件の変更を保存"}).click();
  await wide.getByText("案件の変更を保存しました。",{exact:true}).waitFor();
  await wide.goto(sato+"/#job/"+accepted.id);
  await wide.getByRole("button",{name:"同僚に共有",exact:true}).click();
  await wide.getByLabel("共有する相手").selectOption("tanaka");
  const sharedResponse=wide.waitForResponse(jobRequest("/api/jobs/"+accepted.id+"/share"));
  await wide.getByRole("button",{name:"この内容を共有する"}).click();
  const share={id:(await (await sharedResponse).json()).id};
  const desk=await browser.newPage({viewport:{width:390,height:844}});
  await desk.goto(tanaka+"/#work/projects");
  await desk.getByRole("button",{name:"青葉研修案件",exact:true}).click();
  await desk.locator("#dialog").getByText("共有された成果物",{exact:true}).waitFor();
  const restrictedProject=await (await fetch(tanaka+"/api/projects/"+projectId)).json();
  assert.deepEqual(restrictedProject.jobs,[]);
  assert.deepEqual(restrictedProject.shares.map(item=>item.id),[share.id]);
  await desk.keyboard.press("Escape");
  await desk.locator("#notifications").click();
  await desk.getByRole("button",{name:/成果物の共有/}).click();
  await desk.waitForURL("**/#shared/"+share.id);
  await desk.locator("#main").getByText(/開始：8月22日。/).waitFor();
  assert.equal(await desk.locator("#main").getByRole("button",{name:/出典/}).count(),0);
  await screenshot(desk,"390-tanaka-shared");
  await openJobOperation(wide,"共有を管理");
  await wide.getByRole("button",{name:"共有を取り消す"}).click();
  await wide.locator("#dialog").getByText("共有を取り消しました。").waitFor();
  assert.equal((await fetch(tanaka+"/api/shared/"+share.id)).status,404);
  await wide.keyboard.press("Escape");

  await wide.getByRole("button",{name:"問い合わせの起票案を作る"}).click();
  await wide.getByRole("button",{name:"起票案を確認"}).click();
  await wide.getByLabel("担当窓口").selectOption("operations");
  await wide.getByRole("checkbox",{name:/概要.txt/}).check();
  await wide.getByRole("button",{name:"登録内容を確認"}).click();
  await wide.getByRole("button",{name:"編集に戻る"}).click();
  await wide.getByLabel("本文",{exact:true}).fill("領収書の添付方法と申請期限を確認したいです。");
  await wide.getByRole("button",{name:"登録内容を確認"}).click();
  await screenshot(wide,"1440-sato-inquiry-preview");
  let ticketId, registerPosts=0;
  await wide.route(sato+"/api/jobs/"+accepted.id+"/inquiry/register",async route=>{
    registerPosts++;
    const result=await route.fetch();
    assert.equal(result.status(),201);
    ticketId=(await result.json()).id;
    await route.abort();
  });
  await wide.getByRole("button",{name:"この内容で起票"}).click();
  await wide.waitForURL(/#inquiry\/\d+$/);
  assert.equal(registerPosts,1);
  await desk.goto(tanaka+"/#inquiry/"+ticketId);
  await desk.getByRole("button",{name:"受付票に回答"}).click();
  await desk.getByLabel("依頼者への回答").fill("申請期限は翌月末です。");
  await desk.getByRole("button",{name:"回答を送信"}).click();
  await desk.getByText("申請期限は翌月末です。",{exact:true}).waitFor();
  assert.equal(await desk.getByText("配布先.txt",{exact:true}).count(),0);
  assert.equal((await fetch(tanaka+"/api/jobs/"+accepted.id)).status,404);
  await wide.goto(sato+"/#job/"+accepted.id+"/reply/"+ticketId);
  await wide.getByRole("button",{name:"同じ受付票に追加質問"}).click();
  await wide.getByLabel("窓口への追加質問").fill("領収書が2枚の場合はどうしますか？");
  await wide.getByRole("button",{name:"追加質問を送信"}).click();
  await desk.reload();
  await desk.getByRole("button",{name:"追加質問に回答"}).click();
  await desk.getByLabel("依頼者への回答").fill("領収書ごとに分ける。");
  await desk.getByRole("button",{name:"回答を送信"}).click();
  await desk.getByText("領収書ごとに分ける。",{exact:true}).waitFor();
  await wide.reload();
  await wide.getByRole("button",{name:"この再回答を第2版に反映するようHermesに依頼"}).click();
  await wide.waitForURL(/\/version\/3$/);
  const roundCitation=wide.locator("#memoText").getByRole("link",{name:/再回答（1回目）/});
  await roundCitation.waitFor();
  await roundCitation.click();
  await wide.waitForURL(/\/round\/1\?from=3$/);
  await wide.getByRole("link",{name:"修正版（第3版）に戻る"}).click();
  await wide.getByRole("button",{name:"この版を採用",exact:true}).click();
  await wide.getByRole("button",{name:"受付票 #"+ticketId+" を解決済みにする"}).click();
  await wide.locator("#receiptSources").getByText("解決済み",{exact:true}).waitFor();
  await desk.reload();
  await desk.locator(".heading .status").getByText("解決済み",{exact:true}).waitFor();
  await screenshot(desk,"390-tanaka-resolved");
  const reviewStates=gatewayDb.prepare("SELECT action FROM inquiry_review_events WHERE job=? ORDER BY seq").all(accepted.id).map(row=>row.action);
  assert.deepEqual(reviewStates,["preview","returned","resubmitted","approved","registered"]);

  await wide.locator('#workspaceNav a[href="#work"]').click();
  await wide.locator('#work-nav-projects').click();
  await wide.getByRole("button",{name:"青葉研修案件",exact:true}).click();
  await wide.getByText("責任者・期限・閲覧メンバーを変更",{exact:true}).click();
  await projectForm.getByLabel("責任者").selectOption("tanaka");
  await projectForm.getByLabel("引き継ぎ理由").fill("次月の研修運営を引き継ぐ");
  await projectForm.getByRole("button",{name:"案件の変更を保存"}).click();
  await wide.getByText("案件の変更を保存しました。",{exact:true}).waitFor();
  assert.equal((await (await fetch(tanaka+"/api/projects/"+projectId)).json()).responsible,"tanaka");
  const directory=await (await fetch(admin+"/api/admin/memberships",{headers:{Authorization:auth}})).json();
  const member=(Array.isArray(directory) ? directory : directory.items || directory.rows).find(person=>person.actor==="tanaka");
  const moved=await fetch(admin+"/api/admin/memberships/tanaka",{
    method:"POST",headers:{Authorization:auth,Origin:admin,"Content-Type":"application/json"},
    body:JSON.stringify({base:member.revision,team:"異動先の部門",reason:"検証用の所属変更"}),
  });
  assert.equal(moved.status,200,await moved.clone().text());
  assert.equal((await fetch(tanaka+"/api/projects/"+projectId)).status,404);
  assert.equal((await (await fetch(tanaka+"/api/workspace")).json()).projects.some(p=>p.id===projectId),false);
  console.log(JSON.stringify({ projectId,share:share.id,oldMemberDenied:true,ticketId,registerPosts,reviewStates,resolvedRound:1 },null,2));

  const postAs=(origin,path,data,extra={})=>fetch(origin+path,{method:"POST",headers:{
    Origin:origin,"Content-Type":"application/json","Idempotency-Key":crypto.randomUUID(),...extra,
  },body:JSON.stringify(data)});
  await wide.goto(sato+"/#skills");
  await wide.getByLabel("やりたいこと・資料名で検索").fill("見積");
  await wide.getByRole("button",{name:/2社の見積比較.*会社標準/}).click();
  await wide.getByRole("button",{name:"お気に入りに追加"}).click();
  await wide.getByRole("button",{name:"お気に入りを解除"}).waitFor();
  await wide.keyboard.press("Escape");
  await wide.getByLabel("お気に入りのみ").check();
  await wide.getByRole("button",{name:"会社標準",exact:true}).click();
  assert.equal(await wide.locator("#catalogResults button").count(),1);
  await wide.getByRole("button",{name:"自分が作成",exact:true}).click();
  await wide.getByText("条件に合う手順はありません。",{exact:true}).waitFor();
  await wide.getByLabel("お気に入りのみ").uncheck();
  await wide.getByRole("button",{name:"すべて",exact:true}).click();
  await wide.getByRole("button",{name:/2社の見積比較.*会社標準/}).click();
  await wide.getByRole("button",{name:"この手順で新しく依頼"}).click();
  await wide.waitForURL("**/#home");
  await wide.getByText("2社の見積比較 ・ v1",{exact:true}).waitFor();
  const fromCatalog=wide.waitForResponse(r=>jobRequest("/api/jobs")(r) && r.request().method()==="POST");
  await wide.locator("#request [name=contractFile]").setInputFiles([
    file("標準手順甲.txt","料金は550円。\n期間は6か月。"),file("標準手順乙.txt","料金は700円。"),
  ]);
  await wide.getByText("標準手順乙.txt を読み込みました。",{exact:true}).waitFor();
  await wide.getByRole("button",{name:"送信",exact:true}).click();
  const catalogJob=(await (await fromCatalog).json()).id;
  await wide.waitForURL("**/#job/"+catalogJob);
  await wide.locator("#memoText").waitFor();
  const fixed=await (await fetch(sato+"/api/jobs/"+catalogJob)).json();
  assert.equal(fixed.standard_hash,workflowHashes["quote-comparison"]);
  assert.notEqual(catalogJob,quotes);
  await wide.goto(sato+"/#job/"+quotes);
  await wide.getByRole("button",{name:"この相談で使う",exact:true}).click();
  await wide.getByRole("button",{name:"カタログから手順を探す",exact:true}).click();
  await wide.getByRole("button",{name:/2社の見積比較.*会社標準/}).click();
  await wide.getByRole("button",{name:"この相談で使う",exact:true}).click();
  assert.equal(await wide.getByLabel("適用する手順").inputValue(),"quote-comparison");
  await wide.getByLabel("今回の希望").fill("料金と期間を原文から比べてください");
  await wide.getByRole("button",{name:"この手順を適用"}).click();
  await wide.waitForURL("**/#job/"+quotes+"/version/2");
  await wide.locator('#memoVersion option[value="2"]').waitFor({state:"attached"});
  await wide.locator("#memoText table").waitFor();
  const applied=await (await fetch(sato+"/api/jobs/"+quotes)).json();
  const appliedVersion=applied.versions.find(version=>version.version===2);
  assert.equal(appliedVersion.standard_hash,workflowHashes["quote-comparison"]);
  assert.match(appliedVersion.instruction,/料金と期間/);
  assert.deepEqual(applied.sources.map(source=>source.title),["甲社見積.txt","乙社見積.txt"]);

  await wide.goto(sato+"/#job/"+csv);
  await openJobOperation(wide,"集計条件を自分用に保存");
  await wide.getByLabel("手順名").fill("返品除外の集計");
  const savedTemplateResponse=wide.waitForResponse(jobRequest("/api/templates"));
  await wide.getByRole("button",{name:"自分用に保存",exact:true}).click();
  const release=(await (await savedTemplateResponse).json());
  assert.match(release.hash,/^[0-9a-f]{64}$/);
  const templateCopy=gatewayDb.prepare("SELECT body FROM personal_csv_releases WHERE template=? AND version=?").get(release.id,release.version);
  assert.match(templateCopy.body,/返品.*除外/);
  assert.doesNotMatch(templateCopy.body.replace(/^name: hub-csv-[a-f\d-]+-v\d+$/m,""),/ノート|120|25|190/);
  const override=await postAs(sato,"/api/jobs",{kind:"assistant",company:"A社",ask:"返品も含めて今回だけ集計",
    csv_template_id:release.id,csv_override:{mode:"all"},contract:{name:"新CSV.csv",text:"品名,状態,金額\n鉛筆,販売,12\n鉛筆,返品,9"}});
  assert.equal(override.status,201);
  const overrideId=(await override.json()).id;
  await wide.goto(sato+"/#job/"+overrideId);
  await wide.locator("#memoText").waitFor();
  assert.match(await wide.locator("#memoText").innerText(),/合計\s+21/);
  const stillSaved=(await (await fetch(sato+"/api/workspace")).json()).templates.find(item=>item.id===release.id);
  assert.equal(stillSaved.recipe.exclude_value,"返品");
  const relativeSkill=join("skills","hub-csv-"+release.id+"-v1","SKILL.md");
  const actualSkill=await readFile(join(dir,"hermes-sato",relativeSkill),"utf8");
  assert.equal(actualSkill,templateCopy.body);
  await assert.rejects(readFile(join(dir,"hermes-tanaka",relativeSkill)),{code:"ENOENT"});
  await openJobOperation(wide,"集計条件を自分用に保存");
  await wide.getByLabel("保存先").selectOption(release.id);
  const updatedTemplateResponse=wide.waitForResponse(jobRequest("/api/templates"));
  await wide.getByRole("button",{name:"自分用に保存",exact:true}).click();
  const update=(await (await updatedTemplateResponse).json());
  assert.equal(update.version,2);
  assert.notEqual(update.hash,release.hash);
  const older=await (await fetch(sato+"/api/jobs/"+overrideId)).json();
  assert.equal(older.csv_skill.release.hash,release.hash);
  assert.equal(older.csv_skill.release.version,1);
  assert.equal(await readFile(join(dir,"hermes-sato",relativeSkill),"utf8"),actualSkill);

  const personalWorkflows=[];
  for (const [source,workflow,name,document] of [
    [autoPolicy,"source-answer","自分用の規程調査",file("新しい規程.md","第4条 申請は翌日の17時までに行う。")],
    [notice,"document-draft","自分用の制度案内",file("次の制度資料.txt","対象者は情報管理部。\n開始日は9月14日。")],
  ]) {
    await wide.goto(sato+"/#job/"+source);
    await openJobOperation(wide,"自分用の手順に保存");
    await wide.getByLabel("手順名").fill(name);
    const savedResponse=wide.waitForResponse(jobRequest("/api/templates"));
    await wide.getByRole("button",{name:"自分用に保存",exact:true}).click();
    const saved=await (await savedResponse).json();
    assert.equal(saved.hash,workflowHashes[workflow]);
    await wide.goto(sato+"/#skills");
    await wide.getByLabel("やりたいこと・資料名で検索").fill(name);
    await wide.getByRole("button",{name:new RegExp(name+".*自分が作成")}).click();
    await wide.getByRole("button",{name:"この手順で新しく依頼"}).click();
    await wide.locator("#request [name=contractFile]").setInputFiles(document);
    await wide.getByText(document.name+" を読み込みました。",{exact:true}).waitFor();
    const reusedResponse=wide.waitForResponse(r=>jobRequest("/api/jobs")(r)&&r.request().method()==="POST");
    await wide.getByRole("button",{name:"送信",exact:true}).click();
    const savedJob=(await (await reusedResponse).json()).id;
    await wide.waitForURL("**/#job/"+savedJob);
    await wide.locator("#memoText").waitFor();
    const persisted=await (await fetch(sato+"/api/jobs/"+savedJob)).json();
    assert.equal(persisted.personal_template_ref,saved.id+":1");
    assert.equal(persisted.standard_hash,saved.hash);
    assert.equal(persisted.work_tool.workflow.name,workflow);
    assert.deepEqual(persisted.sources.map(item=>item.title),[document.name]);
    const denied=await postAs(tanaka,"/api/jobs",{kind:"assistant",company:"B社",ask:"本人用の手順で依頼",
      personal_template:{id:saved.id,version:1},contract:{name:document.name,text:document.buffer.toString()}});
    assert.equal(denied.status,404);
    personalWorkflows.push({workflow,template:saved.id,job:savedJob,hash:saved.hash});
  }

  await wide.goto(sato+"/#job/"+quotes+"/version/2");
  await wide.getByRole("button",{name:"この版を採用して個人スキルに保存",exact:true}).click();
  await wide.getByText("本人用の個人スキルに保存済み",{exact:true}).waitFor();
  await wide.getByRole("button",{name:"チーム公開の草案を作る",exact:true}).click();
  await wide.getByRole("button",{name:"個人の草案に保存",exact:true}).click();
  const submittedDraft=wide.waitForResponse(jobRequest("/api/jobs/"+quotes+"/submit-draft"));
  await wide.getByRole("button",{name:"管理者に公開を申請する",exact:true}).click();
  assert.equal((await submittedDraft).status(),200);
  const ownerDraft=(await (await fetch(sato+"/api/jobs/"+quotes)).json()).draft;
  assert.equal(ownerDraft.state,"pending");
  assert.doesNotMatch(ownerDraft.instruction,/甲社|乙社|1700|2200/);
  assert.equal((await (await fetch(tanaka+"/api/workspace")).json()).procedures.some(item=>item.id===ownerDraft.id),false);
  assert.equal((await postAs(admin,"/api/admin/procedures/"+ownerDraft.id+"/publish",{hash:ownerDraft.hash},{Authorization:auth})).status,200);
  await wide.goto(sato+"/#skills");
  await wide.getByLabel("やりたいこと・資料名で検索").fill("見積");
  for (const [label,provider] of [["2社の見積比較","会社標準"],["2社見積比較のチーム手順","チーム共有"],["自分の見積比較","自分が作成"]])
    await wide.getByRole("button",{name:new RegExp(label+".*"+provider)}).waitFor();
  await screenshot(wide,"1440-sato-catalog-all-providers");
  const newQuoteData={kind:"assistant",company:"B社",ask:"公開手順で見積比較",procedure_id:ownerDraft.id,
    contract:{name:"新南社.txt",text:"料金は860円。\n期間は1年。"},second_attachment:{name:"新北社.txt",text:"料金は990円。"}};
  assert.equal((await postAs(tanaka,"/api/jobs",newQuoteData)).status,403);
  const tanakaNow=await (await fetch(admin+"/api/admin/memberships/tanaka",{headers:{Authorization:auth}})).json();
  assert.equal((await postAs(admin,"/api/admin/memberships/tanaka",{base:tanakaNow.revision,team:"営業企画部",reason:"新規業務で再度配布対象として検証"},{Authorization:auth})).status,200);
  await desk.goto(tanaka+"/#skills");
  await desk.getByLabel("やりたいこと・資料名で検索").fill("見積");
  await desk.getByRole("button",{name:/2社見積比較のチーム手順.*チーム共有/}).waitFor();
  assert.equal(await desk.getByText("自分の見積比較",{exact:true}).count(),0);
  const acceptedTeam=await postAs(tanaka,"/api/jobs",newQuoteData);
  assert.equal(acceptedTeam.status,201,await acceptedTeam.clone().text());
  const teamJob=(await acceptedTeam.json()).id;
  await desk.goto(tanaka+"/#job/"+teamJob);
  await desk.locator("#memoText table").waitFor();
  const resultTable=await desk.locator("#memoText table").innerText();
  assert.match(resultTable,/860円/);
  assert.match(resultTable,/990円/);
  const preview=await postAs(admin,"/api/admin/procedures/"+ownerDraft.id+"/preview-revision",{base:ownerDraft.hash,criteria:["料金"]},{Authorization:auth});
  assert.equal(preview.status,200);
  const newVersion=await preview.json();
  assert.equal((await postAs(admin,"/api/admin/procedures/"+ownerDraft.id+"/revise",{base:ownerDraft.hash,hash:newVersion.hash,criteria:["料金"]},{Authorization:auth})).status,200);
  const pinned=await (await fetch(tanaka+"/api/jobs/"+teamJob)).json();
  assert.equal(pinned.skill_hash,ownerDraft.hash);
  assert.equal(pinned.skill_version,1);
  const personalQuote=(await (await fetch(sato+"/api/workspace")).json()).quote_skills.find(item=>item.job===quotes);
  const applyPersonal={base:1,latest:1,instruction:"本人の比較項目で元の資料を再確認",catalog_procedure:{key:"personal:"+personalQuote.id,version:1}};
  assert.equal((await postAs(tanaka,"/api/jobs/"+teamJob+"/revise",applyPersonal)).status,404);
  async function applyFromCatalog(base,expected,item,instruction) {
    await wide.goto(sato+"/#job/"+catalogJob+"/version/"+base);
    await wide.getByRole("button",{name:"この相談で使う",exact:true}).click();
    await wide.getByRole("button",{name:"カタログから手順を探す",exact:true}).click();
    await wide.getByLabel("やりたいこと・資料名で検索").fill("見積");
    await wide.getByRole("button",{name:item}).click();
    await wide.getByRole("button",{name:"この相談で使う",exact:true}).click();
    await wide.getByLabel("今回の希望").fill(instruction);
    const applied=wide.waitForResponse(response=>jobRequest("/api/jobs/"+catalogJob+"/revise")(response) && response.request().method()==="POST");
    await wide.getByRole("button",{name:"この手順を適用",exact:true}).click();
    assert.equal((await applied).status(),200);
    await wide.waitForURL("**/#job/"+catalogJob+"/version/"+expected);
  }
  await applyFromCatalog(1,2,/自分の見積比較.*自分が作成/,applyPersonal.instruction);
  await wide.getByText("適用した手順　自分の見積比較 ・ 第1版",{exact:true}).waitFor();
  const applyTeam={base:2,latest:2,instruction:"公開版の項目で同じ資料を再確認",catalog_procedure:{key:"team:"+ownerDraft.id,version:2}};
  await applyFromCatalog(2,3,/2社見積比較のチーム手順.*チーム共有/,applyTeam.instruction);
  await wide.getByText("適用した手順　"+newVersion.name+" ・ 第2版",{exact:true}).waitFor();
  await wide.reload();
  await wide.getByText("適用した手順　"+newVersion.name+" ・ 第2版",{exact:true}).waitFor();
  const revisedCatalogJob=await (await fetch(sato+"/api/jobs/"+catalogJob)).json();
  assert.deepEqual(revisedCatalogJob.sources,fixed.sources);
  assert.equal(revisedCatalogJob.versions[1].applied_procedure.hash,personalQuote.hash);
  assert.equal(revisedCatalogJob.versions[2].applied_procedure.hash,newVersion.hash);
  assert.deepEqual(revisedCatalogJob.versions[2].work_tool.table.rows.map(row=>row.label),["料金"]);
  assert.equal((await postAs(admin,"/api/admin/procedures/"+ownerDraft.id+"/revoke",{hash:newVersion.hash},{Authorization:auth})).status,200);
  assert.equal((await postAs(tanaka,"/api/jobs",newQuoteData)).status,423);
  assert.equal((await postAs(sato,"/api/jobs/"+catalogJob+"/revise",{...applyTeam,latest:3})).status,423);
  console.log(JSON.stringify({catalogJob,inContext:quotes,inContextVersion:appliedVersion.version,providers:["会社標準","チーム共有","自分が作成"],
    physicalCsv:{path:relativeSkill,hash:createHash("sha256").update(actualSkill).digest("hex"),isolated:true},personalCsv:release,updatedCsv:update,overrideId,personalWorkflows,
    publication:ownerDraft.id,teamJob,firstVersionPinned:pinned.skill_version,revokeDenied:423,
    appliedPersonal:{version:2,hash:personalQuote.hash,peerDenied:404},
    appliedShared:{version:3,hash:newVersion.hash,criteria:["料金"],sameSourceFiles:true,revokeDenied:423}},null,2));

  await mentions();

  const privateJob=await newRequest("MZT の定義を調べて",[],async form=>{
    await form.getByRole("button",{name:"依頼の設定"}).click();
    await form.getByText("社内の資料置き場を選ぶ",{exact:true}).click();
    await form.getByRole("checkbox",{name:/限定規程/}).check();
  });
  const originalPrivate=await (await fetch(sato+"/api/jobs/"+privateJob)).json();
  assert.match(originalPrivate.sources[0].text,/営業企画部でのみ/);
  const satoMember=directory.find(person=>person.actor==="sato");
  const movedOwner=await fetch(admin+"/api/admin/memberships/sato",{
    method:"POST",headers:{Authorization:auth,Origin:admin,"Content-Type":"application/json"},
    body:JSON.stringify({base:satoMember.revision,team:"別部門",reason:"旧索引の参照制限を検証"}),
  });
  assert.equal(movedOwner.status,200,await movedOwner.clone().text());
  assert.equal((await fetch(sato+"/api/jobs/"+privateJob)).status,404);
  assert.equal((await (await fetch(sato+"/api/jobs/search?q=MZT")).json()).some(job=>job.id===privateJob),false);
  assert.match(gatewayDb.prepare("SELECT sources_json FROM jobs WHERE id=?").get(privateJob).sources_json,/MZT/);
  await wide.reload();
  await wide.getByText("依頼が見つかりません。",{exact:true}).waitFor();
  console.log(JSON.stringify({privateJob,restrictedSourceAfterTransfer:404,indexRetainedButHidden:true},null,2));
}

try {
  await runScenario();
} finally {
  await browser?.close();
  if (child?.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  runsServer.close();
  workGateway?.close();
  peerGateway?.close();
  gatewayDb?.close();
  await rm(dir, { recursive: true, force: true });
}
