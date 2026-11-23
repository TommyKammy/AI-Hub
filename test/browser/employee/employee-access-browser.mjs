import { adminCredentials } from "../../support/admin-credentials.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { api, base, chromium, model, project, records, selectModel, sharedProcedure, start,
  satoAnswer, tanakaAnswer } from "../../support/employee-browser-helpers.mjs";

await selectModel();
const p = await sharedProcedure();
const browser = await chromium.launch({ channel: "chrome" });
try {
  const admin = await browser.newPage({ httpCredentials: adminCredentials(base("admin")) });
  await admin.goto(base("admin") + "/#memberships");
  const auditor = await browser.newPage({ timezoneId: "America/Los_Angeles", httpCredentials: adminCredentials(base("admin"), "mori") });
  assert.notEqual(admin.context(), auditor.context());
  await auditor.goto(base("admin") + "/#memberships");
  const stopReason = "B社の担当権限を点検するため";
  const enableReason = "担当権限の点検が完了したため";
  async function setAccess(active, page = admin, changeReason = active ? enableReason : stopReason) {
    await page.reload();
    await page.locator("#adminAccount").getByText("aoki", { exact: true }).waitFor();
    const toggle = page.locator('[data-access="tanaka"]');
    await toggle.click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", { name: active ? "再有効化する" : "利用を停止する", exact: true });
    assert.equal(await dialog.getByRole("button", { name: "閉じる" }).evaluate(el => el === document.activeElement), true);
    await confirm.click();
    const reason = dialog.getByLabel("変更理由（必須）");
    assert.equal(await reason.evaluate(el => el.validity.valueMissing), true);
    await reason.fill(changeReason);
    await confirm.click();
    await dialog.waitFor({ state: "hidden" });
    await page.locator("article").filter({ has: toggle }).getByText(active ? "利用可能" : "利用停止中", { exact: true }).waitFor();
  }
  async function verifyDenied(active) {
    await auditor.reload();
    await auditor.locator("#adminAccount").getByText("mori", { exact: true }).waitFor();
    await auditor.getByText("閲覧専用", { exact: true }).waitFor();
    await auditor.getByLabel("対象社員").selectOption("tanaka");
    for (const name of ["利用を停止", "再有効化", "所属を変更"]) {
      assert.equal(await auditor.getByRole("button", { name, exact: true }).count(), 0);
    }
    assert.equal(await auditor.getByRole("link", { name: "社員の所属・利用状態" }).count(), 0);
    const employees = () => api("admin", "admin/memberships");
    const member = (await employees()).find(m => m.actor === "tanaka");
    assert.equal(member.active, !active);
    const historyPath = "admin/member-changes?employee=tanaka";
    const history = await api("admin", historyPath);
    const started = Date.now();
    const status = await auditor.evaluate(async input => {
      const res = await fetch("/api/admin/memberships/tanaka/access", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      return res.status;
    }, { base: member.revision, active, reason: "閲覧権限の動作確認", operator: "aoki", employee: "sato" });
    assert.equal(status, 403);
    assert.deepEqual((await employees()).find(m => m.actor === "tanaka"), member);
    assert.deepEqual(await api("admin", historyPath), history);
    const { rows: [event] } = await api("admin", "admin/audit?employee=tanaka");
    assert.deepEqual([event.operator, event.target, event.action, event.outcome, event.change_seq, event.stopped_jobs],
      ["mori", "tanaka", active ? "enable" : "disable", "denied", null, 0]);
    assert.ok(event.time >= started - 1000 && event.time <= Date.now() + 1000);
    assert.equal(event.reason, null);
    return { account: "mori", activeRequested: active, status, activeAfter: member.active, revision: member.revision, event };
  }
  async function completeNew(actor, answer) {
    const { page, id } = await start(browser, actor, p);
    await page.getByLabel("Hermesへの回答").fill(answer);
    await page.getByRole("button", { name: "回答して作業を続ける" }).click();
    await page.locator("#main .doc-body").waitFor({ timeout: 180000 });
    const job = await api(actor, "jobs/" + id);
    assert.equal(job.status, "done");
    assert.ok(job.memo.includes(answer));
    const log = await records(actor, id);
    assert.deepEqual(log.receipts.map(r => r[0]), [id + "-draft", id + "-review"]);
    return { id, skill: job.skill_hash, status: job.status, ...log };
  }
  assert.equal((await api("admin", "admin/memberships")).find(m => m.actor === "tanaka").active, true);
  const old = await start(browser, "tanaka", p);
  await old.page.getByLabel("Hermesへの回答").fill(tanakaAnswer);
  const before = await records("tanaka", old.id);
  assert.deepEqual(before.receipts.map(r => r[0]), [old.id + "-review"]);
  assert.ok(before.calls.every(c => c.phase === "review"));
  const denied = [await verifyDenied(false)];
  await setAccess(false);
  let afterAnswer, sato, rejection;
  try {
    denied.push(await verifyDenied(true));
    const response = old.page.waitForResponse(r => r.url() === base("tanaka") + "/api/jobs/" + old.id + "/answer");
    await old.page.getByRole("button", { name: "回答して作業を続ける" }).click();
    rejection = (await response).status();
    assert.equal(rejection, 403);
    await old.page.getByRole("heading", { name: "利用停止中" }).waitFor();
    await api("tanaka", "workspace", undefined, 403);
    await api("tanaka", "jobs/" + old.id, undefined, 403);
    await api("tanaka", "jobs", { company: "B社", ask: "更新商談", procedure_id: p.id }, 403);
    await api("tanaka", "jobs/" + old.id + "/resume", {}, 403);
    await api("tanaka", "admin/memberships/tanaka/access", { active: true, base: 1 }, 403);
    sato = await completeNew("sato", satoAnswer);
    afterAnswer = await records("tanaka", old.id);
    assert.deepEqual(afterAnswer, before);
  } finally { await setAccess(true); }
  await old.page.getByRole("button", { name: "利用状態を確認" }).click();
  await old.page.getByRole("heading", { name: "社員の利用停止により終了" }).waitFor();
  const fresh = await completeNew("tanaka", tanakaAnswer);
  assert.notEqual(fresh.id, old.id);
  await api("tanaka", "jobs/" + old.id + "/answer", { answer: tanakaAnswer }, 409);
  await api("tanaka", "jobs/" + old.id + "/resume", {}, 409);
  const closed = await api("tanaka", "jobs/" + old.id);
  assert.equal(closed.status, "account_blocked");
  assert.equal(closed.answer, null);
  assert.equal(closed.memo, null);
  const afterEnable = await records("tanaka", old.id);
  assert.deepEqual(afterEnable, before);
  const history = await api("admin", "admin/member-changes?employee=tanaka");
  const [enabled, disabled] = history.rows;
  assert.deepEqual([enabled.action, enabled.before_active, enabled.after_active, enabled.reason], ["enable", 0, 1, enableReason]);
  assert.deepEqual([disabled.action, disabled.before_active, disabled.after_active, disabled.reason], ["disable", 1, 0, stopReason]);
  assert.ok(enabled.time >= disabled.time && enabled.seq > disabled.seq);
  assert.equal(disabled.operator, "aoki");
  assert.equal(enabled.operator, "aoki");
  for (const event of [enabled, disabled]) {
    assert.equal(event.employee, "tanaka");
    assert.equal(event.employee_name, "田中 翔");
  }
  await auditor.getByRole("link", { name: "管理操作の監査ログ" }).click();
  await auditor.getByLabel("対象社員").selectOption("tanaka");
  const audit = (await api("admin", "admin/audit?employee=tanaka")).rows.slice(0, 4);
  assert.deepEqual(audit.map(e => [e.action, e.outcome, e.operator]), [
    ["enable", "applied", "aoki"], ["enable", "denied", "mori"],
    ["disable", "applied", "aoki"], ["disable", "denied", "mori"],
  ]);
  assert.deepEqual(audit.map(e => e.change_seq), [enabled.seq, null, disabled.seq, null]);
  assert.deepEqual([audit[1].seq, audit[3].seq], [denied[1].event.seq, denied[0].event.seq]);
  const entries = auditor.locator("#employeeChanges article");
  await entries.first().getByText("操作者 aoki", { exact: false }).waitFor();
  for (const [index, event] of audit.entries()) {
    const row = entries.nth(index);
    const action = event.action === "disable" ? "利用停止" : "再有効化";
    const label = event.outcome === "denied" ? "拒否" : "変更済み";
    await row.getByText("田中 翔（tanaka） · " + action + "（" + label + "）", { exact: true }).waitFor();
    const time = new Date(event.time).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
    await row.getByText(time + " JST ／ 操作者 " + event.operator, { exact: true }).waitFor();
    if (event.outcome === "denied") {
      await row.getByText("拒否理由　管理操作の権限不足（HTTP 403）").waitFor();
      assert.equal(await row.getByRole("button").count(), 0);
    } else await row.getByText(event.reason, { exact: false }).waitFor();
  }
  await api("tanaka", "admin/audit", undefined, 403);
  const localStamp = millis => new Date(millis + 9 * 3600000).toISOString().slice(0, 19);
  const from = localStamp(audit[3].time), to = localStamp(audit[0].time + 600_000);
  await auditor.getByLabel("開始日時（日本時間）").fill(from);
  await auditor.getByLabel("終了日時（日本時間）").fill(to);
  const parseCsv = `import csv,json,sys
with open(sys.argv[1],"rb") as f: assert f.read(3) == bytes.fromhex("efbbbf")
with open(sys.argv[1],encoding="utf-8-sig",newline="") as f: print(json.dumps(list(csv.reader(f,strict=True))))`;
  const readDownload = async download => JSON.parse(execFileSync("python3", ["-c", parseCsv, await download.path()], { encoding: "utf8" }));
  const csvChecks = [];
  const originalCsv = new Map();
  const auditCells = rows => rows.evaluateAll(articles => articles.map(article => {
    const title = article.querySelector("b").innerText.match(/^(.*) · (.+)（(拒否|変更済み)）$/);
    const [time, who] = article.querySelector(".meta").innerText.split(" JST ／ 操作者 ");
    const applied = title[3] === "変更済み";
    const values = applied ? article.querySelector("p").innerText.split(" → ") : ["", ""];
    const reason = article.querySelector(".meta + p").innerText.replace(/^(拒否理由|理由)　/, "");
    const count = article.querySelector("button")?.innerText.match(/（(\d+)件）/)?.[1];
    return [time, who, title[1], title[2], title[3], ...values, reason, applied ? count ?? "0" : ""];
  }));

  async function checkFilter(operator, outcome) {
    await auditor.getByLabel("操作者", { exact: true }).selectOption(operator);
    await auditor.getByLabel("操作結果").selectOption(outcome);
    const expected = audit.filter(e => e.operator === operator && e.outcome === outcome);
    // Refresh the same conditions and check both the complete API page and the rendered rows.
    const [response] = await Promise.all([
      auditor.waitForResponse(res => {
        const url = new URL(res.url());
        return url.pathname === "/api/admin/audit" && url.searchParams.get("operator") === operator &&
          url.searchParams.get("outcome") === outcome && url.searchParams.get("employee") === "tanaka";
      }),
      auditor.getByRole("button", { name: "履歴を更新" }).click(),
    ]);
    assert.equal(response.status(), 200);
    const params = new URL(response.url()).searchParams;
    for (const [key, stamp] of [["from", from], ["to", to]])
      assert.equal(Date.parse(params.get(key) + "+09:00"), Date.parse(stamp + "+09:00"));
    const result = await response.json();
    assert.deepEqual(result.rows.map(e => e.seq), expected.map(e => e.seq));
    assert.equal(result.next, null);
    if (!expected.length) await auditor.locator("#employeeChanges").getByText("該当する記録はありません。").waitFor();
    for (const [i, event] of expected.entries()) {
      const row = entries.nth(i);
      await row.getByText("操作者 " + operator, { exact: false }).waitFor();
      assert.equal(await row.getAttribute(outcome === "denied" ? "data-denial" : "data-change"),
        String(event.change_seq ?? event.seq));
    }
    assert.equal(await entries.count(), expected.length);
    const visible = await auditCells(entries);
    const [download] = await Promise.all([
      auditor.waitForEvent("download"), auditor.getByRole("link", { name: "CSV出力" }).click(),
    ]);
    assert.equal(download.suggestedFilename(), "audit-log-tanaka-" + operator + "-" + outcome + ".csv");
    const [headers, ...downloaded] = await readDownload(download);
    assert.deepEqual(headers, ["日時（日本時間）", "操作者", "対象", "操作", "操作結果", "変更前", "変更後", "理由", "停止した依頼数"]);
    assert.deepEqual(downloaded, visible);
    if (!originalCsv.has(outcome) && downloaded.length) originalCsv.set(outcome, downloaded);
    if (expected.length && process.argv.includes("--save-csv"))
      await download.saveAs(fileURLToPath(new URL("../../../evidence/" + download.suggestedFilename(), import.meta.url)));
    csvChecks.push({ operator, outcome, filename: download.suggestedFilename(), rowsCompared: downloaded.length });
    return expected.map(e => e.seq);
  }
  await checkFilter("mori", "applied");
  const historyPath = "admin/audit/exports";
  const lastExport = (await api("admin", historyPath)).rows[0];
  assert.equal(lastExport.row_count, 0);
  // The history controls have second precision. Keep the empty export outside this case's period.
  await delay(Math.max(0, Math.floor(lastExport.started / 1000) * 1000 + 1000 - Date.now()));
  const started = Date.now();
  const moriDenied = await checkFilter("mori", "denied");
  const aokiApplied = await checkFilter("aoki", "applied");
  const filters = { employee: "tanaka", from, to, moriDenied, aokiApplied };
  await auditor.locator('#employeeChanges [data-change="' + disabled.seq + '"] button').click();
  const detail = auditor.getByRole("dialog");
  await detail.getByRole("heading", { name: "Hermes 送信記録" }).waitFor();
  for (const label of [stopReason, enableReason, old.id, before.receipts[0][1], "停止後の追加試行 0件"]) {
    await detail.getByText(label, { exact: false }).first().waitFor();
  }
  for (const event of [disabled, enabled]) {
    const row = detail.locator('[data-change="' + event.seq + '"]');
    await row.getByText("操作者 " + event.operator, { exact: false }).waitFor();
    await row.getByText(event.reason, { exact: false }).waitFor();
  }
  const path = "admin/member-changes/" + disabled.seq + "/dispatches";
  const trace = await auditor.evaluate(async path => {
    const res = await fetch("/api/" + path);
    if (!res.ok) throw Error("送信記録の取得に失敗");
    return res.json();
  }, path);
  assert.equal(trace.enabled.seq, enabled.seq);
  const job = trace.jobs.find(j => j.id === old.id);
  assert.equal(job.attempts_at_stop, 1);
  assert.equal(job.additional, 0);
  assert.deepEqual(job.sends.map(s => [s.phase, s.hermes_run_id]), [["review", before.receipts[0][1]]]);
  assert.ok(job.sends[0].dispatch_time <= disabled.time);
  await api("tanaka", path, undefined, 403);
  await api("sato", "admin/member-changes", undefined, 403);
  await detail.locator('a[href="/admin.html?job=' + old.id + '#usage"]').click();
  for (const call of before.calls) {
    const record = auditor.locator("#usageRows article").filter({ hasText: call.id });
    await record.locator("summary").click();
    await record.getByText("照合ID " + call.id).waitFor();
  }
  // Independently verify the two downloads as Aoki, including who exported vs whose actions were filtered.
  await admin.getByRole("link", { name: "管理操作の監査ログ" }).click();
  await admin.locator("#exportHistory > summary").click();
  const exportEvents = (await api("admin", historyPath)).rows.filter(e => e.seq > lastExport.seq);
  assert.equal(exportEvents.length, 2);
  for (const [i, event] of exportEvents.entries()) {
    const [operator, outcome, label] = i === 0 ? ["aoki", "applied", "変更済み"] : ["mori", "denied", "拒否"];
    assert.deepEqual([event.exported_by, event.employee, event.filter_operator, event.outcome, event.row_count],
      ["mori", "tanaka", operator, outcome, 2]);
    for (const [value, bound] of [[event.from_jst, from], [event.to_jst, to]])
      assert.equal(Date.parse(value + "+09:00"), Date.parse(bound + "+09:00"));
    assert.ok(started - 1000 <= event.started && event.started <= event.completed && event.completed <= Date.now() + 1000);
    const row = admin.locator('#exportRows [data-export="' + event.seq + '"]');
    await row.getByText("CSV出力 · 2件", { exact: true }).waitFor();
    const time = new Date(event.started).toLocaleString("ja-JP", {timeZone:"Asia/Tokyo", hour12:false});
    await row.getByText(time + " JST ／ 出力者 mori", { exact: true }).waitFor();
    await row.getByText("対象社員　tanaka ／ 抽出した操作の操作者　" + operator + " ／ 操作結果　" + label).waitFor();
    await row.getByText("対象期間（日本時間）　" + event.from_jst.replace("T"," ") + " 〜 " + event.to_jst.replace("T"," ")).waitFor();
  }
  await api("tanaka", historyPath, undefined, 403);
  // An unfiltered download after the export records exist must still contain only the original audit rows.
  await admin.getByRole("button", { name: "条件をクリア" }).click();
  const [allFile] = await Promise.all([admin.waitForEvent("download"),
    admin.getByRole("link", { name: "CSV出力" }).click()]);
  const [, ...allRows] = await readDownload(allFile);
  let auditCount = 0, cursor = null;
  do {
    const page = await api("admin", "admin/audit" + (cursor ? "?before=" + cursor : ""));
    auditCount += page.rows.length;
    cursor = page.next;
  } while (cursor);
  assert.equal(allRows.length, auditCount);
  assert.ok(allRows.every(row => row[3] !== "CSV出力" && ["変更済み","拒否"].includes(row[4])));
  const latest = (await api("admin", historyPath)).rows[0];
  assert.deepEqual([latest.exported_by, latest.employee, latest.filter_operator, latest.row_count], ["aoki", null, null, auditCount]);
  const exportWindow = { from: localStamp(exportEvents[1].started), to: localStamp(latest.started + 600_000) };
  const form = admin.locator("#exportFilters");
  async function expectExports(events) {
    const expectedQuery = await form.evaluate(el => new URLSearchParams([...new FormData(el)].filter(([, value]) => value)).toString());
    const [response] = await Promise.all([
      admin.waitForResponse(res => {
        const url = new URL(res.url());
        return url.pathname === "/api/admin/audit/exports" && url.searchParams.toString() === expectedQuery;
      }),
      form.getByRole("button", { name: "出力履歴を更新" }).click(),
    ]);
    const result = await response.json(), ids = events.map(e => e.seq);
    assert.equal(result.next, null);
    assert.deepEqual(result.rows.map(e => e.seq), ids);
    await admin.waitForFunction(ids => JSON.stringify(Array.from(document.querySelectorAll("#exportRows > [data-export]"),
      el => Number(el.dataset.export))) === JSON.stringify(ids), ids);
  }
  await form.getByLabel("出力日時の開始（日本時間）").fill(exportWindow.from);
  await form.getByLabel("出力日時の終了（日本時間）").fill(exportWindow.to);
  // Aoki's unfiltered download actually exists in the same output period.
  await expectExports([latest, ...exportEvents]);
  await form.getByLabel("出力者", { exact: true }).selectOption("mori");
  await expectExports(exportEvents);
  await form.getByLabel("出力対象の社員").selectOption("tanaka");
  await expectExports(exportEvents);
  for (const e of exportEvents) {
    const row = admin.locator('#exportRows [data-export="' + e.seq + '"]');
    await row.getByText("CSV出力 · 2件", { exact: true }).waitFor();
    await row.getByText("出力者 mori", { exact: false }).waitFor();
    const outcome = e.outcome === "applied" ? "変更済み" : "拒否";
    await row.getByText("対象社員　tanaka ／ 抽出した操作の操作者　" + e.filter_operator + " ／ 操作結果　" + outcome).waitFor();
    await row.getByText("対象期間（日本時間）　" + e.from_jst.replace("T"," ") + " 〜 " + e.to_jst.replace("T"," ")).waitFor();
  }
  assert.equal(await admin.locator('#exportRows [data-export="' + latest.seq + '"]').count(), 0);
  // Filtering by the recorded employee alone also excludes an export that selected all employees.
  await form.getByLabel("出力者", { exact: true }).selectOption("");
  await expectExports(exportEvents);
  await form.getByLabel("出力者", { exact: true }).selectOption("mori");
  await expectExports(exportEvents);
  const visibleHistory = await admin.locator("#exportRows article").evaluateAll(articles => articles.map(article => {
    const [type, count] = article.querySelector("b").innerText.split(" · ");
    const [time, exporter] = article.querySelector(".meta").innerText.split(" JST ／ 出力者 ");
    const [, employee, operator, outcome] = article.querySelector(".meta + p").innerText
      .match(/^対象社員　(.*?) ／ 抽出した操作の操作者　(.*?) ／ 操作結果　(.*)$/);
    const [from, to] = article.querySelector(":scope > p:last-of-type").innerText.replace("CSVの対象期間（日本時間）　", "").split(" 〜 ");
    return [type, time, exporter, employee, operator, outcome, "", from, to, count.replace(/件$/, ""), ""];
  }));
  const [historyFile] = await Promise.all([admin.waitForEvent("download"),
    form.getByRole("link", { name: "出力履歴をCSV保存" }).click()]);
  assert.equal(historyFile.suggestedFilename(), "csv-export-history-mori-tanaka.csv");
  const [historyHeader, ...savedHistory] = await readDownload(historyFile);
  assert.deepEqual(historyHeader, ["種別", "出力日時（日本時間）", "出力者", "対象社員", "抽出した操作の操作者",
    "操作結果", "抽出した履歴の出力者", "CSV対象開始（日本時間）", "CSV対象終了（日本時間）", "出力件数", "抽出した履歴の種別"]);
  assert.deepEqual(savedHistory, visibleHistory);
  assert.deepEqual(savedHistory.map(row => [row[0], row[2], row[3], row[4], row[5], row[9]]),
    [["CSV出力", "mori", "tanaka", "aoki", "変更済み", "2"], ["CSV出力", "mori", "tanaka", "mori", "拒否", "2"]]);
  const savedByAoki = (await api("admin", historyPath)).rows[0];
  assert.ok(savedByAoki.seq > latest.seq);
  assert.deepEqual([savedByAoki.source, savedByAoki.exported_by, savedByAoki.filter_exporter, savedByAoki.employee, savedByAoki.row_count],
    ["history", "aoki", "mori", "tanaka", 2]);
  await api("tanaka", historyPath + ".csv", undefined, 403);
  if (process.argv.includes("--save-history-csv")) {
    await historyFile.saveAs(fileURLToPath(new URL("../../../evidence/" + historyFile.suggestedFilename(), import.meta.url)));
    await admin.locator("#exportHistory").screenshot({ path: fileURLToPath(new URL("../../../evidence/history-csv-aoki.png", import.meta.url)) });
  }
  // Include Aoki's unfiltered audit download in the same time window as the history save.
  await form.getByLabel("出力日時の終了（日本時間）").fill("");
  await form.getByLabel("出力対象の社員").selectOption("");
  await form.getByLabel("出力者", { exact: true }).selectOption("aoki");
  await expectExports([savedByAoki, latest]);
  const sourceFilter = form.getByLabel("出力種別", { exact: true });
  await sourceFilter.selectOption("audit");
  await expectExports([latest]);
  await sourceFilter.selectOption("history");
  await expectExports([savedByAoki]);

  const row = admin.locator('#exportRows [data-export="' + savedByAoki.seq + '"]');
  const time = new Date(savedByAoki.started).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
  const [startTime, endTime] = [savedByAoki.from_jst, savedByAoki.to_jst].map(v => v.replace("T", " "));
  await row.getByText("出力履歴のCSV保存 · 2件", { exact: true }).waitFor();
  await row.getByText(time + " JST ／ 出力者 aoki", { exact: true }).waitFor();
  await row.getByText("対象社員　tanaka ／ 抽出した履歴の出力者　mori ／ 抽出した履歴の種別　すべて", { exact: true }).waitFor();
  await row.getByText("CSVの対象期間（日本時間）　" + startTime + " 〜 " + endTime, { exact: true }).waitFor();
  const link = form.getByRole("link", { name: "出力履歴をCSV保存" });
  const query = new URL(await link.getAttribute("href"), base("admin")).searchParams;
  assert.deepEqual([query.get("source"), query.get("exported_by"), Number(query.get("before"))],
    ["history", "aoki", savedByAoki.seq + 1]);
  const [file] = await Promise.all([admin.waitForEvent("download"), link.click()]);
  assert.equal(file.suggestedFilename(), "csv-export-history-aoki-history.csv");
  const [header, ...typeRows] = await readDownload(file);
  assert.deepEqual(header, historyHeader);
  assert.deepEqual(typeRows, [["出力履歴のCSV保存", time, "aoki", "tanaka", "", "", "mori", startTime, endTime, "2", "すべて"]]);
  if (process.argv.includes("--save-source-csv")) {
    await file.saveAs(fileURLToPath(new URL("../../../evidence/" + file.suggestedFilename(), import.meta.url)));
    await admin.locator("#exportHistory").screenshot({ path: fileURLToPath(new URL("../../../evidence/history-source-aoki.png", import.meta.url)) });
  }
  const typeSave = (await api("admin", historyPath)).rows[0];
  assert.ok(typeSave.seq > savedByAoki.seq);
  assert.deepEqual([typeSave.source, typeSave.exported_by, typeSave.filter_exporter, typeSave.filter_source, typeSave.employee, typeSave.row_count],
    ["history", "aoki", "aoki", "history", null, 1]);
  await expectExports([typeSave, savedByAoki]);
  await admin.locator('#exportRows [data-export="' + typeSave.seq + '"]').getByText("抽出した履歴の種別　出力履歴のCSV保存", { exact: false }).waitFor();
  const sourcePath = historyPath + "/" + savedByAoki.seq + "/rows";
  const originalIds = exportEvents.map(event => event.seq);
  async function openOriginals() {
    const sourceDetails = admin.locator('#exportRows > article > details[data-saved-rows="' + savedByAoki.seq + '"]');
    const summary = sourceDetails.locator(":scope > summary");
    await summary.focus();
    const [response] = await Promise.all([
      admin.waitForResponse(res => new URL(res.url()).pathname === "/api/" + sourcePath),
      summary.press("Enter"),
    ]);
    const page = await response.json();
    assert.equal(response.status(), 200);
    assert.deepEqual(page.rows.map(e => e.seq), originalIds);
    assert.equal(page.next, null);
    const rows = sourceDetails.locator(":scope > .saved-entries > article");
    await rows.nth(1).waitFor();
    assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(n => Number(n.dataset.export))), originalIds);
    for (const [index, e] of exportEvents.entries()) {
      const entry = rows.nth(index);
      await entry.getByText("CSV出力 · 2件", { exact: true }).waitFor();
      await entry.getByText("出力者 mori", { exact: false }).waitFor();
      await entry.getByText("対象社員　tanaka ／ 抽出した操作の操作者　" + e.filter_operator +
        " ／ 操作結果　" + (e.outcome === "denied" ? "拒否" : "変更済み"), { exact: true }).waitFor();
    }
    return sourceDetails;
  }
  await openOriginals();
  await api("tanaka", sourcePath, undefined, 403);
  const receiptBefore = (await api("admin", historyPath)).rows[0].seq;
  assert.equal(receiptBefore, typeSave.seq);
  // Repeat both audit downloads as Mori; both new receipts are also inside the original save's time window.
  await auditor.getByRole("link", { name: "管理操作の監査ログ" }).click();
  await auditor.getByLabel("対象社員", { exact: true }).selectOption("tanaka");
  await auditor.getByLabel("開始日時（日本時間）", { exact: true }).fill(from);
  await auditor.getByLabel("終了日時（日本時間）", { exact: true }).fill(to);
  await checkFilter("mori", "denied");
  await checkFilter("aoki", "applied");
  await form.getByLabel("出力者", { exact: true }).selectOption("mori");
  await form.getByLabel("出力対象の社員").selectOption("tanaka");
  await form.getByLabel("出力日時の終了（日本時間）").fill(exportWindow.to);
  await sourceFilter.selectOption("");
  const liveFilters = new URLSearchParams({ exported_by: "mori", employee: "tanaka", ...exportWindow });
  const live = (await api("admin", historyPath + "?" + liveFilters)).rows;
  const later = live.filter(event => event.seq > receiptBefore);
  assert.equal(later.length, 2);
  for (const [index, event] of later.entries())
    for (const key of ["exported_by", "employee", "filter_operator", "outcome", "from_jst", "to_jst", "row_count"])
      assert.equal(event[key], exportEvents[index][key]);
  await expectExports([...later, ...exportEvents]);
  await form.getByLabel("出力者", { exact: true }).selectOption("aoki");
  await form.getByLabel("出力対象の社員").selectOption("");
  await sourceFilter.selectOption("history");
  await expectExports([typeSave, savedByAoki]);
  const reopened = await openOriginals();
  if (process.argv.includes("--save-originals"))
    await reopened.locator("..").screenshot({ path: fileURLToPath(new URL("../../../evidence/aoki-saved-originals.png", import.meta.url)) });
  assert.equal((await api("admin", historyPath)).rows[0].seq, later[0].seq);
  const originalHistoryCheck = { receipt: savedByAoki.seq, initial: originalIds, repeated: later.map(e => e.seq),
    current: live.map(e => e.seq), reopened: (await api("admin", sourcePath)).rows.map(e => e.seq) };
  async function openAuditLogs(parent) {
    const checks = [];
    for (const event of exportEvents) {
      const expected = audit.filter(e => e.outcome === event.outcome);
      const detail = parent.locator('article[data-export="' + event.seq + '"] > details');
      const path = historyPath + "/" + event.seq + "/audit-rows";
      const [response] = await Promise.all([
        admin.waitForResponse(res => new URL(res.url()).pathname === "/api/" + path),
        detail.getByText("元の監査ログを見る", { exact: true }).press("Enter"),
      ]);
      assert.equal(response.status(), 200);
      const result = await response.json();
      assert.deepEqual(result.rows, expected);
      assert.equal(result.next, null);
      const rendered = detail.locator(":scope > .saved-entries > article");
      await rendered.nth(1).waitFor();
      const cells = await auditCells(rendered);
      assert.deepEqual(cells, originalCsv.get(event.outcome));
      await api("tanaka", path, undefined, 403);
      checks.push({ receipt: event.seq, outcome: event.outcome, ids: result.rows.map(e => e.seq), csvRows: cells });
    }
    return checks;
  }
  const originalAudit = await openAuditLogs(reopened);
  // A later stop must have its own B-company job and a real, distinct Hermes receipt.
  const second = await start(browser, "tanaka", p);
  const secondRecords = await records("tanaka", second.id);
  assert.notEqual(second.id, old.id);
  assert.equal(secondRecords.receipts.length, 1);
  assert.notEqual(secondRecords.receipts[0][1], before.receipts[0][1]);
  const colleague = await browser.newPage({ httpCredentials: adminCredentials(base("admin")) });
  await colleague.goto(base("admin") + "/#memberships");
  await verifyDenied(false);
  await setAccess(false, colleague, "再点検のための停止");
  try { await verifyDenied(true); }
  finally { await setAccess(true, colleague, "再点検後の再有効化"); }
  await colleague.close();
  // Prove all four later operations match the original CSV criteria, including its dates.
  const matchingNow = [];
  for (const event of exportEvents) {
    const params = new URLSearchParams({ employee: event.employee, operator: event.filter_operator,
      outcome: event.outcome, from: event.from_jst, to: event.to_jst });
    const { rows } = await api("admin", "admin/audit?" + params);
    const original = audit.filter(e => e.outcome === event.outcome);
    assert.deepEqual(rows.slice(2), original);
    assert.deepEqual(rows.slice(0, 2).map(e => [e.action, e.operator, e.target, e.outcome]),
      original.map(e => [e.action, e.operator, e.target, e.outcome]));
    assert.ok(rows.slice(0, 2).every(row => row.seq > audit[0].seq));
    matchingNow.push({ outcome: event.outcome, ids: rows.map(row => row.seq) });
  }
  await expectExports([typeSave, savedByAoki]);
  const afterChanges = await openOriginals();
  assert.deepEqual(await openAuditLogs(afterChanges), originalAudit);
  if (process.argv.includes("--save-audit-originals"))
    await afterChanges.locator("..").screenshot({ path: fileURLToPath(new URL("../../../evidence/saved-audit-originals.png", import.meta.url)) });
  assert.equal((await api("admin", historyPath)).rows[0].seq, later[0].seq);
  const [laterEnable, laterStop] = (await api("admin", "admin/member-changes?employee=tanaka")).rows;
  assert.ok(laterStop.seq > enabled.seq);
  const laterTrace = await api("admin", "admin/member-changes/" + laterStop.seq + "/dispatches");
  assert.equal(laterTrace.enabled.seq, laterEnable.seq);
  assert.deepEqual(laterTrace.jobs.map(j => [j.id, ...j.sends.map(s => s.hermes_run_id)]),
    [[second.id, secondRecords.receipts[0][1]]]);
  const moriCsv = exportEvents.find(e => e.outcome === "applied");
  const appliedCsv = afterChanges.locator('article[data-export="' + moriCsv.seq + '"]');
  const button = appliedCsv.locator('article[data-change="' + disabled.seq + '"]').getByRole("button", {name: /停止した依頼の送信記録/});
  const [reply] = await Promise.all([admin.waitForResponse(res => new URL(res.url()).pathname === "/api/" + path),
    button.press("Enter")]);
  assert.equal(reply.status(), 200);
  const fromSave = await reply.json();
  assert.deepEqual(fromSave, trace);
  assert.deepEqual(fromSave.jobs.map(j => j.id), [old.id]);
  assert.deepEqual(await records("tanaka", old.id), before);
  const dialog = admin.getByRole("dialog", { name: "Hermes 送信記録" });
  await dialog.getByText("参照元　保存記録 #" + savedByAoki.seq + "（aoki） → 監査ログCSV #" + moriCsv.seq + "（mori）", {exact:true}).waitFor();
  await dialog.getByRole("heading", {name:"B社の依頼"}).waitFor();
  assert.deepEqual(await dialog.locator("[data-change]").evaluateAll(rows => rows.map(r => Number(r.dataset.change))), [disabled.seq, enabled.seq]);
  assert.deepEqual(await dialog.locator("section .mono").allTextContents(), [old.id]);
  await dialog.getByText("停止時の送信試行 1件 ／ 停止後の追加試行 0件", {exact:true}).waitFor();
  const receiptRows = await dialog.locator("section p").filter({hasText:"Hermes 受付ID"}).allTextContents();
  assert.equal(receiptRows.length, 1);
  assert.ok(receiptRows[0].includes("質問生成") && receiptRows[0].endsWith(before.receipts[0][1]));
  const dialogText = await dialog.innerText();
  for (const excluded of [laterStop.reason, laterEnable.reason, second.id, fresh.id, sato.id,
    ...[...secondRecords.receipts, ...fresh.receipts, ...sato.receipts].map(([, id]) => id)])
    assert.ok(!dialogText.includes(excluded), excluded);
  if (process.argv.includes("--save-dispatch-trace"))
    await dialog.screenshot({path:fileURLToPath(new URL("../../../evidence/saved-dispatch-trace.png", import.meta.url))});
  await admin.keyboard.press("Escape");
  await dialog.waitFor({state:"hidden"});
  assert.ok(await button.evaluate(el => el === document.activeElement));
  console.log(JSON.stringify({ project, model, denied, audit, filters, csvChecks, exportEvents, exportWindow, allExport: latest, savedByAoki, savedHistory, typeSave, typeRows, originalHistoryCheck, originalAudit, matchingNow, auditCount, trace, fromSave, laterTrace, procedure: { id: p.id, version: p.version, name: p.name, hash: p.hash },
    stopped: { id: old.id, status: closed.status, answerHttp: rejection, answer: closed.answer, memo: closed.memo, before, afterAnswer, afterEnable },
    newAfterEnable: fresh, satoWhileStopped: sato }, null, 2));
} finally { await browser.close(); }
