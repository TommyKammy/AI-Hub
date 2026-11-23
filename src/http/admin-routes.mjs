import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { catalog, connections, register, probe, publish } from "../models/catalog.mjs";
import { applyDirectorySync, applyGroupSync, directorySyncPreview, groupAccess, groupOverview, localDirectoryOverview, previewGroupSync, previewLocalGroup, saveCompanySelection, saveLocalGroup } from "../identity/enterprise-directory.mjs";
import { employees } from "../fixtures.mjs";
import { closeUnconfirmedMeeting, HubError, meetingClosureAudit, pendingRecoveries, reconcileRun, startPendingWeekly } from "../jobs/hub.mjs";
import { managedLibraries, updateManagedLibrary } from "../documents/libraries.mjs";
import { adminAccount, adminAudit, adminAuditCsv, auditExportHistory, memberDirectory, memberDirectoryCsv, memberHistory, recordAdminDenial, savedExportRows, setMemberActive, stoppedDispatches, transfer } from "../identity/memberships.mjs";
import { checkModelProfile, modelProfiles, saveModelProfile } from "../models/model-profiles.mjs";
import { setStopped, readLog, reasonText } from "../operations.mjs";
import { changeProcedureDelivery, previewProcedureDelivery, procedureAdministration, rollbackProcedure, reviewList, publishProcedure, previewRevision, publishRevision, revokeProcedure } from "../procedures/procedures.mjs";
import { importIndustryProcedures, industryPackages, listStandardProcedures, saveStandardProcedure, standardProcedureAdministration } from "../procedures/standard-procedures.mjs";
import { changeUsagePolicy, retentionEstimate, usagePolicy, usagePolicyHistory, usageSnapshot } from "../models/usage-policy.mjs";
import { usageReport } from "../models/usage-report.mjs";

export const adminApiPrefix = "/api/admin/";

const postDenial = (scope, action, target = "id") => ({ method, params }) =>
  method === "POST" ? { scope, id: params[target], action: action ?? params.action } : undefined;
const standardDenial = ({ method, params }) => ({
  scope: "procedure",
  id: params.id,
  action: method === "POST" ? "会社標準手順の改訂" : "会社標準手順の管理情報閲覧",
});
const groupDenial = ({ path }) => ({
  scope: "group",
  action: path.endsWith("/save") ? "グループの保存" : "社員別の適用結果",
});
const collectionDenial = ({ method, path }) => ({ action: method + " " + adminApiPrefix + path });

