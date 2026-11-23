import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const file = process.argv[2] ?? new URL("../../../evidence/stage4-a-renewal-v2.json", import.meta.url);
const report = JSON.parse(await readFile(file, "utf8"));
// Compare against the archived inputs, independently of the model and its prompt.
const baseline = JSON.parse(await readFile(new URL("../../../evidence/stage4-a-renewal.json", import.meta.url), "utf8"));
assert.deepEqual(report.input, baseline.input);
assert.deepEqual(report.runs.map(r => [r.round,r.model]), baseline.runs.map(r => [r.round,r.model]));
assert.equal(report.answer, baseline.answer);
for (const run of report.runs) {
  assert.deepEqual(run.sources, baseline.runs[0].sources);
  assert.match(run.question, /12月31日/);
  assert.match(run.question, /12月15日/);
  const sections = run.memo.trim().split(/\n\s*\n/);
  assert.equal(sections.length, 2);
  const [heading, ...facts] = sections[0].split("\n");
  assert.equal(heading, "資料の事実");
  const expectedFacts = run.sources.flatMap(source =>
    source.text.match(/[^。]+。/g).map(sentence => sentence + " [" + source.id + "]"));
  assert.deepEqual(facts.toSorted(), expectedFacts.toSorted());
  assert.equal(sections[1], "社員の判断\n" + baseline.answer);
}
console.log("6件の入力、4文の出典、社員の判断を原文と照合しました。");
