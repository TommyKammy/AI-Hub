import { auditFields, changeLabels, exportHistoryFields, timestamp } from "./audit-format.js";
import { icon } from "./visual.js";
import { loadAnalytics, loadDashboard } from "./admin-dashboard.js";
import { installModelProfiles } from "./admin-model-profiles.js";
import { installMemberWork, memberWorkSections } from "./admin-member-work.js";
import { checkSessionResponse, installAccountSession } from "./account-session.js";
const verifyAccountSession = installAccountSession();
const $ = (s) => document.querySelector(s);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const probeLabels = {
  untested: "未テスト",
  testing: "テスト中",
  passed: "テスト成功",
  failed: "テスト失敗",
};
let state, canManage = false, currentArea;
const areaLinks = [...document.querySelectorAll("#adminAreas a")];
const shortcutLinks = [...document.querySelectorAll("#adminShortcuts a")];
const areas = [...document.querySelectorAll("[data-area]")];
const loadModelProfiles = installModelProfiles({open, request, escape});

function setMenuOpen(open) {
  $("#adminSidebar").classList.toggle("menu-open", open);
  $("#adminMenuToggle").setAttribute("aria-expanded", String(open));
}

$("#adminMenuToggle").onclick = () => setMenuOpen(!$("#adminSidebar").classList.contains("menu-open"));
$("#adminShortcuts").addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (link?.hash === location.hash && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
    setMenuOpen(false);
    currentArea?.focus({ preventScroll: true });
  }
});
$("#adminSidebar").addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#adminSidebar").classList.contains("menu-open")) {
    setMenuOpen(false);
    $("#adminMenuToggle").focus();
  }
});
for (const node of document.querySelectorAll("[data-icon]")) node.innerHTML = icon(node.dataset.icon);

const areaAliases = {
  models: "models-heading",
  analytics: "usage-overview",
  members: "memberships",
  audit: "employee-history",
};
const areaLoaders = {
  dashboard: () => loadDashboard($("#dashboardRows"), { canManage }),
  "models-heading": loadModelProfiles,
  "usage-overview": loadUsageOverview,
  groups: () => Promise.all([
    window.loadAdminGroups(),
    ...(!$("#local-directory").hidden ? [loadLocalDirectory()] : []),
  ]),
  procedures: async () => {
    await Promise.all([loadProcedures(), loadStandardProcedures()]);
  },
  "procedure-quality": loadProcedures,
  memberships: loadDirectory,
  "project-admin": loadProjects,
  "library-connections": loadLibraryConnections,
  "employee-history": () => loadPage("employees"),
};