export function createAdminApi({ db, personal, runtimes, hermes, lookupReceipt, localDirectoryFile }) {
  async function auditCsv({ res, filters, operator }, history) {
    const csv = adminAuditCsv(db, filters, operator, history ? "history" : "audit");
    const keys = history ? ["exported_by", "employee", "source"] : ["employee", "operator", "outcome"];
    const tags = keys.map(key => filters.get(key))
      .filter(value => value && /^[a-zA-Z0-9_.-]{1,64}$/.test(value));
    const filename = [history ? "csv-export-history" : "audit-log", ...tags].join("-") + ".csv";
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="' + filename + '"' });
    await pipeline(Readable.from(csv.lines), res);
    csv.markSent();
  }

  const routes = [
    { path: "session", GET: ({ json, principal, manager }) =>
      json(localDirectoryFile && manager ? { ...principal, localDirectory: true } : principal), auditorRead: true },
    { path: "groups", GET: ({ json, manager }) => json(groupOverview(db, manager)), auditorRead: true },
    { path: "usage-overview", GET: ({ json }) => json(usageSnapshot(db)), auditorRead: true },
    { path: "usage-report", GET: ({ json, filters }) => json(usageReport(db, filters)), auditorRead: true },
    { path: "member-directory", GET: ({ json }) =>
      json(Object.entries(employees).map(([actor, employee]) => ({ actor, name: employee.name }))), auditorRead: true },
    { path: "member-changes", GET: ({ json, filters }) => json(memberHistory(db, filters)), auditorRead: true },
    { path: /^member-changes\/(?<id>[0-9]+)\/dispatches$/, GET: ({ json, params }) =>
      json(stoppedDispatches(db, params.id)), auditorRead: true },
    { path: "audit", GET: ({ json, filters }) => json(adminAudit(db, filters)), auditorRead: true },
    { path: "audit/meeting-closures", GET: ({ json, filters }) =>
      json(meetingClosureAudit(db, filters.get("job"))), auditorRead: true },
    { path: "audit/exports", GET: ({ json, filters }) => json(auditExportHistory(db, filters)), auditorRead: true },
    { path: /^audit\/exports\/(?<id>[0-9]+)\/(?<kind>rows|audit-rows)$/, GET: ({ json, params, filters }) =>
      json(savedExportRows(db, params.id, filters, params.kind === "audit-rows" ? "audit" : "history")), auditorRead: true },
    { path: "audit.csv", GET: context => auditCsv(context, false), auditorRead: true },
    { path: "audit/exports.csv", GET: context => auditCsv(context, true), auditorRead: true },
    { path: /^models\/(?<kind>usage|changes)$/, GET: ({ json, params, filters }) =>
      json(readLog(db, params.kind, filters)), auditorRead: true },

    { path: "industry-packages", GET: ({json})=>json(industryPackages(db)), denial: standardDenial },
    { path: /^industry-packages\/(?<id>[a-z0-9-]+)\/import$/,
      POST: async ({json,params,readBody,operator})=>json(importIndustryProcedures(db,params.id,await readBody(),operator)),
      denial: ({params})=>({scope:"procedure",id:params.id,action:"業種パッケージの取込"}) },
    { path: "standard-procedures", GET: ({ json }) => json(listStandardProcedures(db)), denial: standardDenial },
    { path: /^standard-procedures\/(?<id>[a-z0-9-]+)$/,
      GET: ({ json, params }) => json(standardProcedureAdministration(db, params.id)),
      POST: async ({ json, params, readBody, operator }) =>
        json(saveStandardProcedure(db, params.id, await readBody(128 * 1024), operator)),
      denial: standardDenial },
    { path: "groups/access", GET: ({ json, filters }) =>
      json(groupAccess(db, filters.get("actor") || "")), denial: groupDenial },
    { path: "groups/preview", POST: async ({ json, readBody }) =>
      json(previewLocalGroup(db, await readBody())), denial: groupDenial },
    { path: "groups/save", POST: async ({ json, readBody, operator }) =>
      json(saveLocalGroup(db, await readBody(), operator)), denial: groupDenial },
    { path: "groups/company", POST: async ({ json, readBody, operator }) =>
      json(saveCompanySelection(db, await readBody(), operator)), denial: groupDenial },
    { path: "local-directory", GET: ({ json }) => json(localDirectoryOverview(db)) },
    { path: "local-directory/preview", POST: async ({ json, readBody }) => json(directorySyncPreview(db, await readBody())) },
    { path: "local-directory/apply", POST: async ({ json, readBody, operator }) =>
      json(applyDirectorySync(db, await readBody(), operator)) },
    { path: "local-directory/group/preview", POST: async ({ json, readBody }) =>
      json(previewGroupSync(db, await readBody())), denial: groupDenial },
    { path: "local-directory/group/apply", POST: async ({ json, readBody, operator }) =>
      json(applyGroupSync(db, await readBody(), operator)), denial: groupDenial },
    { path: "usage-policy", GET: ({ json }) => {
      const current = usagePolicy(db);
      return json({ current, history: usagePolicyHistory(db), retentionEstimate: retentionEstimate(db, current) });
    } },
    { path: /^usage-policy\/(?<action>publish|stop|restore)$/, POST: async ({ json, params, readBody, operator }) =>
      json(changeUsagePolicy(db, await readBody(64 * 1024), params.action, operator, Object.keys(connections))) },
    { path: "recoveries", GET: ({ json }) => json(pendingRecoveries(db)) },
    { path: /^recoveries\/(?<id>[a-z0-9-]+)\/close$/, POST: async ({ json, params, readBody, operator }) =>
      json(closeUnconfirmedMeeting(db, params.id, await readBody(), operator)),
      denial: postDenial("job", "結果未確認で対応終了") },
    { path: /^recoveries\/(?<id>[a-z0-9-]+)\/weekly\/(?<weekly>[a-z0-9-]+)$/, POST: ({ json, params, operator }) =>
      json(startPendingWeekly(db, params.id, params.weekly, operator)),
      denial: postDenial("job", "後続の週報を開始", "weekly") },
    { path: /^recoveries\/(?<id>[a-z0-9-]+)$/, POST: async ({ json, params, readBody, operator }) =>
      json(await reconcileRun(db, hermes, params.id, await readBody(), operator, lookupReceipt)),
      denial: postDenial("job", "実行結果の照合") },
    { path: "memberships", GET: ({ json, filters }) => json(memberDirectory(db, filters).rows), denial: collectionDenial },
    { path: "account-list", GET: ({ json, filters }) => json(memberDirectory(db, filters)) },
    { path: "account-list.csv", GET: ({ res, filters }) => {
      const csv = memberDirectoryCsv(db, filters);
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="user-accounts.csv"' });
      return res.end(csv);
    } },
    { path: /^memberships\/(?<id>[a-z0-9._-]+)$/,
      GET: ({ json, params: { id } }) =>
        json({ ...adminAccount(db, id), runtime: runtimes.details(id), schedules: personal.adminSchedules(id) }),
      POST: async ({ json, params, readBody, operator }) => json(transfer(db, params.id, await readBody(), operator)),
      denial: postDenial("employee", "transfer") },
    { path: /^memberships\/(?<id>[a-z0-9._-]+)\/access$/,
      POST: async ({ json, params, readBody, operator }) => json(setMemberActive(db, params.id, await readBody(), operator)),
      denial: async ({ method, params, readBody }) => {
        if (method !== "POST") return;
        // Invalid input still records a denied access change.
        const input = await readBody().catch(() => null);
        return { scope: "employee", id: params.id,
          action: input?.active === true ? "enable" : input?.active === false ? "disable" : "access" };
      } },
    { path: /^memberships\/(?<id>[a-z0-9._-]+)\/(?<kind>runtime|schedules)$/,
      POST: async ({ json, params: { id, kind }, readBody, operator }) => {
        const input = await readBody(4096);
        return json(kind === "runtime" ? runtimes.save(id, input, operator) : personal.saveAdminSchedule(id, input, operator));
      },
      denial: ({ method, params }) => ({ scope: "employee", id: params.id, action: method + " " + params.kind }) },
    { path: "library-connections", GET: ({ json }) => json(managedLibraries(db)),
      POST: async ({ json, readBody, operator }) => json(updateManagedLibrary(db, await readBody(), operator)) },
    { path: "projects", GET: ({ json }) => json(personal.projectsForAdmin()) },
    { path: "procedures", GET: ({ json }) => json(reviewList(db)), denial: collectionDenial },
    { path: /^procedures\/(?<id>[a-z0-9-]+)\/(?<action>quality)$/,
      GET: ({ json, params }) => json(procedureAdministration(db, params.id)), denial: postDenial("procedure") },
    { path: /^procedures\/(?<id>[a-z0-9-]+)\/(?<action>publish|preview-revision|revise|revoke|preview-delivery|delivery|rollback)$/,
      POST: async ({ json, params: { id, action }, readBody, operator }) => {
        const input = await readBody();
        if (action === "preview-revision") return json(previewRevision(db, id, input));
        if (action === "revise") publishRevision(db, id, input, operator);
        else if (action === "revoke") revokeProcedure(db, id, input.hash, operator);
        else if (action === "preview-delivery") return json(previewProcedureDelivery(db, id, input));
        else if (action === "delivery") return json(changeProcedureDelivery(db, id, input, operator));
        else if (action === "rollback") return json(rollbackProcedure(db, id, input, operator));
        else publishProcedure(db, id, input.hash, operator);
        return json({ ok: true });
      },
      denial: postDenial("procedure") },
    { path: "models", GET: ({ json }) => json(catalog(db)),
      POST: async ({ json, readBody, operator }) => json({ id: register(db, await readBody(), operator) }, 201),
      denial: collectionDenial },
    { path: "model-profiles", GET: ({ json }) => json(modelProfiles(db)),
      POST: async ({ json, readBody, operator }) => {
        const input = await readBody(4096);
        return json(saveModelProfile(db, input, operator), input.id === undefined ? 201 : 200);
      } },
    { path: "model-profiles/check", POST: async ({ json, readBody }) => {
      const { target } = checkModelProfile(await readBody(4096));
      return json({ target });
    } },
    { path: /^models\/(?<id>[a-z0-9-]+)\/(?<action>test|publish|stop|enable|restore)$/,
      POST: async ({ json, params: { id, action }, readBody, operator }) => {
        const input = await readBody();
        if (action === "test") return json(await probe(db, id, operator));
        if (action === "stop" || action === "enable") setStopped(db, id, input, action === "stop", operator);
        else publish(db, id, input.base, operator, reasonText(input.reason), action === "restore");
        return json(catalog(db));
      },
      denial: postDenial("model") },

    // Unknown paths in the group namespaces still receive the group denial record.
    { path: /^(?:groups|local-directory\/group)\//, denial: groupDenial },
  ];

  return async function adminApi({ req, res, url, json, principal, readBody }) {
    const path = url.pathname.slice(adminApiPrefix.length);
    const method = req.method;
    const manager = principal.role === "manager";
    let route, params;
    for (const candidate of routes) {
      const match = typeof candidate.path === "string" ? candidate.path === path : candidate.path.exec(path);
      if (match) {
        route = candidate;
        params = match.groups ?? {};
        break;
      }
    }
    const context = { path, method, params, res, filters: url.searchParams, json, principal, manager,
      operator: principal.account, readBody };
    const handler = route && Object.hasOwn(route, method) ? route[method] : undefined;
    if (!manager && !(handler && method === "GET" && route.auditorRead)) {
      const { scope = "admin", id = "", action = "その他の管理API" } = await route?.denial?.(context) ?? {};
      recordAdminDenial(db, principal.account, scope, id.slice(0, 256), action);
      throw new HubError(403, "この操作には管理操作の権限が必要です。");
    }
    if (path.startsWith("local-directory") && !localDirectoryFile)
      throw new HubError(404, "ローカルの検証ディレクトリが設定されていません。");
    if (!handler) throw new HubError(404, "見つかりません。");
    return handler(context);
  };
}
