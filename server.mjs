import { personalWork } from "./personal-work.mjs";
import { reservationPlans } from "./reservation-plan.mjs";
import { groupWork } from "./work-split.mjs";
import { listLibraries, liveLibrarySource, managedLibraries, workspaceDocument, workspaceDocuments, updateManagedLibrary } from "./libraries.mjs";
import { createArrivalScanner } from "./arrival-waits.mjs";
import { workspaceTasks } from "./skills/workspace-tasks.mjs";
import { loadAdminAuth, validAdminId } from "./admin-auth.mjs";
import { catalog, connections, register, probe, publish } from "./catalog.mjs";
import { checkModelProfile, migrateModelProfiles, modelProfiles, saveModelProfile } from "./model-profiles.mjs";
import { runtimeAssignments } from "./runtime-assignments.mjs";
import { changeUsagePolicy, retentionEstimate, usagePolicy, usagePolicyHistory, usageSnapshot } from "./usage-policy.mjs";
import { usageReport } from "./usage-report.mjs";
import { applyDirectorySync, applyGroupSync, configureLocalDirectory, directorySyncPreview, employeeModelChoices, groupAccess, groupOverview, localDirectoryOverview, previewGroupSync, previewLocalGroup, saveCompanySelection, saveLocalGroup } from "./enterprise-directory.mjs";
import { listenGateway } from "./gateway.mjs";
import { setStopped, readLog, reasonText } from "./operations.mjs";
import http from "node:http";
import { documentText } from "./document-text.mjs";
import { employeePreferences, profileProjection, saveEmployeePreference, writeProfileFiles } from "./employee-profile.mjs";
import {answerInquiry,availableDesks,postInquiryFollowup,receivedInquiries,readInquiry,recordInquiryReview,registerInquiry,resolveInquiry} from "./inquiries.mjs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { listStandardProcedures, saveStandardProcedure, standardProcedureAdministration } from "./standard-procedures.mjs";
import { openHub, createWorker, createReceiptRechecker, pendingRecoveries, reconcileRun, closeUnconfirmedMeeting, meetingClosureAudit, startPendingWeekly, HubError } from "./hub.mjs";
import { adminActor, employees, registerAdminWorkspaces, sourcesFor } from "./fixtures.mjs";
import { activeMember, adminAccount, adminAudit, adminAuditCsv, auditExportHistory, csvLine, member, memberDirectory, memberDirectoryCsv, memberHistory, recordAdminDenial, savedExportRows, setMemberActive, stoppedDispatches, transfer } from "./memberships.mjs";
import { changeProcedureDelivery, makeDraft, previewProcedureDelivery, procedureAdministration, rollbackProcedure, submitDraft, reviewList, publishProcedure, publishedFor, previewRevision, publishRevision, revokeProcedure } from "./procedures.mjs";

const { authenticate: authenticateAdmin, accountIds, accountRoles } = loadAdminAuth(process.env.ADMIN_ACCOUNTS_DIR || ".runtime/admin-accounts");
registerAdminWorkspaces(accountIds, accountRoles);
const entryPorts = {
  sato: Number(process.env.SATO_PORT || 18731),
  tanaka: Number(process.env.TANAKA_PORT || 18732),
  admin: Number(process.env.ADMIN_PORT || 18733),
};
const sessionCookie = `ai_hub_session_${entryPorts.admin}`;
const sessionLifetime = 12 * 60 * 60 * 1000;
const sessions = new Map();
const signInAssets = new Set(["/login", "/account-session.js", "/account-session.css", "/style.css"]);
const dir = process.env.DATA_DIR || ".runtime";
mkdirSync(dir, { recursive: true, mode: 0o700 });
const hub = openHub(dir + "/hub.sqlite");
migrateModelProfiles(hub.db);
for (const {actor} of hub.db.prepare("SELECT DISTINCT p.actor FROM employee_preferences p JOIN memberships m ON m.actor=p.actor WHERE m.active=1").all())
  writeProfileFiles(hub.db,actor,dir);
const localDirectoryFile=process.env.AI_HUB_LOCAL_DIRECTORY_FILE;
if (localDirectoryFile) configureLocalDirectory(hub.db,JSON.parse(readFileSync(localDirectoryFile,"utf8")));
hub.db.exec("UPDATE model_calls SET outcome='unknown' WHERE outcome='sending'");
const personal = personalWork(hub);
const plans=reservationPlans(hub,personal);
const split=groupWork(hub);
const cronTokenFile=process.env.AI_HUB_LOCAL_CRON_TOKEN_FILE;
const cronToken=cronTokenFile && readFileSync(cronTokenFile,"utf8").trim();
if (cronTokenFile && !/^[a-zA-Z0-9_-]{32,128}$/.test(cronToken))
  throw Error("ローカルCronの認証設定を確認してください。");
const digest=value=>createHash("sha256").update(value).digest();
const cronAuthorization=cronTokenFile && digest("Bearer "+cronToken);
const runtimes = runtimeAssignments(hub.db);
const hermes = runtimes.call;
const lookupReceipt = (actor,id,phase,attempt,runtime) => hermes(actor,"/receipt/"+encodeURIComponent(id+"-"+phase),
  {headers:{"X-Hub-Attempt":attempt}},runtime,true);