function showArea(navigating = false) {
  if ($("#adminAreas").hidden || location.hash === "#main" && currentArea) return;
  const fragment = location.hash.slice(1);
  const target = document.getElementById(Object.hasOwn(areaAliases, fragment) ? areaAliases[fragment] : fragment);
  const requested = target?.closest("[data-area]");
  const area = requested && (!requested.hasAttribute("data-manager") || canManage) ? requested : $("#dashboard");
  const sectionChanged = currentArea !== area;
  currentArea = area;
  for (const section of areas) section.hidden = section !== area;
  for (const link of [...areaLinks, ...shortcutLinks]) {
    if (link.hash === "#" + area.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("#adminCrumb").textContent = areaLinks.find(link => link.hash === "#" + area.id).textContent.trim();
  document.title = $("#adminCrumb").textContent + "｜AI Hub";

  const deepLink = target && target !== area && area.contains(target) && !target.closest("[hidden]");
  const details = deepLink && target.closest("details");
  if (details) details.open = true;
  if (navigating) {
    setMenuOpen(false);
    $("#notice").textContent = "";
    area.focus({ preventScroll: true });
  }
  if (deepLink) target.scrollIntoView();
  else if (navigating) window.scrollTo(0, 0);
  if (sectionChanged && (navigating || ["dashboard", "models-heading", "usage-overview", "groups"].includes(area.id))) {
    areaLoaders[area.id]?.().catch(report);
  }
}

window.addEventListener("hashchange", () => showArea(true));
async function request(path, payload, base = "/api/admin/models") {
  const res = await fetch(
    base + path,
    payload === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
  );
  const result = await res.json();
  if (!res.ok) {
    checkSessionResponse(result);
    const error = Error(result.error || "操作できませんでした。");
    error.status = res.status;
    throw error;
  }
  return result;
}
function current() {
  return state.models.find((m) => m.id === state.current.model);
}
function resultHtml(result) {
  if (!result) return "";
  if (result.error) return '<p class="error">' + escape(result.error) + "</p>";
  return (
    "<details><summary>テスト結果を見る</summary><p>所要時間 " +
    result.elapsed_ms +
    " ms ・ " +
    (result.tokens ?? "不明") +
    " トークン</p><h3>生成した質問</h3><p>" +
    escape(result.question) +
    '</p><h3>回答後のメモ</h3><p class="doc-body">' +
    escape(result.memo) +
    "</p></details>"
  );
}
function usageSummary(id) {
  const x = state.usageTotals.find((r) => r.model === id);
  return x
    ? '<details><summary>累計の利用状況</summary><p class="info">' +
        x.jobs +
        "依頼 ／ 呼び出し " +
        x.calls +
        "件 ／ 提供元エラー " +
        x.failures +
        "件 ／ 結果不明 " +
        x.uncertain +
        '件</p><p class="info">平均応答時間 ' +
        (x.mean_ms ?? "不明") +
        " ms ／ 使用量が判明した合計 " +
        (x.known_tokens ?? "不明") +
        " トークン（未判明 " +
        x.missing_tokens +
        "件）</p></details>"
    : "";
}
function render() {
  $("#standard").textContent = current().name;
  $("#standardDetail").textContent =
    "設定 v" + state.current.version + " ・ 新しく受け付けるすべての依頼に適用";
  if (current().stopped) $("#standardDetail").textContent += " ・ 緊急停止中";
  $("#register").disabled = false;
  $("#modelConnections").replaceChildren(...state.connections.map(connection => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = connection.name;
    button.addEventListener("click", () => openRegistration(connection.id));
    item.append(button);
    return item;
  }));
  $("#rollback").hidden = !state.previous;
  $("#models").innerHTML = state.models
    .map(
      (m) =>
        '<section class="panel pad" data-model="' +
        escape(m.id) +
        '"><div class="split"><h2>' +
        escape(m.name) +
        '</h2><span class="meta">' +
        (m.stopped ? "緊急停止中" : probeLabels[m.probe]) +
        '</span></div><p class="info">' +
        escape(state.connections.find((c) => c.id === m.connection).name) +
        " ／ " +
        escape(m.model_id) +
        " ／ " +
        escape(m.data_class) +
        "</p>" +
        resultHtml(m.result) +
        usageSummary(m.id) +
        '<div class="actions"><button type="button" data-action="test" class="secondary" ' +
        (m.stopped ? "disabled" : "") +
        ">接続テスト</button>" +
        '<button type="button" class="secondary" data-action="' +
        (m.stopped ? "enable" : "stop") +
        '">' +
        (m.stopped ? "停止を解除" : "緊急停止") +
        "</button>" +
        (m.id === state.current.model
          ? '<strong class="info">全社標準</strong>'
          : '<button type="button" data-action="compare" class="primary" ' +
            (m.stopped || m.probe !== "passed" ? "disabled" : "") +
            ">公開内容を確認</button>") +
        "</div></section>",
    )
    .join("");
}
async function refresh() {
  const session = await request("", undefined, "/api/admin/session");
  canManage = session.role === "manager";
  $("#local-directory").hidden = !canManage;
  $("#local-directory").dataset.configured = String(Boolean(session.localDirectory));
  $("#adminInitials").textContent = session.account.slice(0,2).toUpperCase();
  $("#sidebarAccount").textContent = session.account;
  $("#sidebarRole").textContent = canManage ? "管理者" : "閲覧専用管理者";
  $("#adminAccount").textContent = session.account;
  $("#adminRole").textContent = canManage ? "管理者" : "閲覧専用管理者";
  document.querySelectorAll("a[data-manager]").forEach(el => { el.hidden = !canManage; });
  $("#adminShortcuts").hidden = $("#adminAreas").hidden = false;
  showArea();
  if (canManage) {
    state = await request("");
    render();
    await Promise.all([loadProcedures(), loadRecoveries(), loadLibraryConnections(), loadPolicy(),
      ...(currentArea.id === "procedures" ? [loadStandardProcedures()] : [])]);
  }
  await Promise.all([loadLogs(), loadMembers()]);
}
const policyApi = "/api/admin/usage-policy";
const money = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 6 });
const yen = value => money.format(value / 1_000_000) + " 円";
const policyActions = { initial:"初期設定", publish:"公開", stop:"緊急停止", restore:"復元" };
const retentionLabels = { attachments:"添付を含む仕事", outputs:"成果物を含む仕事", audit:"管理監査の記録" };
let policyView;
async function loadPolicy() {
  policyView = await request("", undefined, policyApi);
  const { current, history, retentionEstimate } = policyView;
  const { settings } = current;
  const policyReason = '<label class="formlabel">ポリシーを変更する理由（必須）<input name="reason" required maxlength="240"></label>';
  const restore = history.filter(row => row.version < current.version && row.action !== "stop");
  const choice = settings.models ?? state.models.map(model=>model.id);
  const routes = settings.destinations ?? state.connections.map(connection=>connection.id);
  const controls = (values, name, selected, label) => '<fieldset class="panel pad"><legend>' + label + '</legend>' +
    values.map(value => '<label><input type="checkbox" name="' + name + '" value="' + escape(value.id) + '"' +
      (selected.includes(value.id) ? ' checked' : '') + '> ' + escape(value.name) + '</label><br>').join("") + '</fieldset>';
  const numeric = (id,name,label,value,maximum) => '<div class="formlabel"><label for="' + id + '">' + label + '</label><input id="' +
    id + '" name="' + name + '" type="number" min="0" max="' + maximum + '" value="' + (value ?? "") + '"></div>';
  const editor = settings.stopped ? "" : '<form id="publishPolicy" data-policy-action="publish">' +
    controls(state.models,"models",choice,"利用を許可するモデル") + controls(state.connections,"destinations",routes,"利用を許可する推論先") +
    '<details><summary>限定合成資料の利用可否と推論先</summary><p>部門の資料、添付、過去の仕事を使う依頼に適用します。</p>' +
    '<label><input type="checkbox" name="restricted_enabled"' + (settings.restricted.enabled ? ' checked' : '') +
    '> 限定合成資料での利用を許可</label>' +
    controls(state.models,"restricted_models",settings.restricted.models ?? choice,"限定合成資料で利用を許可するモデル") +
    controls(state.connections,"restricted_destinations",settings.restricted.destinations ?? routes,"限定合成資料で利用を許可する推論先") +
    '</details>' +
    '<div class="actions"><label><input type="checkbox" name="inquiry"' + (settings.inquiry ? ' checked' : '') +
    '> 新規の窓口起票を許可</label><label><input type="checkbox" name="memory"' + (settings.memory ? ' checked' : '') +
    '> プロフィールの参照・記録を許可</label></div>' +
    '<details><summary>保持期間の試算</summary><p>仕事は受付日、管理監査は操作日時からの日数で集計します。</p><div class="log-filters">' +
    Object.entries(retentionLabels).map(([field,label])=>numeric("policy-retention-"+field,"retention_"+field,label+"（日）",
      settings.retention[field],3650)).join("") + '</div></details>' +
    '<details><summary>合成評価の月間予算と単価</summary><p>金額はマイクロ円（100万マイクロ円＝1円）で入力します。</p>' +
    '<div class="log-filters">' + numeric("policyBudget","budget","月間上限（空欄は上限なし）",settings.budget?.limit,100_000_000_000) +
    numeric("policyThreshold","threshold","通知のしきい値（%）",settings.budget?.threshold ?? 80,100) + '</div>' +
    state.models.map((model,index) => {
      const rate=settings.rates.find(row=>row.model===model.id);
      return '<fieldset class="panel pad"><legend>' + escape(model.name) + '</legend><div class="log-filters">' +
        numeric("policy-in-"+index,"rate_input_"+index,"入力1トークンの単価",rate?.input,100_000_000_000) +
        numeric("policy-out-"+index,"rate_output_"+index,"出力1トークンの単価",rate?.output,100_000_000_000) +
        numeric("policy-reserve-"+index,"rate_reserve_"+index,"送信1回の予約額",rate?.reserve,100_000_000_000) + '</div></fieldset>';
    }).join("") + '</details>' + policyReason + '<button type="submit" class="primary">利用ポリシーを公開する</button></form>';
  $("#policyRows").innerHTML = '<article class="panel pad"><h3>公開版 v' + current.version + '</h3><p>対象の機密区分　' +
    escape(settings.classification) + ' ／ 限定合成資料 ' + (settings.restricted.enabled ? '許可' : '停止') +
    ' ／ ' + (settings.stopped ? '緊急停止中' : '適用中') + '</p>' +
    '<h4>保持期間の試算</h4><ul>' + Object.entries(retentionEstimate).map(([field,item]) => '<li>' +
      retentionLabels[field] + '　' + (item.days===null ? '未指定' : item.days + '日 ／ 該当 ' + item.candidates + '件') + '</li>').join("") +
    '</ul>' + editor +
    (!settings.stopped ? '<form data-policy-action="stop">' + policyReason + '<button type="submit" class="secondary">利用を緊急停止する</button></form>' : '') +
    (restore.length ? '<form data-policy-action="restore"><div class="formlabel"><label for="policyRestoreVersion">復元する公開版</label>' +
      '<select id="policyRestoreVersion" name="version">' + restore.map(row => '<option value="' + row.version + '">v' + row.version +
      '　' + policyActions[row.action] + '</option>').join("") + '</select></div>' + policyReason +
      '<button type="submit" class="secondary">選択した公開版を復元する</button></form>' : '') +
    '<details><summary>ポリシーの変更履歴</summary>' + history.map(row => '<div class="logrow"><b>v' + row.version + '　' +
      policyActions[row.action] + '</b><p>' + escape(timestamp(row.time)) + (row.operator ? ' ／ 操作者 ' + escape(row.operator) : '') +
      '</p>' + (row.reason ? '<p>理由　' + escape(row.reason) + '</p>' : '') +
      (row.source ? '<p>復元元　v' + row.source + '</p>' : '') + '</div>').join("") + '</details><p id="policyStatus" role="status"></p></article>';
}
$("#policyRows").addEventListener("submit", async event => {
  const form=event.target, action=form.dataset.policyAction, button=event.submitter ?? form.querySelector("button[type=submit]");
  if (!action || !button || button.disabled) return;
  event.preventDefault();
  const status=$("#policyStatus"), values=new FormData(form);
  button.disabled=true;
  try {
    const input={base:policyView.current.version,reason:values.get("reason")};
    if (action==="publish") {
      const budget=values.get("budget");
      input.settings={classification:"合成資料",models:values.getAll("models"),destinations:values.getAll("destinations"),
        restricted:{enabled:values.has("restricted_enabled"),models:values.getAll("restricted_models"),
          destinations:values.getAll("restricted_destinations")},
        inquiry:values.has("inquiry"),memory:values.has("memory"),
        retention:Object.fromEntries(Object.keys(retentionLabels).map(field=>{
          const days=values.get("retention_"+field);
          return [field,days ? Number(days) : null];
        })),
        budget:budget ? {limit:Number(budget),threshold:Number(values.get("threshold"))} : null,
        rates:state.models.flatMap((model,index)=>{
          const [costIn,costOut,reserve]=["input","output","reserve"].map(field=>values.get("rate_"+field+"_"+index));
          return costIn || costOut || reserve ? [{model:model.id,input:Number(costIn),output:Number(costOut),reserve:Number(reserve)}] : [];
        })};
    } else if (action==="restore") input.version=Number(values.get("version"));
    const changed=await request("/"+action,input,policyApi);
    await Promise.all([loadPolicy(),loadUsageOverview()]);
    $("#policyStatus").textContent="利用ポリシー v"+changed.version+" を適用しました。";
  } catch (error) { status.textContent=error.message; }
  finally { button.disabled=false; }
});
async function loadUsageOverview() {
  return loadAnalytics($("#usageOverviewRows"));
}
$("#refreshUsageOverview").onclick = () => loadUsageOverview().catch(report);
const localDirectoryApi = "/api/admin/local-directory";
function syncSummary(state) {
  return (state.eligible ? "利用可能" : "利用停止中") + " ／ モデル " + (state.models.map(model=>model.name).join("、") || "なし")+
    (state.restrictedModels ? " ／ 限定合成資料 "+(state.restrictedModels.map(model=>model.name).join("、") || "なし") : "");
}
function attributeDiff(before,after,groups=[]) {
  const values=[["表示名","displayName"],["メール","email"]].flatMap(([label,field])=>before[field]===after[field] ? [] :
    [label+"　"+(before[field] || "未設定")+" → "+(after[field] || "未設定")]);
  const names=ids=>(ids || []).map(id=>groups.find(group=>group.id===id)?.name || id).join("、") || "なし";
  const former=names(before.groups), current=names(after.groups);
  if (former!==current) values.push("グループ　"+former+" → "+current);
  return values.join(" ／ ");
}
async function loadLocalDirectory() {
  if ($("#local-directory").dataset.configured!=="true") {
    $("#directoryRows").innerHTML='<article class="panel pad"><p>ローカル検証用のディレクトリは未設定です。</p>'+
      '<p class="meta">検証用のテナントID・社員のobject ID・同期元グループを設定し、Hubに読み込ませると同期差分を確認できます。</p></article>';
    return;
  }
  const data=await request("",undefined,localDirectoryApi);
  if (!data.people.length) {
    $("#directoryRows").innerHTML='<p class="empty">同期できる社員の対応付けはありません。</p>';
    return;
  }
  $("#directoryRows").innerHTML = '<article class="panel pad"><h3>ローカル同期の差分</h3><form id="localSync">' +
    '<div class="formlabel"><label for="syncPerson">同期する社員</label><select id="syncPerson" required name="externalId">' +
    data.people.map(person=>'<option value="'+escape(person.externalId)+'">'+escape(person.name)+'</option>').join("")+
    '</select></div><div class="formlabel"><label for="syncName">同期元の表示名</label><input id="syncName" name="displayName" maxlength="120"></div>' +
    '<div class="formlabel"><label for="syncEmail">同期元のメール</label><input id="syncEmail" type="email" name="email" maxlength="254"></div>' +
    '<label><input type="checkbox" name="active">同期元で有効</label>' +
    (data.groups?.length ? '<fieldset><legend>同期元のEntraグループ</legend>'+data.groups.map(group=>
      '<label class="library-choice"><input type="checkbox" name="groups" value="'+escape(group.id)+'"> '+escape(group.name)+'</label>').join("")+'</fieldset>' : '')+
    '<div class="actions"><button type="button" class="secondary" id="previewSync">差分を確認する</button></div>' +
    '<p id="syncResult" role="status"></p><div id="syncApproval" hidden><label class="formlabel">同期理由（必須）' +
    '<input name="reason" maxlength="240" required></label><button type="submit" class="primary">確認した差分を適用する</button></div></form></article>' +
    '<article class="panel pad"><h3>同期履歴</h3>' + (data.history.map(row=>'<div class="logrow"><strong>' +
      escape(data.people.find(person=>person.actor===row.actor)?.name || row.actor) + ' ／ v' + row.version + '</strong><p>' +
      escape(timestamp(row.synced))+' JST ／ 操作者 '+escape(row.operator)+'</p><p>理由　'+escape(row.reason)+'</p><p>'+
      escape(syncSummary(row.before))+' → '+escape(syncSummary(row.after))+'</p><p>'+
      escape(attributeDiff(row.before,row.after,data.groups))+'</p></div>').join("") || '<p>同期履歴はありません。</p>') + '</article>';
  const form=$("#localSync"), preview=$("#previewSync"), approval=$("#syncApproval"), status=$("#syncResult");
  installDirectoryGroupSync(data);
  const input=()=>({tenant:data.tenant,externalId:form.elements.externalId.value,displayName:form.elements.displayName.value,
    email:form.elements.email.value,active:form.elements.active.checked,
    ...(data.groups?.length && {groups:new FormData(form).getAll("groups")})});
  let verified=null, serial=0;
  function reset() {
    verified=null;
    serial++;
    approval.hidden=true;
    form.elements.reason.disabled=true;
    status.textContent="";
  }
  function fillPerson() {
    const person=data.people.find(row=>row.externalId===form.elements.externalId.value);
    if (!person) return;
    form.elements.displayName.value=person.displayName;
    form.elements.email.value=person.email;
    form.elements.active.checked=person.active;
    for (const box of form.querySelectorAll('[name="groups"]')) box.checked=person.groups.includes(box.value);
    reset();
  }
  fillPerson();
  form.oninput=event=>{ if (event.target!==form.elements.reason) reset(); };
  form.elements.externalId.onchange=fillPerson;
  preview.onclick=async()=>{
    if (!form.reportValidity()) return;
    const seq=++serial;
    preview.disabled=true;
    try {
      const payload=input();
      const result=await request("/preview",payload,localDirectoryApi);
      if (seq!==serial) return;
      status.textContent=result.changed ? "適用前　"+syncSummary(result.before)+"。適用後　"+syncSummary(result.after)+
        (result.operatorLock ? "。管理者による停止を適用中。" : "。")+
        attributeDiff(result.before,result.after,data.groups) : "適用する差分はありません。";
      if (result.changed) {
        verified={...payload,preview:result.preview};
        approval.hidden=false;
        form.elements.reason.disabled=false;
      }
    } catch(error) { if (seq===serial) status.textContent=error.message; }
    finally { preview.disabled=false; }
  };
  form.onsubmit=async event=>{
    event.preventDefault();
    if (!verified || event.submitter.disabled) return;
    event.submitter.disabled=true;
    try {
      await request("/apply",{...verified,reason:form.elements.reason.value},localDirectoryApi);
      await Promise.all([loadLocalDirectory(),window.loadAdminGroups(),loadMembers(),loadPage("employees")]);
      $("#syncResult").textContent="確認した差分を適用しました。";
    } catch(error) { status.textContent=error.message; }
    finally { event.submitter.disabled=false; }
  };
}

