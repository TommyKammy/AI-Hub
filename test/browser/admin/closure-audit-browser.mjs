// Read-only check against an already closed meeting in the disposable recovery stack.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import {adminCredentials} from "../../support/admin-credentials.mjs";
import {timestamp} from "../../../public/admin/audit-format.js";

const {chromium} = createRequire(new URL("../../", import.meta.url))(process.env.PLAYWRIGHT_PACKAGE || "@playwright/test");
const id = process.argv[2];
assert.match(id,/^[0-9a-f-]{36}$/);
const admin = "http://127.0.0.1:18833", employee = "http://127.0.0.1:18831";
const docker = (...args) => execFileSync("docker",["--context",process.env.AI_HUB_DOCKER_CONTEXT || "colima-mac-studio-solo",...args],{encoding:"utf8"});
function snapshot() {
  const hub = JSON.parse(docker("exec","hermes-recovery-verify-hub-1","node","-e",`
    const db=new(require("node:sqlite").DatabaseSync)("/data/hub.sqlite",{readOnly:true}), job=process.argv[1];
    console.log(JSON.stringify({
      job:db.prepare("SELECT status,run_id,memo FROM jobs WHERE id=?").get(job),
      closure:db.prepare("SELECT time,operator,reason FROM meeting_closures WHERE meeting=?").get(job),
      checks:db.prepare("SELECT time,outcome,operator FROM receipt_checks WHERE job=? AND phase='compose' ORDER BY seq").all(job),
      attempts:db.prepare("SELECT phase,hermes_run_id,dispatch_time FROM attempts WHERE job_id=?").all(job)
    }));`,id));
  const admissions = JSON.parse(docker("exec","hermes-recovery-verify-sato-1","python","-c",
    `import json,sqlite3,sys
db=sqlite3.connect("file:/opt/data/state.db?mode=ro",uri=True)
print(json.dumps(db.execute("SELECT request_id FROM session_admissions WHERE target_session_id=? AND principal_id='api' ORDER BY request_id",(sys.argv[1],)).fetchall()))`,"hub-"+id+"-compose"));
  const posts = docker("logs","hermes-recovery-verify-recovery-proxy-1").split("\n").filter(l=>l.startsWith("POST /v1/runs "+id+"-compose "));
  return {hub,admissions,posts};
}
const before = snapshot();
assert.equal(before.hub.job.status,"closed_unconfirmed");
assert.equal(before.admissions.length,1);
assert.equal(before.posts.length,1);
const checks = before.hub.checks.filter(c=>c.operator==="system:auto-receipt");
assert.deepEqual(checks.map(c=>c.outcome),["missing","missing","missing"]);
const browser = await chromium.launch({channel:"chrome"});
try {
  for (const [account,role] of [["aoki","管理者"],["mori","閲覧専用管理者"]]) {
    const page = await browser.newPage({httpCredentials:adminCredentials(admin,account)});
    await page.goto(admin+"/admin.html");
    await page.locator("#adminRole").filter({hasText:role}).waitFor();
    await page.getByRole("link",{name:"監査ログ",exact:true}).click();
    await page.getByText("対応終了した会議メモを検索",{exact:true}).click();
    const card = page.locator("#closureAudit");
    const field = card.getByLabel("依頼ID",{exact:true});
    const search = card.getByRole("button",{name:"終了記録を検索"});
    await field.fill(id);
    await search.click();
    await card.getByRole("heading",{name:"結果未確認で対応終了"}).waitFor();
    assert.deepEqual((await card.locator("li").allTextContents()),checks.map(c=>timestamp(c.time)+"　受付記録なし"));
    const closure = before.hub.closure;
    for (const value of ["依頼ID　"+id,"担当者　"+closure.operator,"終了日時（日本時間）　"+timestamp(closure.time),closure.reason])
      await card.getByText(value,{exact:true}).waitFor();
    if (process.env.RECOVERY_SCREENSHOTS) {
      await page.locator("#employee-history").evaluate(el=>el.scrollIntoView({block:"start"}));
      await page.screenshot({path:process.env.RECOVERY_SCREENSHOTS+"/closure-audit-"+account+".png"});
    }
    await field.fill("00000000-0000-4000-8000-000000000000");
    await search.click();
    await card.getByText("この依頼IDに該当する対応終了記録はありません。").waitFor();
    assert.equal(await card.locator("article").count(),0);
    await field.fill(id);
    await search.click();
    await card.getByText(closure.reason,{exact:true}).waitFor();
    assert.deepEqual(snapshot(),before,account+" の監査閲覧で記録が変化しました");
    await page.close();
    console.log(account,role,"照合3件・終了記録一致、状態・受付・POSTに変化なし");
  }
  const staff = await browser.newPage();
  assert.equal((await staff.request.get(employee+"/api/admin/audit/meeting-closures?job="+id)).status(),403);
  assert.equal((await staff.request.get(admin+"/api/admin/audit/meeting-closures?job="+id)).status(),401);
} finally { await browser.close(); }