const work = createWorker(hub.db, hermes, runtimes.selected);
const scanArrivals = createArrivalScanner(hub.db);
const recheckReceipts = createReceiptRechecker(hub.db, hermes, lookupReceipt);
const assets = new Map(
  Object.entries({
    "/": ["index.html", "text/html"],
    "/login": ["login.html", "text/html"],
    "/account-session.js": ["account-session.js", "text/javascript"],
    "/account-session.css": ["account-session.css", "text/css"],
    "/admin.html": ["admin.html", "text/html"],
    "/admin-groups.js": ["admin-groups.js", "text/javascript"],
    "/audit-format.js": ["audit-format.js", "text/javascript"],
    "/admin.js": ["admin.js", "text/javascript"],
    "/admin-model-profiles.js": ["admin-model-profiles.js", "text/javascript"],
    "/admin-member-work.js": ["admin-member-work.js", "text/javascript"],
    "/admin-dashboard.js": ["admin-dashboard.js", "text/javascript"],
    "/admin-dashboard.css": ["admin-dashboard.css", "text/css"],
    "/app.js": ["app.js", "text/javascript"],
    "/work-planning.js": ["work-planning.js", "text/javascript"],
    "/job-chat.css": ["job-chat.css", "text/css"],
    "/style.css": ["style.css", "text/css"],
    "/visual.js": ["visual.js", "text/javascript"],
  }).map(([path, [file, type]]) => [
    path,
    { file: new URL("./public/" + file, import.meta.url), type },
  ]),
);
async function displayJob(actor, id) {
  const member = activeMember(hub.db, actor);
  const job = hub.get(actor, id);
  const distribution=split.summary(actor,id),reservation=personal.reservationDetails(id);
  if (distribution) job.distribution=distribution;
  if (reservation) job.reservation=reservation;
  if (!job.sources.some(source => source.library)) return job;
  job.sources = await Promise.all(job.sources.map(source => source.library ? liveLibrarySource(member, source, hub.db) : source));
  if (activeMember(hub.db, actor).revision !== member.revision)
    throw new HubError(409, "所属が変更されました。仕事を開き直してください。");
  const expired = new Set(job.sources.filter(source => source.unavailable).map(source => source.id));
  function redact(result) {
    const { memo, ...tool } = result;
    return {
      ...tool,
      evidence: tool.evidence.map(item => expired.has(item.source) ?
        { label:item.label, source:item.source, unavailable:true } : item),
      ...(tool.table && {table: {...tool.table, rows:tool.table.rows.map(row => ({
        ...row, cells:row.cells.map(cell => expired.has(cell.source) ?
          {source:cell.source, text:"要確認（出典失効）", ref:""} : cell),
      }))}}),
    };
  }
  if (expired.size) {
    if (job.work_tool) job.work_tool=redact(job.work_tool);
    for (const version of job.versions)
      if (version.work_tool) version.work_tool=redact(version.work_tool);
  }
  return job;
}

async function readBytes(req, limit) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) {
      req.resume();
      throw new HubError(413, "入力が長すぎます。");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function body(req, limit = 8192) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HubError(415, "JSONが必要です。");
  const bytes = await readBytes(req, limit);
  try {
    const value = JSON.parse(bytes);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value;
  } catch {}
  throw new HubError(400, "入力を読み取れません。");
}
async function previewAttachment(req, format) {
  if (!["pdf", "docx", "txt", "md", "csv"].includes(format)) throw new HubError(415, "CSV、PDF、Word、テキスト形式を選んでください。");
  const bytes = await readBytes(req, 5 * 1024 * 1024);
  return {text:await documentText(bytes,format)};
}
function requestSession(req) {
  const cookies = (req.headers.cookie || "").split(";").map(cookie => cookie.trim());
  const matches = cookies.filter(cookie => cookie.startsWith(sessionCookie + "="));
  if (!matches.length) return null;
  // Even an expired or revoked cookie keeps the browser in the sign-in flow.
  const token = matches.length === 1 ? matches[0].slice(sessionCookie.length + 1) : "";
  const session = sessions.get(token);
  if (session && session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return { token };
  }
  return { token, session };
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `${sessionCookie}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
}

function sessionEntry(identity) {
  return identity.kind === "admin" ? "admin" : identity.actor;
}

function sessionHome(hostname, identity, path = "/") {
  const page = identity.kind === "admin" && path === "/admin.html" ? path : "/";
  return `http://${hostname}:${entryPorts[sessionEntry(identity)]}${page}`;
}