window.addEventListener("local-model-groups-changed",async()=>{
  const form=$("#directoryGroupSync");
  if (!form) return;
  try {
    const data=await request("",undefined,localDirectoryApi);
    if (form.isConnected) form.refreshTargets(data.targets);
  } catch (error) { report(error); }
});

function installDirectoryGroupSync(data) {
  if (!data.groups.length) {
    $("#directoryRows").insertAdjacentHTML("afterbegin",'<p>検証用の同期元グループは登録されていません。</p>');
    return;
  }
  $("#directoryRows").insertAdjacentHTML("afterbegin",'<article class="panel pad"><h3>Entra ID グループ同期</h3>'+
    '<form id="directoryGroupSync" class="stack"><p class="meta">ローカル検証データの配信内容を使います。手動で追加したメンバーは同期後も残ります。</p>'+
    '<div class="formlabel"><label for="directorySyncSource">Entra グループ</label><select id="directorySyncSource" name="source">'+
    data.groups.map(group=>'<option value="'+escape(group.id)+'">'+escape(group.name)+'</option>').join("")+'</select></div>'+
    '<div class="formlabel"><label for="directorySyncTarget">対応する AI Hub グループ</label><select id="directorySyncTarget" name="target"></select></div>'+
    '<fieldset><legend>受信メンバー</legend>'+data.people.map(person=>'<label class="library-choice">'+
      '<input type="checkbox" name="member" value="'+escape(person.externalId)+'"> '+escape(person.name)+'</label>').join("")+'</fieldset>'+
    '<button type="button" class="secondary" data-group-preview>グループの差分を確認</button>'+
    '<div data-group-result aria-live="polite"></div><div data-group-approval hidden>'+
    '<label class="formlabel">グループの同期理由<textarea name="reason" rows="2" maxlength="240" required disabled></textarea></label>'+
    '<button type="submit" class="primary">確認したグループ差分を適用</button></div>'+
    '<p data-group-status role="status"></p></form></article>');
  const form=$("#directoryGroupSync");
  const preview=form.querySelector("[data-group-preview]"), result=form.querySelector("[data-group-result]"),
    approval=form.querySelector("[data-group-approval]"), status=form.querySelector("[data-group-status]");
  const newId=crypto.randomUUID();
  let saved, sequence=0;
  function reset() {
    sequence++;
    saved=null;
    approval.hidden=form.elements.reason.disabled=true;
    result.replaceChildren();
    status.textContent="";
  }
  const selectedSource=()=>data.groups.find(group=>group.id===form.elements.source.value);
  function renderTargets(source,previous) {
    const targets=data.targets.filter(target=>source.target ? target.id===source.target : !target.source);
    form.elements.target.innerHTML=(source.target ? "" :
      '<option value="'+newId+'">新規グループとして作成（全社設定を継承）</option>')+
      targets.map(target=>'<option value="'+escape(target.id)+'">'+escape(target.name)+'</option>').join("");
    form.elements.target.disabled=Boolean(source.target);
    if (targets.some(target=>target.id===previous)) form.elements.target.value=previous;
  }
  function selectSource() {
    const source=selectedSource();
    renderTargets(source);
    for (const box of form.querySelectorAll('[name="member"]'))
      box.checked=source.members.includes(data.people.find(person=>person.externalId===box.value).actor);
    reset();
  }
  selectSource();
  form.refreshTargets=targets=>{
    data.targets=targets;
    renderTargets(selectedSource(),form.elements.target.value);
    reset();
  };
  form.elements.source.onchange=selectSource;
  form.oninput=event=>{if (event.target!==form.elements.reason) reset();};
  const employeeNames=ids=>ids.map(actor=>data.people.find(person=>person.actor===actor)?.name || actor).join("、") || "なし";
  const models=choices=>choices.map(model=>model.name).join("、") || "なし";
  preview.onclick=async()=>{
    const sequenceAtStart=++sequence;
    preview.disabled=true;
    const target=form.elements.target.value;
    const payload={tenant:data.tenant,source:form.elements.source.value,target,create:target===newId,
      members:new FormData(form).getAll("member")};
    try {
      const view=await request("/group/preview",payload,localDirectoryApi);
      if (sequenceAtStart!==sequence || !form.isConnected) return;
      if (!view.changed) { status.textContent="適用するグループ差分はありません。"; return; }
      result.innerHTML='<p><strong>'+escape(view.target.name)+'</strong></p><dl><dt>同期メンバー追加</dt><dd>'+
        escape(employeeNames(view.added))+'</dd><dt>同期メンバー除外</dt><dd>'+escape(employeeNames(view.removed))+'</dd></dl>'+
        '<h4>社員のモデル選択</h4><div class="quote-table"><table><thead><tr><th scope="col">社員</th><th scope="col">現在</th>'+
        '<th scope="col">同期後</th></tr></thead><tbody>'+view.impact.map(row=>
          '<tr><th scope="row">'+escape(row.name)+'</th>'+[row.before,row.after].map(access=>'<td>'+
            escape(access.eligible ? "合成資料 "+models(access.general)+" ／ 限定合成資料 "+models(access.restricted) : "利用停止中")+'</td>').join("")+'</tr>').join("")+
        '</tbody></table></div>';
      saved={...payload,preview:view.preview};
      approval.hidden=form.elements.reason.disabled=false;
    } catch(error) { if (sequenceAtStart===sequence) status.textContent=error.message; }
    finally { preview.disabled=false; }
  };
  form.onsubmit=async event=>{
    event.preventDefault();
    if (!saved || event.submitter.disabled) return;
    event.submitter.disabled=true;
    try {
      await request("/group/apply",{...saved,reason:form.elements.reason.value},localDirectoryApi);
      await Promise.all([loadLocalDirectory(),window.loadAdminGroups()]);
      $("#directoryGroupSync [data-group-status]").textContent="確認したグループ差分を適用しました。";
    } catch(error) { status.textContent=error.message; }
    finally { event.submitter.disabled=false; }
  };
}
let members = [];
const recoveriesApi = "/api/admin/recoveries";
async function loadRecoveries() {
  const rows = await request("", undefined, recoveriesApi);
  $("#recoveryRows").innerHTML = rows.map(row =>
    '<article class="panel pad"><h3>' + escape(row.task) + ' ・ ' + escape(row.employee) +
    '</h3><p>受付　' + escape(timestamp(row.created)) + '</p><p>依頼ID　' + escape(row.id) +
    '</p><p>実行段階　' + escape(({review:"資料の照合",draft:"メモの作成",compose:"成果物の作成"})[row.phase] ||
      (row.phase.startsWith("revise-") ? "成果物の修正" : row.phase.startsWith("question-") ? "追加質問への回答" : row.phase)) +
    '</p>' + (row.run_id ? '<p>Hermes 実行ID　' + escape(row.run_id) +
      '</p><button type="button" class="secondary" data-reconcile="' + escape(row.id) +
      '" data-phase="' + escape(row.phase) + '" data-run="' + escape(row.run_id) + '">実行結果を照合</button>' :
      '<p>' + escape(row.reason) + ' 保留中です。</p>' + (row.can_lookup
        ? '<button type="button" class="secondary" data-reconcile="' + escape(row.id) + '" data-phase="' +
          escape(row.phase) + '" data-lookup="receipt">受付記録を照合</button>' : '')) +
    (row.can_close ? '<form class="panel pad" method="post" data-close="' + escape(row.id) +
      '"><label class="formlabel" for="closure-' + escape(row.id) +
      '">終了理由（依頼者に表示・必須）</label><input id="closure-' + escape(row.id) +
      '" name="reason" required pattern=".*\\S.*" maxlength="240"><p>対応を終了すると、待機中の依頼が順に進みます。この会議メモの照合は終了します。</p>' +
      '<button type="submit" class="secondary">結果未確認で対応終了</button></form>' : '') +
    (row.weeks.length ? '<h4>この会議メモの後に待機している週報</h4>' + row.weeks.map(week =>
      '<div class="panel pad"><p>週報の受付　' + escape(timestamp(week.created)) + '</p><p>依頼ID　' + escape(week.id) +
      '</p><button type="button" class="secondary" data-meeting="' + escape(row.id) + '" data-weekly="' +
      escape(week.id) + '">この週報を開始</button></div>').join('') : '') + '</article>'
  ).join("") || '<p class="empty">照合待ちの依頼はありません。</p>';
}
$("#refreshRecoveries").onclick = () => loadRecoveries().catch(report);
$("#recoveryRows").onclick = event => {
  const button = event.target.closest("button[data-reconcile],button[data-weekly]");
  if (!button) return;
  const weekly = button.dataset.weekly;
  if (weekly) return recoveryAction(button,"/" + button.dataset.meeting + "/weekly/" + weekly,{},"週報の開始を受け付けています。");
  return recoveryAction(button,"/" + button.dataset.reconcile,
    {phase:button.dataset.phase, run_id:button.dataset.run ?? null, lookup:button.dataset.lookup},"Hermes に実行結果を照会しています。");
};
$("#recoveryRows").onsubmit = event => {
  event.preventDefault();
  const form = event.target;
  return recoveryAction(form.querySelector("button"),"/" + form.dataset.close + "/close",
    {reason:form.elements.reason.value},"終了理由を保存しています。");
};
async function recoveryAction(button,path,payload,pending) {
  if (button.disabled) return;
  button.disabled = true;
  const result = $("#recoveryResult");
  result.textContent = pending;
  try {
    const response = await request(path,payload,recoveriesApi);
    result.textContent = response.message;
    await loadRecoveries();
    $("#refreshRecoveries").focus();
  } catch (error) {
    result.textContent = error.message;
  } finally { button.disabled = false; }
}
const reasonField = '<label class="formlabel">変更理由（必須）<input name="reason" required maxlength="240"></label>';
const memberFilters = $("#memberFilters");
const accountListApi = "/api/admin/account-list";
let directoryParams = new URLSearchParams(), directoryCsv, directoryLoad = 0;
const accountRoleLabel = { employee:"一般社員", manager:"管理者", auditor:"閲覧専用管理者" };
let selectedMember, selectedDetail = null, detailLoad = 0;
installMemberWork({open, request, escape, selected:()=>selectedDetail, reload:showMember});
const memberActions = m => '<div class="actions"><button type="button" class="secondary" data-member="' +
  escape(m.actor) + '">所属を変更</button><button type="button" class="secondary" data-access="' +
  escape(m.actor) + '">' + (m.manual_active ? '利用を停止' : '再有効化') + '</button></div>';
