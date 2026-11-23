import { arrivalDocument, librarySelection } from "../documents/libraries.mjs";
import { HubError } from "../operations.mjs";
import { resolvePublished } from "../procedures/procedures.mjs";

export function assertDraftSources(db, member, sources) {
  const lookup=db.prepare(`SELECT j.sources_json,j.library_selection,j.procedure_id,j.skill_hash,j.recurring_draft FROM jobs j
    WHERE j.id=? AND j.actor=? AND j.id IN (SELECT id FROM permitted_job_teams)
    AND j.id NOT IN (SELECT job FROM deleted_jobs)`);
  const seen=new Set(), pending=[];
  function collect({template,quote,libraries,jobs=[]}) {
    if (template && !db.prepare(`SELECT 1 FROM personal_templates WHERE id=? AND version=? AND actor=?
      AND (team IS NULL OR team=?)`).get(template.id,template.version,member.actor,member.team))
      throw new HubError(403,"登録した個人手順の版を利用できません。");
    if (libraries?.length) librarySelection(member,libraries,db);
    if (quote) {
      const skill=db.prepare(`SELECT s.job FROM quote_skills s JOIN jobs j ON j.id=s.job
        WHERE s.id=? AND s.hash=? AND j.actor=? AND s.id NOT IN (SELECT skill FROM deleted_quote_skills)`).get(quote.id,quote.hash,member.actor);
      if (!skill) throw new HubError(403,"登録した見積比較スキルを利用できません。");
      pending.push(skill.job);
    }
    pending.push(...jobs);
  }
  collect(sources);
  while (pending.length) {
    const id=pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const row=lookup.get(id,member.actor);
    if (!row) throw new HubError(403,"登録した元の仕事を参照できません。");
    if (row.procedure_id) {
      try { resolvePublished(db,member.actor,row.procedure_id,row.skill_hash); }
      catch (error) {
        if (!(error instanceof HubError)) throw error;
        throw new HubError(403,"元の仕事で使用した公開手順を利用できません。");
      }
    }
    const selection=JSON.parse(row.library_selection || "[]");
    if (selection.length) librarySelection(member,selection.map(folder=>folder.id),db,selection[0].document);
    const prior=JSON.parse(row.recurring_draft || "null");
    if (prior) collect(prior);
    for (const source of JSON.parse(row.sources_json || "[]")) {
      if (source.library && !arrivalDocument(member,source.library,source.title,db)?.read)
        throw new HubError(403,"元の仕事が参照した資料を利用できません。");
      if (source.job) pending.push(source.job);
    }
  }
}
