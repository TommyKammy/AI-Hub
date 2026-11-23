import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

function entry(port, fallback) {
  const selected = Number(port ?? fallback);
  assert.ok(Number.isInteger(selected) && selected>0 && selected<=65535);
  return "http://127.0.0.1:"+selected;
}
const employee = entry(process.env.AIHUB_CANDIDATE_EMPLOYEE_PORT,19631);
const admin = entry(process.env.AIHUB_CANDIDATE_ADMIN_PORT,19633);
const company = process.env.AIHUB_CANDIDATE_COMPANY ?? "A社";
assert.ok(["A社","B社"].includes(company));
const model = "qwen3.8-flash-next";
const passwordFile = process.env.AIHUB_CANDIDATE_ADMIN_FILE;
const manifestFile = process.env.AIHUB_CANDIDATE_MANIFEST;
const output = process.env.AIHUB_MODEL_RESULT;
assert.ok(passwordFile && manifestFile && output,"The isolated candidate, manifest and result path are required");
const token = "Basic "+Buffer.from("aoki:"+(await readFile(passwordFile,"utf8")).trim()).toString("base64");
const fixture = new URL("../../../evidence/2026-11-23-wp02-contracts/fixtures/",import.meta.url);
const text = async name=>(await readFile(new URL(name,fixture),"utf8")).trim();
const document = async name=>({name,text:await text(name)});
const normalize = value=>String(value ?? "").normalize("NFKC").replaceAll(",","");

async function api(origin,path,input,key) {
  const response = await fetch(origin+path,{
    method:input===undefined ? "GET" : "POST",
    headers:{...(input!==undefined && {Origin:origin,"Content-Type":"application/json"}),
      ...(origin===admin && {Authorization:token}),...(key && {"Idempotency-Key":key})},
    ...(input!==undefined && {body:JSON.stringify(input)}),
    signal:AbortSignal.timeout(240_000),
  });
  const data = await response.json();
  assert.ok(response.ok,path+" "+response.status+" "+(data.error ?? ""));
  return data;
}
const manager = (path,input)=>api(admin,path,input);
const job = id=>api(employee,"/api/jobs/"+id);
const submit = async (ask,input)=>{
  const {id} = await api(employee,"/api/jobs",{company,kind:"assistant",ask,...input},randomUUID());
  return id;
};
async function wait(id) {
  const until = Date.now()+180_000;
  while (Date.now()<until) {
    const current = await job(id);
    if (["done","unknown","failed","held","held_dispatched","membership_blocked"].includes(current.status)) return current;
    await delay(350);
  }
  throw Error("Model evaluation timed out for "+id);
}
async function calls(id) {
  const until = Date.now()+30_000;
  let rows;
  do {
    rows=(await manager("/api/admin/models/usage?job="+id)).rows;
    if (!rows.some(row=>row.outcome==="sending")) break;
    await delay(350);
  } while (Date.now()<until);
  return rows.map(row=>({
    requested:row.requested,served:row.served,outcome:row.outcome,tokens:row.total_tokens,phase:row.phase,
  }));
}
async function describe(id,current,checks) {
  const usage = await calls(id);
  return {id,status:current.status,memo:current.memo,modelVersion:current.model_version,
    checks:{...checks,localModelWasUsed:usage.length>0 && usage.every(row=>row.requested===model && row.served===model && row.outcome==="ok")},
    usage,
  };
}
const catalogPath = "/api/admin/models";
const startupDeadline=Date.now()+30_000;
while (Date.now()<startupDeadline) {
  const response=await fetch(employee+"/",{signal:AbortSignal.timeout(1000)}).catch(()=>null);
  if (response?.ok) break;
  await delay(150);
}
let catalog = await manager(catalogPath);
const local = catalog.models.find(row=>row.connection==="local-mlx" && row.model_id===model) ??
  await manager(catalogPath,{name:"候補版のローカルQwen",connection:"local-mlx",model_id:model,data_class:"合成資料"});
const probe=await manager(catalogPath+"/"+local.id+"/test",{});
assert.equal(probe.state,"passed");
if (catalog.current.model!==local.id) catalog=await manager(catalogPath+"/"+local.id+"/publish",{
  base:catalog.current.version,reason:"候補版の合成資料による文章品質の確認",
});
const report={candidateManifestHash:createHash("sha256").update(await readFile(manifestFile)).digest("hex"),
  model,proof:"Local real Hermes and local MLX. Only fixed synthetic inputs.",modelRelease:catalog.current.version,cases:{}};
async function assess(name, fn) {
  try { report.cases[name]=await fn(); }
  catch (error) {report.cases[name]={error:error.message};}
  await writeFile(output,JSON.stringify(report,null,2)+"\n",{mode:0o600});
}

