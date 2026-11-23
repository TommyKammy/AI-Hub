import { HubError } from "./operations.mjs";
import { createHash } from "node:crypto";

// Read just the header, including quoted commas, doubled quotes and embedded newlines.
function csvHeader(text) {
  const input=text.replace(/^\uFEFF/,"");
  const cell=/(?:"((?:[^"]|"")*)"|([^",\r\n]*))(,|\r?\n|\r|$)/y;
  const header=[];
  while (true) {
    const m=cell.exec(input);
    if (!m) throw new HubError(400,"CSVの見出しを読み取れません。");
    header.push((m[1]?.replaceAll('""','"') ?? m[2]).trim());
    if (m[3]!==",") break;
  }
  if (header.includes("") || new Set(header).size!==header.length)
    throw new HubError(400,"CSVの列名は空欄と重複を避けてください。");
  return header;
}

export function checkCsvColumns(text, recipe) {
  const header=csvHeader(text);
  const missing=[recipe.amount_column,recipe.group_column,recipe.filter_column].filter(col=>col && !header.includes(col));
  if (missing.length) throw new HubError(400,"CSVに必要な列がありません。必要な列名は「"+[...new Set(missing)].join("」「")+"」です。");
}

export function recipeFromResult(result, sources) {
  if (result?.tool!=="aggregate_csv" || result.workflow?.name!=="csv-summary") return null;
  if (result.recipe) return result.recipe;
  // Older successful runs recorded the exact conditions as three display strings.
  const [amount,group,filter]=result.conditions || [];
  const source=sources.find(s=>s.id===result.evidence?.[0]?.source);
  if (!source || !amount?.startsWith("金額列　") || !group?.startsWith("グループ　")) return null;
  const match=/^(.+) が「(.+)」の行を(除外|採用)$/u.exec(filter);
  if (!match && filter!=="すべての明細行を採用") return null;
  if (match && filter.split(" が「").length!==2) return null;
  try {
    if (group==="グループ　全件" && csvHeader(source.text).includes("全件")) return null;
    const recipe={amount_column:amount.slice(4),group_column:group==="グループ　全件" ? "" : group.slice(5),
      filter_column:match?.[1] || "",exclude_value:match?.[3]==="除外" ? match[2] : "",include_value:match?.[3]==="採用" ? match[2] : ""};
    checkCsvColumns(source.text,recipe);
    return recipe;
  } catch { return null; }
}

export function csvSkillRelease(id, version, recipe) {
  const name="hub-csv-"+id+"-v"+version;
  const filter=recipe.filter_column ? recipe.filter_column+" が「"+(recipe.exclude_value || recipe.include_value)+"」の行を"+
    (recipe.exclude_value ? "除外" : "採用") : "すべての明細行を採用";
  const body="---\nname: "+name+"\ndescription: 本人が確認した条件で新しいCSVを集計する\n---\n\n# CSV集計\n\n"+
    "- 金額列: "+recipe.amount_column+"\n- グループ: "+(recipe.group_column || "全件")+"\n- 条件: "+filter+
    "\n- 出力列: "+(recipe.group_column || "対象")+"、"+recipe.amount_column+"（合計）\n";
  return {version,hash:createHash("sha256").update(body).digest("hex"),body};
}