function listen(entry, port) {
  const server = http.createServer(async (req, res) => {
    const json = (v, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(v));
    };
    try {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      const host = req.headers.host;
      if (!["localhost:" + port, "127.0.0.1:" + port].includes(host))
        throw new HubError(403, "接続先が一致しません。");
      const { hostname, pathname: path } = new URL(req.url, "http://" + host);
      if (path==="/internal/local-scheduler/tick") {
        if (entry!=="admin" || !cronAuthorization) throw new HubError(404,"見つかりません。");
        if (req.method!=="POST") throw new HubError(405,"POSTで起動してください。");
        if (req.headers.origin || !timingSafeEqual(cronAuthorization,digest(req.headers.authorization || "")))
          throw new HubError(403,"スケジューラの認証を確認できません。");
        const count=()=>hub.db.prepare("SELECT count(*) AS n FROM scheduled_jobs").get().n;
        const active=()=>hub.db.prepare("SELECT count(*) AS n FROM weekly_schedules WHERE enabled=1").get().n;
        const before=count(), enabled=active();
        personal.runDue();
        return json({created:count()-before,disabled:enabled-active()});
      }
      if (
        req.method === "POST" &&
        (req.headers.origin !== "http://" + host ||
          req.headers["sec-fetch-site"] === "cross-site")
      )
        throw new HubError(403, "画面から操作してください。");
      if (req.method === "GET" && signInAssets.has(path)) {
        const asset = assets.get(path);
        const content = await readFile(asset.file);
        res.writeHead(200, { "Content-Type": asset.type + "; charset=utf-8" });
        return res.end(content);
      }
      const managed = requestSession(req);
      if (req.method === "GET" && path === "/api/session/accounts") {
        return json({ employees: Object.keys(entryPorts).filter(actor => actor !== "admin")
          .map(actor => member(hub.db, actor)).filter(employee => employee.active)
          .map(({ actor, name }) => ({ actor, name })) });
      }
      if (req.method === "POST" && path === "/api/session/logout") {
        if (managed) sessions.delete(managed.token);
        setSessionCookie(res, "signed-out");
        return json({ redirect: "/login" });
      }
      if (req.method === "POST" && path === "/api/session/login") {
        const input = await body(req);
        let identity;
        if (input.kind === "employee" && typeof input.actor === "string" && input.actor !== "admin" && Object.hasOwn(entryPorts, input.actor)) {
          activeMember(hub.db, input.actor);
          identity = { kind: "employee", actor: input.actor };
        } else if (input.kind === "admin") {
          const { account, password } = input;
          const principal = validAdminId(account)
            && typeof password === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(password)
            && authenticateAdmin("Basic " + Buffer.from(account + ":" + password).toString("base64"));
          if (!principal) throw new HubError(401, "アカウントIDまたはパスワードを確認してください。");
          activeMember(hub.db, adminActor(principal.account));
          identity = { kind: "admin", ...principal };
        } else {
          throw new HubError(400, "ログインするアカウントを選択してください。");
        }
        if (managed) sessions.delete(managed.token);
        const now = Date.now();
        for (const [token, session] of sessions) {
          if (session.expiresAt <= now) sessions.delete(token);
        }
        const token = randomBytes(32).toString("base64url");
        sessions.set(token, { identity, expiresAt: now + sessionLifetime });
        setSessionCookie(res, token);
        return json({ redirect: sessionHome(hostname, identity) });
      }
      if (req.headers["sec-fetch-site"] === "cross-site" && req.headers["sec-fetch-dest"] !== "document")
        throw new HubError(403, "画面から操作してください。");
      const identity = managed?.session?.identity;
      if (managed) {
        const page = req.method === "GET" && (path === "/" || path === "/admin.html");
        if (!identity) {
          if (page) {
            res.writeHead(303, { Location: "/login" });
            return res.end();
          }
          throw new HubError(401, "ログインしてください。", "session_required");
        }
        if (sessionEntry(identity) !== entry) {
          if (page) {
            res.writeHead(303, { Location: sessionHome(hostname, identity, path) });
            return res.end();
          }
          throw new HubError(403, "アカウントの接続先が一致しません。", "session_port_mismatch");
        }
        activeMember(hub.db, identity.kind === "admin" ? adminActor(identity.account) : identity.actor);
      }
      const admin = entry === "admin";
      const principal = admin ? (identity ? { account: identity.account, role: identity.role } : authenticateAdmin(req.headers.authorization)) : null;
      if (admin && !principal) {
        res.setHeader(
          "WWW-Authenticate",
          'Basic realm="AI Hub Admin", charset="UTF-8"',
        );
        throw new HubError(401, "管理者としてログインしてください。");
      }
      if (req.method === "GET" && path === "/api/session") {
        activeMember(hub.db, admin ? adminActor(principal.account) : entry);
        return json(admin ? { kind: "admin", ...principal } : { kind: "employee", actor: entry });
      }
      if (path.startsWith("/api/admin/")) {
        if (!admin) throw new HubError(403, "管理者権限が必要です。");
        if (req.method === "GET" && path === "/api/admin/session")
          return json(localDirectoryFile && principal.role==="manager" ? {...principal,localDirectory:true} : principal);
        if (req.method === "GET" && path === "/api/admin/groups") return json(groupOverview(hub.db,principal.role==="manager"));
        if (req.method === "GET" && path === "/api/admin/usage-overview") return json(usageSnapshot(hub.db));
        if (req.method === "GET" && path === "/api/admin/usage-report")
          return json(usageReport(hub.db, new URL(req.url, "http://" + host).searchParams));
        if (req.method === "GET" && path === "/api/admin/member-directory")
          return json(Object.entries(employees).map(([actor, e]) => ({ actor, name: e.name })));
        if (req.method === "GET" && path === "/api/admin/member-changes")
          return json(memberHistory(hub.db, new URL(req.url, "http://" + host).searchParams));
        if (req.method === "GET" && path === "/api/admin/audit")
          return json(adminAudit(hub.db, new URL(req.url, "http://" + host).searchParams));
        if (req.method === "GET" && path === "/api/admin/audit/meeting-closures")
          return json(meetingClosureAudit(hub.db, new URL(req.url, "http://" + host).searchParams.get("job")));
        if (req.method === "GET" && path === "/api/admin/audit/exports")
          return json(auditExportHistory(hub.db, new URL(req.url, "http://" + host).searchParams));
        const savedRows = path.match(/^\/api\/admin\/audit\/exports\/([0-9]+)\/(rows|audit-rows)$/);
        if (req.method === "GET" && savedRows)
          return json(savedExportRows(hub.db, savedRows[1], new URL(req.url, "http://" + host).searchParams,
            savedRows[2] === "audit-rows" ? "audit" : "history"));
        if (req.method === "GET" && ["/api/admin/audit.csv", "/api/admin/audit/exports.csv"].includes(path)) {
          const filters = new URL(req.url, "http://" + host).searchParams;
          const history = path === "/api/admin/audit/exports.csv";
          const csv = adminAuditCsv(hub.db, filters, principal.account, history ? "history" : "audit");
          const keys = history ? ["exported_by", "employee", "source"] : ["employee", "operator", "outcome"];
          const tags = keys.map(key => filters.get(key))
            .filter(value => value && /^[a-zA-Z0-9_.-]{1,64}$/.test(value));
          const filename = [history ? "csv-export-history" : "audit-log", ...tags].join("-") + ".csv";
          res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="' + filename + '"' });
          await pipeline(Readable.from(csv.lines), res);
          csv.markSent();
          return;
        }
        const trace = path.match(/^\/api\/admin\/member-changes\/([0-9]+)\/dispatches$/);
        if (req.method === "GET" && trace) return json(stoppedDispatches(hub.db, trace[1]));
        if (
          req.method === "GET" &&
          ["/api/admin/models/usage", "/api/admin/models/changes"].includes(
            path,
          )
        )
          return json(
            readLog(
              hub.db,
              path.split("/").at(-1),
              new URL(req.url, "http://" + host).searchParams,
            ),
          );
        const access = path.match(/^\/api\/admin\/memberships\/([a-z0-9._-]+)\/access$/);
        const membership = path.match(/^\/api\/admin\/memberships\/([a-z0-9._-]+)$/);
        const memberWork = path.match(/^\/api\/admin\/memberships\/([a-z0-9._-]+)\/(runtime|schedules)$/);
        const standardEntry = path.match(/^\/api\/admin\/standard-procedures\/([a-z0-9-]+)$/);
        const publication = path.match(/^\/api\/admin\/procedures\/([a-z0-9-]+)\/(publish|preview-revision|revise|revoke|quality|preview-delivery|delivery|rollback)$/);
        const target = path.match(
          /^\/api\/admin\/models\/([a-z0-9-]+)\/(test|publish|stop|enable|restore)$/,
        );
        const recovery = path.match(/^\/api\/admin\/recoveries\/([a-z0-9-]+)$/);
        const closure = path.match(/^\/api\/admin\/recoveries\/([a-z0-9-]+)\/close$/);
        const weeklyStart = path.match(/^\/api\/admin\/recoveries\/([a-z0-9-]+)\/weekly\/([a-z0-9-]+)$/);
        if (principal.role !== "manager") {
          let scope = "admin", id = "", action = "その他の管理API";
          if (req.method === "POST" && (access || membership)) {
            scope = "employee";
            id = (access || membership)[1];
            action = "transfer";
            if (access) {
              // Read only the requested direction. Invalid input is still a denied access change.
              const input = await body(req).catch(() => null);
              action = input?.active === true ? "enable" : input?.active === false ? "disable" : "access";
            }
          } else if (memberWork) {
            scope = "employee"; id = memberWork[1]; action = req.method + " " + memberWork[2];
          } else if (req.method === "POST" && weeklyStart) {
            scope = "job"; id = weeklyStart[2]; action = "後続の週報を開始";
          } else if (req.method === "POST" && closure) {
            scope = "job"; id = closure[1]; action = "結果未確認で対応終了";
          } else if (req.method === "POST" && recovery) {
            scope = "job"; id = recovery[1]; action = "実行結果の照合";
          } else if (standardEntry || path === "/api/admin/standard-procedures") {
            scope = "procedure";
            id = standardEntry?.[1] ?? "";
            action = req.method === "POST" ? "会社標準手順の改訂" : "会社標準手順の管理情報閲覧";
          } else if (req.method === "POST" && (publication || target)) {
            const route = publication || target;
            scope = publication ? "procedure" : "model";
            [, id, action] = route;
          } else if (path.startsWith("/api/admin/groups/") || path.startsWith("/api/admin/local-directory/group/")) {
            scope = "group";
            action = path.endsWith("/save") ? "グループの保存" : "社員別の適用結果";
          } else if (["/api/admin/models", "/api/admin/procedures", "/api/admin/memberships"].includes(path)) {
            action = req.method + " " + path;
          }
          recordAdminDenial(hub.db, principal.account, scope, id.slice(0, 256), action);
          throw new HubError(403, "この操作には管理操作の権限が必要です。");
        }
        const operator = principal.account;
        if (req.method === "GET" && path === "/api/admin/standard-procedures")
          return json(listStandardProcedures(hub.db));
        if (req.method === "GET" && standardEntry)
          return json(standardProcedureAdministration(hub.db, standardEntry[1]));
        if (req.method === "POST" && standardEntry)
          return json(saveStandardProcedure(hub.db, standardEntry[1], await body(req,128*1024), operator));
        if (req.method==="GET" && path==="/api/admin/groups/access")
          return json(groupAccess(hub.db,new URL(req.url,"http://"+host).searchParams.get("actor") || ""));
        if (req.method==="POST" && path==="/api/admin/groups/preview")
          return json(previewLocalGroup(hub.db,await body(req)));
        if (req.method==="POST" && path==="/api/admin/groups/save")
          return json(saveLocalGroup(hub.db,await body(req),operator));
        if (req.method==="POST" && path==="/api/admin/groups/company")
          return json(saveCompanySelection(hub.db,await body(req),operator));
        if (path.startsWith("/api/admin/local-directory") && !localDirectoryFile)
          throw new HubError(404,"ローカルの検証ディレクトリが設定されていません。");
        if (req.method === "GET" && path === "/api/admin/local-directory") return json(localDirectoryOverview(hub.db));
        if (req.method === "POST" && path === "/api/admin/local-directory/preview") return json(directorySyncPreview(hub.db,await body(req)));
        if (req.method === "POST" && path === "/api/admin/local-directory/apply") return json(applyDirectorySync(hub.db,await body(req),operator));
        if (req.method === "POST" && path === "/api/admin/local-directory/group/preview") return json(previewGroupSync(hub.db,await body(req)));
        if (req.method === "POST" && path === "/api/admin/local-directory/group/apply") return json(applyGroupSync(hub.db,await body(req),operator));
        if (req.method === "GET" && path === "/api/admin/usage-policy") {
          const current=usagePolicy(hub.db);
          return json({ current, history:usagePolicyHistory(hub.db), retentionEstimate:retentionEstimate(hub.db,current) });
        }
        const policyAction=path.match(/^\/api\/admin\/usage-policy\/(publish|stop|restore)$/);
        if (req.method === "POST" && policyAction)
          return json(changeUsagePolicy(hub.db,await body(req,64*1024),policyAction[1],operator,Object.keys(connections)));
        if (req.method === "GET" && path === "/api/admin/recoveries") return json(pendingRecoveries(hub.db));
        if (req.method === "POST" && closure)
          return json(closeUnconfirmedMeeting(hub.db,closure[1],await body(req),operator));
        if (req.method === "POST" && weeklyStart)
          return json(startPendingWeekly(hub.db, weeklyStart[1], weeklyStart[2], operator));
        if (req.method === "POST" && recovery)
          return json(await reconcileRun(hub.db, hermes, recovery[1], await body(req), operator, lookupReceipt));
        if (req.method === "GET" && path === "/api/admin/memberships")
          return json(memberDirectory(hub.db, new URL(req.url, "http://" + host).searchParams).rows);
        if (req.method === "GET" && path === "/api/admin/account-list")
          return json(memberDirectory(hub.db, new URL(req.url, "http://" + host).searchParams));
        if (req.method === "GET" && path === "/api/admin/account-list.csv") {
          const csv = memberDirectoryCsv(hub.db, new URL(req.url, "http://" + host).searchParams);
          res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="user-accounts.csv"' });
          return res.end(csv);
        }
        if (req.method === "GET" && membership) {
          const actor = membership[1];
          return json({...adminAccount(hub.db, actor),runtime:runtimes.details(actor),schedules:personal.adminSchedules(actor)});
        }
        if (req.method === "POST" && memberWork) {
          const [,actor,kind] = memberWork;
          const input = await body(req,4096);
          return json(kind === "runtime" ? runtimes.save(actor,input,operator) : personal.saveAdminSchedule(actor,input,operator));
        }
        if (req.method === "GET" && path === "/api/admin/library-connections") return json(managedLibraries(hub.db));
        if (req.method === "GET" && path === "/api/admin/projects") return json(personal.projectsForAdmin());
        if (req.method === "POST" && path === "/api/admin/library-connections")
          return json(updateManagedLibrary(hub.db, await body(req), operator));
        if (req.method === "POST" && access) return json(setMemberActive(hub.db, access[1], await body(req), operator));
        if (req.method === "POST" && membership) return json(transfer(hub.db, membership[1], await body(req), operator));
        if (req.method === "GET" && path === "/api/admin/procedures") return json(reviewList(hub.db));
        if (req.method === "GET" && publication?.[2]==="quality") return json(procedureAdministration(hub.db,publication[1]));
        if (req.method === "POST" && publication && publication[2]!=="quality") {
          const [, id, action] = publication, input = await body(req);
          if (action === "preview-revision") return json(previewRevision(hub.db, id, input));
          if (action === "revise") publishRevision(hub.db, id, input, operator);
          else if (action === "revoke") revokeProcedure(hub.db, id, input.hash, operator);
          else if (action === "preview-delivery") return json(previewProcedureDelivery(hub.db,id,input));
          else if (action === "delivery") return json(changeProcedureDelivery(hub.db,id,input,operator));
          else if (action === "rollback") return json(rollbackProcedure(hub.db,id,input,operator));
          else publishProcedure(hub.db, id, input.hash, operator);
          return json({ ok: true });
        }
        if (req.method === "GET" && path === "/api/admin/models")
          return json(catalog(hub.db));
        if (req.method === "POST" && path === "/api/admin/models")
          return json({ id: register(hub.db, await body(req), operator) }, 201);
        if (req.method === "GET" && path === "/api/admin/model-profiles")
          return json(modelProfiles(hub.db));
        if (req.method === "POST" && path === "/api/admin/model-profiles/check") {
          const { target } = checkModelProfile(await body(req, 4096));
          return json({ target });
        }
        if (req.method === "POST" && path === "/api/admin/model-profiles") {
          const input = await body(req, 4096);
          return json(saveModelProfile(hub.db, input, operator), input.id === undefined ? 201 : 200);
        }
        if (req.method === "POST" && target) {
          const input = await body(req);
          if (target[2] === "test") return json(await probe(hub.db, target[1], operator));
          if (["stop", "enable"].includes(target[2]))
            setStopped(hub.db, target[1], input, target[2] === "stop", operator);
          else
            publish(
              hub.db,
              target[1],
              input.base,
              operator,
              reasonText(input.reason),
              target[2] === "restore",
            );
          return json(catalog(hub.db));
        }
        throw new HubError(404, "見つかりません。");
      }
      const actor = admin ? adminActor(principal.account) : entry;
      if (!admin && (path === "/admin.html" || /^\/admin(?:-[a-z]+)*\.(?:js|css)$/.test(path)))
        throw new HubError(403, "管理者権限が必要です。");
      if (req.method === "GET" && assets.has(path)) {
        const asset = assets.get(path);
        let content = await readFile(asset.file);
        if (admin && path === "/") {
          content = content.toString().replace('id="adminMenu" hidden', 'id="adminMenu"');
          if (principal.role === "manager")
            content = content.replaceAll("data-manager-shortcut hidden", "data-manager-shortcut");
        }
        res.writeHead(200, { "Content-Type": asset.type + "; charset=utf-8" });
        return res.end(content);
      }
      if (req.method === "POST" && path === "/api/attachments/preview") {
        activeMember(hub.db, actor);
        return json(await previewAttachment(req, new URL(req.url, "http://" + host).searchParams.get("format")));
      }
      if (req.method === "GET" && ["/api/workspace/documents", "/api/workspace/document"].includes(path)) {
        const employee = activeMember(hub.db, actor);
        const params = new URL(req.url, "http://" + host).searchParams;
        const result = path.endsWith("/documents")
          ? await workspaceDocuments(employee, params.get("q") || "", hub.db)
          : await workspaceDocument(employee, params.get("library"), params.get("name"), hub.db);
        if (activeMember(hub.db, actor).revision !== employee.revision) throw new HubError(409, "所属が変更されました。");
        return json(result);
      }
      if (req.method === "GET" && path === "/api/workspace") {
        const employee = activeMember(hub.db, actor);
        const standards = listStandardProcedures(hub.db).map(({id,name,source,example,output,scope,hash,version}) =>
          ({id,name,source,example,output,scope,hash,version}));
        const renewal = standards.find(entry => entry.id === "renewal-brief");
        return json({
          employee,
          model_choices:employeeModelChoices(hub.db,actor),
          preferences:employeePreferences(hub.db,actor),
          memory_enabled:usagePolicy(hub.db).settings.memory,
          inquiry_desks:usagePolicy(hub.db).settings.inquiry
            ? availableDesks(hub.db).map(({id,name,actor})=>({id,name,actor,contact:employees[actor].name})) : [],
          received_inquiries:receivedInquiries(hub.db,actor),
          libraries:listLibraries(employee,{db:hub.db}),
          arrival_libraries:listLibraries(employee,{db:hub.db,includeEmpty:true}),
          quote_skills:hub.quoteSkills(actor),
          ...personal.overview(actor),
          taskTypes: [...workspaceTasks.values()].map(({id,name,sourceLabel,example}) => ({id,name,sourceLabel,example})),
          standardWorkflows:standards.filter(entry => entry.id !== "renewal-brief"),
          defaultSources: sourcesFor(actor, employee.company),
          jobs: hub.list(actor),
          skill: employee.team === renewal.scope ? renewal : null,
          procedures: publishedFor(hub.db, actor),
        });
      }
      const ticket=path.match(/^\/api\/inquiries\/(\d+)(\/answer|\/resolve)?$/);
      const followup=path.match(/^\/api\/inquiries\/(\d+)\/followups\/(\d+)(\/answer)?$/);
      if (followup && req.method==="POST")
        return json(postInquiryFollowup(hub.db,actor,Number(followup[1]),Number(followup[2]),Boolean(followup[3]),await body(req,32*1024)));
      if (ticket && !ticket[2] && req.method==="GET") return json(readInquiry(hub.db,actor,Number(ticket[1])));
      if (ticket?.[2]==="/resolve" && req.method==="POST") return json(resolveInquiry(hub,actor,Number(ticket[1]),await body(req,32*1024)));
      if (ticket?.[2]==="/answer" && req.method==="POST") return json(answerInquiry(hub.db,actor,Number(ticket[1]),await body(req,32*1024)));
      const inquiry=path.match(/^\/api\/jobs\/([a-z0-9-]+)\/inquiry\/(prepare|review|register)$/);
      if (inquiry && req.method==="POST") {
        const input=await body(req,32*1024);
        if (inquiry[2]!=="prepare" && Array.isArray(input.attachments) && input.attachments.length) {
          const job=await displayJob(actor,inquiry[1]);
          if (!job.inquiries.some(item=>item.version===input.version && item.id) &&
            job.sources.some(source=>input.attachments.includes(source.id) && source.unavailable))
            throw new HubError(409,"添付候補の出典が失効しました。仕事を開き直してください。");
        }
        if (inquiry[2]==="review") return json(recordInquiryReview(hub,actor,inquiry[1],input));
        if (inquiry[2]==="register") return json(registerInquiry(hub,actor,inquiry[1],input),201);
        hub.prepareInquiry(actor,inquiry[1],input.version,req.headers["idempotency-key"]);
        return json({ok:true});
      }
      const project = path.match(/^\/api\/projects\/([a-z0-9-]+)$/);
      if (req.method === "GET" && project) return json(personal.project(actor,project[1]));
      if (req.method === "POST" && project) return json(personal.updateProject(actor,project[1],await body(req)));
      if (req.method==="GET" && path==="/api/profile")
        return json({preferences:employeePreferences(hub.db,actor),projection:profileProjection(hub.db,actor)});
      if (req.method==="POST" && path==="/api/profile") {
        const input=await body(req);
        if (!usagePolicy(hub.db).settings.memory && input.deleted!==true)
          throw new HubError(403,"利用ポリシーにより記憶の追加・更新を停止しています。");
        const saved=saveEmployeePreference(hub.db,actor,input);
        writeProfileFiles(hub.db,actor,dir);
        return json(saved);
      }
      const action = path.match(/^\/api\/meeting-actions\/([a-z0-9-]+)$/);
      if (req.method === "POST" && action) return json(personal.completeAction(actor,action[1],(await body(req)).done));
      const draft = path.match(/^\/api\/request-drafts\/([a-f0-9-]{36})$/);
      if (draft && req.method === "GET") return json(personal.readDraft(actor,draft[1]));
      if (draft && req.method === "POST") return json(personal.saveDraft(actor,draft[1],await body(req,128*1024)));
      if (req.method === "POST" && path === "/api/templates") return json(personal.saveTemplate(actor, await body(req)),201);
      if (req.method === "POST" && path === "/api/procedure-favorites") return json(personal.favorite(actor,await body(req)));
      if (req.method === "POST" && path === "/api/schedules") return json(personal.schedule(actor, await body(req)),201);
      if (req.method === "POST" && path === "/api/reservation-plan/preview") return json(plans.preview(actor,await body(req)));
      if (req.method === "POST" && path === "/api/reservation-plan/confirm") return json(plans.confirm(actor,await body(req)),201);
      if (req.method === "POST" && path === "/api/work-split") {
        const input=await body(req,24000);
        const origin=typeof input.origin==="string" && /^[0-9a-f-]{36}$/i.test(input.origin) ? await displayJob(actor,input.origin) : null;
        return json(split.create(actor,input,req.headers["idempotency-key"],origin),201);
      }
      const splitRoute=path.match(/^\/api\/work-split\/([a-z0-9-]+)\/(retry|partial)$/);
      if (req.method === "POST" && splitRoute) {
        const input=await body(req);
        return json(splitRoute[2]==="partial" ? split.acceptPartial(actor,splitRoute[1]) :
          split.retry(actor,splitRoute[1],input.position,input.generation));
      }
      const occurrence=path.match(/^\/api\/schedules\/([a-z0-9-]+)\/next$/);
      if (occurrence && req.method === "GET") {
        const at=new URL(req.url,"http://"+host).searchParams.get("at");
        return json(personal.previewOccurrence(actor,occurrence[1],at === null ? null : Number(at)));
      }
      if (occurrence && req.method === "POST") return json(personal.editOccurrence(actor,occurrence[1],await body(req,128*1024)));
      const schedule = path.match(/^\/api\/schedules\/([a-z0-9-]+)$/);
      if (req.method === "POST" && schedule) return json(personal.enableSchedule(actor,schedule[1],(await body(req)).enabled));
      if (req.method === "GET" && path === "/api/recipients") return json(personal.recipients(actor));
      if (req.method === "GET" && path === "/api/shared") return json(personal.sharedItems(actor));
      const shared = path.match(/^\/api\/shared\/([a-z0-9-]+)$/);
      if (req.method === "GET" && shared) return json(personal.readShare(actor,shared[1]));
      const sharedAction=path.match(/^\/api\/shared\/([a-z0-9-]+)\/(read|revoke)$/);
      if (req.method==="POST" && sharedAction) return json(sharedAction[2]==="read" ?
        personal.viewShare(actor,sharedAction[1]) : personal.revokeShare(actor,sharedAction[1]));
      const sentShares=path.match(/^\/api\/jobs\/([a-z0-9-]+)\/shares$/);
      if (req.method==="GET" && sentShares) return json(personal.sentShares(actor,sentShares[1]));
      if (req.method === "GET" && path === "/api/notifications") return json(hub.notifications(actor));
      const notification = path.match(/^\/api\/notifications\/(\d+)\/read$/);
      if (req.method === "POST" && notification) return json(hub.readNotification(actor, Number(notification[1])));
      if (req.method === "GET" && path === "/api/jobs/search")
        return json(hub.search(actor, new URL(req.url, "http://" + host).searchParams.get("q") || ""));
      if (req.method === "GET" && path === "/api/jobs/receipt")
        return json(hub.requestReceipt(actor, req.headers["idempotency-key"]));
      if (req.method === "POST" && path === "/api/jobs") {
        const input = await body(req,128*1024);
        if (input.draft_id && input.arrival_wait!==undefined) throw new HubError(400,"到着待ちの比較は新しい依頼から登録してください。");
        const id = input.draft_id ? personal.submitDraft(actor,input) : hub.create(actor,input,req.headers["idempotency-key"]);
        return json({id},201);
      }
      const quoteExport = path.match(/^\/api\/jobs\/([a-z0-9-]+)\/versions\/(\d+)\/comparison\.csv$/);
      if (quoteExport && req.method === "GET") {
        const job=await displayJob(actor,quoteExport[1]), number=Number(quoteExport[2]);
        const version=job.versions.find(v=>v.version===number);
        const table=(number===1 ? job.work_tool : version?.work_tool)?.table;
        if (!version || !table) throw new HubError(404,"比較表が見つかりません。");
        const header=["比較項目",...table.columns.flatMap((name,i)=>[name,"出典 ["+(i+1)+"]"])];
        const rows=table.rows.map(row=>[row.label,...row.cells.flatMap((cell,i)=>
          [cell.text,table.columns[i]+(cell.ref ? " ・ "+cell.ref : " ・ 記載なし")])]);
        res.writeHead(200,{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="quote-comparison-'+job.id+'-v'+number+'.csv"'});
        return res.end("\uFEFF"+[header,...rows].map(csvLine).join(""));
      }
      const match = path.match(
        /^\/api\/jobs\/([a-z0-9-]+)(\/answer|\/resume|\/revise|\/ask|\/adopt|\/previous-reports|\/project|\/track|\/candidates|\/register-candidates|\/share|\/cancel|\/viewed|\/remind|\/reschedule|\/draft|\/submit-draft)?$/,
      );
      if (match?.[2] === "/previous-reports" && req.method === "GET") return json(personal.previousReports(actor,match[1]));
      if (match && !match[2] && req.method === "GET")
        return json(await displayJob(actor, match[1]));
      if (match && match[2] && match[2] !== "/previous-reports" && req.method === "POST") {
        const input = await body(req,match[2] === "/register-candidates" ? 128*1024 : 8192);
        if (match[2] === "/draft") return json(makeDraft(hub.db, actor, match[1], input.layout));
        if (match[2] === "/submit-draft") return json(submitDraft(hub.db, actor, match[1], input.hash));
        if (match[2] === "/candidates") { hub.extractActions(actor,match[1],input.version,req.headers["idempotency-key"]); return json({ok:true}); }
        if (match[2] === "/register-candidates") return json(personal.registerCandidates(actor,match[1],input));
        if (match[2] === "/project") return json(personal.fileInProject(actor,match[1],input));
        if (match[2] === "/track") return json(personal.trackAction(actor,match[1],input));
        if (match[2] === "/share") return json(personal.share(actor, match[1], input));
        if (match[2] === "/cancel") hub.cancel(actor, match[1]);
        else if (match[2] === "/remind") hub.remind(actor,match[1],input.due);
        else if (match[2] === "/viewed") hub.viewed(actor,match[1],input.seq);
        else if (match[2] === "/reschedule") hub.reschedule(actor, match[1], input);
        else if (match[2] === "/adopt") hub.adopt(actor, match[1], input.version,input.expected,input.save_quote_skill===true);
        else if (match[2] === "/ask") hub.ask(actor, match[1], input, req.headers["idempotency-key"]);
        else if (match[2] === "/revise") return json({ok:true,...hub.revise(actor, match[1], input, req.headers["idempotency-key"])});
        else if (match[2] === "/resume") hub.resume(actor, match[1]);
        else hub.answer(actor, match[1], input);
        return json({ ok: true });
      }
      throw new HubError(404, "見つかりません。");
    } catch (e) {
      if (res.headersSent || res.destroyed) return res.destroy();
      json(
        { error: e instanceof HubError ? e.message : "処理できませんでした。", code: e instanceof HubError ? e.code : undefined },
        e instanceof HubError ? e.status : 500,
      );
    }
  });
  server.listen(port, process.env.LISTEN_ADDR || "127.0.0.1", () =>
    console.log(entry + " http://127.0.0.1:" + port),
  );
}
// Development identities are attached to loopback-only listening ports.
for (const [entry, port] of Object.entries(entryPorts)) listen(entry, port);
for (const actor of Object.keys(employees)) {
  const host = process.env[actor.toUpperCase() + "_GATEWAY_HOST"];
  if (host) listenGateway(hub.db, actor, host);
}
setInterval(
  () => work().catch(() => console.error("実行状態の更新に失敗しました。")),
  500,
);
setInterval(()=>{
  try { split.pump(); } catch { console.error("作業分担の受付に失敗しました。"); }
},500);
setInterval(
  () => scanArrivals().catch(() => console.error("見積の到着確認に失敗しました。")),
  500,
);

personal.runDue();
setInterval(() => recheckReceipts().catch(() => console.error("会議メモの自動照合に失敗しました。")), 1000);
setInterval(() => { hub.sendReminders(); personal.runDue(); }, 15000);
