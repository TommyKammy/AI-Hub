import { createHash } from "node:crypto";
import { HubError } from "../operations.mjs";
import { activeMember } from "../identity/memberships.mjs";
import { quoteProcedure, resolvePublished } from "./procedures.mjs";

const hashOf=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function catalogProcedureReference(input) {
  if (!input || typeof input.key!=="string" || !/^(team|personal):[\w-]{1,80}$/.test(input.key) ||
      !Number.isSafeInteger(input.version) || input.version<1)
    throw new HubError(400,"適用する手順と版を確認してください。");
  return {key:input.key,version:input.version};
}

export function resolveAppliedProcedure(db,actor,reference,includeDeleted=false) {
  const {key,version}=catalogProcedureReference(reference);
  const member=activeMember(db,actor);
  const [provider,id]=key.split(":");
  let resolved;
  if (provider==="team") {
    const item=resolvePublished(db,actor,id,reference.hash);
    const teamQuote=quoteProcedure(item);
    resolved={version:item.version,name:item.name,hash:item.hash,kind:teamQuote ? "assistant" : "renewal",
      ...(teamQuote ? {workflow:"quote-comparison",teamQuote} : {instruction:item.instruction,layout:item.layout})};
  } else {
    const item=db.prepare(`SELECT p.*,r.hash AS csv_hash,r.body AS csv_body FROM personal_templates p
      LEFT JOIN personal_csv_releases r ON r.template=p.id AND p.version=r.version
      WHERE p.id=? AND p.actor=? AND (p.team IS NULL OR p.team=?)`).get(id,actor,member.team);
    if (item?.recipe) {
      const recipe=JSON.parse(item.recipe);
      const release=item.csv_hash && {version:item.version,hash:item.csv_hash,body:item.csv_body};
      resolved={name:item.name,version:item.version,hash:hashOf([item.name,recipe,release]),kind:"assistant",
        workflow:"csv-summary",csvSkill:{id,name:item.name,recipe,release}};
    } else if (item) {
      resolved={name:item.name,version:item.version,hash:hashOf([item.name,item.kind,item.ask,item.output_format,item.standard_hash]),
        kind:item.kind,workflow:item.standard_workflow,standardHash:item.standard_hash,instruction:item.ask,output:item.output_format};
    } else {
      const quote=db.prepare(`SELECT s.id,s.hash,s.criteria FROM quote_skills s JOIN jobs j ON j.id=s.job
        WHERE (? OR s.id NOT IN (SELECT skill FROM deleted_quote_skills)) AND s.id=? AND j.actor=? AND j.id IN (SELECT id FROM permitted_job_teams) AND s.hash IS NOT NULL`).get(Number(includeDeleted),id,actor);
      if (!quote) throw new HubError(404,"個人手順が見つかりません。");
      resolved={name:"自分の見積比較",version:1,hash:quote.hash,kind:"assistant",workflow:"quote-comparison",quoteSkill:quote};
    }
  }
  if (version!==resolved.version || (reference.hash && reference.hash!==resolved.hash))
    throw new HubError(409,"手順の版が変わりました。最新の手順を選び直してください。");
  return {...resolved,key};
}

export function requireRevisionProcedure(db,actor,job,phase) {
  if (!phase.startsWith("revise-")) return null;
  const row=db.prepare("SELECT applied_procedure FROM memo_versions WHERE job_id=? AND version=?").get(job,Number(phase.slice(7)));
  return row?.applied_procedure ? resolveAppliedProcedure(db,actor,JSON.parse(row.applied_procedure),true) : null;
}
