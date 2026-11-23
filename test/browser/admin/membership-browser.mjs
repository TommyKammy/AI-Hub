import { adminCredentials } from "../../support/admin-credentials.mjs";
import assert from "node:assert/strict";
import { api, base, chromium, company, model, project, records, select, selectModel, sharedProcedure,
  start, satoAnswer, tanakaAnswer } from "../../support/employee-browser-helpers.mjs";
const original = "営業企画部", destination = "業務企画部";

await selectModel();
const p = await sharedProcedure();
const browser = await chromium.launch({ channel: "chrome" });
try {
  const admin = await browser.newPage({ httpCredentials: adminCredentials(base("admin")) });
  await admin.goto(base("admin") + "/#memberships");
  async function move(team) {
    await admin.locator('[data-member="tanaka"]').click();
    await admin.getByLabel("異動先の部門名").fill(team);
    const reason = team === destination ? "B社の担当部門を変更するため" : "営業企画部での担当を再開するため";
    await admin.getByLabel("変更理由（必須）").fill(reason);
    await admin.getByRole("button", { name: "所属変更を確定する" }).click();
    await admin.locator("#dialog").waitFor({ state: "hidden" });
    await admin.locator("article").filter({ has: admin.locator('[data-member="tanaka"]') }).getByText(team, { exact: true }).waitFor();
    const { rows: [log] } = await api("admin", "admin/member-changes?employee=tanaka");
    assert.deepEqual([log.action, log.operator, log.before_team, log.after_team, log.reason],
      ["transfer", "aoki", team === destination ? original : destination, team, reason]);
    await admin.locator('#employeeChanges [data-change="' + log.seq + '"]').getByText(reason, { exact: false }).waitFor();
  }
  const initial = await api("tanaka", "workspace");
  if (initial.employee.team === destination) await move(original);
  assert.equal((await api("tanaka", "workspace")).employee.team, original);
  const tanaka = await start(browser, "tanaka", p);
  const stale = await select(browser, "tanaka", p);
  const before = await records("tanaka", tanaka.id);
  assert.deepEqual(before.receipts.map(row => row[0]), [tanaka.id + "-review"]);
  assert.ok(before.calls.every(c => c.phase === "review"));
  await move(destination);
  try {
    const ws = await api("tanaka", "workspace");
    assert.equal(ws.employee.team, destination);
    assert.equal(ws.skill, null);
    assert.ok(!ws.procedures.some(row => row.id === p.id));
    const blockedRequest = stale.waitForResponse(res => res.url() === base("tanaka") + "/api/jobs" && res.request().method() === "POST");
    await stale.getByRole("button", { name: "この手順で依頼する" }).click();
    const httpStatus = (await blockedRequest).status();
    assert.equal(httpStatus, 403);
    await stale.getByRole("alert").filter({ hasText: "現在の所属" }).waitFor();
    await stale.reload();
    await stale.getByText("現在の所属で利用できる手順はありません。").waitFor();
    await api("tanaka", "jobs", { company: company.tanaka, ask: "更新商談" }, 403);
    await api("tanaka", "admin/memberships/tanaka", { team: original, base: ws.employee.revision }, 403);
    await tanaka.page.getByLabel("Hermesへの回答").fill(tanakaAnswer);
    await tanaka.page.getByRole("button", { name: "回答して作業を続ける" }).click();
    await tanaka.page.getByRole("heading", { name: "所属変更により停止" }).waitFor();
    const stopped = await api("tanaka", "jobs/" + tanaka.id);
    assert.equal(stopped.status, "membership_blocked");
    assert.equal(stopped.answer, tanakaAnswer);
    assert.equal(stopped.memo, null);
    await api("tanaka", "jobs/" + tanaka.id + "/resume", {}, 403);

    assert.equal((await api("sato", "workspace")).employee.team, original);
    const sato = await start(browser, "sato", p);
    await sato.page.getByLabel("Hermesへの回答").fill(satoAnswer);
    await sato.page.getByRole("button", { name: "回答して作業を続ける" }).click();
    await sato.page.locator("#main .doc-body").waitFor({ timeout: 180000 });
    const done = await api("sato", "jobs/" + sato.id);
    assert.equal(done.status, "done");
    assert.equal(done.skill_hash, stopped.skill_hash);
    assert.ok(done.memo.includes(satoAnswer) && done.memo.includes("12月31日") && done.memo.includes("12月15日"));
    const completed = await records("sato", sato.id);
    assert.deepEqual(completed.receipts.map(row => row[0]), [sato.id + "-draft", sato.id + "-review"]);
    assert.deepEqual([...new Set(completed.calls.map(c => c.phase))].sort(), ["draft", "review"]);
    const after = await records("tanaka", tanaka.id);
    assert.deepEqual(after, before);
    assert.equal((await api("tanaka", "workspace")).jobs.length, ws.jobs.length);
    console.log(JSON.stringify({ project, model, procedure: { id: p.id, version: p.version, hash: p.hash, name: p.name },
      tanaka: { id: tanaka.id, from: original, to: destination, httpStatus, status: stopped.status, answer: stopped.answer, memo: stopped.memo, before, after },
      sato: { id: sato.id, team: original, status: done.status, memo: done.memo, ...completed } }, null, 2));
  } finally { await move(original); }
} finally { await browser.close(); }
