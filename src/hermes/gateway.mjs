import { measuredSend, transaction } from "../operations.mjs";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { upstream } from "../models/catalog.mjs";
import { workPassages, receiptClient, canRequestPreference } from "../jobs/hub.mjs";
import { librarySelection, listLibraries, searchLibraries } from "../documents/libraries.mjs";
import { generalSynthetic, modelPolicyDenial, usagePolicy } from "../models/usage-policy.mjs";
import { splitJobPermitted } from "../jobs/work-split.mjs";
import { createHash } from "node:crypto";
import { profileProjection, saveEmployeePreference, writeProfileFiles } from "../workspace/employee-profile.mjs";
import { employeeGroupAllows } from "../identity/enterprise-directory.mjs";
import { quoteProcedure, resolvePublished } from "../procedures/procedures.mjs";
import { requireRevisionProcedure } from "../procedures/applied-procedure.mjs";
import { standardProcedureVersion } from "../procedures/standard-procedures.mjs";
import { readFileSync } from "node:fs";

const workflowTools = new Map([
  ["csv-summary", "aggregate_csv"],
  ["source-answer", "read_passages"],
  ["document-draft", "draft_document"],
  ["quote-comparison", "compare_quotes"],
]);
const workflowHashes = new Map([...workflowTools.keys()].map(name => [
  name,
  createHash("sha256").update(readFileSync(new URL("../../skills/" + name + "/SKILL.md", import.meta.url))).digest("hex"),
]));

function matchesPassage(item, passages) {
  const passage = passages.find(p => p.ref === item?.ref);
  return passage && item.source === passage.source && item.text === passage.text && item.offset === passage.offset;
}

function resultUsesJobSources(result, sources, passages) {
  if (!Array.isArray(result.evidence)) return false;
  if (result.tool === "compare_quotes") {
    const table = result.table;
    return sources.length === 2 && Array.isArray(table?.columns) && table.columns.length === 2 &&
      table.columns.every((title, i) => title === sources[i].title) &&
      Array.isArray(table.rows) && table.rows.length > 0 && table.rows.length <= 30 &&
      table.rows.every(row => typeof row?.label === "string" && row.label.length > 0 && row.label.length <= 100 &&
        Array.isArray(row.cells) && row.cells.length === 2 &&
        row.cells.every((cell, i) => cell?.source === sources[i].id &&
          (cell.ref === "" ? cell.text === "要確認（記載なし）" && cell.offset === null : matchesPassage(cell, passages))));
  }
  if (result.tool === "aggregate_csv") {
    if (!result.evidence.length) return false;
    const source = sources.find(s => s.id === result.evidence[0]?.source && /\.csv$/i.test(s.title));
    return source && result.evidence.every(item => item?.source === source.id &&
      typeof item.text === "string" && source.text.includes(item.text));
  }
  return result.evidence.every(item => matchesPassage(item, passages) ||
    (result.tool === "draft_document" && item && ["対象者", "開始日", "必要な行動"].includes(item.label) &&
      item.source === undefined && item.ref === undefined && item.text === "記載なし"));
}

// Only the native tool reply, matched to its call, acknowledges a profile write.
function savedUserPreference(messages) {
  const reply = messages.at(-1);
  if (reply?.role !== "tool" || !reply.tool_call_id || typeof reply.content !== "string") return false;
  const call = messages.findLast(m => m.role === "assistant")?.tool_calls?.find(c => c.id === reply.tool_call_id);
  if (call?.function?.name !== "memory") return false;
  try {
    const result = JSON.parse(reply.content.replace(/^<untrusted_tool_result [^>]*>\s*/, "").replace(/\s*<\/untrusted_tool_result>$/, ""));
    const args=JSON.parse(call.function.arguments);
    const operation=args.operations?.[0];
    return result.success === true && result.done === true && result.target === "user" && !result.staged &&
      args.target==="user" && args.operations.length===1 && operation.action==="add" &&
      typeof operation.content==="string" && operation.content.trim().length<=280 && operation.content.trim();
  } catch {
    return false;
  }
}