async function loadMembers() {
  members = await request("", undefined, "/api/admin/member-directory");
  const filter = $("#employeeFilter"), selected = filter.value;
  filter.replaceChildren(new Option("すべての対象", ""), ...members.map(m => new Option(m.name, m.actor)));
  filter.value = selected;
  if (canManage) {
    await loadDirectory();
    await loadProjects();
    if (selectedMember) await showMember(selectedMember, false);
  }
}
async function loadProjects() {
  const rows = await request("", undefined, "/api/admin/projects");
  const employee = id => members.find(person => person.actor === id)?.name ?? id;
  $("#projectRows").innerHTML = rows.map(project => {
    const handoffs = project.handoffs.map(item => '<div class="logrow"><strong>' + escape(employee(item.previous)) + ' → ' +
      escape(employee(item.next)) + '</strong><p>' + escape(timestamp(item.occurred_at)) + ' JST ／ 操作者 ' +
      escape(employee(item.operator)) + '</p><p>理由　' + escape(item.reason) + '</p></div>').join("");
    const pending = (project.pending_items ?? []).map(item => '<li>担当　' + escape(item.assignee || "記録なし") +
      ' ／ 期限　' + escape(item.due || "未設定") + '</li>').join("");
    return '<article class="panel pad"><h3>' + escape(project.name) + '</h3><p>' + escape(project.team) +
      ' ／ 責任者　' + escape(employee(project.responsible)) + ' ／ 期限　' + escape(project.due ?? "未設定") + '</p><p>仕事 ' +
      project.jobs + '件</p><h4>未完了事項（' + project.open_items + '件）</h4>' + (pending ? '<ul>' + pending + '</ul>' : '') +
      '<details><summary>引き継ぎ履歴</summary>' + (handoffs || '<p>引き継ぎの記録はありません。</p>') + '</details></article>';
  }).join("") || '<p class="empty">登録された案件はありません。</p>';
}
$("#refreshProjects").onclick = () => loadProjects().catch(report);
let listedMembers = [];
async function loadDirectory() {
  const seq = ++directoryLoad;
  const params = new URLSearchParams(directoryParams);
  const download = $("#downloadMembers");
  download.hidden = true;
  $("#memberStatus").textContent = "社員一覧を読み込んでいます。";
  const result = await request("?" + params, undefined, accountListApi);
  if (seq !== directoryLoad) return;
  listedMembers = result.rows;
  setLogOptions($("#memberTeam"), result.teams.map(team => new Option(team, team)));
  const existingTeam = params.get("team");
  if (existingTeam && !result.teams.includes(existingTeam)) $("#memberTeam").add(new Option(existingTeam, existingTeam));
  if (existingTeam) $("#memberTeam").value = existingTeam;
  $("#memberRows").innerHTML = listedMembers.map(m => '<article class="admin-account-row"><div class="admin-account-person">' +
    '<button type="button" class="secondary" data-detail="' + escape(m.actor) + '">' + escape(m.name) + '</button>' +
    '<small>' + escape(m.email || m.actor) + '</small></div><div>' + escape(m.team) +
    (m.responsibility ? '<p>担当　' + escape(m.responsibility) + '</p>' : '') +
     '</div><span class="meta">' + escape(accountRoleLabel[m.role]) + ' · ' + (m.active ? '利用可能' : '利用停止中') + '</span>' + memberActions(m) + '</article>').join("");
  $("#memberStatus").textContent = listedMembers.length ? listedMembers.length + "件の社員が見つかりました。" : "条件に一致する社員はいません。";
  params.set("snapshot", result.snapshot);
  directoryCsv = accountListApi + ".csv?" + params;
  download.hidden = false;
}
memberFilters.onsubmit = event => {
  event.preventDefault();
  directoryParams = new URLSearchParams(new FormData(memberFilters));
  loadDirectory().catch(error => { $("#memberStatus").textContent = error.message; });
};
$("#clearMemberFilters").onclick = () => {
  memberFilters.reset();
  memberFilters.requestSubmit();
};
$("#downloadMembers").onclick = async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch(directoryCsv);
    if (!response.ok) throw new Error((await response.json()).error);
    const file = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = file;
    link.download = "user-accounts.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(file), 30_000);
  } catch (error) {
    $("#memberStatus").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
async function showMember(actor, focus = true) {
  const seq = ++detailLoad;
  selectedMember = actor;
  const body = $("#memberDetailContent");
  $("#memberList").hidden = true;
  $("#memberDetail").hidden = false;
  body.innerHTML = '<p role="status">社員の詳細を読み込んでいます。</p>';
  if (focus) $("#closeMemberDetail").focus();
  try {
    const [person, history] = await Promise.all([
      request("/" + actor, undefined, "/api/admin/memberships"),
      request("?outcome=applied&employee=" + encodeURIComponent(actor), undefined, "/api/admin/audit"),
    ]);
    if (seq !== detailLoad) return;
    selectedDetail = person;
    body.innerHTML = '<h3 tabindex="-1">' + escape(person.name) + '</h3><p>社員ID　' + escape(person.actor) + '</p><p>所属　' +
      escape(person.team) + '</p><p>権限　' + escape(accountRoleLabel[person.role]) + '</p><p>メールアドレス　' +
      escape(person.email || "未登録") + '</p>' + (person.directory_id ? '<p>Entra ID　' + escape(person.directory_id) +
      '</p><p>同期元の表示名　' + escape(person.directory_name || "未登録") + '</p>' : '') + '<p>担当　'  + escape(person.responsibility || "未設定") + '</p><p>' +
      (person.active ? '利用可能' : '利用停止中') + (person.directory_active ? "" : "（同期元で停止中）") + '</p>' + memberActions(person) +
      memberWorkSections(person,escape,timestamp) +
      '<h4>変更履歴</h4>' + (history.rows.filter(row => row.scope === "employee").map(row => {
        const f = auditFields(row);
        return '<div class="logrow"><strong>' + escape(f.action) + '　' + escape(f.before) + ' → ' + escape(f.after) +
          '</strong><p>' + escape(f.time) + ' JST ／ 操作者 ' + escape(f.operator) + '</p><p>理由　' + escape(f.reason) + '</p></div>';
      }).join("") || '<p>変更履歴はありません。</p>');
    if (focus) body.querySelector("h3").focus();
  } catch (error) {
    if (seq === detailLoad) body.textContent = error.message;
  }
}
$("#closeMemberDetail").onclick = () => {
  detailLoad++;
  const previous = selectedMember;
  selectedMember = selectedDetail = null;
  $("#memberDetail").hidden = true;
  $("#memberDetailContent").replaceChildren();
  $("#memberList").hidden = false;
  ($("#memberRows [data-detail='" + previous + "']") || $("#memberQuery")).focus();
};
$("#memberships").onclick = e => {
  const control = e.target.closest("button[data-detail],button[data-member],button[data-access]");
  if (!control) return;
  if (control.dataset.detail) return showMember(control.dataset.detail);
  const m = control.closest("#memberDetail") ? selectedDetail
    : listedMembers.find(m => m.actor === (control.dataset.member ?? control.dataset.access));
  if (!m) return;
  if (control.hasAttribute("data-access")) {
    const action = m.manual_active ? "利用を停止する" : "再有効化する";
    open(m.name + "の利用" + (m.manual_active ? "を停止" : "を再有効化"),
      "<p>" + (m.manual_active
        ? "確認待ちの依頼への回答を含め、この社員の利用を停止します。進行中の依頼は、再有効化後も停止したままです。"
        : m.directory_active ? "現在の所属で新しい依頼を作成できます。以前の利用停止で止まった依頼は再開されません。"
          : "管理者による停止を解除します。同期元で停止中の間は引き続き依頼の利用が止まります。") +
      '</p><form id="memberAccess" data-id="' + escape(m.actor) + '" data-active="' + !m.manual_active + '" data-base="' + m.revision +
      '">' + reasonField + '<div class="actions"><button class="primary">' + action + '</button></div></form>');
    return;
  }
  open("社員の所属を変更", '<p>' + escape(m.name) + '　現在の所属：' + escape(m.team) +
    '</p><p>異動先の部門で公開されている手順を利用できます。元の部門の確認待ち依頼に回答すると、回答だけが保存されます。</p>' +
    '<form id="transferMember" data-id="' + escape(m.actor) + '" data-base="' + m.revision +
    '"><div class="formlabel"><label for="transferTeam">異動先の部門名</label><input id="transferTeam" name="team" maxlength="80" required value="' + escape(m.team) + '"></div>' +
    '<div class="formlabel"><label for="transferResponsibility">担当</label><input id="transferResponsibility" name="responsibility" maxlength="120" value="' + escape(m.responsibility) + '"></div>' +
    reasonField + '<div class="actions"><button class="primary">所属変更を確定する</button></div></form>');
};
let procedures = [];
const proceduresApi = "/api/admin/procedures";
const standardProceduresApi = "/api/admin/standard-procedures";
const standardProcedureFields = [
  { name: "name", label: "手順名", max: 120 },
  { name: "source", label: "用意するもの", max: 400 },
  { name: "output", label: "受け取れるもの", max: 400 },
  { name: "example", label: "依頼例", max: 400 },
  { name: "instruction", label: "手順本文（Markdown）", max: 20000, rows: 10 },
  { name: "reason", label: "変更理由", max: 240 },
];
let standardProcedures = [];

const packageApi = "/api/admin/industry-packages";
let industryCatalog = [];
const importForm = $("#industryImportForm");
const packageSelect = $("#industryPackage");
const importButton = importForm.querySelector("button");

function renderIndustryItems() {
  const pkg = industryCatalog.find(item => item.id === packageSelect.value);
  $("#industryItems").innerHTML = (pkg?.procedures ?? []).map(item =>
    '<div><label><input type="checkbox" name="procedure" value="' + escape(item.id) + '" ' +
    (item.installed ? 'disabled' : 'checked') + '> ' + escape(item.name) + (item.installed ? '（導入済み）' : '') +
    '</label><details><summary>内容を確認</summary><p>' + escape(item.instruction) +
    '</p><p>利用する資料　' + escape(item.source) + '</p><p>成果物　' + escape(item.output) + '</p></details></div>'
  ).join("");
  updateImportButton();
}

function updateImportButton() {
  importButton.disabled = !importForm.querySelector("input:checked:not(:disabled)");
}

async function loadIndustryPackages() {
  const catalog = await request("", undefined, packageApi);
  const previous = packageSelect.value;
  industryCatalog = catalog;
  packageSelect.replaceChildren(...catalog.map(pkg => new Option(pkg.name + "（v" + pkg.version + "）", pkg.id)));
  if (catalog.some(pkg => pkg.id === previous)) packageSelect.value = previous;
  renderIndustryItems();
}

packageSelect.onchange = () => {
  $("#industryStatus").textContent = "";
  renderIndustryItems();
};
$("#industryItems").onchange = updateImportButton;
importForm.onsubmit = async event => {
  event.preventDefault();
  if (importButton.disabled) return;
  const pkg = industryCatalog.find(item => item.id === packageSelect.value);
  const procedures = new FormData(importForm).getAll("procedure");
  const fieldset = importForm.querySelector("fieldset");
  fieldset.disabled = packageSelect.disabled = importButton.disabled = true;
  try {
    const result = await request("/" + encodeURIComponent(pkg.id) + "/import", { version: pkg.version, procedures }, packageApi);
    await Promise.all([loadIndustryPackages(), loadStandardProcedures()]);
    $("#industryStatus").textContent = result.imported.length + "件の手順を会社標準として公開しました。";
  } catch (error) {
    $("#industryStatus").textContent = error.message;
  } finally {
    fieldset.disabled = packageSelect.disabled = false;
    updateImportButton();
  }
};
$("#industryImport").ontoggle = async event => {
  if (!event.target.open) return;
  try { await loadIndustryPackages(); }
  catch (error) { $("#industryStatus").textContent = error.message; }
};

function renderStandardProcedures() {
  $("#standardProcedureRows").innerHTML = standardProcedures.map((p) =>
    '<li><div><h3>' + escape(p.name) + '</h3><p class="meta">' + escape(p.scope) + ' ・ v' +
    escape(p.version) + '</p></div><button type="button" class="secondary" data-standard-procedure="' + escape(p.id) +
    '" aria-label="' + escape(p.name + "を編集") + '">編集</button></li>'
  ).join("");
}

async function loadStandardProcedures() {
  const button = $("#refreshStandardProcedures");
  if (button.disabled) return;
  button.disabled = true;
  const status = $("#standardProcedureStatus");
  status.textContent = "";
  try {
    const rows = await request("", undefined, standardProceduresApi);
    standardProcedures = rows.map((p) => {
      const current = standardProcedures.find((row) => row.id === p.id);
      return current?.version > p.version ? current : p;
    });
    renderStandardProcedures();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

$("#refreshStandardProcedures").onclick = loadStandardProcedures;
$("#standardProcedureRows").onclick = (event) => {
  const id = event.target.closest("[data-standard-procedure]")?.dataset.standardProcedure;
  const p = standardProcedures.find((row) => row.id === id);
  if (!p) return;
  const action = standardProceduresApi + "/" + encodeURIComponent(p.id);
  const fields = standardProcedureFields.map(({ name, label, max, rows }) => {
    const attrs = ' id="standard-procedure-' + name + '" name="' + name + '" maxlength="' + max + '" required';
    const control = rows ? '<textarea class="field" rows="' + rows + '"' + attrs + '></textarea>' : '<input' + attrs + '>';
    return '<div class="formlabel"><label for="standard-procedure-' + name + '">' + label + '（必須）</label>' + control + '</div>';
  }).join("");
  open("会社標準の手順を編集",
    '<p class="meta">' + escape(p.name) + ' ・ ' + escape(p.scope) + ' ・ 現行 v' + escape(p.version) + '</p>' +
    '<p>公開後に受け付ける依頼から新版を使います。受付済みの依頼は元の版で続行します。</p>' +
    '<form id="editStandardProcedure" method="post" action="' + escape(action) + '" data-id="' + escape(p.id) +
    '" data-base="' + escape(p.version) + '" aria-labelledby="dlgtitle">' + fields +
    '<div class="actions"><button type="submit" class="primary">新版を公開する</button></div></form>');
  const form = $("#editStandardProcedure");
  for (const { name } of standardProcedureFields) form.elements[name].value = p[name] ?? "";
  form.elements.name.focus();
};

$("#dialogContent").addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.id !== "editStandardProcedure") return;
  event.preventDefault();
  const button = event.submitter ?? form.querySelector("button[type=submit]");
  if (button.disabled) return;
  button.disabled = true;
  $("#dialogError").textContent = "";
  const { id, base } = form.dataset;
  const fields = Object.fromEntries(new FormData(form));
  try {
    const updated = await request("/" + encodeURIComponent(id), { base: Number(base), ...fields }, standardProceduresApi);
    standardProcedures = standardProcedures.map((p) => p.id === id ? updated : p);
    const dialog = $("#dialog");
    if (dialog.open && dialog.contains(form)) dialog.close();
    const focusedId = document.activeElement?.dataset.standardProcedure;
    renderStandardProcedures();
    if (focusedId) {
      $("#standardProcedureRows").querySelector('[data-standard-procedure="' + CSS.escape(focusedId) + '"]')?.focus();
    }
    $("#standardProcedureStatus").textContent = updated.version === Number(base)
      ? "変更はありません。現在は第" + updated.version + "版です。"
      : updated.name + "の第" + updated.version + "版を公開しました。";
  } catch (error) {
    const message = error.status === 409
      ? "標準手順の最新の版を確認してください。編集を閉じて「公開版を更新」を選ぶと、最新の版を開けます。"
      : error.message;
    if ($("#dialog").open && $("#dialog").contains(form)) $("#dialogError").textContent = message;
    else $("#standardProcedureStatus").textContent = message;
  } finally {
    button.disabled = false;
  }
});
const libraryApi = "/api/admin/library-connections";
let libraryConnections = [];
const libraryActions = { sync: "対象版を確認する", pause: "利用を停止する", resume: "確認して利用を再開する" };
async function loadLibraryConnections() {
  libraryConnections = await request("", undefined, libraryApi);
  const states = { paused: "停止中", failed: "読み取り失敗", synced: "版確認済み", live: "接続中" };
  $("#libraryRows").innerHTML = libraryConnections.map((source, index) =>
    '<article class="panel pad"><div class="split"><h3>' + escape(source.name) + '</h3><span class="meta">' +
    escape(states[source.status]) + '</span></div><p>公開範囲　' + escape(source.scope) +
    '</p><p>確認した対象版　' + escape(source.version?.slice(0, 12) ?? "未確認") + '</p>' +
    (source.error ? '<p class="error">' + escape(source.error) + '</p>' : '') +
    '<div class="actions">' + ["sync", source.paused ? "resume" : "pause"].map(action =>
      '<button type="button" class="secondary" data-library="' + index + '" data-library-action="' + action +
        '">' + libraryActions[action] + '</button>').join("") + '</div>' +
    (source.history.length ? '<details><summary>操作履歴</summary>' + source.history.map(entry =>
      '<div class="logrow"><strong>' + escape(libraryActions[entry.action]) + '</strong><p>' + escape(timestamp(entry.time)) +
      ' JST ／ 操作者 ' + escape(entry.operator) + '</p><p>理由　' + escape(entry.reason) + '</p>' +
      (entry.error ? '<p>' + escape(entry.error) + '</p>' : '') + '</div>').join("") + '</details>' : '') + '</article>'
  ).join("") || '<p class="empty">接続済みの共有資料置き場はありません。</p>';
}
$("#refreshLibraries").onclick = () => loadLibraryConnections().catch(report);
$("#libraryRows").onclick = event => {
  const control = event.target.closest("button[data-library]");
  if (!control) return;
  const source = libraryConnections[Number(control.dataset.library)];
  const action = control.dataset.libraryAction;
  open(libraryActions[action], '<p>' + escape(source.name) + '（' + escape(source.scope) +
    '）</p><form id="updateLibrary" data-library="' + escape(source.id) + '" data-base="' + source.revision + '" data-action="' +
    escape(action) + '">' + reasonField + '<div class="actions"><button type="submit" class="primary">' + libraryActions[action] + '</button></div></form>');
};
async function loadProcedures() {
  procedures = await request("", undefined, proceduresApi);
  $("#procedureRows").innerHTML = procedures.map(p =>
    '<article class="panel pad"><p class="meta">' + escape(p.scope) + ' ・ ' +
    (p.state === "pending" ? "確認待ち" : (p.state === "revoked" ? "公開取消済み v" : "公開済み v") + p.version) + '</p><h3>' + escape(p.name) +
    '</h3><button type="button" class="secondary" data-procedure="' + escape(p.id) + '">' +
    (p.state === "pending" ? "草案の内容を確認" : "公開内容を見る") + '</button>' +
    (p.state === "published" ? ' <button type="button" class="secondary" data-quality="' + escape(p.id) + '">配布と推奨を確認</button>' : '') +
    (p.state === "published" ? ' <button class="secondary" data-revise="' + escape(p.id) + '">手順を改訂</button> ' +
      '<button class="secondary" data-revoke="' + escape(p.id) + '">公開を取り消す</button>' : '') + '</article>'
  ).join("") || '<p class="panel pad">公開申請はありません。</p>';
  $("#qualityRows").innerHTML = procedures.map(p => '<article class="panel pad"><h3>' + escape(p.name) +
    '</h3><button type="button" class="secondary" data-quality="' + escape(p.id) + '">評価と版履歴を見る</button></article>').
    join("") || '<p class="empty">品質を確認できる手順はありません。</p>';
}
function qualityFields(p, key, label) {
  return '<fieldset class="panel pad"><legend>' + label + '</legend>' + p.teams.map(team => '<label>' +
    '<input type="checkbox" name="' + key + '" value="' + escape(team) + '"' +
    (p.delivery[key].includes(team) ? ' checked' : '') + '> ' + escape(team) + '</label><br>').join("") + '</fieldset>';
}
async function openProcedureQuality(button) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const p = await request("/" + button.dataset.quality + "/quality", undefined, proceduresApi);
    const archived = p.versions.map(version => '<details><summary>第' + version.version + '版　' + escape(version.name) +
      '</summary><p class="doc-body">' + escape(version.instruction) + '</p>' +
      (p.state === "published" ? '<form class="rollbackProcedure" data-id="' + escape(p.id) + '" data-base="' + escape(p.hash) +
        '" data-version="' + version.version + '" data-hash="' + escape(version.hash) + '">' + reasonField +
        '<button type="submit" class="secondary">この版の内容を再公開する</button></form>' : '') + '</details>').join("");
    const delivery = p.state === "revoked" ? '' :
      '<form id="procedureDelivery" data-id="' + escape(p.id) + '" data-base="' + escape(p.hash) + '" data-revision="' + p.delivery.revision +
      '">' + qualityFields(p,"trials","試行部署") + qualityFields(p,"teams","公開時の配布先") +
      (p.state === "published" ? qualityFields(p,"recommended","推奨先") : '') +
      '<div class="formlabel"><label for="previewEmployee">表示を確認する社員</label><select id="previewEmployee" name="employee">' +
      members.map(person => '<option value="' + escape(person.actor) + '">' + escape(person.name) + '</option>').join("") + '</select></div>' +
      '<button type="button" id="previewDelivery" class="secondary">社員の表示を確認する</button><p id="deliveryStatus" role="status"></p>' +
      reasonField + '<button type="submit" class="primary">配布設定を保存する</button></form>';
    open(p.name, '<h3>評価用の入力例</h3><p>' + escape(p.example.prompt) + '</p><ul>' + p.example.sources.map(source =>
      '<li><strong>' + escape(source.title) + '（' + escape(source.version) + '）</strong><p>' +
      escape(source.text) + '</p></li>').join("") + '</ul><h3>現行の手順・第' + p.version + '版</h3><p class="doc-body">' +
      escape(p.instruction) + '</p><h3>以前の版と比較</h3>' + (archived || '<p>以前の版はありません。</p>') + delivery +
      '<h3>変更履歴</h3>' + (p.history.map(entry => {
        const actions = { publish: "公開", revoke: "公開取消", rollback: "以前の内容を再公開", delivery: "配布設定を変更" };
        const after = entry.action === "delivery" ? JSON.parse(entry.detail).after : null;
        return '<div class="logrow"><b>' + actions[entry.action] + '　v' + entry.version + '</b><p>' +
          escape(timestamp(entry.time)) + ' JST ／ 操作者 ' + escape(entry.operator) + '</p>' +
          (entry.reason ? '<p>理由　' + escape(entry.reason) + '</p>' : '') +
          (after ? '<p>配布先　' + escape(after.teams.join("、") || "なし") + ' ／ 推奨先　' +
            escape(after.recommended.join("、") || "なし") + '</p>' : '') + '</div>';
      }).join("") || '<p>変更履歴はありません。</p>'));
  } catch (error) { report(error); }
  finally { button.disabled = false; }
}
function deliveryInput(form) {
  const data = new FormData(form);
  return { base: form.dataset.base, revision: Number(form.dataset.revision), employee: data.get("employee"),
    teams: data.getAll("teams"), recommended: data.getAll("recommended"), trials: data.getAll("trials"), reason: data.get("reason") };
}
$("#dialogContent").addEventListener("click", async event => {
  const button = event.target.closest("#previewDelivery");
  if (!button || button.disabled) return;
  button.disabled = true;
  const form = button.form, status = form.querySelector("#deliveryStatus");
  try {
    const p = await request("/" + form.dataset.id + "/preview-delivery", deliveryInput(form), proceduresApi);
    status.textContent = p.employee + "（" + p.team + "）：" + (p.visible ? "第" + p.version + "版を表示" : "社員画面には表示されません") +
      (p.recommended ? " ・ 推奨" : "") + (p.trial ? " ・ 試行部署" : "") + (p.active ? "" : " ・ 利用停止中");
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
$("#qualityRows").onclick = event => {
  const button = event.target.closest("button[data-quality]");
  if (button) openProcedureQuality(button);
};
$("#refreshProcedures").onclick = () => loadProcedures().catch(report);
$("#procedureRows").onclick = async e => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.quality) return openProcedureQuality(b);
  const p = procedures.find(p => p.id === (b.dataset.procedure || b.dataset.revise || b.dataset.revoke));
  if (!p) return;
  if (b.dataset.revise) {
    if (p.layout==="quote-comparison") {
      const criteria=JSON.parse(p.instruction).criteria;
      open("見積比較の項目を改訂",'<form id="previewQuoteProcedure" data-id="'+escape(p.id)+'" data-base="'+escape(p.hash)+'">'+
        '<fieldset><legend>新版に残す比較項目</legend>'+criteria.map(label=>'<label><input type="checkbox" name="criteria" value="'+
          escape(label)+'" checked> '+escape(label)+'</label><br>').join("")+'</fieldset><button class="primary">改訂内容を確認</button></form>');
      return;
    }
    const layout = p.layout === "meeting" ? "contract" : "meeting";
    b.disabled = true;
    try {
      const next = await request("/" + p.id + "/preview-revision", { base: p.hash, layout }, "/api/admin/procedures");
      open("改訂内容を確認", '<p>' + escape(p.name) + '（v' + p.version + '） → ' + escape(next.name) +
        '（v' + next.version + '）</p><p>受付済みの依頼は元の版で続行します。</p><p class="doc-body">' +
        escape(next.instruction) + '</p><form id="reviseProcedure" data-id="' + escape(p.id) + '" data-base="' +
        escape(p.hash) + '" data-hash="' + escape(next.hash) + '" data-layout="' + layout +
        '"><div class="actions"><button class="primary">新版を公開する</button></div></form>');
    } catch (err) { report(err); }
    finally { b.disabled = false; }
    return;
  }
  if (b.dataset.revoke) {
    open("公開取消を確認", '<p>' + escape(p.name) + '（現行 v' + p.version +
      '）</p><p>この手順の全版が対象です。新規利用と受付済み依頼の追加送信を停止します。完了メモは引き続き閲覧できます。</p>' +
      '<form id="revokeProcedure" data-id="' + escape(p.id) + '" data-hash="' + escape(p.hash) +
      '"><div class="actions"><button class="primary">公開取消を確定する</button></div></form>');
    return;
  }
  const instruction=p.layout==="quote-comparison" ? '<ul>'+JSON.parse(p.instruction).criteria.map(label=>'<li>'+escape(label)+'</li>').join("")+'</ul>' :
    '<p class="doc-body">'+escape(p.instruction)+'</p>';
  open(p.name, '<p>公開先　' + escape(p.scope) + ' ・ v' + p.version +
    '</p><h3>手順本文</h3>' + instruction +
    (p.state === "pending" ? '<form id="publishProcedure" data-id="' + escape(p.id) +
    '" data-hash="' + escape(p.hash) + '"><div class="actions"><button class="primary">確認した手順を公開する</button></div></form>' : ''));
};
function open(title, body) {
  $("#dlgtitle").textContent = title;
  $("#dialogContent").innerHTML = body;
  $("#dialogError").textContent = "";
  if (!$("#dialog").open) $("#dialog").showModal();
}
function report(e) {
  ($("#dialog").open ? $("#dialogError") : $("#notice")).textContent =
    e.message;
}
function openRegistration(connection) {
  open(
    "モデルを登録",
    '<form id="newModel"><label class="formlabel">表示名<input name="name" maxlength="80" required></label><label class="formlabel">提供元・接続先<select name="connection">' +
      state.connections
        .map(
          (c) =>
            '<option value="' +
            escape(c.id) +
            '">' +
            escape(c.name) +
            "（" +
            escape(c.url) +
            "）</option>",
        )
        .join("") +
      '</select></label><label class="formlabel">モデルID<input name="model_id" maxlength="120" placeholder="fixture-model-b" required></label><label class="formlabel">利用できるデータ区分<select name="data_class"><option>合成資料</option></select></label><div class="actions"><button class="primary">台帳に登録</button></div></form>',
  );
  if (connection) $("#newModel").elements.connection.value = connection;
}
$("#register").onclick = () => openRegistration();
$("#models").onclick = async (e) => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  const m = state.models.find(
    (v) => v.id === b.closest("[data-model]").dataset.model,
  );
  if (["stop", "enable"].includes(b.dataset.action)) {
    const stop = b.dataset.action === "stop";
    controlDialog(
      stop ? "モデルを緊急停止" : "モデルの停止を解除",
      m,
      b.dataset.action,
      stop
        ? "このモデルへの新規送信と接続テストを止めます。確認待ちの依頼への回答は保存されます。すでに送信した処理は完了する場合があります。"
        : "このモデルへの送信を許可します。送信前に保留した依頼は社員が個別に再開できます。",
      stop ? "緊急停止を確定" : "停止解除を確定",
    );
    return;
  }
  if (b.dataset.action === "compare") {
    open(
      "全社員の標準モデルを変更",
      "<p><strong>" +
        escape(current().name) +
        "</strong> → <strong>" +
        escape(m.name) +
        '</strong></p><p class="note">対象は全社員です。公開後に受け付けた依頼から設定 v' +
        (state.current.version + 1) +
        ' を使います。確認待ち・作業中の依頼は受付時のモデルで完了します。</p><form id="apply" data-id="' +
        m.id +
        '" data-base="' +
        state.current.version +
        '"><label class="formlabel">変更理由<input name="reason" required maxlength="240" value="全社標準モデルの変更"></label><div class="actions"><button class="primary">全社員に公開する</button></div></form>',
    );
    return;
  }
  b.disabled = true;
  b.textContent = "テスト中…";
  try {
    const r = await request("/" + m.id + "/test", {});
    await refresh();
    $("#notice").textContent = m.name + "：" + probeLabels[r.state];
  } catch (err) {
    report(err);
  } finally {
    b.disabled = false;
  }
};
document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (f.id==="previewQuoteProcedure") {
    e.preventDefault();
    const b=e.submitter ?? f.querySelector("button");
    if (b.disabled) return;
    b.disabled=true;
    try {
      const criteria=new FormData(f).getAll("criteria");
      const preview=await request("/"+f.dataset.id+"/preview-revision",{base:f.dataset.base,criteria},proceduresApi);
      open("改訂内容を確認",'<p>公開版 v'+preview.version+'</p><ul>'+criteria.map(label=>'<li>'+escape(label)+'</li>').join("")+
        '</ul><form id="reviseProcedure" data-id="'+escape(preview.id)+'" data-base="'+escape(f.dataset.base)+'" data-hash="'+
        escape(preview.hash)+'" data-criteria="'+escape(JSON.stringify(criteria))+'"><button class="primary">新版を公開する</button></form>');
    } catch(error) { report(error); }
    finally {b.disabled=false;}
    return;
  }
  if (!["apply", "newModel", "control", "publishProcedure", "reviseProcedure", "revokeProcedure", "transferMember", "memberAccess", "updateLibrary", "procedureDelivery"].includes(f.id)
    && !f.classList.contains("rollbackProcedure")) return;
  e.preventDefault();
  const b = e.submitter ?? f.querySelector("button");
  b.disabled = true;
  try {
    if (f.id === "procedureDelivery") {
      await request("/" + f.dataset.id + "/delivery", deliveryInput(f), proceduresApi);
      $("#notice").textContent = "手順の配布設定を更新しました。";
    } else if (f.classList.contains("rollbackProcedure")) {
      await request("/" + f.dataset.id + "/rollback", {
        base: f.dataset.base, version: Number(f.dataset.version), hash: f.dataset.hash, reason: new FormData(f).get("reason"),
      }, proceduresApi);
      $("#notice").textContent = "以前の内容を新しい版として公開しました。";
    } else if (f.id === "updateLibrary") {
      const result = await request("", { id: f.dataset.library, base: Number(f.dataset.base), action: f.dataset.action,
        reason: new FormData(f).get("reason") }, libraryApi);
      $("#libraryStatus").textContent = result.error || (result.paused ? "資料置き場の利用は停止中です。" : "資料置き場の現在の版を確認しました。");
    } else if (f.id === "memberAccess") {
      const active = f.dataset.active === "true";
      await request("/" + f.dataset.id + "/access", { base: Number(f.dataset.base), active, reason: new FormData(f).get("reason") }, "/api/admin/memberships");
      $("#notice").textContent = active ? "社員の利用を再有効化しました。" : "社員の利用を停止しました。";
    } else if (f.id === "transferMember") {
      await request("/" + f.dataset.id, { base: Number(f.dataset.base), ...Object.fromEntries(new FormData(f)) }, "/api/admin/memberships");
      $("#notice").textContent = "社員情報を更新しました。";
    } else if (f.id === "reviseProcedure" || f.id === "revokeProcedure") {
      const revise = f.id === "reviseProcedure";
      await request("/" + f.dataset.id + (revise ? "/revise" : "/revoke"),
        { base: f.dataset.base, hash: f.dataset.hash, layout: f.dataset.layout,
          ...(f.dataset.criteria && {criteria:JSON.parse(f.dataset.criteria)}) }, "/api/admin/procedures");
      $("#notice").textContent = revise ? "新版を公開しました。" : "手順の公開を取り消しました。";
    } else if (f.id === "publishProcedure") {
      await request("/" + f.dataset.id + "/publish", { hash: f.dataset.hash }, "/api/admin/procedures");
      $("#notice").textContent = "確認した手順を公開しました。";
    } else if (f.id === "control") {
      await request("/" + f.dataset.id + "/" + f.dataset.action, {
        base: Number(f.dataset.base),
        generation: Number(f.dataset.generation),
        reason: new FormData(f).get("reason"),
      });
      $("#notice").textContent = "設定を更新しました。";
    } else if (f.id === "apply") {
      await request("/" + f.dataset.id + "/publish", {
        base: Number(f.dataset.base),
        reason: new FormData(f).get("reason"),
      });
      $("#notice").textContent = "全社員の標準モデルを変更しました。";
    } else {
      await request("", Object.fromEntries(new FormData(f)));
      $("#notice").textContent =
        "登録しました。公開前に接続テストを実行してください。";
    }
    $("#dialog").close();
    await refresh();
  } catch (err) {
    report(err);
    await refresh().catch(() => {});
  } finally {
    b.disabled = false;
  }
});
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));

