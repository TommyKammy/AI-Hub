import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HubError } from "../operations.mjs";

export async function documentText(bytes,format,limit=12000) {
  let text;
  try {
    if (format === "pdf" || format === "docx") {
      const pdf = format === "pdf";
      const args = pdf ? ["-enc", "UTF-8", "-", "-"] : [fileURLToPath(new URL("../../infra/extract-docx.py", import.meta.url))];
      text = await new Promise((resolve, reject) => {
        const child = execFile(pdf ? "pdftotext" : "python3", args,
          { timeout: 8000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 },
          (error, stdout) => error ? reject(error) : resolve(stdout));
        child.stdin.on("error", reject);
        child.stdin.end(bytes);
      });
    } else text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HubError(422, "本文を読み取れません。保護されていない文書か UTF-8 のテキストを選んでください。");
  }
  text = text.replace(/\r\n?/g, "\n").replace(/\f/g, "\n").trim();
  if (!text || text.includes("\0")) throw new HubError(422, "文字を読み取れません。文字を選択できる資料を使ってください。");
  if (text.length > limit) throw new HubError(413, "資料は対象範囲を含む"+limit.toLocaleString("ja-JP")+"文字以内にしてください。");
  return text;
}
