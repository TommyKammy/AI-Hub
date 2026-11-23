import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdminAuth, validAdminId } from "../admin-auth.mjs";

test("個人IDと本人のパスワードの組み合わせから操作者を特定する", t => {
  const dir = mkdtempSync(join(tmpdir(), "hub-admin-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const passwords = ["aoki", "mori"].map(id => {
    const secret = randomBytes(32).toString("base64url");
    writeFileSync(join(dir, id), secret + "\n", { mode: 0o600 });
    return secret;
  });
  const basic = (id, secret) => "Basic " + Buffer.from(id + ":" + secret).toString("base64");
  assert.deepEqual(loadAdminAuth(dir).authenticate(basic("aoki", passwords[0])), { account: "aoki", role: "auditor" });
  writeFileSync(join(dir, ".roles.json"), JSON.stringify({ aoki: "manager" }));
  const { authenticate, accountIds } = loadAdminAuth(dir);
  assert.deepEqual(accountIds.sort(), ["aoki", "mori"]);
  assert.deepEqual(authenticate(basic("aoki", passwords[0])), { account: "aoki", role: "manager" });
  assert.deepEqual(authenticate(basic("mori", passwords[1])), { account: "mori", role: "auditor" });
  for (const value of [undefined, basic("admin", passwords[0]), basic("mori", passwords[0]), basic("aoki", passwords[1])])
    assert.equal(authenticate(value), null);
  assert.equal(validAdminId("admin"), false);
  assert.equal(validAdminId("../test"), false);
  writeFileSync(join(dir, "admin"), passwords[0]);
  assert.throws(() => loadAdminAuth(dir));
});

test("認証済みの権限はホスト側の割り当てで決まり、不明な権限設定は拒否する", t => {
  const dir = mkdtempSync(join(tmpdir(), "hub-roles-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const password = randomBytes(32).toString("base64url");
  writeFileSync(join(dir, "test-user"), password, { mode: 0o600 });
  const token = "Basic " + Buffer.from("test-user:" + password).toString("base64");
  for (const role of ["manager", "auditor"]) {
    writeFileSync(join(dir, ".roles.json"), JSON.stringify({ "test-user": role }));
    assert.deepEqual(loadAdminAuth(dir).authenticate(token), { account: "test-user", role });
  }
  for (const config of ['{"test-user":"unknown"}', "null", "[]", "{"]) {
    writeFileSync(join(dir, ".roles.json"), config);
    assert.throws(() => loadAdminAuth(dir));
  }
});
