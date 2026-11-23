// Run against the local synthetic Compose stack.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
const people = [
  ["http://127.0.0.1:18731", "A社", "12月31日", "3月31日"],
  ["http://127.0.0.1:18732", "B社", "3月31日", "12月31日"],
];
async function request(origin, path, data, key) {
  const res = await fetch(
    origin + path,
    data
      ? {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "Idempotency-Key": key || randomUUID(),
          },
          body: JSON.stringify(data),
        }
      : {},
  );
  return { status: res.status, body: await res.json() };
}
async function until(origin, id, expected) {
  for (let i = 0; i < 60; i++) {
    const { body } = await request(origin, "/api/jobs/" + id);
    if (body.status === expected) return body;
    assert.ok(
      ["queued", "dispatching", "running"].includes(body.status),
      "想定外の実行状態 " + body.status,
    );
    await delay(500);
  }
  assert.fail("Hermesの応答待ち時間を超えました。");
}
const hashes = [];
for (const [index, [origin, company, date, otherDate]] of people.entries()) {
  const other = people[1 - index][0],
    input = { company, ask: company + "の更新商談を準備して" },
    key = randomUUID();
  const result = await request(origin, "/api/jobs", input, key);
  assert.equal(result.status, 201);
  const { id } = result.body;
  assert.equal((await request(origin, "/api/jobs", input, key)).body.id, id);
  assert.equal((await request(other, "/api/jobs/" + id)).status, 404);
  assert.equal(
    (await request(other, "/api/jobs", input, randomUUID())).status,
    403,
  );
  const review = await until(origin, id, "waiting");
  assert.ok(review.question.includes(date));
  assert.equal(
    (
      await request(origin, "/api/jobs/" + id + "/answer", {
        answer: "日付は未確定。先方に確認する。",
      })
    ).status,
    200,
  );
  const done = await until(origin, id, "done");
  assert.ok(
    done.memo.includes(date) &&
      done.memo.includes("[1]") &&
      done.memo.includes("[2]"),
  );
  assert.ok(done.memo.includes(done.answer));
  assert.ok(!done.memo.includes(otherDate));
  hashes.push(done.skill_hash);
  console.log(company + " 質問・回答・成果物・他社員の拒否を確認");
}
assert.equal(hashes[0], hashes[1]);
console.log("公開版ハッシュ一致", hashes[0]);
