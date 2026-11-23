import assert from "node:assert/strict";
import test from "node:test";
import { createAdminApi } from "../../src/http/admin-routes.mjs";
import { openHub } from "../../src/jobs/hub.mjs";

test("管理ルートは権限判定と拒否監査で同じ対象を使う", async t => {
  const hub = openHub(":memory:");
  t.after(() => hub.close());
  const adminApi = createAdminApi({ db: hub.db });
  const auditor = { account: "audit-operator", role: "auditor" };
  const manager = { account: "manager-operator", role: "manager" };
  let bodyReads = 0;

  const request = (method, path, principal = auditor, input = Error("invalid body")) => adminApi({
    req: { method },
    url: new URL("/api/admin/" + path, "http://localhost"),
    principal,
    json: value => value,
    async readBody() {
      bodyReads++;
      if (input instanceof Error) throw input;
      return input;
    },
  });
  const denied = { status: 403, message: "この操作には管理操作の権限が必要です。" };
  const missing = { status: 404, message: "見つかりません。" };
  const longId = "x".repeat(257);

  assert.deepEqual(await request("GET", "session"), auditor);
  assert.deepEqual(await request("GET", "session", manager), manager);
  await assert.rejects(request("POST", "memberships/sato"), denied);
  await assert.rejects(request("GET", "memberships/sato/schedules"), denied);
  await assert.rejects(request("POST", "procedures/sample/quality"), denied);
  await assert.rejects(request("POST", "procedures/sample/quality", manager), missing);
  await assert.rejects(request("POST", "recoveries/origin/weekly/followup"), denied);
  await assert.rejects(request("DELETE", "models"), denied);
  await assert.rejects(request("GET", "models/sample/test"), denied);
  await assert.rejects(request("POST", "models/" + longId + "/test"), denied);
  await assert.rejects(request("POST", "standard-procedures"), denied);
  await assert.rejects(request("GET", "local-directory/group"), denied);
  await assert.rejects(request("PATCH", "local-directory/group/missing/save"), denied);
  await assert.rejects(request("PATCH", "local-directory/group/missing/save", manager), {
    status: 404, message: "ローカルの検証ディレクトリが設定されていません。",
  });
  await assert.rejects(request("GET", "groups/missing"), denied);
  await assert.rejects(request("GET", "groups/missing", manager), missing);
  assert.equal(bodyReads, 0);

  await assert.rejects(request("POST", "memberships/sato/access", auditor, { active: true }), denied);
  await assert.rejects(request("POST", "memberships/sato/access", auditor, { active: false }), denied);
  await assert.rejects(request("POST", "memberships/sato/access"), denied);
  assert.equal(bodyReads, 3);

  const events = hub.db.prepare("SELECT operator, scope, target, action FROM admin_audit ORDER BY seq").all();
  assert.deepEqual(events.map(({ operator, scope, target, action }) => [operator, scope, target, action]), [
    ["employee", "sato", "transfer"],
    ["employee", "sato", "GET schedules"],
    ["procedure", "sample", "quality"],
    ["job", "followup", "後続の週報を開始"],
    ["admin", "", "DELETE /api/admin/models"],
    ["admin", "", "その他の管理API"],
    ["model", longId.slice(0, 256), "test"],
    ["procedure", "", "会社標準手順の改訂"],
    ["admin", "", "その他の管理API"],
    ["group", "", "グループの保存"],
    ["group", "", "社員別の適用結果"],
    ["employee", "sato", "enable"],
    ["employee", "sato", "disable"],
    ["employee", "sato", "access"],
  ].map(event => [auditor.account, ...event]));
});