function controlDialog(title, m, action, explanation, confirm) {
  open(
    title,
    "<p><strong>" +
      escape(m.name) +
      '</strong></p><p class="note">' +
      escape(explanation) +
      "</p>" +
      '<form id="control" data-action="' +
      action +
      '" data-id="' +
      m.id +
      '" data-generation="' +
      m.generation +
      '" data-base="' +
      state.current.version +
      '">' +
      '<label class="formlabel">変更理由<input name="reason" maxlength="240" required></label><div class="actions"><button class="primary">' +
      confirm +
      "</button></div></form>",
  );
}
$("#rollback").onclick = () => {
  const m = state.models.find((m) => m.id === state.previous?.model);
  if (!m) return;
  controlDialog(
    "直前の標準設定に戻す",
    m,
    "restore",
    current().name +
      "（v" +
      state.current.version +
      "）から " +
      m.name +
      "（v" +
      state.previous.version +
      " の内容）へ戻し、設定 v" +
      (state.current.version + 1) +
      " として公開します。各モデルの停止状態と受付済み依頼のモデルは保持します。",
    "復元を確定",
  );
};
const outcomes = {
  blocked: "送信前に停止",
  ok: "応答完了",
  sending: "送信中",
  unknown: "結果不明",
  error: "提供元エラー",
};
const phaseLabels = {
  review: "質問生成",
  draft: "メモ作成",
  "probe-review": "接続テスト・質問",
  "probe-draft": "接続テスト・メモ",
};
function changeRow(x) {
  return (
    '<article class="logrow"><b>' +
    escape(changeLabels[x.action]) +
    " · " +
    escape(x.name) +
    '</b><p class="meta">' +
    escape(timestamp(x.time)) +
    " JST ／ " +
    escape(x.actor || "変更者記録なし") +
    " ／ 標準 v" +
    x.version +
    (x.source_version ? "（参照 v" + x.source_version + "）" : "") +
    "</p><p>" +
    escape(x.reason || "工程3開始前の設定") +
    "</p></article>"
  );
}
function usageRow(x) {
  const duration = x.finished == null ? "不明" : x.finished - x.started + " ms";
  const actual = x.served || "提供元の応答未確認";
  return (
    '<article class="logrow"><b>' +
    escape(x.name) +
    " · " +
    escape(phaseLabels[x.phase] || x.phase) +
    " · " +
    escape(outcomes[x.outcome]) +
    '</b><p class="meta">' +
    escape(timestamp(x.started)) +
    " JST ／ " +
    escape(x.actor) +
    (x.version ? " ／ v" + x.version : "") +
    (x.policy_version ? " ／ 利用ポリシー v" + x.policy_version : "") +
    (x.data_class ? " ／ " + escape(x.data_class) : "") +
    "</p>" + (x.block_reason ? '<p>' + escape(x.block_reason) + '</p>' : '') +
    (x.job ? '<p class="mono">依頼 ' + escape(x.job) + "</p>" : "") +
    "<details><summary>呼び出しの詳細</summary><p>接続先 " +
    escape(x.connection) +
    " ／ 要求 " +
    escape(x.requested) +
    " ／ 実モデル " +
    escape(actual) +
    "</p>" +
    "<p>所要時間 " +
    duration +
    " ／ 使用量 " +
    (x.outcome === "blocked"
      ? "送信前"
      : (x.total_tokens ?? "不明") + " トークン") +
    (x.input_tokens !== null
      ? "（入力 " +
        x.input_tokens +
        "・出力 " +
        (x.output_tokens ?? "不明") +
        "）"
      : "") +
    (x.http_status ? " ／ HTTP " + x.http_status : "") +
    '</p><p class="mono">照合ID ' +
    escape(x.call_id) +
    "</p></details></article>"
  );
}
function memberChangeRow(change) {
  return auditRow({ ...change, scope: "employee", target: change.employee, outcome: "applied", change_seq: change.seq });
}
function auditRow(event) {
  if (event.closure_job) return closureCard({ ...event, id: event.closure_job });
  const f = auditFields(event), applied = event.outcome === "applied";
  const key = applied ? 'data-change="' + event.change_seq : 'data-denial="' + event.seq;
  return '<article class="logrow" ' + key + '"><b>' + escape(f.target) + ' · ' + escape(f.action) +
    '（' + f.outcome + '）</b>' + (applied ? '<p>' + escape(f.before) + ' → ' + escape(f.after) + '</p>' : '') +
    '<p class="meta">' + escape(f.time) + ' JST ／ 操作者 ' + escape(f.operator) + '</p><p>' +
    (applied ? '理由' : '拒否理由') + '　' + escape(f.reason) + '</p>' + (f.stopped
      ? '<button class="secondary" data-dispatches="' + event.change_seq + '">停止した依頼の送信記録（' + f.stopped + '件）</button>' : '') + '</article>';
}
$("#employee-history").addEventListener("click", async e => {
  const button = e.target.closest("[data-dispatches]");
  if (!button) return;
  const origin = [];
  for (let source = button.closest("details[data-saved-rows]"); source;
       source = source.parentElement.closest("details[data-saved-rows]")) {
    const label = source.dataset.source === "audit" ? "監査ログCSV" : "保存記録";
    origin.unshift(label + " #" + source.dataset.savedRows + "（" + source.dataset.exporter + "）");
  }
  const trail = origin.length ? '<p class="meta">参照元　' + escape(origin.join(" → ")) + '</p>' : '';
  open("Hermes 送信記録", trail + '<p role="status">送信記録を読み込み中…</p>');
  const loading = $("#dialogContent").lastElementChild;
  try {
    const trace = await request("/" + button.dataset.dispatches + "/dispatches", undefined, "/api/admin/member-changes");
    const end = trace.enabled ? memberChangeRow(trace.enabled)
      : trace.change.action === "disable" ? "<p>再有効化の記録はまだありません。</p>" : "";
    const jobs = trace.jobs.map(j => '<section class="panel pad"><h3>' + escape(j.company) + 'の依頼</h3><p class="mono">' +
      escape(j.id) + '</p><p>停止時の送信試行 ' + j.attempts_at_stop + '件 ／ 停止後の追加試行 ' + j.additional + '件</p>' +
      j.sends.map(a => '<p>' + escape(timestamp(a.dispatch_time)) + ' JST · ' + escape(phaseLabels[a.phase] || a.phase) +
        '<br>Hermes 受付ID　' + escape(a.hermes_run_id ?? "受付未確認") + '</p>').join("") +
      '<a href="/admin.html?job=' + encodeURIComponent(j.id) + '#usage">この依頼のモデル利用記録</a></section>').join("");
    if (loading.isConnected) loading.outerHTML = memberChangeRow({ ...trace.change, stopped_jobs: 0 }) + end + jobs;
  } catch (err) {
    loading.textContent = err.message;
  }
});
function exportHistoryRow(event) {
  const f = exportHistoryFields(event);
  const count = typeof f.count === "number" ? f.count + "件" : f.count;
  const history = event.source === "history";
  const condition = history ? '抽出した履歴の出力者　' + escape(f.filterExporter) + ' ／ 抽出した履歴の種別　' + escape(f.filterSource)
    : '抽出した操作の操作者　' + escape(f.operator) + ' ／ 操作結果　' + f.outcome;
  const detail = event.completed !== null
    ? '<details data-saved-rows="' + event.seq + '" data-source="' + escape(event.source) +
      '" data-exporter="' + escape(event.exported_by) + '"><summary>' +
      (history ? '保存した元の履歴を見る' : '元の監査ログを見る') + '</summary>' +
      '<div class="saved-entries"></div><p role="status"></p><button type="button" class="secondary" data-more-saved hidden>さらに表示</button></details>'
    : "";
  return '<article class="logrow" data-export="' + event.seq + '"><b>' + f.type + ' · ' + count + '</b>' +
    '<p class="meta">' + escape(f.time) + ' JST ／ 出力者 ' + escape(f.exporter) + '</p>' +
    '<p>対象社員　' + escape(f.employee) + ' ／ ' + condition +
    '</p>' + (event.filter_job ? '<p>依頼ID　' + escape(event.filter_job) + '</p>' : '') +
    (event.filter_reason ? '<p>理由の検索語　' + escape(event.filter_reason) + '</p>' : '') +
    '<p>CSVの対象期間（日本時間）　' + escape(f.from) + ' 〜 ' + escape(f.to) + '</p>' + detail + '</article>';
}
async function loadSavedRows(details) {
  if (details.dataset.loading) return;
  const entries = details.querySelector(":scope > .saved-entries");
  const status = details.querySelector(":scope > [role=status]");
  const more = details.querySelector(":scope > button");
  details.dataset.loading = "true";
  more.disabled = true;
  status.textContent = "読み込み中…";
  try {
    const query = details.dataset.before ? "?before=" + details.dataset.before : "";
    const audit = details.dataset.source === "audit";
    const path = "/" + details.dataset.savedRows + (audit ? "/audit-rows" : "/rows");
    const page = await request(path + query, undefined, "/api/admin/audit/exports");
    entries.insertAdjacentHTML("beforeend", page.rows.map(audit ? auditRow : exportHistoryRow).join(""));
    details.dataset.loaded = "true";
    details.dataset.before = page.next ?? "";
    more.hidden = page.next === null;
    status.textContent = entries.childElementCount === 0 ? (audit ? "出力した監査ログは0件です。" : "保存した履歴は0件です。") :
      page.legacyCounts ? "以前の保存記録のため、各履歴の出力件数は現在の値です。" : "";
    more.textContent = "さらに表示";
  } catch (err) {
    status.textContent = err.message;
    more.textContent = "再読み込み";
    more.hidden = false;
  } finally {
    delete details.dataset.loading;
    more.disabled = false;
  }
}
$("#exportRows").addEventListener("toggle", e => {
  const details = e.target;
  if (details.matches("details[data-saved-rows]") && details.open && !details.dataset.loaded) loadSavedRows(details);
}, true);
$("#exportRows").addEventListener("click", e => {
  const more = e.target.closest("[data-more-saved]");
  if (more) loadSavedRows(more.closest("details"));
});
const logViews = {
  exports: { form: "#exportFilters", download: "#downloadExports", path: "/api/admin/audit/exports", rows: "#exportRows", older: "#olderExports", render: exportHistoryRow },
  changes: { path: "/api/admin/models/changes", rows: "#changeRows", older: "#olderChanges", render: changeRow },
  usage: { path: "/api/admin/models/usage", rows: "#usageRows", older: "#olderUsage", render: usageRow },
  employees: { form: "#auditFilters", download: "#exportAudit", path: "/api/admin/audit", rows: "#employeeChanges", older: "#olderEmployeeChanges", render: auditRow },
};
const next = {}, loadSeq = { changes: 0, usage: 0, employees: 0, exports: 0 };
let exportCompletion;
let jobFilter = new URLSearchParams(location.search).get("job") || "";
$("#findUsage [name=job]").value = jobFilter;
function setLogOptions(select, options) {
  const selected = select.value;
  select.replaceChildren(select.options[0], ...options);
  select.value = selected;
}
async function loadPage(kind, append = false) {
  const seq = ++loadSeq[kind],
    params = new URLSearchParams();
  if (append && next[kind]) params.set("before", next[kind]);
  if (append && kind === "exports") params.set("completion", exportCompletion);
  if (kind === "usage" && jobFilter) params.set("job", jobFilter);
  const view = logViews[kind];
  if (view.form) {
    const form = $(view.form);
    for (const [key, value] of new FormData(form)) {
      if (value) params.set(key, value);
    }
    $(view.older).hidden = true;
    if (!append) {
      $(view.download).hidden = true;
      next[kind] = null;
      $(view.rows).replaceChildren();
    }
    if (!form.checkValidity()) {
      $(view.rows).textContent = "期間の日時を確認してください。";
      return;
    }
  }
  let result;
  try {
    result = await request("?" + params, undefined, view.path);
  } catch (error) {
    if (seq !== loadSeq[kind]) return;
    if (!view.form) throw error;
    if (append) $(view.older).hidden = false;
    else $(view.rows).textContent = error.message;
    if (append) report(error);
    return;
  }
  if (seq !== loadSeq[kind]) return;
  if (kind === "employees" && result.operators) {
    setLogOptions($("#operatorFilter"), result.operators.map(id => new Option(id, id)));
  }
  if (kind === "exports" && !append) {
    setLogOptions($("#exporterFilter"), result.exporters.map(id => new Option(id, id)));
    setLogOptions($("#exportEmployeeFilter"), result.employees.map(id => {
      const person = members.find(m => m.actor === id);
      return new Option(person ? person.name + "（" + id + "）" : id, id);
    }));
  }
  if (view.download && !append) {
    const exportParams = new URLSearchParams(params);
    exportParams.set("before", result.rows.length ? result.rows[0].seq + 1 : 0);
    if (kind === "exports") {
      exportCompletion = result.completion;
      exportParams.set("completion", exportCompletion);
    }
    const link = $(view.download);
    link.href = view.path + ".csv?" + exportParams;
    link.hidden = false;
  }
  const target = $(view.rows);
  const rows = result.rows.map(view.render).join("");
  if (append) target.insertAdjacentHTML("beforeend", rows);
  else
    target.innerHTML = rows || '<p class="info">該当する記録はありません。</p>';
  next[kind] = result.next;
  $(view.older).hidden = !result.next;
}
function loadLogs() {
  return Promise.all(Object.keys(logViews).filter(kind => kind !== "exports" || $("#exportHistory").open).map(kind => loadPage(kind)));
}
$("#findUsage").onsubmit = (e) => {
  e.preventDefault();
  jobFilter = new FormData(e.target).get("job").trim();
  const url = new URL(location.href);
  if (jobFilter) url.searchParams.set("job", jobFilter);
  else url.searchParams.delete("job");
  url.hash = "usage";
  history.replaceState(null, "", url);
  loadPage("usage").catch(report);
};
const auditFilters = $("#auditFilters");
const receiptOutcomeLabels = {
  missing:"受付記録なし", ambiguous:"候補が複数", mismatch:"送信試行と不一致", expired:"受付記録の期限切れ",
  unavailable:"受付記録を取得できず", unverified:"元の実行を確認できず", matched:"元の実行と一致",
};
function closureCard(record) {
  const rows = record.checks.map(check => '<li>' + escape(timestamp(check.time)) + '　' +
    escape(receiptOutcomeLabels[check.outcome] ?? check.outcome) + '</li>').join("");
  const missing = record.reserved - record.checks.length;
  return '<article class="logrow" data-closure="' + escape(record.id) + '"><h3>結果未確認で対応終了</h3><p>依頼ID　' + escape(record.id) +
    '</p><h4>自動照合（日本時間）</h4>' + (rows ? '<ul>' + rows + '</ul>' : '<p>照合結果の記録はありません。</p>') +
    (record.reserved === null ? '<p>自動照合の回数は記録されていません。</p>' : '') +
    (missing > 0 ? '<p>残り' + missing + '件は時刻・結果の記録がありません。</p>' : '') +
    '<h4>対応終了</h4><p>担当者　' + escape(record.operator) + '</p><p>終了日時（日本時間）　' +
    escape(timestamp(record.time)) + '</p><h4>終了理由</h4><p class="doc-body">' + escape(record.reason) + '</p></article>';
}
const closureSearch = $("#closureSearch"), closureResult = $("#closureDetails"), closureStatus = $("#closureSearchStatus");
let closureSearchSeq = 0;
closureSearch.oninput = () => {
  closureSearchSeq++;
  closureResult.replaceChildren();
  closureStatus.textContent = "";
};
closureSearch.onsubmit = async event => {
  event.preventDefault();
  const seq = ++closureSearchSeq;
  const id = closureSearch.elements.job.value.trim();
  closureResult.replaceChildren();
  closureStatus.textContent = "検索中…";
  try {
    const record = await request("?job=" + encodeURIComponent(id),undefined,"/api/admin/audit/meeting-closures");
    if (seq !== closureSearchSeq) return;
    closureResult.innerHTML = closureCard(record);
    closureStatus.textContent = "終了記録が1件見つかりました。";
  } catch (error) {
    if (seq === closureSearchSeq) closureStatus.textContent = error.message;
  }
};
auditFilters.onsubmit = e => {
  e.preventDefault();
  loadPage("employees").catch(report);
};
$("#clearAuditFilters").onclick = () => {
  auditFilters.reset();
  loadPage("employees").catch(report);
};
auditFilters.onchange = $("#refreshEmployeeHistory").onclick = () => loadPage("employees").catch(report);
$("#olderEmployeeChanges").onclick = () => loadPage("employees", true).catch(report);
$("#exportHistory").ontoggle = () => {
  if ($("#exportHistory").open) loadPage("exports").catch(report);
};
const exportFilters = $("#exportFilters");
exportFilters.onsubmit = e => {
  e.preventDefault();
  loadPage("exports").catch(report);
};
exportFilters.onchange = () => loadPage("exports").catch(report);
$("#clearExportFilters").onclick = () => {
  exportFilters.reset();
  loadPage("exports").catch(report);
};
$("#olderExports").onclick = () => loadPage("exports", true).catch(report);
$("#olderChanges").onclick = () => loadPage("changes", true).catch(report);
$("#olderUsage").onclick = () => loadPage("usage", true).catch(report);
$("#refreshLogs").onclick = () => refresh().catch(report);
if (await verifyAccountSession()) refresh().catch(report);
