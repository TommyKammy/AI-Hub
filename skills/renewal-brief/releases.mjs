import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function loadRelease(version, file, hash) {
  const instruction = readFileSync(new URL(file, import.meta.url), "utf8");
  if (createHash("sha256").update(instruction).digest("hex") !== hash)
    throw new Error("公開版 v" + version + " の手順ハッシュが一致しません。");
  return { version, hash, instruction };
}

const previous = loadRelease(1, "v1.md", "b5f25994d533d7641c9f28ff764f4f7bf738e20cc075b0f45bb84ae3ae385f40");
export const current = loadRelease(2, "SKILL.md", "68e57bbbfe096d8f7d2324af33247a5afadc8ebb9c057c1366e84952b38cd5da");
export const releases = new Map([previous, current].map(r => [r.hash, r]));
