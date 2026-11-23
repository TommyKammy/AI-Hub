import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { seedLegacyWorkspace, verifyLegacyWorkspace } from "./legacy-workspace-fixture.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PACKAGE || "playwright");
const directory = await mkdtemp(join(tmpdir(), "ai-hub-admin-check-"));
const file = join(directory, "hub.sqlite"), accounts = join(directory, "accounts");
const libraries = join(directory, "libraries"), library = join(libraries, "shared", "規程");
const directoryConfig=join(directory,"enterprise-fixture.json");
const tenant=randomUUID(), satoOid=randomUUID(), tanakaOid=randomUUID();
const password = randomBytes(24).toString("hex");
const server = createServer();
let posts = 0, child, browser;
server.on("request", async (request, response) => {
  for await (const _chunk of request) {}
  if (request.method === "POST" && request.url === "/v1/runs") {
    posts++;
    response.writeHead(502, { "Content-Type": "application/json" }).end("{}");
  } else response.writeHead(404).end();
});

async function listen(instance) {
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  return instance.address().port;
}
const url = port => "http://127.0.0.1:" + port;
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}
function db(fn, readOnly = true) {
  const handle = new DatabaseSync(file, { readOnly });
  try { return fn(handle); }
  finally { handle.close(); }
}
function auth(username) {
  return "Basic " + Buffer.from(username + ":" + password).toString("base64");
}
function post(origin, route, payload, username) {
  const headers = { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": randomUUID() };
  if (username) headers.Authorization = auth(username);
  return fetch(origin + route, { method: "POST", headers, body: JSON.stringify(payload) });
}

try {
  await mkdir(accounts, { mode: 0o700 });
  const legacyId = seedLegacyWorkspace(file);
  await mkdir(library, { recursive: true });
  await writeFile(join(library, "旅費規程.md"), "# 出張精算\n旅費は承認を受けて精算する。");
  await writeFile(directoryConfig,JSON.stringify({tenant,bindings:[{actor:"sato",objectId:satoOid},{actor:"tanaka",objectId:tanakaOid}]}),{mode:0o600});
  for (const name of ["aoki", "mori"]) await writeFile(join(accounts, name), password, { mode: 0o600 });
  await writeFile(join(accounts, ".roles.json"), '{"aoki":"manager","mori":"auditor"}', { mode: 0o600 });
  const fixture = url(await listen(server));
  const reserved = Array.from({ length: 3 }, () => createServer());
  const [satoPort, tanakaPort, adminPort] = await Promise.all(reserved.map(listen));
  await Promise.all(reserved.map(instance => new Promise(resolve => instance.close(resolve))));
  const employee = url(satoPort), tanaka = url(tanakaPort), admin = url(adminPort);
  async function boot() {
    child = spawn(process.execPath, ["server.mjs"], {
      cwd: new URL("../", import.meta.url),
      env: {
        PATH: process.env.PATH, DATA_DIR: directory, ADMIN_ACCOUNTS_DIR: accounts, LIBRARY_ROOT: libraries,
        AI_HUB_LOCAL_DIRECTORY_FILE:directoryConfig,
        SATO_PORT: String(satoPort), TANAKA_PORT: String(tanakaPort), ADMIN_PORT: String(adminPort),
        SATO_URL: fixture, SATO_KEY: password,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.resume();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw Error("Hub startup failed");
      if (await fetch(admin).then(response => response.status === 401).catch(() => false)) return;
      await delay(50);
    }
    throw Error("Hub did not start");
  }
  await boot();
  await verifyLegacyWorkspace(employee,legacyId);
  browser = await chromium.launch({ channel: "chrome" });
  const staff = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await staff.goto(employee);
  await staff.getByLabel("依頼内容", { exact: true }).waitFor();
  assert.equal(await staff.getByRole("link", { name: "管理者画面" }).count(), 0);
  assert.equal((await staff.request.get(employee + "/admin.html")).status(), 403);
  assert.equal((await fetch(admin + "/admin.html")).status, 401);
  const pages = {};
  for (const [username, width, role] of [["aoki", 1440, "管理者"], ["mori", 390, "閲覧専用管理者"]]) {
    const page = await browser.newPage({ httpCredentials: { username, password }, viewport: { width, height: 844 } });
    pages[username] = page;
    await page.goto(admin);
    await page.getByLabel("依頼内容", { exact: true }).waitFor();
    if (width === 390) await page.getByRole("button", { name: "メニューを開く", exact: true }).click();
    await page.getByRole("link", { name: "管理者画面", exact: true }).click();
    await page.locator("#adminRole").getByText(role, { exact: true }).waitFor();
  }
  const manager = pages.aoki, auditor = pages.mori;
  await manager.goto(admin+"/admin.html#groups");
  await manager.getByRole("button",{name:"グループを作成"}).click();
  const groupForm=manager.locator("#localGroupEditor");
  await groupForm.getByLabel("グループ名").fill("営業検証");
  await groupForm.getByRole("checkbox",{name:/佐藤/}).check();
  await groupForm.getByLabel("モデル選択方針").selectOption("fixed");
  await groupForm.getByLabel("社員",{exact:true}).selectOption("sato");
  await groupForm.getByLabel("資料区分").selectOption("restricted");
  await groupForm.getByRole("button",{name:"適用結果を確認"}).click();
  await groupForm.getByText("所属グループ　営業検証",{exact:true}).waitFor();
  await groupForm.getByLabel("変更理由").fill("標準モデルで試行");
  await groupForm.getByRole("button",{name:"グループを保存"}).click();
  const group=manager.locator("#adminGroupSummary article").filter({hasText:"営業検証"});
  await group.getByText(/標準モデルのみ/).waitFor();
  assert.equal((await (await fetch(employee+"/api/workspace")).json()).model_choices.scoped,true);
  await group.getByRole("button",{name:"編集"}).click();
  await groupForm.getByLabel("モデル選択方針").selectOption("inherit");
  await groupForm.getByRole("button",{name:"適用結果を確認"}).click();
  await groupForm.getByRole("button",{name:"グループを保存"}).waitFor();
  await groupForm.getByLabel("変更理由").fill("全社設定を継承する");
  await groupForm.getByRole("button",{name:"グループを保存"}).click();
  await group.getByText(/全社設定を継承/).waitFor();
  assert.equal((await (await fetch(employee+"/api/workspace")).json()).model_choices.scoped,false);
  await auditor.goto(admin+"/admin.html#groups");
  await auditor.locator("#adminGroupSummary").getByRole("heading",{name:"営業検証"}).waitFor();
  assert.equal(await auditor.getByRole("button",{name:"グループを作成"}).count(),0);
  assert.equal(await auditor.locator("#savedGroupAccess").count(),0);
  assert.equal((await post(admin,"/api/admin/groups/save",{},"mori")).status,403);
  assert.equal((await fetch(admin+"/api/admin/groups/access?actor=sato",{headers:{Authorization:auth("mori")}})).status,403);
  const audit=await (await fetch(admin+"/api/admin/audit",{headers:{Authorization:auth("mori")}})).json();
  assert.match(JSON.stringify(audit),/全社設定を継承する/);
  console.log("グループを作成・編集、社員と資料区分の適用を確認、利用設定・監査・閲覧者の403");

  assert.equal(await auditor.getByRole("link", { name: "ユーザアカウント" }).count(), 0);
  const directoryPath = "/api/admin/account-list";
  for (const path of [directoryPath, directoryPath + ".csv", "/api/admin/memberships/tanaka"]) {
    assert.equal((await fetch(employee + path)).status, 403);
    assert.equal((await fetch(admin + path, { headers: { Authorization: auth("mori") } })).status, 403);
  }
  await manager.locator("#adminAreas").getByRole("link", { name: "ユーザアカウント" }).click();
  await manager.getByLabel("氏名・メールアドレス・社員ID・担当").fill("田中翔");
  await manager.locator("#memberState").selectOption("active");
  await manager.getByRole("button", { name: "社員を絞り込む" }).click();
  const matches = manager.locator("#memberRows > article");
  await manager.locator("#memberStatus").getByText("1件の社員が見つかりました。").waitFor();
  assert.equal(await matches.count(), 1);
  await matches.getByRole("button", { name: "田中 翔" }).click();
  await manager.locator("#memberDetail h3").getByText("田中 翔").waitFor();
  await manager.getByRole("button", { name: "一覧に戻る" }).click();
  assert.equal(await manager.getByLabel("氏名・メールアドレス・社員ID・担当").inputValue(), "田中翔");
  assert.equal(await manager.locator("#memberState").inputValue(), "active");
  assert.equal(await matches.count(), 1);
  const [accountsDownload] = await Promise.all([
    manager.waitForEvent("download"),
    manager.getByRole("button", { name: "ユーザアカウントをCSV出力" }).click(),
  ]);
  const csv = (await readFile(await accountsDownload.path(), "utf8")).split("\r\n");
  assert.deepEqual(csv.slice(1), ['"tanaka","田中 翔","営業企画部","","利用可能","","一般社員"', ""]);
  const oldDirectory = await fetch(admin + directoryPath + "?q=tanaka", { headers: { Authorization: auth("aoki") } }).then(r => r.json());
  await matches.getByRole("button", { name: "所属を変更" }).click();
  await manager.getByLabel("担当", { exact: true }).fill("契約更新の取りまとめ");
  await manager.getByLabel("変更理由（必須）").fill("担当交代を記録");
  await manager.getByRole("button", { name: "所属変更を確定する" }).click();
  await matches.getByText("担当　契約更新の取りまとめ").waitFor();
  const changed = db(database => database.prepare("SELECT action,operator,time,reason FROM member_changes WHERE employee='tanaka'").get());
  assert.deepEqual([changed.action, changed.operator, changed.reason], ["responsibility", "aoki", "担当交代を記録"]);
  assert.ok(changed.time > 0);
  assert.equal((await fetch(admin + directoryPath + ".csv?q=tanaka&snapshot=" + oldDirectory.snapshot,
    { headers: { Authorization: auth("aoki") } })).status, 409);
  assert.equal((await post(admin, "/api/admin/memberships/tanaka/access", { base: 2, active: false, reason: "権限確認" }, "mori")).status, 403);
  assert.equal((await fetch(tanaka + "/api/workspace")).status, 200);
  await matches.getByRole("button", { name: "利用を停止" }).click();
  await manager.getByLabel("変更理由（必須）").fill("停止反映を確認");
  await manager.getByRole("dialog").getByRole("button", { name: "利用を停止する", exact: true }).click();
  await manager.locator("#memberStatus").getByText("条件に一致する社員はいません。").waitFor();
  assert.equal((await fetch(tanaka + "/api/workspace")).status, 403);
  console.log("TOM-114 社員・閲覧専用・管理の遷移／権限、担当と停止の監査、停止直後の拒否、絞り込み復帰／CSV一致");

  const create = await post(employee, "/api/jobs", { kind: "meeting", company: "A社", ask: "依頼の照合を検証", minutes: "棚卸しは12月4日。" });
  assert.equal(create.status, 201);
  const { id } = await create.json();
  for (let attempt = 0; attempt < 80; attempt++) {
    if (db(d => d.prepare("SELECT status FROM jobs WHERE id=?").get(id).status) === "unknown") break;
    await delay(100);
  }
  assert.equal(posts, 1);
  assert.equal(db(d => d.prepare("SELECT status FROM jobs WHERE id=?").get(id).status), "unknown");
  // Prepare three receipt outcomes in the fixture. The worker retry limits are separately exercised
  // by reconciliation.test.mjs with controlled time, including late results and restarts.
  db(database => {
    database.prepare("INSERT INTO meeting_receipt_retries(meeting,checks) VALUES(?,3)").run(id);
    const check = database.prepare("INSERT INTO receipt_checks(job,phase,operator,time,outcome) VALUES(?,'compose','system:auto-receipt',?,?)");
    for (let i = 0; i < 3; i++) check.run(id, Date.now() - 1000 + i, "ambiguous");
  }, false);
  const reason = "候補を一意に特定できなかった";
  const close = () => post(admin, "/api/admin/recoveries/" + id + "/close", { reason }, "aoki");
  assert.deepEqual((await Promise.all([close(), close()])).map(response => response.status), [200, 200]);
  await stop();
  await boot();
  assert.equal((await close()).status, 200);
  const snapshot = () => db(database => ({
    job: database.prepare("SELECT * FROM jobs WHERE id=?").get(id),
    closures: database.prepare("SELECT * FROM meeting_closures WHERE meeting=?").all(id),
    attempts: database.prepare("SELECT * FROM attempts WHERE job_id=?").all(id),
    checks: database.prepare("SELECT * FROM receipt_checks WHERE job=?").all(id),
    posts,
  }));
  const before = snapshot();
  assert.equal(before.closures.length, 1);
  assert.equal(before.job.status, "closed_unconfirmed");
  for (const page of [manager, auditor]) {
    await page.reload();
    await page.locator("#adminAreas").getByRole("link", { name: "監査ログ", exact: true }).click();
    await page.locator("#auditFilters #auditJob").fill(id);
    await page.locator("#auditFilters #auditReason").fill("一意に特定");
    await page.locator("#auditFilters #operatorFilter").selectOption("aoki");
    await page.locator("#auditFilters #outcomeFilter").selectOption("closed_unconfirmed");
    await page.getByRole("button", { name: "監査ログを検索" }).click();
    const card = page.locator("#employeeChanges [data-closure]");
    await card.getByText(reason, { exact: true }).waitFor();
    assert.equal(await card.locator("li").count(), 3);
    assert.equal(await card.count(), 1);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "CSV出力", exact: true }).click()]);
    const contents = await readFile(await download.path(), "utf8");
    assert.ok(contents.includes(id) && contents.includes(reason));
    assert.equal(contents.trimEnd().split("\r\n").length, 2);
    await page.getByText("CSV出力履歴", { exact: true }).click();
    await page.locator("#exportRows details").first().getByText("元の監査ログを見る", { exact: true }).click();
    await page.locator("#exportRows details").first().locator("[data-closure]").getByText(reason, { exact: true }).waitFor();
    assert.deepEqual(snapshot(), before);
  }
  assert.equal((await fetch(employee + "/api/admin/audit?job=" + id)).status, 403);
  assert.equal((await fetch(employee + "/api/admin/audit.csv?job=" + id)).status, 403);
  console.log("TOM-117 同じ依頼・担当者・結果・理由による検索、照合3件、管理／閲覧専用CSVと出力履歴、再起動と連打後も終了1件・作成POST1件");

  const manage = (path,payload) => post(admin, "/api/admin/" + path, payload, "aoki");
  assert.equal((await manage("memberships/tanaka/access", { base:3, active:true, reason:"手順配布試験" })).status, 200);
  assert.equal((await manage("memberships/tanaka", { base:4, team:"法務部", reason:"手順配布試験" })).status, 200);
  const source = await post(employee, "/api/jobs", { company:"A社", ask:"更新商談の準備", scheduled_at:Date.now()+86400000 });
  assert.equal(source.status, 201);
  const sourceId = (await source.json()).id;
  db(database=>database.prepare("UPDATE jobs SET status='done' WHERE id=?").run(sourceId),false);
  const draftResponse = await post(employee,"/api/jobs/"+sourceId+"/draft",{layout:"meeting"});
  assert.equal(draftResponse.status,200);
  const draft = await draftResponse.json();
  assert.equal((await post(employee,"/api/jobs/"+sourceId+"/submit-draft",{hash:draft.hash})).status,200);
  const route="procedures/"+draft.id;
  const delivery={base:draft.hash,revision:0,teams:["法務部"],recommended:["法務部"],trials:["法務部"],reason:"配布対象の検証"};
  assert.equal((await manage(route+"/delivery",delivery)).status,409);
  assert.equal((await manage(route+"/publish",{hash:draft.hash})).status,200);
  const employeeWorkspace = origin=>fetch(origin+"/api/workspace").then(response=>response.json());
  assert.equal((await employeeWorkspace(tanaka)).procedures.length,0);
  await manager.reload();
  await manager.locator("#adminAreas").getByRole("link", { name: "手順の品質" }).click();
  const quality = manager.locator("#qualityRows");
  await quality.getByRole("button",{name:"評価と版履歴を見る"}).click();
  const dialog=manager.getByRole("dialog");
  await dialog.getByRole("heading",{name:"評価用の入力例"}).waitFor();
  for (const legend of ["試行部署","公開時の配布先","推奨先"])
    await dialog.getByRole("group",{name:legend}).getByLabel("法務部",{exact:true}).check();
  await dialog.getByRole("group",{name:"公開時の配布先"}).getByLabel("営業企画部",{exact:true}).uncheck();
  await dialog.getByLabel("表示を確認する社員").selectOption("tanaka");
  await dialog.getByRole("button",{name:"社員の表示を確認する"}).click();
  await dialog.getByText(/田中 翔.*第1版を表示.*推奨.*試行部署/).waitFor();
  await dialog.getByLabel("変更理由（必須）").fill("法務部へ配布対象を変更");
  await dialog.getByRole("button",{name:"配布設定を保存する"}).click();
  await dialog.waitFor({state:"hidden"});
  assert.equal((await employeeWorkspace(employee)).procedures.length,0);
  assert.equal((await employeeWorkspace(tanaka)).procedures[0].recommended,true);
  const tanakaPage=await browser.newPage({viewport:{width:390,height:844}});
  await tanakaPage.goto(tanaka+"/#skills");
  await tanakaPage.getByRole("button",{name:/先方の希望から確認する更新商談.*推奨/}).waitFor();
  const previous = await post(tanaka,"/api/jobs",{company:"B社",ask:"旧版で受け付けた依頼",procedure_id:draft.id,scheduled_at:Date.now()+86400000});
  assert.equal(previous.status,201);
  const previousId = (await previous.json()).id;
  const previewInput = {base:draft.hash,layout:"contract"};
  const preview = await manage(route+"/preview-revision",previewInput).then(response=>response.json());
  assert.equal((await manage(route+"/revise",{...previewInput,hash:preview.hash})).status,200);
  const rolled = await manage(route+"/rollback",{base:preview.hash,hash:draft.hash,version:1,reason:"以前の品質を復元する"});
  assert.equal(rolled.status,200);
  assert.equal((await rolled.json()).version,3);
  const oldJob = await fetch(tanaka+"/api/jobs/"+previousId).then(response=>response.json());
  assert.equal(oldJob.skill_version,1);
  assert.equal(oldJob.skill_hash,draft.hash);
  assert.equal((await employeeWorkspace(tanaka)).procedures[0].version,3);
  await manager.getByRole("link",{name:"資料接続",exact:true}).click();
  const card = manager.locator("#libraryRows > article");
  await card.getByRole("heading",{name:"規程"}).waitFor();
  await card.getByRole("button",{name:"利用を停止する",exact:true}).click();
  await dialog.getByLabel("変更理由（必須）").fill("再同期前に利用を停止");
  await dialog.getByRole("button",{name:"利用を停止する",exact:true}).click();
  await dialog.waitFor({state:"hidden"});
  await card.getByText("停止中",{exact:true}).waitFor();
  assert.equal((await employeeWorkspace(employee)).libraries.length,0);
  const sourcePath="library-connections", folder="shared/規程";
  await rm(library,{recursive:true});
  const failed = await manage(sourcePath,{id:folder,base:1,action:"resume",reason:"置き場消失の試験"});
  assert.equal(failed.status,200);
  assert.ok((await failed.json()).error);
  await mkdir(library);
  await writeFile(join(library,"旅費規程.md"),"# 新版\n精算期限は翌月10日。");
  assert.equal((await employeeWorkspace(employee)).libraries.length,0);
  const resumed = await manage(sourcePath,{id:folder,base:2,action:"sync",reason:"置き場を再確認"});
  assert.equal(resumed.status,200);
  const sync = await resumed.json();
  assert.match(sync.version,/^[0-9a-f]{64}$/);
  assert.equal(sync.error,null);
  assert.equal((await employeeWorkspace(employee)).libraries[0].id,folder);
  assert.equal((await manage("memberships/tanaka",{base:5,team:"営業企画部",reason:"引き継ぎ試験"})).status,200);
  const createdProject=await post(employee,"/api/jobs/"+id+"/project",{name:"調達計画の確認"});
  assert.equal(createdProject.status,200);
  const projectId=(await createdProject.json()).id;
  db(database=>database.prepare("INSERT INTO meeting_actions(id,actor,job,version,line,assignee,due) VALUES(?,?,?,?,?,?,?)")
    .run(randomUUID(),"sato",id,1,"進捗の確認","田中 翔","2026-12-08"),false);
  await manager.getByRole("link",{name:"案件管理",exact:true}).click();
  const project=manager.locator("#projectRows article");
  await project.getByText(/責任者　佐藤 由衣/).waitFor();
  const changedProject=await post(employee,"/api/projects/"+projectId,{revision:0,members:["sato","tanaka"],responsible:"tanaka",
    due:"2026-12-10",reason:"田中に引き継ぐ"});
  assert.equal(changedProject.status,200);
  await manager.getByRole("button",{name:"案件を更新"}).click();
  await project.getByText(/責任者　田中 翔.*2026-12-10/).waitFor();
  await project.getByText("未完了事項（1件）",{exact:true}).waitFor();
  await project.getByText("引き継ぎ履歴",{exact:true}).click();
  await project.getByText("佐藤 由衣 → 田中 翔",{exact:true}).waitFor();
  await project.getByText(/田中に引き継ぐ/).waitFor();
  assert.equal((await fetch(admin+"/api/admin/projects",{headers:{Authorization:auth("mori")}})).status,403);
  assert.equal((await fetch(tanaka+"/api/jobs/"+id)).status,404);
  console.log("TOM-115 社員別の配布前後、非公開推奨拒否、試行と表示、旧版受付の固定、巻戻し、資料停止と失敗後の再同期、責任者交代と未完了事項");

  await manager.getByRole("link",{name:"利用ポリシー",exact:true}).click();
  const policy = manager.locator("#policyRows"), publish = policy.locator("#publishPolicy");
  await publish.getByLabel("新規の窓口起票を許可").uncheck();
  await publish.getByLabel("プロフィールの参照・記録を許可").uncheck();
  await publish.getByText("保持期間の試算",{exact:true}).click();
  await publish.getByLabel("添付を含む仕事（日）").fill("30");
  await publish.getByLabel("成果物を含む仕事（日）").fill("60");
  await publish.getByLabel("管理監査の記録（日）").fill("180");
  await publish.getByLabel("ポリシーを変更する理由（必須）").fill("窓口とプロフィールを一時停止");
  await publish.getByRole("button",{name:"利用ポリシーを公開する"}).click();
  await policy.getByRole("heading",{name:"公開版 v2"}).waitFor();
  await policy.getByText(/添付を含む仕事.*30日.*該当/).waitFor();
  assert.deepEqual((await employeeWorkspace(employee)).inquiry_desks,[]);
  assert.equal((await post(admin,"/api/admin/usage-policy/stop",{base:2,reason:"拒否を確認"},"mori")).status,403);
  const disable = policy.locator('[data-policy-action="stop"]');
  await disable.getByLabel("ポリシーを変更する理由（必須）").fill("全体の利用停止を確認");
  await disable.getByRole("button",{name:"利用を緊急停止する"}).click();
  await policy.getByRole("heading",{name:"公開版 v3"}).waitFor();
  const deniedJob={kind:"weekly",company:"A社",ask:"利用停止中の依頼"};
  assert.equal((await post(employee,"/api/jobs",deniedJob)).status,423);
  const restore = policy.locator('[data-policy-action="restore"]');
  await restore.getByLabel("復元する公開版").selectOption("1");
  await restore.getByLabel("ポリシーを変更する理由（必須）").fill("通常の利用を再開");
  await restore.getByRole("button",{name:"選択した公開版を復元する"}).click();
  await policy.getByRole("heading",{name:"公開版 v4"}).waitFor();
  assert.equal((await post(employee,"/api/jobs",{...deniedJob,scheduled_at:Date.now()+86400000})).status,201);
  await auditor.getByRole("link",{name:"アナリティクス",exact:true}).click();
  await auditor.locator("#usageOverviewRows").getByRole("heading", {name:"呼び出し明細", exact:true}).waitFor();
  assert.equal(await auditor.getByRole("link",{name:"利用ポリシー",exact:true}).count(),0);
  console.log("TOM-116 利用ポリシーを公開・停止・復元、社員の受付と窓口への反映、閲覧専用の変更拒否と利用集計");

  await manager.locator("#adminAreas").getByRole("link",{name:"グループと権限",exact:true}).click();
  const syncForm=manager.locator("#localSync");
  await syncForm.getByLabel("同期する社員").selectOption(tanakaOid);
  await syncForm.getByLabel("同期元の表示名").fill("田中 翔");
  await syncForm.getByLabel("同期元のメール").fill("employee@example.invalid");
  await syncForm.getByLabel("同期元で有効").uncheck();
  await syncForm.getByRole("button",{name:"差分を確認する"}).click();
  await syncForm.getByText(/適用前.*利用可能.*合成モデル A.*適用後.*利用停止中.*モデル なし/).waitFor();
  await syncForm.getByLabel("同期理由（必須）").fill("利用資格の同期試験");
  await syncForm.getByRole("button",{name:"確認した差分を適用する"}).click();
  await manager.locator("#directoryRows").getByText(/利用資格の同期試験/).waitFor();
  assert.equal((await fetch(tanaka+"/api/workspace")).status,403);
  assert.equal(await auditor.locator("#local-directory:visible").count(),0);
  assert.equal((await post(admin,"/api/admin/local-directory/apply",{tenant,externalId:tanakaOid,active:true},"mori")).status,403);
  await manager.locator("#adminAreas").getByRole("link",{name:"ユーザアカウント"}).click();
  await manager.locator("#memberQuery").fill("employee@example.invalid");
  await manager.locator("#memberState").selectOption("stopped");
  await manager.locator("#memberRole").selectOption("employee");
  await manager.locator("#memberFilters").getByRole("button",{name:"社員を絞り込む"}).click();
  await manager.locator("#memberRows").getByRole("button",{name:"田中 翔"}).click();
  await manager.locator("#memberDetail").getByText("メールアドレス　employee@example.invalid").waitFor();
  await manager.locator("#closeMemberDetail").click();
  assert.equal(await manager.locator("#memberQuery").inputValue(),"employee@example.invalid");
  console.log("TOM-124 管理画面の適用前モデル候補、差分の適用、資格の停止、同期履歴、閲覧専用からの直接更新拒否");
} finally {
  await browser?.close();
  await stop();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