await assess("A03",async()=>{
  const input = await document("sales.csv");
  const id = await submit("添付CSVを商品コード別に、金額列で集計してください。返品を含め全明細を使い、総合計と出典を示してください。",{contract:input});
  const first = await wait(id);
  const evidence = first.work_tool?.evidence ?? [];
  const result = await describe(id,first,{
    originalUnchanged:first.sources?.[0]?.text===input.text,
    fullTotal:/合計\D*1600\b/.test(normalize(first.memo)),
    fullSku:/A-1\D*800\b/.test(normalize(first.memo)),
    rawReturn:evidence.some(row=>row.text==="A-1,商品A,返品,-200" && row.label==="採用 ・ 3行目"),
  });
  if (first.status!=="done") return result;
  const edited = await api(employee,"/api/jobs/"+id+"/revise",{
    base:1,latest:1,instruction:"区分列が返品の行を除外して、商品コード別・金額の条件は変えずに再集計してください。",
  },randomUUID());
  const second = await wait(id);
  const revision=second.versions?.find(v=>v.version===edited.version);
  const revisedEvidence=revision?.work_tool?.evidence ?? second.work_tool?.evidence ?? [];
  let adopted = false;
  if (revision?.memo) {
    await api(employee,"/api/jobs/"+id+"/adopt",{version:revision.version,expected:second.adopted_version ?? revision.version});
    adopted=(await job(id)).adopted_version===revision.version;
  }
  result.revision=await describe(id,second,{
    resultTotal:/合計\D*1800\b/.test(normalize(revision?.memo)),
    sku:/A-1\D*1000\b/.test(normalize(revision?.memo)),
    retainedSource:second.sources?.[0]?.text===input.text,
    exactExcludedRow:revisedEvidence.some(row=>row.text==="A-1,商品A,返品,-200" && row.label==="除外 ・ 3行目"),
    adopted,
  });
  return result;
});

await assess("A04",async()=>{
  const [a,b] = await Promise.all([document("quote-a.md"),document("quote-b.md")]);
  b.text=b.text.split("\n").filter(line=>!line.startsWith("納期は")).join("\n");
  const id = await submit("2社の見積を比較してください。初期費用、月額保守費、納期、契約期間を4行の比較表にし、未記載の条件は要確認にしてください。",
    {contract:a,second_attachment:b});
  const result = await wait(id);
  const rows=result.work_tool?.table?.rows ?? [];
  const duration=rows.find(row=>row.label.includes("納期"))?.cells;
  const setup=rows.find(row=>row.label.includes("初期"))?.cells;
  return describe(id,result,{
    exactlyTwoSources:result.sources?.length===2 && result.sources[0].text===a.text && result.sources[1].text===b.text,
    exactLeadTime:duration?.[0]?.source===1 && duration[0].text==="納期は契約日から10営業日です。",
    absentLeadTime:duration?.[1]?.source===2 && duration[1].text==="要確認（記載なし）" && !duration[1].ref,
    exactSetup:setup?.[0]?.text==="初期費用は120,000円です。" && setup?.[1]?.text==="初期費用は100,000円です。",
  });
});

await assess("A05",async()=>{
  const input=await document("change.md");
  const id=await submit("添付した制度変更文をもとに案内を作成してください。対象者・開始日・必要な行動の3項目を原文から取り、書かれていなければ記載なしとしてください。",{contract:input});
  const result=await wait(id);
  const items=result.work_tool?.evidence ?? [];
  const missingAudience = await describe(id,result,{
    exactStart:items.some(e=>e.label==="開始日" && e.source===1 && e.text==="制度変更の施行日は12月1日です。"),
    exactAction:items.some(e=>e.label==="必要な行動" && e.source===1 && e.text==="精算申請は新しい申請フォームで提出してください。"),
    unknownAudience:items.some(e=>e.label==="対象者" && e.text==="記載なし" && e.source===undefined),
    noInventedAudience:typeof result.memo==="string" && !/全社員|契約社員|対象の社員/.test(result.memo),
  });
  const missingAction = {name:"対象と開始日だけの変更文.md",text:"対象者は営業企画部です。\n制度変更の施行日は12月1日です。"};
  const secondId=await submit("添付から社内案内を作成してください。対象者、開始日、必要な行動を示し、原文にない場合は記載なしとしてください。",{contract:missingAction});
  const second=await wait(secondId);
  const passages=second.work_tool?.evidence ?? [];
  missingAudience.missingAction=await describe(secondId,second,{
    exactAudience:passages.some(e=>e.label==="対象者" && e.source===1 && e.text==="対象者は営業企画部です。"),
    exactStart:passages.some(e=>e.label==="開始日" && e.source===1 && e.text==="制度変更の施行日は12月1日です。"),
    unknownAction:passages.some(e=>e.label==="必要な行動" && e.text==="記載なし" && e.source===undefined),
  });
  return missingAudience;
});

await assess("A06",async()=>{
  const [oldVersion,newVersion]=await Promise.all([document("policy-v2.md"),document("policy-v3.md")]);
  const id=await submit("出張を取り消した場合の提出物を教えてください。版と根拠の条項を確認してください。",{contract:newVersion});
  const result=await wait(id);
  const items=result.work_tool?.evidence ?? [];
  const checked=await describe(id,result,{
    exactArticle:items.some(e=>e.source===1 && e.text==="第8条　出張を取り消した場合は取消料の領収書と所属長の承認記録を提出する。"),
    bothItems:typeof result.memo==="string" && result.memo.includes("領収書") && result.memo.includes("承認記録"),
  });
  const diffId=await submit("旅費規程の旧版と新版を比較し、変更・追加・削除と根拠の原文を示してください。",{
    kind:"general",compare_documents:[oldVersion,newVersion],
  });
  const diff=await wait(diffId);
  const compared=normalize(diff.memo);
  checked.editionComparison=await describe(diffId,diff,{
    bothRates:compared.includes("2000") && compared.includes("2500"),
    exactCancellationRule:compared.includes("所属長の承認記録"),
    bothVersions:diff.sources?.[0]?.edition==="old" && diff.sources?.[1]?.edition==="new" &&
      diff.sources[0].text===oldVersion.text && diff.sources[1].text===newVersion.text,
  });
  return checked;
});
console.log(JSON.stringify(report,null,2));
const accepted = Object.values(report.cases).every(item=>
  [item,item.revision,item.missingAction,item.editionComparison].filter(Boolean)
    .every(run=>run.status==="done" && Object.values(run.checks).every(Boolean)));
if (!accepted) process.exitCode=1;