// Each listener is bound only to its employee's private network. The one-use
// attempt identifier is supplied by the worker outside the user input frame.
export function listenGateway(db, actor, host, port = 18800) {
  const readReceipt = receiptClient();
  const route =
    db.prepare(`SELECT j.id job,j.kind,j.phase,j.status,j.model_version,j.data_class,j.skip_profile,j.profile_project,j.profile_snapshot,m.id,m.connection,m.model_id
    FROM attempts a JOIN jobs j ON j.id=a.job_id AND j.phase=a.phase
    JOIN model_releases r ON r.version=j.model_version JOIN models m ON m.id=r.model
    JOIN memberships employee ON employee.actor=j.actor AND employee.active=1
    WHERE j.actor=? AND a.route_key=? AND a.member_revision=employee.revision AND (j.status IN ('dispatching','running') OR
      (j.status='unknown' AND j.run_id IS NULL AND a.hermes_run_id IS NULL))
    AND EXISTS (SELECT 1 FROM permitted_job_teams a WHERE a.id=j.id)
    AND NOT EXISTS (SELECT 1 FROM procedures p LEFT JOIN procedure_delivery d ON d.procedure=p.id
      WHERE p.id=j.procedure_id AND (p.revoked_at IS NOT NULL OR
        employee.team NOT IN (SELECT value FROM json_each(COALESCE(d.teams,json_array(p.scope))))))`);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "hub-managed", object: "model" }],
          }),
        );
      }
      const workTool = req.url === "/work-tool";
      if (req.method !== "POST" || (!workTool && req.url !== "/v1/chat/completions")) {
        res.writeHead(404);
        return res.end();
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 2_000_000) {
          res.writeHead(413);
          return res.end();
        }
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks));
      const release=usagePolicy(db);
      if (workTool) {
        if (release.settings.stopped) {res.writeHead(423);return res.end();}
        if (["prepare_quote_skill","confirm_quote_skill"].includes(payload.result?.tool)) {
          const skill=db.prepare(`SELECT s.*,v.memo,v.instruction,j.data_class,m.id AS model,m.connection,m.model_id,m.data_class AS model_data_class FROM quote_skills s JOIN jobs j ON j.id=s.job AND j.adopted_version=s.version AND j.phase=s.phase
            JOIN memo_versions v ON v.job_id=s.job AND v.version=s.version JOIN attempts a ON a.job_id=j.id AND a.phase=j.phase
            JOIN memberships e ON e.actor=j.actor AND e.active=1 AND e.revision=a.member_revision
            JOIN model_releases r ON r.version=j.model_version JOIN models m ON m.id=r.model AND m.stopped=0
            WHERE s.ticket=? AND j.actor=? AND j.status IN ('running','dispatching') AND j.id IN (SELECT id FROM permitted_job_teams)`).get(payload.ticket,actor);
          if (!skill) {res.writeHead(403); return res.end();}
          if (!employeeGroupAllows(db,actor,skill)) {res.writeHead(403);return res.end();}
          if (modelPolicyDenial(release,{id:skill.model,connection:skill.connection,data_class:skill.model_data_class},skill.data_class)) {
            res.writeHead(423); return res.end();
          }
          if (payload.result.tool==="prepare_quote_skill") {
            const labels=payload.result.criteria;
            if (!Array.isArray(labels) || !labels.length || labels.length>30 || new Set(labels).size!==labels.length ||
                !labels.every(s=>typeof s==="string" && /^[\p{L}\p{N}（）()・／/ ー]{1,40}$/u.test(s) && s===s.trim() && skill.memo.includes(s))) {
              res.writeHead(400); return res.end("採用版にある比較項目の名前だけを指定してください。");
            }
            const rules=payload.result.rules ?? [];
            if (!Array.isArray(rules) || rules.length>8 || !rules.every(rule=>typeof rule==="string" && rule.length>0 && rule.length<=160 &&
                !/[\n\r<>\[\]`]|[\d０-９,，]+\s*(円|万円|営業日|月額)/u.test(rule) && skill.instruction.includes(rule))) {
              res.writeHead(400); return res.end("判断ルールは本人の修正指示から汎用的な条件だけを抜き出してください。");
            }
            db.prepare("UPDATE quote_skills SET criteria=?,rules=? WHERE id=? AND criteria IS NULL")
              .run(JSON.stringify(labels),JSON.stringify(rules),skill.id);
            return res.end(JSON.stringify({id:skill.id,criteria:skill.criteria ? JSON.parse(skill.criteria) : labels,
              rules:skill.criteria ? JSON.parse(skill.rules) : rules}));
          }
          const hash=payload.result.hash;
          if (!skill.criteria || !/^[0-9a-f]{64}$/.test(hash) || (skill.hash && skill.hash!==hash)) {res.writeHead(409);return res.end();}
          db.prepare("UPDATE quote_skills SET hash=? WHERE id=?").run(hash,skill.id);
          return res.end("{}");
        }
        const permitted = db.prepare(`WITH tool_ticket AS (
          SELECT job,ticket,workflow,library_hits,NULL AS version,result FROM work_tool_results WHERE ticket=$ticket
          UNION ALL
          SELECT job,ticket,workflow,NULL,version,result FROM revision_tool_results WHERE ticket=$ticket
        )
          SELECT j.id,j.phase,j.sources_json,j.data_class,j.procedure_id,j.skill_hash,e.team,t.workflow,t.library_hits,t.version,t.result,
          CASE WHEN t.version IS NULL THEN j.library_selection END library_selection,
          t.version IS NULL AND j.library_automatic library_automatic,
          CASE WHEN t.version IS NULL THEN j.standard_workflow ELSE v.standard_workflow END standard_workflow,
          CASE WHEN t.version IS NULL THEN j.standard_hash ELSE v.standard_hash END standard_hash,
          CASE WHEN t.version IS NULL THEN j.standard_editions END standard_editions,
          CASE WHEN t.version IS NULL THEN j.csv_skill END csv_skill,
          CASE WHEN t.version IS NULL THEN j.quote_skill_id END quote_skill_id,
          t.version IS NULL AND EXISTS(SELECT 1 FROM arrival_waits w WHERE w.job=j.id) arrival_comparison,m.id model,m.connection,m.model_id,m.data_class model_data_class FROM tool_ticket t
          JOIN jobs j ON j.id=t.job JOIN memberships e ON e.actor=j.actor AND e.active=1
          LEFT JOIN memo_versions v ON v.job_id=j.id AND v.version=t.version
          JOIN attempts a ON a.job_id=j.id AND a.phase=j.phase AND a.member_revision=e.revision
          JOIN model_releases r ON r.version=j.model_version JOIN models m ON m.id=r.model AND m.stopped=0
          WHERE j.actor=$actor AND j.kind='assistant' AND j.phase=COALESCE('revise-' || t.version,'compose')
          AND j.status IN ('running','dispatching') AND j.id IN (SELECT id FROM permitted_job_teams)`);
        const row = typeof payload.ticket === "string" && permitted.get({ticket:payload.ticket,actor});
        if (!row) {res.writeHead(403); return res.end();}
        if (!employeeGroupAllows(db,actor,row)) {res.writeHead(403);return res.end();}
        const applied=requireRevisionProcedure(db,actor,row.id,row.phase);
        const teamQuote=applied?.teamQuote || (!row.version && row.procedure_id && quoteProcedure(resolvePublished(db,actor,row.procedure_id,row.skill_hash)));
        const csv=applied?.csvSkill || (row.csv_skill && JSON.parse(row.csv_skill));
        if (modelPolicyDenial(release,{id:row.model,connection:row.connection,data_class:row.model_data_class},row.data_class)) {
          res.writeHead(423); return res.end();
        }
        const selectedFolders=row.library_selection && JSON.parse(row.library_selection);
        const folderIds=selectedFolders && selectedFolders.map(folder=>folder.id);
        const document=selectedFolders?.[0]?.document;
        const member={actor,team:row.team};
        if (folderIds?.length) librarySelection(member,folderIds,db,document);
        res.setHeader("Content-Type","application/json");
        const quoteSkill=applied?.quoteSkill || (row.quote_skill_id && db.prepare(`SELECT s.id,s.hash,s.criteria FROM quote_skills s JOIN jobs j ON j.id=s.job
          WHERE s.id=? AND j.actor=? AND j.id IN (SELECT id FROM permitted_job_teams) AND s.hash IS NOT NULL`).get(row.quote_skill_id,actor));
        if (row.quote_skill_id && !quoteSkill) {res.writeHead(403);return res.end();}
        if (payload.result?.tool==="search_libraries") {
          if ((!row.library_selection && !row.library_automatic) || JSON.parse(row.workflow || "null")?.name!=="source-answer") {
            res.writeHead(403); return res.end();
          }
          if (row.library_hits) return res.end(row.library_hits);
          const ids=folderIds || listLibraries(member,{db}).filter(folder=>row.data_class!==generalSynthetic || folder.id.startsWith("shared/"))
            .slice(0,12).map(folder=>folder.id);
          const attached=row.library_automatic ? [] : JSON.parse(row.sources_json);
          const {sources,matches}=ids.length ? await searchLibraries(member,ids,payload.result.query,attached,workPassages,db,document) :
            {sources:[],matches:[]};
          const hits=JSON.stringify({query:payload.result.query,matches});
          const saved=transaction(db,()=>{
            const current=permitted.get({ticket:payload.ticket,actor});
            if (!current) return null;
            if (!employeeGroupAllows(db,actor,current)) return null;
            if (modelPolicyDenial(usagePolicy(db),{id:current.model,connection:current.connection,data_class:current.model_data_class},current.data_class)) return null;
            if (current.library_hits) return current.library_hits;
            const selection=ids.length ? librarySelection({actor,team:current.team},ids,db,document) : [];
            db.prepare("UPDATE jobs SET sources_json=?,library_selection=? WHERE id=?")
              .run(JSON.stringify(sources),JSON.stringify(selection),row.id);
            const emptyResult=matches.length ? null : JSON.stringify({tool:"search_libraries",workflow:JSON.parse(current.workflow),
              conditions:[],evidence:[],memo:"検索結果は0件です。"});
            db.prepare("UPDATE work_tool_results SET library_hits=?, result=? WHERE job=?").run(hits,emptyResult,row.id);
            return hits;
          });
          if (!saved) {res.writeHead(403); return res.end();}
          return res.end(saved);
        }
        const savedSources=JSON.parse(row.sources_json);
        const passages=row.library_selection ? JSON.parse(row.library_hits || "{}").matches || [] : workPassages(savedSources);
        if (payload.result == null) {
          const sources=row.library_selection ? [] : savedSources;
          return res.end(JSON.stringify({sources,passages,...(quoteSkill && {quote_skill:quoteSkill}),...(teamQuote && {team_quote:teamQuote}),...(csv && {csv_recipe:csv.recipe,
            ...(csv.release && {csv_skill:{id:csv.id,...csv.release}})})}));
        }
        const result=payload.result;
        if (result.tool === "load_workflow") {
          if (quoteSkill && (result.name!=="quote-comparison" || result.hash!==quoteSkill.hash)) {res.writeHead(409);return res.end();}
          if (row.arrival_comparison && result.name!=="quote-comparison") {res.writeHead(409);return res.end();}
          if (teamQuote && result.name!=="quote-comparison") {res.writeHead(409);return res.end();}
          if (row.standard_workflow && result.name!==row.standard_workflow) {
            res.writeHead(409);return res.end();
          }
          if (row.version && !row.standard_workflow && result.name!=="csv-summary") {res.writeHead(409);return res.end();}
          if (csv && result.name!=="csv-summary") {res.writeHead(400); return res.end();}
          if (row.library_selection && result.name!=="source-answer") { res.writeHead(400); return res.end(); }
          if (!workflowTools.has(result.name) || typeof result.title!=="string" ||
              result.hash!==(quoteSkill?.hash ?? workflowHashes.get(result.name))) {
            res.writeHead(400); return res.end();
          }
          const pin=row.standard_hash ?? JSON.parse(row.standard_editions || "null")?.[result.name];
          const standard=pin && pin!==result.hash ? standardProcedureVersion(db,result.name,pin) : null;
          if (standard && result.procedure_delivery!==1) {res.writeHead(409);return res.end();}
          const workflow=JSON.stringify({name:result.name,title:standard?.name ?? result.title,hash:standard?.hash ?? result.hash});
          if (row.workflow && row.workflow !== workflow) {res.writeHead(409); return res.end();}
          if (row.version) db.prepare("UPDATE revision_tool_results SET workflow=? WHERE job=? AND version=?").run(workflow,row.id,row.version);
          else db.prepare("UPDATE work_tool_results SET workflow=? WHERE job=?").run(workflow,row.id);
          return res.end(JSON.stringify(standard ? {standard_procedure:{
            instruction:standard.instruction,content_hash:standard.content_hash,
          }} : {}));
        }
        if (!row.workflow || workflowTools.get(JSON.parse(row.workflow).name)!==result.tool) {res.writeHead(409); return res.end();}
        if (quoteSkill && (result.tool!=="compare_quotes" || JSON.stringify(result.table?.rows?.map(r=>r.label))!==quoteSkill.criteria)) {res.writeHead(409);return res.end();}
        if (teamQuote && (result.tool!=="compare_quotes" || JSON.stringify(result.table?.rows?.map(r=>r.label))!==JSON.stringify(teamQuote.criteria))) {
          res.writeHead(409);return res.end();
        }
        if (csv) {
          const recipe=csv.recipe;
          if (result.tool!=="aggregate_csv" || Object.entries(recipe).some(([key,value])=>result.recipe?.[key]!==value)) {
            res.writeHead(409); return res.end();
          }
        }
        if (row.library_selection && (result.tool!=="read_passages" || !row.library_hits)) {res.writeHead(409); return res.end();}
        if (typeof result.memo!=="string" || !resultUsesJobSources(result,savedSources,passages)) {
          res.writeHead(400); return res.end();
        }
        const saved = JSON.stringify({...result,workflow:JSON.parse(row.workflow)});
        if (row.version) {
          if (row.result && row.result!==saved) {res.writeHead(409);return res.end();}
          db.prepare("UPDATE revision_tool_results SET result=? WHERE job=? AND version=?").run(saved,row.id,row.version);
        } else db.prepare("UPDATE work_tool_results SET result=? WHERE job=?").run(saved,row.id);
        return res.end("{}");
      }
      const user = payload.messages?.findLast(
        (m) => m.role === "user",
      )?.content;
      const key =
        typeof user === "string"
          ? user.match(/^AI_HUB_ROUTE ([0-9a-f-]{36})\n/)?.[1]
          : null;
      let target = key && route.get(actor, key);
      if (target?.status === "unknown") {
        // Losing the 202 can precede the accepted run's first inference. Authorize
        // only that original turn; the admin still owns the Hub state transition.
        const receipt = await readReceipt(actor,target.job,target.phase,key);
        const session = "hub-" + target.job + "-" + target.phase;
        target = receipt.result === "matched" && receipt.session_id === session ? route.get(actor,key) : null;
      }
      if (!target || !employeeGroupAllows(db,actor,target) || !splitJobPermitted(db,target.job,actor)) {
        res.writeHead(403);
        return res.end();
      }
      requireRevisionProcedure(db,actor,target.job,target.phase);
      const policy=usagePolicy(db).settings;
      // Remove the internal identifier before handing the request to the provider.
      payload.messages.findLast((m) => m.role === "user").content = user.slice(
        user.indexOf("\n") + 1,
      );
      const projection=profileProjection(db,actor,target.profile_project,JSON.parse(target.profile_snapshot || "null"));
      if (!policy.memory || target.skip_profile || projection.managed) {
        for (const message of payload.messages) {
          if (message.role !== "system" || typeof message.content !== "string") continue;
          // Hermes injects personal memory sections under these titles.
          const offset=message.content.search(/(?:^|\n)(?:USER PROFILE \(who the user is\)|MEMORY \(agent[^\n]*\))[^\n]*\n═+\n/u);
          if (offset !== -1) message.content=message.content.slice(0,offset);
        }
      }
      if (policy.memory && !target.skip_profile && projection.managed) {
        const system=payload.messages.find(m=>m.role==="system" && typeof m.content==="string");
        if (system && projection.user) system.content+="\n\nUSER PROFILE (who the user is) [AI Hub]\n════\n"+projection.user;
        if (system && projection.memory) system.content+="\n\n案件の前提（今回の案件だけに適用）\n"+projection.memory;
        if (system && (projection.user || projection.memory))
          system.content+="\n\n今回の依頼で明示した希望と資料の記述を優先して、本人の書き方の好みと案件の前提を適用する。";
      }
      if (target.phase === "compose" || target.phase === "draft") {
        const system = payload.messages.find(m => m.role === "system" && typeof m.content === "string");
        const profile = system?.content.match(/\nUSER PROFILE \(who the user is\) \[[^\n]*\]\n═+\n([\s\S]+?)(?:\n\n|$)/)?.[1];
        if (profile) {
          system.content += "\n本人のプロフィールにある書き方の希望を、今回の指定や必須の出典と両立する範囲で本文に適用する。";
          if (/結論[^。\n]{0,20}(?:先|最初|冒頭)/u.test(profile))
            system.content += "結論を先にという希望には、冒頭に「結論」と明記して具体的な答えを述べ、続いて根拠を書く。";
        }
      }
      // Tool access follows the current employee, job and workflow step.
      if (target.kind === "assistant" && target.phase.startsWith("learn-quote-")) {
        const saved=db.prepare("SELECT hash FROM quote_skills WHERE job=? AND phase=?").get(target.job,target.phase);
        if (saved && !saved.hash) payload.tools=(payload.tools || []).filter(t=>t.function?.name==="mcp__work__save_quote_skill");
        else { delete payload.tools; delete payload.tool_choice; }
      } else if (target.kind === "assistant" && target.phase.startsWith("revise-")) {
        const state = db.prepare("SELECT workflow,result FROM revision_tool_results WHERE job=? AND version=?")
          .get(target.job, Number(target.phase.slice(7)));
        if (state && !state.result) {
          const name = state.workflow ? "mcp__work__"+workflowTools.get(JSON.parse(state.workflow).name) : "mcp__work__load_workflow";
          payload.tools = (payload.tools || []).filter(tool => tool.function?.name === name);
        } else { delete payload.tools; delete payload.tool_choice; }
      } else if (target.kind === "assistant" && target.phase === "compose") {
        const state = db.prepare("SELECT t.workflow,t.library_hits,t.profile_saved,t.result IS NOT NULL AS finished,j.kind,j.phase,j.sources_json,j.ask,j.library_selection,j.library_automatic,j.csv_skill,j.standard_workflow,j.skip_profile FROM work_tool_results t JOIN jobs j ON j.id=t.job WHERE t.job=?").get(target.job);
        const loaded=state?.workflow;
        const maySave = policy.memory && state && !loaded && canRequestPreference(state);
        const saved = maySave && savedUserPreference(payload.messages);
        if (saved) {
          saveEmployeePreference(db,actor,{source_job:target.job,content:saved});
          writeProfileFiles(db,actor,process.env.DATA_DIR || ".runtime");
          db.prepare("UPDATE work_tool_results SET profile_saved=1 WHERE job=?").run(target.job);
        }
        if (saved || state?.profile_saved || ((state?.library_selection || state?.csv_skill) && state.finished)) {
          delete payload.tools;
          delete payload.tool_choice;
        } else {
          let allowed;
          if (!loaded) allowed=["load_workflow"];
          else if (state.library_selection) allowed=[state.library_hits ? "read_passages" : "search_libraries"];
          else if (state.library_automatic && JSON.parse(loaded).name==="source-answer") allowed=["read_passages","search_libraries"];
          else allowed=[workflowTools.get(JSON.parse(loaded).name)];
          payload.tools=(payload.tools || []).filter(t=>allowed.some(name=>t.function?.name==="mcp__work__"+name) || (maySave && t.function?.name==="memory"));
          const profileTool = payload.tools.find(t=>t.function.name==="memory");
          if (profileTool) {
            const fields = profileTool.function.parameters.properties;
            fields.target.enum = ["user"];
            fields.operations.maxItems = 1;
            fields.operations.items.properties.action.enum = ["add"];
          }
        }
      } else {
        delete payload.tools;
        delete payload.tool_choice;
      }
      if (payload.tool_choice?.type === "function" &&
          !payload.tools?.some(tool => tool.function?.name === payload.tool_choice.function?.name))
        delete payload.tool_choice;
      if (payload.stream)
        payload.stream_options = {
          ...payload.stream_options,
          include_usage: true,
        };
      let reply;
      try {
        reply = await measuredSend(
          db,
          target,
          {
            actor,
            job: target.job,
            phase: target.phase,
            version: target.model_version,
            dataClass: target.data_class,
          },
          payload,
          upstream,
        );
      } catch (e) {
        if (e.status !== 423) throw e;
        db.prepare(
          "UPDATE jobs SET status='held_dispatched' WHERE id=? AND phase=? AND status IN ('running','dispatching')",
        ).run(target.job, target.phase);
        res.writeHead(423);
        return res.end();
      }
      if (!reply.ok) {
        await reply.body?.cancel();
        res.writeHead(502);
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type": reply.headers.get("Content-Type") || "application/json",
      });
      await pipeline(Readable.fromWeb(reply.body), res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead([403,404,409,423].includes(error?.status) ? 403 : 502);
        res.end();
      } else res.destroy();
    }
  });
  return server.listen(port, host);
}
