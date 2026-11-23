import { icon } from "./visual.js";
import { employeeInquiries, versionReceipts } from "./employee-inquiries.js";
import { workPlanning, installDistribution } from "./work-planning.js";
import { checkSessionResponse, installAccountSession } from "./account-session.js";

const verifyAccountSession = installAccountSession({ onDisabled: showDisabled });

const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const inquiries = employeeInquiries({
  esc, button, section, plannedTime, displayedVersion, acceptsJobFollowup,
  api, modal, go, route, reload, notice, showDisabled,
});
const nav = {
  home: "ホーム",
  jobs: "依頼一覧",
  catalog: "手順を探す",
  work: "業務スペース",
};
const legacyRoutes = new Map([
  ["skills", "catalog"],
  ["planning", "jobs/reservations"],
  ["work/reservations", "jobs/reservations"],
]);
const menu = $("#workspaceMenu");
function setMenu(open) {
  menu.setAttribute("aria-expanded", String(open));
  menu.setAttribute("aria-label", open ? "メニューを閉じる" : "メニューを開く");
}
menu.addEventListener("click", () => setMenu(menu.getAttribute("aria-expanded") === "false"));
menu.closest("aside").addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menu.getAttribute("aria-expanded") === "true") {
    setMenu(false);
    menu.focus();
  }
});
$(".skip").addEventListener("click", (event) => {
  event.preventDefault();
  $("#main").focus();
});
const labels = {
  cancelled: "取り消し済み",
  scheduled: "実行予約済み",
  queued: "受付済み",
  split_waiting: "作業分担中",
  dispatching: "起動中",
  running: "作業中",
  waiting: "確認待ち",
  source_waiting: "資料待ち",
  source_expired: "資料待ちの期限切れ",
  source_blocked: "資料待ちを停止",
  held: "モデル停止による保留",
  held_dispatched: "実行中にモデル停止",
  procedure_revoked: "手順の利用条件が変わったため停止",
  account_blocked: "社員の利用停止により終了",
  membership_blocked: "所属変更により停止",
  done: "完了",
  failed: "要確認",
  unknown: "結果を確認中",
  closed_unconfirmed: "結果未確認で対応終了",
};
let openedVersion;
let focusedReply;
let composerProcedure;
let composerDocument;
let freshComposer=false;
let retainedRequest;
let catalogContext;
const catalogFilter={query:"",group:"all",favorites:false};
let libraryViewer;
let workDocumentQuery="";
let workDocumentRequest=0, workSearchTimer;
let lastView,
  workspace,
  job,
  generation = 0,
  timer,
  requestKey,
  requestBody,
  submitting = false;
function route(path = location.hash.slice(1) || "home") {
  path = legacyRoutes.get(path) || path;
  return path.replace(/^(job\/[\w-]+)\/(?:version\/\d+|reply\/\d+(?:\/round\/\d+)?)$/, "$1")
    .replace(/^(inquiry\/\d+)\/round\/\d+(?:\?from=\d+)?$/, "$1");
}
function leavePreviousJob(nextRoute) {
  if (!job || nextRoute === "job/" + job.id) return;
  if (nextRoute !== 'job/' + openedVersion?.job) openedVersion = null;
  job = null;
  lastView = null;
  $("#main").replaceChildren();
}
function go(path) {
  path = legacyRoutes.get(path) || path;
  leavePreviousJob(route(path));
  if ((location.hash.slice(1) || "home") === path) reload();
  else location.hash = path;
}
function button(label, op, cls = "secondary", symbol = "") {
  return (
    '<button type="button" class="' +
    cls +
    '" data-op="' +
    esc(op) +
    '">' +
    esc(label) +
    (symbol ? icon(symbol) : "") +
    "</button>"
  );
}
function status(j) {
  const tone =
    ["waiting","source_waiting"].includes(j.status) ? "wait" : j.status === "done" ? "" :
    ["closed_unconfirmed","source_blocked","source_expired"].includes(j.status) ? "stop" : "run";
  const phase = j.phase?.startsWith("inquiry-") ? "問い合わせの起票案を作成中" : j.phase?.startsWith("actions-") ? "宿題候補を抽出中" : j.phase === "review" ? "資料を照合中" : j.phase?.startsWith("question-") ? "質問に回答中" : j.phase?.startsWith("revise-") ? "修正中" : "成果物を作成中";
  const label = j.status === "running" ? (j.phase.startsWith("learn-quote-") ? "個人スキルを保存中" : phase) : labels[j.status];
  return '<span class="status ' + tone + '">' + label + "</span>";
}
function section(title, extra = "") {
  return (
    '<div class="sectionhead"><h2>' + esc(title) + "</h2>" + extra + "</div>"
  );
}
function tile(name, tone = "") {
  return '<span class="tile ' + tone + '">' + icon(name) + "</span>";
}
function row(j) {
  return (
    '<button class="listbtn" data-op="job/' +
    j.id +
    '">' +
    tile("file") +
    '<span class="listtext"><b>' +
    esc(j.ask) +
    "</b><small>" +
    esc(j.kind === "renewal" ? j.company : workspace.taskTypes.find(t => t.id === j.kind)?.name || j.company) +
    (j.status === "scheduled" ? " ・ " + plannedTime(j.scheduled_at) + "（日本時間）" : "") + "</small></span>" +
    status(j) +
    icon("chev", "chev") +
    "</button>"
  );
}
let requestListActor, requestListQuery = "", requestListFilter = "all", requestSearchTimer;

function jobsPage(current) {
  if (requestListActor !== workspace.employee.actor) {
    requestListActor = workspace.employee.actor;
    requestListQuery = "";
    requestListFilter = "all";
  }
  const reservations = current === "jobs/reservations";
  const tabs = '<section class="request-list" aria-label="依頼一覧">' +
    '<nav class="request-filters" aria-label="依頼の表示">' +
    [["all","すべて"],["waiting","回答待ち"]].map(([value,label]) => reservations
      ? '<a href="#jobs" data-op="request-filter/'+value+'">'+label+'</a>'
      : '<button type="button" data-op="request-filter/'+value+'"'+
        (requestListFilter === value ? ' aria-current="page"' : '')+'>'+label+'</button>').join("") +
    '<a href="#jobs/reservations"'+(reservations ? ' aria-current="page"' : '')+'>予約</a></nav>';
  if (reservations) {
    const scheduled = workspace.jobs.filter(j=>j.status==="scheduled");
    return tabs+'<div id="planningRoot"></div>'+
      (scheduled.length ? section("実行予約済みの依頼")+list(scheduled) : "")+'</section>';
  }
  return tabs+
    '<search class="request-search"><label for="jobSearch">依頼文や会話から検索</label>' +
    '<input id="jobSearch" type="search" name="q" aria-controls="jobResults" placeholder="キーワードを入力" autocomplete="off" value="'+esc(requestListQuery)+'"></search>' +
    '<div class="delete-tools"><p id="jobSearchStatus" class="meta" role="status"></p>'+
    button("選択して削除","delete-picker/jobs")+'</div><div id="jobResults" class="request-results"></div>' +
    '<div class="actions request-list-actions">'+button("新しく依頼","home","primary","arrow")+
    button("複数の仕事から依頼","combine-work","secondary")+'</div>' +
    draftList() + '</section>';
}

function jobResults(jobs, query) {
  return jobs.map(j => {
    const label = j.kind === "renewal" ? j.company : workspace.taskTypes.find(t => t.id === j.kind)?.name;
    const date = new Date(j.scheduled_at && j.status === "scheduled" ? j.scheduled_at : j.created);
    const when = date.toLocaleDateString("ja-JP", {timeZone:"Asia/Tokyo",month:"numeric",day:"numeric"});
    const excerpt = j.match && '<small class="request-match">'+esc(j.match.label)+' · '+esc(j.match.before)+
      '<mark>'+esc(j.match.term)+'</mark>'+esc(j.match.after)+'</small>';
    return '<div class="request-result"><button type="button" class="listbtn" data-op="job/'+esc(j.id)+'">'+tile("file")+
      '<span class="listtext"><b>'+esc(j.ask)+'</b>'+(excerpt || (label ? '<small>'+esc(label)+'</small>' : ""))+'</span>'+
      status(j)+'<time datetime="'+date.toISOString()+'">'+esc(when)+'</time>'+icon("chev","chev")+'</button>'+
      '<button type="button" class="secondary request-reuse" data-op="repeat/'+esc(j.id)+
      '" aria-label="「'+esc(j.ask)+'」を新しい依頼に使う">新しい依頼に使う</button></div>';
  }).join("") || '<p class="empty">'+(query ? "一致する依頼はありません。別のキーワードで検索してください。" :
    requestListFilter === "waiting" ? "回答待ちの依頼はありません。" : "まだ依頼はありません。")+'</p>';
}

function restoreJobsSearch(focused) {
  const field = $("#jobSearch");
  if (!field) return;
  searchJobs(field);
  if (focused?.id === "jobSearch") field.focus();
}
function catalogEntries() {
  const standard=(workspace.standardWorkflows || []).map(item=>({...item,key:"standard:"+item.id,provider:"会社標準",kind:"assistant",workflow:item.id}));
  if (workspace.skill) standard.unshift({...workspace.skill,key:"standard:"+workspace.skill.id,provider:"会社標準",kind:"renewal"});
  const team=workspace.procedures.map(item=>{
    const quote=item.layout==="quote-comparison";
    return {...item,key:"team:"+item.id,provider:"チーム共有",kind:quote ? "assistant" : "renewal",procedure:item.id,
      source:quote ? "新しい見積書2件" : "契約台帳・商談議事録",example:quote ? "公開手順の項目で2社の見積比較を作成して" : item.name+"を使って更新商談を準備して",
      output:quote ? JSON.parse(item.instruction).criteria.join("・") : "チームの手順に沿った更新商談メモ",scope:item.delivery_team || item.scope};
  });
  const personal=workspace.templates.map(item=>{
    const workflow=workspace.standardWorkflows?.find(entry=>entry.id===item.standard_workflow);
    return {...item,key:"personal:"+item.id,provider:"自分が作成",version:item.version || 1,scope:"本人のみ",
      source:item.recipe ? "集計する新しいCSV" : workflow?.source || "今回の依頼に使う資料",example:item.ask,
      output:item.output_format || workflow?.output || item.name,template:item.recipe ? item.id : null,
      workflow:workflow?.id,personalTemplate:!item.recipe ? item.id : null};
  });
  const quotes=workspace.quote_skills.map(item=>({...item,name:"自分の見積比較",key:"personal:"+item.id,provider:"自分が作成",version:1,scope:"本人のみ",
    source:"新しい見積書2件",example:"保存した条件で2社の見積を比較して",output:item.criteria.join("・"),kind:"assistant",quote:item.id}));
  return [...standard,...team,...personal,...quotes];
}
const catalogGroups={all:"すべて",standard:"会社標準",team:"チーム共有",personal:"自分が作成"};
const normalizeSearch=value=>String(value ?? "").normalize("NFKC").trim().toLowerCase();
function catalogRows(query) {
  const terms=normalizeSearch(query).split(/\s+/).filter(Boolean);
  const favorites=new Set(workspace.favorites || []);
  const entries=catalogEntries().filter(item=>{
    const group=item.key.split(":")[0];
    if ((catalogFilter.group!=="all" && group!==catalogFilter.group) ||
        (catalogFilter.favorites && !favorites.has(item.key))) return false;
    const haystack=normalizeSearch([item.name,item.provider,item.scope,item.source,item.example,item.output,item.instruction,catalogGroups[group]].join(" "));
    return terms.every(term=>haystack.includes(term));
  });
  return entries.map(item=>'<button type="button" class="listbtn catalog-row" data-op="catalog/'+esc(item.key)+'">'+tile("skills")+
    '<span class="listtext"><b>'+esc(item.name)+'</b><small>'+esc(item.provider+" ・ "+item.scope+" ・ v"+item.version)+
    (item.recommended ? ' ・ 部署推奨' : '')+(favorites.has(item.key) ? ' ・ お気に入り' : '')+'</small>'+
    '<span class="catalog-output">'+esc(item.output)+'</span></span>'+icon("chev","chev")+'</button>').join("");
}
function catalogPage() {
  return (catalogContext ? '<div class="catalog-context"><span>相談「'+esc(catalogContext.ask)+'」に使う手順を選択中</span>'+
    '<a href="#job/'+esc(catalogContext.id)+'/version/'+catalogContext.version+'">会話に戻る</a></div>' : '')+
    '<section class="catalog-page" aria-label="手順を探す"><search aria-label="手順の検索">'+
    '<div class="catalog-search"><label for="catalogSearch">やりたいこと・資料名で検索</label>'+
    '<input id="catalogSearch" type="search" value="'+esc(catalogFilter.query)+
    '" aria-controls="catalogResults" placeholder="例：見積、メール、CSV"></div>'+
    '<div class="workspace-subnav" role="group" aria-label="手順の提供元">'+Object.entries(catalogGroups).map(([group,label])=>
      '<button type="button" data-op="catalog-filter/'+group+'" aria-pressed="'+(catalogFilter.group===group)+'">'+label+'</button>').join("")+
    '</div><label><input id="catalogFavorites" type="checkbox" '+(catalogFilter.favorites ? "checked" : "")+'> お気に入りのみ</label></search>'+
    '<div class="catalog-tools"><p id="catalogCount" role="status"></p>'+button("手順を作成","save-template","catalog-create")+
    button("選択して削除","delete-picker/procedures")+'</div>'+
    '<div id="catalogResults" class="catalog-results"></div></section>';
}
function refreshCatalog() {
  const results=$("#catalogResults");
  if (!results) return;
  results.innerHTML=catalogRows(catalogFilter.query) || '<p class="empty">条件に合う手順はありません。</p>';
  $("#catalogCount").textContent=results.querySelectorAll(".catalog-row").length+"件の手順";
  $('[data-op="delete-picker/procedures"]').hidden=!results.querySelector('[data-op^="catalog/personal:"]');
}
function showCatalogEntry(item) {
  const favorite=workspace.favorites?.includes(item.key);
  const inConsultation=catalogContext?.eligible.some(entry=>entry.key===item.key && entry.version===item.version);
  const draft=$("#request") || retainedRequest;
  const inDraft=Boolean(draft?.elements.ask.value.trim()) && (!draft.dataset.libraryDocument || item.workflow==="source-answer");
  modal(item.name,'<p class="meta">'+esc(item.provider+" ・ "+item.scope+" ・ v"+item.version)+'</p><dl class="catalog-detail">'+
    '<dt>用意するもの</dt><dd>'+esc(item.source)+'</dd><dt>受け取れるもの</dt><dd>'+esc(item.output)+'</dd>'+
    '<dt>依頼例</dt><dd>'+esc(item.example)+'</dd></dl>'+
    (item.instruction && item.layout!=="quote-comparison" ? '<details><summary>公開されている手順</summary><p class="doc-body">'+esc(item.instruction)+'</p></details>' : '')+
    '<div class="actions">'+(inConsultation ? button("この相談で使う","apply-catalog-entry/"+item.key,"primary") : '')+
    button("この手順で新しく依頼","start-catalog/"+item.key,inConsultation ? "secondary" : "primary")+
    (inDraft ? button("入力中の相談で使う","carry-catalog/"+item.key,"secondary") : '')+
    (item.template ? button("新しいCSVで使う","template/"+item.template) : '')+
    (item.personalTemplate ? button("依頼内容と出力形式を設定","template/"+item.personalTemplate) : '')+
    (item.quote ? button("新しい見積2件で使う","quote-run/"+item.quote) : '')+
    (item.template || item.personalTemplate ? button("定期実行を設定","template-schedule/"+(item.template || item.personalTemplate)) : '')+
    button(favorite ? "お気に入りを解除" : "お気に入りに追加","favorite-catalog/"+item.key,"secondary")+
    (item.key.startsWith("personal:") ? button("この手順を削除","delete-one/procedures/"+item.id) : "")+"</div>");
}
function fillComposerProcedure(form) {
  if (!composerProcedure) return;
  const {key,keepAsk}=composerProcedure;
  const selected=catalogEntries().find(item=>item.key===key);
  composerProcedure=null;
  if (!selected) return;
  if (!keepAsk || selected.workflow!=="source-answer") clearComposerDocument(form,true);
  form.elements.kind.value=selected.kind;
  if (!keepAsk || !form.elements.ask.value.trim()) form.elements.ask.value=selected.example;
  form.dataset.example=selected.example;
  form.dataset.procedure=selected.procedure || "";
  form.dataset.workflow=selected.workflow || "";
  form.dataset.csvTemplate=selected.template || "";
  form.dataset.quoteSkill=selected.quote || "";
  form.dataset.outputFormat=selected.output_format || "";
  form.dataset.personalTemplate=selected.personalTemplate || "";
  form.dataset.personalTemplateVersion=String(selected.version);
  form.querySelector("[data-composer-procedure]").textContent=selected.name+" ・ v"+selected.version;
  refreshSources(form);
  form.elements.ask.focus();
}
function clearComposerProcedure(form) {
  for (const setting of ["procedure","workflow","csvTemplate","quoteSkill","outputFormat","personalTemplate","personalTemplateVersion"]) delete form.dataset[setting];
  form.querySelector("[data-composer-procedure]").textContent="";
}
function clearComposerDocument(form,clearScope=false) {
  if (!form.dataset.libraryDocument) return;
  if (clearScope) for (const input of form.querySelectorAll("[name=library]")) input.checked=false;
  delete form.dataset.libraryDocument;
  delete form.dataset.documentLibrary;
  form.querySelector("[data-document-pin]").textContent="";
  form.querySelector('[data-op="clear-document"]').hidden=true;
}
function selectedLibraryDocument(form,data) {
  if (data.getAll("library").length===1 && data.get("library")===form.dataset.documentLibrary) return form.dataset.libraryDocument;
}
function fillComposerDocument(form) {
  if (!composerDocument) return;
  const {library,name}=composerDocument;
  composerDocument=null;
  const boxes=Array.from(form.querySelectorAll("[name=library]"));
  if (!boxes.some(input=>input.value===library)) {
    form.querySelector(".form-error").textContent="資料の閲覧範囲が変わりました。社内資料を選び直してください。";
    return;
  }
  clearComposerProcedure(form);
  form.elements.kind.value="assistant";
  form.elements.ask.value="「"+name+"」について教えてください。";
  form.dataset.example=form.elements.ask.value;
  form.dataset.workflow="source-answer";
  form.dataset.libraryDocument=name;
  form.dataset.documentLibrary=library;
  for (const box of boxes) box.checked=box.value===library;
  form.querySelector("[data-document-pin]").textContent="質問する資料　"+name;
  form.querySelector('[data-op="clear-document"]').hidden=false;
  refreshSources(form);
  form.elements.ask.focus();
}
function consultationCatalog(current,version) {
  const workflowIds=(workspace.standardWorkflows || []).filter(item=>
    (!current.library_selection.length || item.id==="source-answer") &&
    (item.id!=="csv-summary" || current.sources.some(source=>source.attached && /\.csv$/i.test(source.title))) &&
    (item.id!=="quote-comparison" || (current.sources.length===2 && current.sources.every(source=>source.attached)))
  ).map(item=>item.id);
  const eligible=catalogEntries().filter(item=>{
    if (item.kind!==current.kind) return false;
    if (item.key.startsWith("standard:")) return workflowIds.includes(item.workflow);
    if (item.template && current.sources.length!==1) return false;
    const workflow=item.workflow || (item.template ? "csv-summary" : item.quote || item.layout==="quote-comparison" ? "quote-comparison" : null);
    return !workflow || workflowIds.includes(workflow);
  }).map(item=>({key:item.key,version:item.version}));
  return {id:current.id,version,latest:current.versions.at(-1).version,ask:current.ask,eligible,
    actor:workspace.employee.actor,team:workspace.employee.team};
}
function showApplyCatalog(context,selected) {
  const options=catalogEntries().filter(item=>context.eligible.some(entry=>entry.key===item.key && entry.version===item.version));
  modal("この相談で使う手順",'<form id="applyCatalog" data-job="'+esc(context.id)+'" data-version="'+context.version+'" data-latest="'+context.latest+'">'+
    '<label class="formlabel">適用する手順<select name="workflow" required>'+options.map(item=>{
      const standard=item.key.startsWith("standard:");
      return '<option value="'+esc(standard ? item.workflow : item.key)+'"'+(standard ? "" : ' data-procedure-version="'+item.version+'"')+
        (item.key===selected ? ' selected' : '')+'>'+esc(item.name+" ・ "+item.provider)+'</option>';
    }).join("")+
    '</select></label><label class="formlabel">今回の希望<textarea name="instruction" class="field" required maxlength="4000">'+esc(context.instruction ?? context.ask)+'</textarea></label>'+
    '<p>第'+context.version+'版に、同じ相談と資料を使って修正版を作ります。</p><div class="actions">'+
    '<button class="primary" '+(options.length ? "" : "disabled")+'>この手順を適用</button>'+
    (!selected ? button("カタログから手順を探す","consultation-catalog/"+context.version,"secondary") : '')+
    '</div><p class="form-error" role="alert"></p></form>');
}
function projectChoices() {
  return '<option value="">案件を指定しない</option>'+
    workspace.projects.map(item=>'<option value="'+esc(item.id)+'">'+esc(item.name)+'</option>').join("");
}
function updatePreferencePreview(form) {
  if (form.id!=="request") return;
  const field=form.querySelector("[data-preference-preview]");
  const selected=form.elements.profileProject?.value;
  const entries=workspace.memory_enabled && !form.elements.skipProfile?.checked ?
    workspace.preferences.filter(item=>!item.project || item.project===selected) : [];
  field.hidden=!entries.length;
  field.innerHTML=entries.length ? '<summary>今回使う記憶（'+entries.length+'件）</summary><ul>'+
    entries.map(item=>'<li>'+esc(item.content)+'</li>').join("")+'</ul>' : "";
}
function profileContent(items) {
  const originChoices=workspace.jobs.slice(0,20).map(item=>'<option value="'+esc(item.id)+'">'+esc(item.ask)+'</option>').join("");
  const manage=items.map(item=>'<article class="preference-entry"><form class="preferenceForm" data-preference="'+esc(item.id)+'" data-revision="'+item.revision+'">'+
    '<label class="formlabel">'+esc(item.project ? workspace.projects.find(project=>project.id===item.project)?.name || "案件の前提" : "本人の好み")+
    '<textarea class="field" name="content" maxlength="280" required>'+esc(item.content)+'</textarea></label>'+
    (item.source_job && workspace.jobs.some(job=>job.id===item.source_job) ? button("記憶の元の仕事",
      "job/"+item.source_job+(item.source_version ? "/version/"+item.source_version : ""),"link") : "")+
    '<div class="actions"><button value="save" class="secondary" '+(!workspace.memory_enabled ? 'disabled' : '')+'>変更を保存</button>'+
    '<button value="delete" class="secondary" formnovalidate>忘れる</button></div><p class="form-error" role="alert"></p></form></article>').join("");
  const add=workspace.memory_enabled ? '<details><summary>記憶を追加</summary><form class="preferenceForm">'+
    '<label class="formlabel">覚えておく内容<textarea class="field" name="content" maxlength="280" required placeholder="例：次回から結論を先に書く"></textarea></label>'+
    '<label class="formlabel">適用する案件<select name="project">'+projectChoices()+'</select></label>'+
    '<label class="formlabel">元の仕事<select name="sourceJob"><option value="">指定しない</option>'+originChoices+'</select></label>'+
    '<button class="primary" value="save">記憶を保存</button><p class="form-error" role="alert"></p></form></details>' : "";
  return (manage || "<p>保存した好みや案件の前提はありません。</p>")+add;
}
function showProfile(items) {
  modal("Hermesが覚えていること",profileContent(items));
}
function showAnswerPreference(current,version) {
  modal("この回答の好みを今後も使う",'<form id="saveAnswerPreference" data-job="'+esc(current.id)+'" data-version="'+version+'">'+
    '<p id="answerPreferenceHelp">第'+version+'版を見て、次の依頼でも使いたい書き方や形式を入力してください。</p>'+
    '<label class="formlabel" for="answerPreferenceText">覚えておく内容</label>'+
    '<textarea class="field" id="answerPreferenceText" name="content" maxlength="280" required aria-describedby="answerPreferenceHelp"'+
    ' placeholder="例：結論を先に書く"></textarea>'+
    '<div class="actions"><button class="primary">記憶を保存</button><a href="#work/memory">Hermesの記憶を開く</a></div>'+
    '<p class="form-error" role="alert"></p></form>');
  $("#answerPreferenceText").focus();
}
function list(items) {
  return (
    '<div class="panel">' +
    (items.map(row).join("") ||
      '<p class="empty">依頼すると、ここで進捗と成果物を確認できます。</p>') +
    "</div>"
  );
}
const weekdays = ["日","月","火","水","木","金","土"];
function actionRows(actions) {
  return actions.map(a => '<article class="schedule-row"><div><b>' + esc(a.line) + '</b><small>' +
    esc(a.assignee || "担当未定") + ' ・ ' + (a.due ? '期限 ' + esc(a.due) : "期限未定") + '</small></div>' +
    button("元の会議メモ","origin/" + a.job + "/" + a.version,"link") +
    button(a.done ? "未完了に戻す" : "完了にする","action-toggle/" + a.id,"secondary") + '</article>').join("");
}
function actionList() {
  if (!workspace.actions.length) return "";
  const complete = actionRows(workspace.actions.filter(a => a.done));
  return section("会議の宿題") + '<div class="panel">' + (actionRows(workspace.actions.filter(a => !a.done)) || '<p>未完了の宿題はありません。</p>') +
    (complete ? '<details><summary>完了した宿題</summary>' + complete + '</details>' : '') + '</div>';
}
function meetingDecisions(memo) {
  const facts=[];
  let decisions=false;
  for (const raw of (memo || "").split("\n")) {
    const line=raw.trim(), heading=line.replace(/^[#*\s\d.．、-]+/u,"").replace(/[*：:\s]+$/u,"");
    if (/^(決定事項|決まったこと|会議の決定事項)$/.test(heading)) { decisions=true; continue; }
    if (/^(?:宿題|アクション|次の対応|未決|確認事項|担当者|次回予定)/.test(heading) || /^#/.test(line)) decisions=false;
    if (line && (decisions || /に決定|と決定|で合意/.test(line)) && !/^記載なし/.test(line)) facts.push(line);
  }
  return facts.join("\n");
}
function occurrenceSources(items,excluded) {
  return items.map(s=>'<label><input type="checkbox" name="include" value="'+esc(s.id)+'" '+(excluded.has(s.id) ? '' : 'checked')+'> '+
    esc(s.ask)+'</label><br>').join("") || '<p>対象の仕事はありません。</p>';
}
function projectList() {
  if (!workspace.projects.length) return "";
  return section("案件") + '<div class="panel">' + workspace.projects.map(p=>button(p.name,"project/"+p.id,"listbtn")).join("") + '</div>';
}
function projectEditor(project) {
  if (!project.can_manage) return "";
  const choices=project.roster.map(person=>'<option value="'+esc(person.actor)+'" '+(person.actor===project.responsible ? "selected" : "")+'>'+esc(person.name)+'</option>').join("");
  const roster=project.roster.map(person=>'<label class="library-choice"><input type="checkbox" name="projectMember" value="'+esc(person.actor)+'" '+
    (project.members.includes(person.actor) ? "checked" : "")+'> '+esc(person.name)+'</label>').join("");
  return '<details><summary>責任者・期限・閲覧メンバーを変更</summary><form id="projectSettings" data-project="'+esc(project.id)+'" data-revision="'+project.revision+'">'+
    '<label class="formlabel">責任者<select name="responsible">'+choices+'</select></label>'+
    '<label class="formlabel">期限<input type="date" name="due" value="'+esc(project.due || "")+'"></label>'+
    '<label class="formlabel">引き継ぎ理由<input name="reason" maxlength="400"></label>'+
    '<fieldset><legend>案件を閲覧できる社員</legend>'+roster+'</fieldset>'+
    '<p>同僚の仕事は、その同僚が明示的に共有した版の本文を確認できます。</p><button class="primary">案件の変更を保存</button><p class="form-error" role="alert"></p></form></details>';
}
function draftList() {
  if (!workspace.drafts.length) return "";
  return section("依頼の下書き") + '<div class="panel">' + workspace.drafts.map(d =>
    button(d.ask || "作成途中の依頼","request-draft/" + d.id,"listbtn")).join("") + "</div>";
}
function sharedList() {
  if (!workspace.shared.length) return "";
  return section("共有された成果物") + '<div class="panel">' + workspace.shared.map(item =>
    button(item.title + " ・ 第" + item.version + "版（" + item.sender + "）","shared/" + item.id,"listbtn")).join("") + '</div>';
}
const workSections={docs:"社内資料",projects:"案件・引き継ぎ",memory:"Hermesの記憶",actions:"承認・登録"};
function workSection(path) {
  const key=path.split("/")[1];
  return Object.hasOwn(workSections,key) ? key : "docs";
}
function workPage(path) {
  const active=workSection(path);
  const nav='<nav class="workspace-subnav" aria-label="業務スペースの項目">'+Object.entries(workSections).map(([key,label])=>
    '<a id="work-nav-'+key+'" href="#work'+(key==="docs" ? "" : "/"+key)+'"'+(key===active ? ' aria-current="page"' : '')+
    '>'+label+'</a>').join("")+'</nav>';
  let content;
  if (active==="docs") content='<search aria-label="社内資料の検索"><label class="formlabel" for="workDocSearch">資料名・業務で検索'+
    '<input id="workDocSearch" type="search" value="'+esc(workDocumentQuery)+'" placeholder="例：出張、精算、発注" aria-controls="workDocResults">'+
    '</label></search><p id="workDocStatus" class="meta" role="status"></p><div id="workDocResults"></div>';
  else if (active==="projects") content=(projectList() || '<p>参加している案件はありません。</p>')+sharedList();
  else if (active==="memory") content='<div id="workMemory" data-snapshot="'+esc(JSON.stringify([workspace.employee.actor,workspace.employee.team,
    workspace.preferences,workspace.projects,workspace.memory_enabled]))+'"><p class="meta">'+
    (workspace.memory_enabled ? "次の依頼でも使う好みや、案件の前提を確認できます。" : "現在の利用設定では記憶の追加・更新が停止されています。")+
    '</p>'+profileContent(workspace.preferences)+'</div>';
  else content=todaySection(workspace.jobs.filter(entry=>entry.status==="waiting"))+actionList()+inquiries.receivedInquiryList(workspace.received_inquiries);
  return nav+'<section id="workPanel" class="workspace-pane panel pad" aria-labelledby="work-nav-'+active+'">'+content+'</section>';
}
function workDocumentParams(library,name) {
  return new URLSearchParams({library,name}).toString();
}
async function refreshWorkDocuments(field) {
  if (!field?.isConnected) return;
  const request=++workDocumentRequest, query=field.value.trim(), results=$("#workDocResults"), status=$("#workDocStatus");
  status.textContent="資料を検索中…";
  try {
    const {documents,skipped}=await api("/api/workspace/documents?"+new URLSearchParams({q:query}));
    if (!field.isConnected || request!==workDocumentRequest) return;
    status.textContent=documents.length ? documents.length+"件の資料" : "条件に合う資料はありません。";
    if (skipped) status.textContent+=" ／ "+skipped+"件は本文を検索できませんでした。資料名で探せます。";
    results.innerHTML=documents.map(doc=>{
      const params=workDocumentParams(doc.library,doc.name);
      return '<article class="workspace-document"><h2>'+esc(doc.name)+'</h2><p class="meta">'+esc([doc.folder,doc.scope].filter(Boolean).join(" ・ "))+
        '</p><div class="actions">'+button("原文を開く","work-document/"+params,"link")+
        button("この資料に質問","ask-document/"+params,"secondary")+'</div></article>';
    }).join("");
  } catch(error) {
    if (!field.isConnected || request!==workDocumentRequest || showDisabled(error)) return;
    results.replaceChildren();
    status.textContent=error.message;
  }
}
function quoteSkillDialog(skill) {
  modal("個人スキルで見積比較",'<form id="quoteRun" aria-labelledby="dlgtitle" data-skill="'+esc(skill.id)+'"><p>比較基準　'+esc(skill.criteria.join("・"))+'</p>'+
    skill.rules.map(rule=>'<p>'+esc(rule)+'</p>').join("")+
    ['1社目','2社目'].map((label,i)=>'<label class="formlabel">'+label+'の新しい見積<input type="file" name="quote'+i+'" required accept=".txt,.md,.pdf,.docx,.csv"></label>').join("")+
    '<button class="primary">この2件で比較する</button><p class="form-error" role="alert"></p></form>');
}
function reuseDialog(title, work, format) {
  const quote=workspace.quote_skills?.find(s=>s.id===work.quote_skill_id || (s.job===work.id && s.version===work.adopted_version));
  if (quote) return quoteSkillDialog(quote);
  const version=work.adopted_version ?? (work.versions?.length===1 ? 1 : null);
  const selectedTool=version===1 ? work.work_tool : work.versions?.find(item=>item.version===version)?.work_tool;
  const prior=selectedTool?.recipe && {id:work.id,name:"第"+version+"版の集計条件",recipe:selectedTool.recipe};
  const saved=prior || work.csv_skill || (work.recipe && work);
  if (saved) {
    const origin=prior ? ' data-origin="'+esc(work.id)+'" data-version="'+version+'"' : ' data-template="'+esc(saved.id)+'"';
    modal(saved.name,'<form id="csvRun" aria-labelledby="dlgtitle"'+origin+'>'+recipeDetails(saved.recipe)+
      '<label class="formlabel" for="nextCsv">今回のCSV<input id="nextCsv" name="file" type="file" accept=".csv" required></label>'+
      '<details><summary>今回だけ条件を変更</summary><label class="formlabel">集計する行<select name="csvOverride"><option value="">保存した条件を使う</option>'+
      '<option value="all">すべての行</option><option value="exclude">指定した値の行を除外</option></select></label>'+
      '<fieldset data-csv-override hidden disabled><legend>今回の除外条件</legend><label class="formlabel">列名<input name="csvColumn" required maxlength="200"></label>'+
      '<label class="formlabel">除外する値<input name="csvValue" required maxlength="200"></label></fieldset></details>'+
      '<label class="formlabel" for="csvTiming">実行のタイミング<select id="csvTiming" name="timing"><option value="now">今すぐ実行</option><option value="once">日時を指定して1回だけ実行</option></select></label><div data-planned-time></div>'+
      '<button class="primary">このCSVで集計する</button><p class="form-error" role="alert"></p></form>');
    return;
  }
  const selected = work.versions?.find(item => item.version === version);
  const workflow = selected?.standard_workflow || work.standard_workflow || "";
  const wanted=work.library_ids || (!work.library_automatic ? (work.library_selection || []).map(l=>l.id) : []);
  const document=work.library_document || work.library_selection?.[0]?.document;
  modal(title, '<form id="repeat" data-procedure="' + esc(work.procedure_id || "") + '" data-workflow="'+esc(workflow)+'"'+
    (document ? ' data-library-document="'+esc(document)+'" data-document-library="'+esc(wanted[0])+'"' : '')+'>' +
    (version ? '<p class="meta">引き継ぎ元　'+esc(work.ask)+' · 第'+version+'版</p>' : '')+
    '<p class="meta" data-document-pin>'+esc(document ? "質問する資料　"+document : "")+'</p>'+
    '<button type="button" class="link" data-op="clear-document"'+(document ? '' : ' hidden')+'>資料の指定を外す</button>'+
    '<label class="formlabel">新しい依頼内容<textarea name="ask" class="field" maxlength="4000" required>' + esc(work.ask) + '</textarea></label>' +
    '<label class="formlabel">引き継ぐ出力形式<input name="outputFormat" maxlength="500" value="' + esc(format || "") + '"></label>' +
    '<input type="hidden" name="kind" value="' + esc(work.kind) + '">' + minutesField("repeat") + '<div class="actions"><button class="primary">新しい仕事として依頼</button></div><p class="form-error" role="alert"></p></form>');
  for (const box of $("#repeat").querySelectorAll("[name=library]")) box.checked=wanted.includes(box.value);
  refreshSources($("#repeat"));
}
const attachments = new WeakMap();
const homeFiles = new WeakMap();
function homeFileEntry(name) {
  const element = document.createElement("li");
  element.innerHTML = '<span data-file-result role="status"></span><button type="button" class="link">取り外す</button><details hidden><summary>抽出した本文を確認</summary><p class="doc-body"></p></details>';
  element.querySelector("button").setAttribute("aria-label", name + " を取り外す");
  element.querySelector("summary").setAttribute("aria-label", name + " の抽出本文を確認");
  return { name, element };
}
function renderHomeFiles(form) {
  const entries = homeFiles.get(form) || [];
  const loaded = entries.filter(entry => entry.text);
  if (loaded.length) {
    attachments.set(form, { ...loaded[0], second_attachment: loaded[1] &&
      { name: loaded[1].name, text: loaded[1].text } });
  } else attachments.delete(form);
  const list = form.querySelector("[data-file-previews]");
  for (const [index, entry] of entries.entries()) {
    const item = entry.element;
    item.querySelector("button").dataset.removeFile = index;
    item.querySelector("[data-file-result]").textContent = entry.error || (entry.text ? entry.name + " を読み込みました。" : entry.name + " を読み込んでいます…");
    const preview = item.querySelector("details");
    preview.hidden = !entry.text;
    preview.querySelector("p").textContent = entry.text || "";
    if (!item.isConnected) list.append(item);
  }
  refreshSources(form);
}
async function addHomeFiles(field) {
  const form = field.form;
  const files = Array.from(field.files);
  field.value = "";
  const entries = homeFiles.get(form) || [];
  homeFiles.set(form, entries);
  const limit = field.multiple ? 2 : 1;
  const feedback = form.querySelector(".form-error");
  if (entries.length + files.length > limit) {
    feedback.textContent = files.map(file => file.name).join("、") + "：添付は" + limit + "件までです。先に不要な資料を取り外してください。";
    return;
  }
  feedback.textContent = "";
  await Promise.all(files.map(async file => {
    const entry = homeFileEntry(file.name);
    entries.push(entry);
    renderHomeFiles(form);
    try {
      entry.text = (await readAttachment(file)).text;
    } catch (error) {
      if (showDisabled(error)) return;
      entry.error = file.name + "：" + error.message;
    }
    if (form.isConnected && entries.includes(entry)) renderHomeFiles(form);
  }));
}
async function readAttachment(file) {
  if (file.size>5*1024*1024) throw Error("5 MB以内のファイルを選んでください。");
  const format=file.name.split(".").pop().toLowerCase();
  const result=await api("/api/attachments/preview?format="+encodeURIComponent(format),{method:"POST",body:file});
  return {name:file.name,text:result.text};
}
function japanInput(stamp) {
  return new Date(stamp + 9 * 3600000).toISOString().slice(0,16);
}
function dateField(value = "") {
  return '<label class="formlabel">実行予定日時（日本時間）<input type="datetime-local" name="scheduledAt" required min="' +
    japanInput(Math.ceil((Date.now()+1)/60000)*60000) + '" value="' + esc(value) + '"></label>';
}
function arrivalFields() {
  return '<fieldset data-arrival-fields hidden disabled><legend>到着を待つ見積</legend>' +
    '<label class="formlabel">到着先の資料置き場（必須）<select name="arrivalLibrary" required><option value="">置き場を選ぶ</option>' +
    workspace.arrival_libraries.map(l=>'<option value="'+esc(l.id)+'">'+esc(l.name)+'（'+esc(l.scope)+'）</option>').join("") +
    '</select></label><label class="formlabel">到着予定のファイル名（必須）<input name="arrivalName" required maxlength="200" aria-describedby="arrival-file-help"></label>' +
    '<small id="arrival-file-help">拡張子まで入力してください。例：B社見積.pdf</small>' +
    '<label class="formlabel">待機期限（日本時間・必須）<input type="datetime-local" name="arrivalDeadline" required min="' +
    japanInput(Math.ceil((Date.now()+1)/60000)*60000) + '"></label></fieldset>';
}
function japanStamp(value) {
  return globalThis.Temporal ? Temporal.ZonedDateTime.from(value + "[Asia/Tokyo]", {disambiguation:"reject"}).epochMilliseconds :
    Date.parse(value + ":00+09:00");
}
function plannedTime(stamp) {
  return new Date(stamp).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",dateStyle:"medium",timeStyle:"short"});
}
function minutesField(formId) {
  const [contract, minutes] = workspace.defaultSources;
  const isHome = formId === "request";
  return '<details class="minutes"><summary>' + (isHome ? '資料の本文を貼り付ける' : '自分の資料を使う') + '</summary>' +
    (isHome ? "" : '<label class="formlabel"><span data-file-label>契約書を添付</span><input type="file" name="contractFile" accept=".csv,.pdf,.docx,.txt,.md"></label>' +
    '<small>CSV（UTF-8）・PDF・Word・テキスト（5 MB、抽出した本文12,000文字まで）</small>' +
    '<div><span class="attachment-status" role="status"></span> <button type="button" class="link" data-clear-contract hidden>添付を外す</button></div>') +
    '<div class="formlabel" data-paste><label data-note-label for="' + formId + '-minutes">議事録の本文</label><textarea class="field" id="' + formId + '-minutes" aria-describedby="' + formId + '-note-help" name="minutes" rows="4" maxlength="6000" placeholder="今回の商談議事録を貼り付けてください"></textarea></div>' +
    '<small data-note-help id="' + formId + '-note-help">6,000文字まで。空欄の場合は案件の商談議事録を使います。</small></details>' +
    '<details data-library-picker hidden><summary>社内の資料置き場を選ぶ</summary><p>社内の規程・用語・申請案内を質問すると、置き場を選んでいない場合は閲覧できる範囲を検索します。</p><fieldset><legend>今回検索する置き場</legend>'+
    (workspace.libraries || []).map(l=>'<label class="library-choice"><input type="checkbox" name="library" value="'+esc(l.id)+'"> '+esc(l.name)+'（'+esc(l.scope)+'・'+l.count+'件）</label>').join("")+
    '</fieldset></details><details class="source-preview"><summary>今回使う資料を確認</summary><p data-library-preview hidden></p><dl>' +
    '<dt data-preview-name>[1] ' + esc(contract.title) + '</dt><dd data-preview-contract>' + esc(contract.text) + '</dd>' +
    '<dt data-preview-second hidden></dt><dd data-preview-second-text hidden></dd>' +
    '<dt data-preview-meeting>[2] ' + esc(minutes.title) + '</dt><dd data-preview-minutes>' + esc(minutes.text) + '</dd></dl></details>' +
    '<label class="formlabel">実行のタイミング<select name="timing"><option value="now">今すぐ実行</option><option value="once">日時を指定して1回だけ実行</option>' +
    (formId==="request" && workspace.arrival_libraries?.length ? '<option value="arrival">後から届く見積で比較</option>' : '') +
    '</select></label><div data-planned-time></div>' +
    (formId==="request" && workspace.arrival_libraries?.length ? arrivalFields() : '') +
    button("下書きを保存","save-request-draft","secondary");
}
function refreshSources(form) {
  const attachment = attachments.get(form);
  const [contract, meeting] = workspace.defaultSources;
  const task = workspace.taskTypes.find(type => type.id === form.elements.kind?.value);
  const general = Boolean(task);
  const multi=task?.id==="assistant", extra=attachment?.second_attachment;
  const arrivalOption=form.elements.timing?.querySelector('[value="arrival"]');
  if (arrivalOption) {
    arrivalOption.disabled=Boolean(!multi || form.dataset.draftId);
    arrivalOption.hidden=arrivalOption.disabled;
    if (arrivalOption.disabled && form.elements.timing.value==="arrival") form.elements.timing.value="now";
  }
  const waits=form.elements.timing?.value==="arrival";
  const waitFields=form.querySelector("[data-arrival-fields]");
  if (waitFields) {
    waitFields.hidden=waitFields.disabled=!waits;
    form.elements.minutes.disabled=waits;
    form.querySelector("[data-paste]").hidden=waits;
    form.querySelector("[data-note-help]").hidden=waits;
    form.querySelector('[data-op="save-request-draft"]').hidden=waits;
    const send = form.querySelector('[type="submit"]');
    send.querySelector("[data-request-submit]").textContent = waits ? "資料待ちを登録" : "送信";
  }
  const minutes = waits ? "" : form.elements.minutes.value.trim();
  const picker=form.querySelector("[data-library-picker]");
  picker.hidden=waits || !multi || !workspace.libraries?.length;
  picker.querySelector("fieldset").disabled=picker.hidden;
  const chosen=multi && !waits ? Array.from(form.querySelectorAll("[name=library]:checked"),box=>workspace.libraries.find(l=>l.id===box.value)?.name).filter(Boolean) : [];
  const preview=form.querySelector("[data-library-preview]");
  preview.hidden=!chosen.length;
  preview.textContent="検索する置き場　"+chosen.join("、");
  form.elements.contractFile.multiple=multi && !waits;
  const fileLabel = waits ? "先に届いた見積を1件添付（必須）" : multi ? "参考資料を添付（2件まで同時選択）" : general ? "参考資料を添付" : "契約書を添付";
  if (form.id === "request") form.elements.contractFile.setAttribute("aria-label", fileLabel);
  else form.querySelector("[data-file-label]").textContent = fileLabel;
  if (form.id === "request") {
    const entries = homeFiles.get(form);
    const incomplete = entries?.find(entry => !entry.text);
    form.elements.contractFile.setCustomValidity(incomplete ? incomplete.error || incomplete.name + " を読み込んでいます。" :
      (entries?.length || 0) > (multi && !waits ? 2 : 1) ? "この依頼では添付を1件にしてください。" : "");
  } else if (attachment?.text) form.elements.contractFile.setCustomValidity(extra && (!multi || waits) ? "この依頼では添付を1件にしてください。" : "");
  form.querySelector("[data-preview-second]").hidden=form.querySelector("[data-preview-second-text]").hidden=!extra;
  form.querySelector("[data-preview-second]").textContent=extra ? "[2] "+extra.name : "";
  form.querySelector("[data-preview-second-text]").textContent=extra?.text || "";
  form.querySelector("[data-note-label]").textContent = task?.sourceLabel || "議事録の本文";
  form.querySelector("[data-note-help]").textContent = chosen.length ? "選んだ置き場と一緒に使う資料を、6,000文字まで貼り付けられます。" :
    general ? "6,000文字まで。資料が空なら依頼内容を使います。" : "6,000文字まで。空欄の場合は案件の商談議事録を使います。";
  form.elements.minutes.placeholder = task ? task.sourceLabel + "を貼り付けてください" : "今回の商談議事録を貼り付けてください";
  const firstName = form.querySelector("[data-preview-name]"), first = form.querySelector("[data-preview-contract]");
  firstName.hidden = first.hidden = Boolean(general && !attachment && (minutes || chosen.length));
  firstName.textContent = "[1] " + (attachment?.name || (general ? "依頼内容" : contract.title));
  first.textContent = attachment ? attachment.text || attachment.status : general ? form.elements.ask.value : contract.text;
  const secondName = form.querySelector("[data-preview-meeting]"), second = form.querySelector("[data-preview-minutes]");
  secondName.hidden = second.hidden = Boolean(general && !minutes);
  secondName.textContent = (extra ? "[3] " : general && !attachment ? "[1] " : "[2] ") + (minutes ? (task?.sourceLabel || "貼り付けた議事録") : meeting.title);
  second.textContent = minutes || meeting.text;
  if (form.id !== "request") {
    form.querySelector(".attachment-status").textContent = attachment?.status || "";
    form.querySelector("[data-clear-contract]").hidden = !attachment;
  }
  refreshModelChoices(form);
}
function refreshModelChoices(form) {
  const model=form.elements.modelRelease;
  if (!model) return;
  const dataClass=form.elements.dataClass;
  const libraries=[...form.querySelectorAll("[name=library]:checked")].map(input=>input.value);
  const attachmentsPresent=(homeFiles.get(form)?.length || 0)>0;
  const forced=attachmentsPresent || Boolean(form.elements.minutes.value.trim()) || form.elements.timing?.value==="arrival" ||
    libraries.some(id=>!id.startsWith("shared/"));
  const restricted=forced || dataClass.value==="restricted" ||
    (dataClass.value!=="general" && form.elements.kind.value==="assistant" && !libraries.length);
  dataClass.setCustomValidity(forced && dataClass.value==="general" ? "添付・貼り付け・部門資料を含む依頼は限定合成資料を選んでください。" : "");
  const options=workspace.model_choices?.[restricted ? "restricted" : "general"] || [];
  const selected=model.value;
  const values=[new Option("許可されたモデルを自動選択",""),...options.map(item=>new Option(item.name+" ・ v"+item.release,String(item.release)))];
  const stale=selected && !values.some(option=>option.value===selected);
  if (stale) values.push(new Option("以前選んだモデルは現在利用できません",selected));
  model.replaceChildren(...values);
  model.value=selected;
  model.setCustomValidity(stale ? "この資料区分とグループで利用できるモデルを選び直してください。" : "");
  form.querySelector("[data-model-scope]").textContent=(restricted ? "限定合成資料" : "合成資料")+
    (options.length ? "で利用できる公開モデル "+options.length+"件" : "で利用できる公開モデルがありません。");
}
document.addEventListener("invalid", event=>{
  if (event.target.form?.id!=="request" || !["modelRelease","dataClass"].includes(event.target.name)) return;
  $("#requestOptions").hidden=false;
  const toggle=$("#request [data-op='request-settings']");
  toggle.setAttribute("aria-expanded","true");
},true);
document.addEventListener("input", e => {
  if (["ask","minutes"].includes(e.target.name) && e.target.form?.elements.contractFile) refreshSources(e.target.form);
});
document.addEventListener("change", async e => {
  if (["skipProfile","profileProject"].includes(e.target.name)) updatePreferencePreview(e.target.form);
  if (["dataClass","modelRelease"].includes(e.target.name)) refreshModelChoices(e.target.form);
  if (e.target.name==="csvTarget") {
    const template=workspace.templates.find(item=>item.id===e.target.value);
    e.target.form.elements.name.value=template?.name || "";
    e.target.form.elements.name.readOnly=Boolean(template);
    e.target.form.elements.base.value=template?.version || "";
  }
  if (e.target.name==="csvOverride") {
    const fields=e.target.form.querySelector("[data-csv-override]");
    fields.disabled=fields.hidden=e.target.value!=="exclude";
  }
  if(e.target.name==="library") {
    clearComposerDocument(e.target.form);
    refreshSources(e.target.form);
  }
  if (e.target.name === "kind" && e.target.form?.elements.contractFile) {
    const form = e.target.form;
    if (form.id==="request") {
      clearComposerDocument(form,true);
      clearComposerProcedure(form);
    }
    const example = (e.target.value === "renewal" ? workspace.skill?.example : workspace.taskTypes.find(t => t.id === e.target.value)?.example)
      || workspace.employee.company + "の更新商談を準備して";
    if (!form.elements.ask.value.trim() || form.elements.ask.value === form.dataset.example) form.elements.ask.value = example;
    form.dataset.example = example;
    form.elements.ask.placeholder = "例：" + example;
    refreshSources(form);
    return;
  }
  if (e.target.form?.id === "occurrence" && e.target.name === "scheduledAt" && e.target.validity.valid) {
    const f=e.target.form, stamp=japanStamp(e.target.value), field=f.querySelector("[data-occurrence-sources]");
    if (!field) return;
    const excluded=new Set([...field.querySelectorAll("input:not(:checked)")].map(box=>box.value));
    const submit=f.querySelector("button[value=change]"); submit.disabled=true;
    try {
      const o=await api("/api/schedules/"+f.dataset.id+"/next?at="+stamp);
      if (!f.isConnected || stamp!==japanStamp(f.elements.scheduledAt.value)) return;
      if (o.slot!==Number(f.dataset.slot) || o.revision!==Number(f.dataset.revision)) throw Error("予定が変更されました。開き直してください。");
      field.innerHTML=occurrenceSources(o.sources,excluded); submit.disabled=false;
    } catch(error) { if (f.isConnected && !showDisabled(error)) f.querySelector(".form-error").textContent=error.message; }
    return;
  }
  if (e.target.hasAttribute("data-edition")) {
    const file = e.target.files[0], field = e.target, section = field.closest("fieldset");
    if (!file) { field.setCustomValidity(""); return; }
    field.setCustomValidity("資料を読み込んでいます。");
    try {
      if (file.size > 5*1024*1024) throw Error("5 MB以内のファイルを選んでください。");
      const result = await api("/api/attachments/preview?format=" + encodeURIComponent(file.name.split(".").pop().toLowerCase()),{method:"POST",body:file});
      if (field.files[0] !== file) return;
      section.querySelector("[name=documentName]").value = file.name;
      section.querySelector("[name=documentText]").value = result.text;
      field.setCustomValidity("");
    } catch (error) { if (field.files[0] === file) { field.setCustomValidity(error.message); field.reportValidity(); } }
    return;
  }
  if (e.target.name !== "contractFile") return;
  const field = e.target, form = field.form, file = field.files[0];
  if (form.id === "request") return addHomeFiles(field);
  if (!file) {
    attachments.delete(form);
    field.setCustomValidity("");
    refreshSources(form);
    return;
  }
  const pending = { name: file.name, status: "本文を読み込み中…" };
  attachments.set(form, pending);
  field.setCustomValidity(pending.status);
  refreshSources(form);
  try {
    const files=Array.from(field.files);
    if (files.length>(field.multiple ? 2 : 1)) throw Error("添付できる資料数を超えています。ファイルを選び直してください。");
    const docs=await Promise.all(files.map(readAttachment));
    if (attachments.get(form) !== pending) return;
    pending.text = docs[0].text;
    pending.second_attachment=docs[1];
    pending.status = docs.map(d=>d.name).join("、") + " を読み込みました。";
    field.setCustomValidity("");
  } catch (error) {
    if (attachments.get(form) !== pending || showDisabled(error)) return;
    pending.status = error.message;
    field.setCustomValidity(error.message);
  }
  refreshSources(form);
});
document.addEventListener("click", e => {
  const remove = e.target.closest("[data-remove-file]");
  if (remove) {
    const form = remove.form, entries = homeFiles.get(form);
    const index = Number(remove.dataset.removeFile);
    const [entry] = entries.splice(index, 1);
    entry.element.remove();
    renderHomeFiles(form);
    (entries[index]?.element.querySelector("button") || form.elements.contractFile).focus();
    return;
  }
  const clear = e.target.closest("[data-clear-contract]");
  if (!clear) return;
  const field = clear.form.elements.contractFile;
  field.value = "";
  field.dispatchEvent(new Event("change", { bubbles: true }));
});
function todaySection(waiting) {
  const today = japanInput(Date.now()).slice(0,10);
  const planned = workspace.jobs.filter(j => j.status === "scheduled" && japanInput(j.scheduled_at).startsWith(today))
    .sort((a,b) => a.scheduled_at-b.scheduled_at);
  const unread = workspace.jobs.filter(j => j.status === "done" && j.done_seq > j.viewed_seq);
  const groups = [["あなたの確認待ち",waiting],["今日の実行予約",planned],["未確認の成果物",unread]];
  const pending = workspace.actions.filter(a => !a.done && a.due);
  const tasks = [["期限超過",pending.filter(a => a.due < today)],["今日が期限",pending.filter(a => a.due === today)]];
  const content = tasks.filter(([,items]) => items.length).map(([title,items]) =>
    "<section><h3>" + title + '</h3><div class="panel">' + actionRows(items) + "</div></section>").join("") +
    groups.filter(([,jobs]) => jobs.length).map(([title,jobs]) => "<h3>" + title + "</h3>" + list(jobs)).join("");
  return section("今日の仕事") + (content || '<p class="panel empty">今日対応する仕事はありません。</p>');
}
function featuredProcedures() {
  const favorites = new Set(workspace.favorites || []);
  const rank = ["document-draft", "source-answer", "csv-summary"];
  const featured = catalogEntries().filter(item =>
    favorites.has(item.key) || item.recommended || rank.includes(item.workflow) && item.key.startsWith("standard:"),
  ).sort((a, b) =>
    Number(favorites.has(b.key)) - Number(favorites.has(a.key)) ||
    Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) ||
    rank.indexOf(a.workflow) - rank.indexOf(b.workflow),
  ).slice(0, 3);
  return featured.map(item => {
    const scope = item.key.startsWith("standard:") ? "会社標準" : item.key.startsWith("team:") ? "チーム共有" : "自分が作成";
    const tone = item.workflow === "source-answer" ? "green" : item.workflow === "csv-summary" ? "gold" : "";
    return '<button type="button" class="home-example ' + tone + '" data-op="catalog/' + esc(item.key) + '"><span>' + scope +
      '</span><strong>' + esc(item.name) + '</strong>' + icon("chev") + '</button>';
  }).join("") || '<p class="empty">利用できる手順はありません。</p>';
}
function homeRecent() {
  const jobs = workspace.jobs.slice(0, 3);
  return jobs.map(j => {
    const date = new Date(j.created);
    const sameDay = japanInput(j.created).slice(0, 10) === japanInput(Date.now()).slice(0, 10);
    const time = date.toLocaleString("ja-JP", {timeZone:"Asia/Tokyo", ...(sameDay ? {hour:"2-digit", minute:"2-digit"} : {month:"numeric", day:"numeric"})});
    return '<a class="home-recent-row" href="#job/' + esc(j.id) + '">' + tile("file") + '<strong>' + esc(j.ask) + '</strong>' + status(j) +
      '<time datetime="' + date.toISOString() + '">' + esc(time) + '</time>' + icon("chev", "chev") + '</a>';
  }).join("") || '<p class="empty">まだ依頼はありません。</p>';
}
function home() {
  const e = workspace.employee;
  const expired = workspace.jobs.filter(j => j.status === "source_expired");
  return (
    '<form id="request" class="request-composer" aria-label="Hermesに相談" method="post" action="/api/jobs" data-actor="' + esc(e.actor) + '" data-owner-team="' + esc(e.team) + '">' +
    '<label class="visually-hidden" for="requestAsk">依頼内容</label><textarea id="requestAsk" rows="2" name="ask" required maxlength="4000" placeholder="何を手伝いましょうか？"></textarea>' +
    '<ul class="request-attachment" data-file-previews aria-label="添付資料"></ul>' +
    '<p class="meta" data-composer-procedure></p>' +
    '<p class="meta" data-document-pin></p>' +
    '<button type="button" class="link" data-op="clear-document" hidden>資料の指定を外す</button>' +
    '<details data-preference-preview hidden></details>' +
    '<div class="request-toolbar">' +
    '<label class="attach-file">' + icon("clip") + '<span data-file-label>資料を添付</span><input type="file" name="contractFile" accept=".csv,.pdf,.docx,.txt,.md"></label>' +
    '<button type="button" class="link" data-op="request-settings" aria-expanded="false" aria-controls="requestOptions">依頼の設定</button>' +
    '<button class="primary" type="submit"><span data-request-submit>送信</span>' + icon("arrow") + '</button></div>' +
    '<button type="button" class="secondary" data-op="check-request" hidden>受付を確認</button>' +
    '<div id="requestOptions" hidden><label class="formlabel task-kind">依頼の種類<select name="kind">' +
    '<option value="assistant" selected>Hermesにおまかせ</option>' + (workspace.skill ? '<option value="renewal">'+esc(workspace.skill.name)+'</option>' : '') +
    workspace.taskTypes.filter(t=>t.id!=="assistant").map(t => '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>').join('') +
    '</select></label>'+
    (workspace.projects.length ? '<label class="formlabel">前提に使う案件<select name="profileProject">'+projectChoices()+'</select></label>' : "")+
    '<label class="library-choice"><input type="checkbox" name="skipProfile">今回は記憶を使わない</label>'+
    (workspace.model_choices?.scoped ? '<label class="formlabel">資料区分<select name="dataClass"><option value="">自動判定</option>'+
      '<option value="general">合成資料（全社資料の範囲）</option><option value="restricted">限定合成資料</option></select></label>'+
      '<label class="formlabel">実行モデル<select name="modelRelease" aria-describedby="modelScope"></select></label>'+
      '<p id="modelScope" data-model-scope class="meta" role="status"></p>' : "")+
    minutesField("request") + '<div class="home-extra-actions">' +
    button("新旧資料を比較","compare-documents","secondary") +
    button("分担して依頼","jobs/reservations","secondary") +
    (workspace.quote_skills?.length ? button("前回の比較基準で見積を比較","quote-run/"+workspace.quote_skills[0].id,"link") : "") +
    '</div></div><p class="form-error" role="alert"></p></form>' +
    '<section class="home-section">' +
    section("手順から始める", '<a class="home-text-link" href="#catalog">手順を探す' + icon("arrow") + '</a>') +
    '<div class="home-examples">' + featuredProcedures() + '</div></section>' +
    (expired.length ? '<section class="home-section">' + section("期限通知") + '<ul class="home-deadlines">' +
      expired.map(j => '<li><a href="#job/' + esc(j.id) + '">見積が未着 · ' + esc(j.ask) + '</a></li>').join("") + '</ul></section>' : '') +
    '<section class="home-section">' +
    section("最近の依頼", '<a class="home-text-link" href="#jobs">すべて見る' + icon("arrow") + '</a>') +
    '<div class="home-recent">' + homeRecent() + '</div></section>' +
    '<nav class="home-work-links" aria-label="業務スペースへのショートカット">' +
    '<a href="#work">社内資料を検索</a><a href="#work/projects">案件・引き継ぎ</a>' +
    '<a href="#work/memory">Hermesが覚えていること</a><a href="#work/actions">承認・登録</a></nav>'
  );
}
function sourceLinks(j) {
  return j.sources
    .map((s) =>
      button(
        "[" + s.id + "] " + s.title,
        "source/" + s.id,
        "secondary source",
        "file",
      ),
    )
    .join("");
}
function memoTitle(j) {
  if (j.csv_skill) return j.csv_skill.name;
  if (j.work_tool?.tool==="compare_quotes") return "見積比較表";
  if (j.sources[0]?.period) return "前回からの変化";
  if (j.sources[0]?.edition) return "新旧資料の変更点";
  if (j.sources[0]?.job) return "選んだ仕事のまとめ";
  return j.kind === "renewal" ? j.company + " 更新商談メモ" : j.skill_name;
}
function recipeDetails(recipe) {
  const filter=!recipe.filter_column ? "すべての明細行を採用" : recipe.filter_column+" が「"+(recipe.exclude_value || recipe.include_value)+"」の行を"+(recipe.exclude_value ? "除外" : "採用");
  return '<p>金額列　'+esc(recipe.amount_column)+'<br>グループ　'+esc(recipe.group_column || "全件")+'<br>'+esc(filter)+
    '<br>出力列　'+esc((recipe.group_column || "対象")+"、"+recipe.amount_column+"（合計）")+'</p>';
}
function workEvidence(result, standardProcedure) {
  if (!result) return "";
  if (result.tool==="compare_quotes") return '<p class="meta">'+
    (standardProcedure ? '' : '手順　'+esc(result.workflow?.title)+' ・ ')+'ツール　見積条件の照合</p>';
  const names = {aggregate_csv:"CSV集計",read_passages:"根拠条項の参照",search_libraries:"社内の資料置き場を検索",draft_document:"案内・文書の作成"};
  const title = {aggregate_csv:"集計条件と元の行",read_passages:"回答の根拠原文",search_libraries:"資料の検索結果",draft_document:"案内に使った原文"};
  return '<details class="previous-memo"><summary>'+title[result.tool]+'</summary>'+
    (result.workflow && !standardProcedure ? '<p>Hermesが選んだ手順　'+esc(result.workflow.title)+'</p>' : '') +
    '<p>Hermesが使用したツール　'+names[result.tool]+'</p>' +
    result.conditions.map(c=>'<p>'+esc(c)+'</p>').join("") +
    result.evidence.map((item,i)=>'<p><strong>'+esc(item.label)+'</strong>'+(item.source?' ・ 資料 ['+Number(item.source)+']':'')+'<br>'+
      esc(item.unavailable ? "要確認（出典失効）" : !item.source && item.text==="記載なし" ? "要確認（記載なし）" : item.text)+
      (item.source ? ' '+button("根拠の原文を開く","work-evidence/"+i,"link") : "")+'</p>').join("")+'</details>';
}
function quoteTable(job, table, version) {
  const rows=table.rows.map((row,i)=>'<tr><th scope="row">'+esc(row.label)+'</th>'+
    row.cells.map((cell,k)=>'<td>'+esc(cell.text)+(cell.ref ? ' '+button("["+cell.ref+"]","quote-source/"+i+"/"+k,"citation") : "")+'</td>').join("")+'</tr>').join("");
  return '<div id="memoText" class="quote-table" role="region" aria-label="見積比較表" tabindex="0"><table><thead><tr><th scope="col">比較項目</th>'+
    table.columns.map(name=>'<th scope="col">'+esc(name)+'</th>').join("")+'</tr></thead><tbody>'+rows+'</tbody></table></div>'+
    '<a class="secondary" download href="/api/jobs/'+esc(job.id)+'/versions/'+version+'/comparison.csv">比較表をCSVで保存</a>';
}
function versionTool(j,version) {
  return version===1 ? j.work_tool : j.versions.find(item=>item.version===version)?.work_tool;
}
function displayedVersion(j) {
  return (openedVersion?.job===j.id && j.versions.some(v=>v.version===openedVersion.version) ? openedVersion.version : null) ??
    j.adopted_version ?? j.versions.at(-1)?.version;
}

function acceptsJobFollowup(j) {
  return ["done","failed"].includes(j.status) && !j.team_denied && !j.procedure_revoked;
}

function jobComposer(j, version = displayedVersion(j)) {
  const selected = j.versions.find(v => v.version === version);
  if (!selected || !acceptsJobFollowup(j)) return "";
  const edit = '<form id="revise" class="memo-edit" data-base="' + version + '"><label class="formlabel">修正範囲<select name="lineIndex"><option value="">全文</option>' + selected.memo.split("\n").map((line,i)=>line.trim() ? '<option value="'+i+'">段落 '+(i+1)+'　'+esc(line)+'</option>' : "").join("") + '</select></label><label class="formlabel">修正内容<textarea class="field" name="instruction" rows="2" maxlength="4000" required placeholder="例：上司向けに3行にして"></textarea></label>' +
      (["fixture-model", "fixture-model-b"].includes(j.model.model_id)
        ? '<small>合成モデルで試せる修正：3行の要約、箇条書き、先方の希望を先に記載。</small>' : '') +
      '<div class="actions"><button class="secondary">修正を依頼する</button></div><p class="form-error" role="alert"></p></form>';
  const ask = '<form id="ask" data-version="' + version + '"><label class="formlabel">このメモについて質問<textarea class="field" name="question" rows="2" maxlength="500" required placeholder="例：この日付の根拠は？"></textarea></label><div class="actions"><button class="primary">質問する</button></div><p class="form-error" role="alert"></p></form>';
  return '<section class="job-composer" aria-label="第'+version+'版への追加質問・修正">'+ask+edit+'</section>';
}
function memoPanel(j, version = displayedVersion(j)) {
  const selected = j.versions.find(v => v.version === version);
  const result = versionTool(j,version);
  const latest = j.versions.at(-1).version;
  const editable = acceptsJobFollowup(j);
  const versions = j.versions.length > 1
    ? '<label class="version-picker">表示する版 <select id="memoVersion">' +
      j.versions.slice().reverse().map(v => '<option value="' + v.version + '"' + (version === v.version ? ' selected' : '') +
        '>第' + v.version + '版' + (v.version === latest ? '（最新）' : '') + (v.version === j.adopted_version ? '・採用版' : '') + '</option>').join("") + '</select></label>'
    : '<span class="meta">成果物 ・ 第1版</span>';
  const currentAdopted=version!==j.adopted_version && j.versions.find(v=>v.version===j.adopted_version);
  const other = currentAdopted || (selected.answer_inquiry && j.versions.find(v=>v.version===selected.base)) ||
    j.versions.filter(v => v.version < version).at(-1) || j.versions.find(v=>v.version > version);
  const compare = other ? '<details class="previous-memo"><summary>'+(currentAdopted ? "現在の採用版（第"+other.version+"版）" : "第"+other.version+"版")+'と見比べる</summary><div class="version-comparison">' +
    '<section><h3>第'+other.version+'版'+(other.version===j.adopted_version ? ' ・ 採用版' : '')+'</h3><p class="note">'+inquiries.citationText(other.memo,j,other.version)+'</p></section>'+
    '<section><h3>第'+version+'版'+(version===j.adopted_version ? ' ・ 採用版' : ' ・ 修正版')+'</h3><p class="note">'+inquiries.citationText(selected.memo,j,version)+'</p></section></div></details>' : '';
  const before = j.versions.find(v=>v.version===selected.base);
  const delta = selected.replacement && before ? '<section><h3>修正前</h3><p class="note">' + inquiries.citationText(before.memo.split("\n")[selected.line_index],j,before.version) + '</p><h3>修正後</h3><p class="note">'+inquiries.citationText(selected.replacement,j,version)+'</p></section>' : '';
  const quoteSkill = workspace.quote_skills?.find(s=>s.job===j.id && s.version===version);
  const learnQuote = version>1 && j.work_tool?.tool==="compare_quotes" && !j.team_denied;
  let adopt = j.versions.length > 1 && version !== j.adopted_version ? button("この版を採用", "adopt/" + version, "secondary") : '';
  if (learnQuote && ["done","failed"].includes(j.status) && !quoteSkill)
    adopt += button(j.adopted_version===version ? "採用版の比較基準を個人スキルに保存" : "この版を採用して個人スキルに保存","adopt-quote/"+version,"secondary");
  const savedQuote = quoteSkill ? '<section><h3>本人用の個人スキルに保存済み</h3><p>比較項目　'+esc(quoteSkill.criteria.join("・"))+
    '</p><details><summary>SKILL.md に保存した判断ルール</summary>'+
    (quoteSkill.rules.length ? quoteSkill.rules.map(rule=>'<p>'+esc(rule)+'</p>').join("") : '<p>今回の見積の原文を照合し、記載がない項目は要確認にします。</p>')+
    '</details>'+button("新しい見積2件で使う","quote-run/"+quoteSkill.id,"secondary")+'</section>' : '';
  const comparisons = j.comparisons.filter(c=>c.current_version===version).map(c=>
    '<section><h3>前回からの変化</h3><small>'+esc(c.previous)+' ・ 第'+c.previous_version+'版</small>' +
    (c.memo ? '<p class="note">'+esc(c.memo).replace(/\[([12])\]/g,(_,n)=>button("["+n+"]","origin/"+(n==="1" ? c.previous_job+"/"+c.previous_version : j.id+"/"+version),"citation"))+
      "</p>" : status({status:c.status,phase:"compose"})) + button("比較の詳細","job/"+c.id,"link")+"</section>").join("");
  const applied=selected.applied_procedure;
  const standardProcedure=selected.standard_procedure ?? j.standard_procedure;
  return versions + '<h2>' + esc(memoTitle(j)) + '</h2>' +
    (applied ? '<p class="meta">適用した手順　'+esc(applied.name)+' ・ 第'+applied.version+'版</p>' : '')+
    (!applied && standardProcedure ? '<p class="meta">使用した手順　'+esc(standardProcedure.name)+' ・ 第'+esc(standardProcedure.version)+'版</p>' : '')+
    inquiries.jobAnswer(j,version,workspace.employee.name) +
    (result?.table ? quoteTable(j,result.table,version) : '<p class="doc-body" id="memoText">' + inquiries.citationText(selected.memo, j,version) + '</p>') +
    workEvidence(result, standardProcedure) + delta + compare + '<div class="actions">' +
    '<button type="button" class="secondary" command="--copy" commandfor="memoText">出典付きでコピー</button>' +
    (editable && workspace.memory_enabled ? button("今後も使う","remember-answer/"+version) : "") +
    (j.kind === "meeting" && !j.team_denied ? button("宿題を登録","track/" + version,"secondary") + button(j.candidate_sets.some(s=>s.version===version) ? "宿題候補を確認" : "宿題候補を抽出","candidates/"+version,"secondary") : "") + button("Markdownで保存", "export-memo", "secondary") + (!j.team_denied && !j.sources[0]?.period ? button("前回の報告と比較","report-diff/"+version,"secondary") : "") + button("同僚に共有", "share/" + version, "secondary") + adopt +
    (editable && consultationCatalog(j,version).eligible.length ? button("この相談で使う","apply-catalog/"+version,"secondary") : "")+
    inquiries.inquiryButton(j,version,workspace.inquiry_desks)+'<small id="copyStatus" role="status"></small></div>' + savedQuote + comparisons;
}
function passage(source, claim) {
  if (!claim) return "";
  const sentences = source.text.match(/[^。！？\n]+[。！？]?/g)?.map(s => s.trim()).filter(Boolean) || [];
  const exact = sentences.filter(s => claim.includes(s) || s.includes(claim));
  if (exact.length === 1) return exact[0];
  const dates = claim.match(/\d{1,2}月\d{1,2}日/g) || [];
  const dated = sentences.filter(s => dates.some(date => s.includes(date)));
  if (dated.length === 1) return dated[0];
  // Inflected Japanese often retains the same nouns. Highlight only a unique candidate.
  const terms = [...new Set(claim.match(/[一-龯々ァ-ヶー]{2,}/gu) || [])];
  const candidates = (dated.length ? dated : sentences).filter(sentence =>
    terms.filter(term => sentence.includes(term)).length >= 2);
  return candidates.length === 1 ? candidates[0] : "";
}
function comparisonContext(citation) {
  const range = document.createRange();
  range.selectNodeContents(citation.parentNode);
  range.setEndAfter(citation);
  const before = range.toString(), after = citation.parentNode.textContent.slice(before.length);
  const earlier = before.split("\n"), later = after.split("\n");
  const line = earlier.at(-1) + later[0];
  if (line.includes("[1]") && line.includes("[2]")) return line;
  if (line.includes("[1]") && later[1]?.includes("[2]")) return line + "\n" + later[1];
  if (line.includes("[2]") && earlier.at(-2)?.includes("[1]")) return earlier.at(-2) + "\n" + line;
  return before.split(/\n\s*\n/).at(-1) + after.split(/\n\s*\n/)[0];
}
function comparisonExcerpt(source,claim) {
  if (source.unavailable) return sourceExcerpt(source, claim);
  const parts = source.text.match(/[^。！？\n]+[。！？]?|[\s\S]/g) || [];
  const matches = parts.filter(s => s.trim() && claim.includes(s.trim()) && source.text.indexOf(s) === source.text.lastIndexOf(s));
  if (!matches.length) return sourceExcerpt(source,claim);
  return '<p class="note">' + parts.map(s => matches.includes(s) ? '<mark tabindex="-1">' + esc(s) + '</mark>' : esc(s)).join("") + '</p>';
}
function libraryExcerpt(source, evidence) {
  if (source.unavailable) return sourceExcerpt(source, "");
  let cursor=0, marked="";
  for (const item of evidence.filter(e=>e.source===source.id).sort((a,b)=>a.offset-b.offset)) {
    const start=item.offset, end=start+item.text.length;
    if (!Number.isInteger(start) || start<cursor || source.text.slice(start,end)!==item.text) continue;
    marked+=esc(source.text.slice(cursor,start))+'<mark tabindex="-1">'+esc(item.text)+'</mark>';
    cursor=end;
  }
  return '<small>'+esc([source.library_name,source.version].filter(Boolean).join(" ・ "))+'</small><p class="note">'+marked+esc(source.text.slice(cursor))+'</p>';
}
function sourceExcerpt(source, claim) {
  if (source.unavailable) return '<small class="meta">'+esc(source.version)+'</small><p role="status">'+esc(source.unavailable)+'</p>';
  const quote = passage(source, claim);
  const offset = quote ? source.text.indexOf(quote) : -1;
  const text = offset < 0 ? esc(source.text) : esc(source.text.slice(0, offset)) + '<mark tabindex="-1">' +
    esc(quote) + '</mark>' + esc(source.text.slice(offset + quote.length));
  return '<small class="meta">' + esc(source.version) + '</small>' +
    (claim && !quote ? '<p>該当箇所を特定できないため、原文全体を表示しています。</p>' : '') +
    '<p class="note">' + text + '</p>' + (source.job ? button("元の仕事を開く","origin/" + source.job + "/" + source.memo_version,"link") : "");
}
async function currentSourceJob() {
  const current = location.hash;
  try {
    const latest = await api("/api/jobs/" + encodeURIComponent(job.id));
    return location.hash === current ? latest : null;
  } catch (error) {
    if (!showDisabled(error) && location.hash === current)
      modal("出典を参照できません", '<p role="status">'+esc(error.message)+'</p>');
    return null;
  }
}
function detail(j) {
  const wait=j.arrival_wait;
  const arrivalReasons={
    attachment_access:"現在の所属または利用状態では、先に添付した見積を参照できません。",
    arrival_access:"到着先の資料置き場を参照できなくなりました。",
    arrival_changed:"届いた見積が変更されたため、受け付けた版を確認できません。",
    arrival_unreadable:"届いた見積の本文を読み取れませんでした。",
  };
  const info =
    '<div class="job-record-content"><h2>参照資料</h2>' +
    (j.library_selection.length ? '<p>検索対象の置き場　'+esc(j.library_selection.map(l=>l.name).join("、"))+'</p>' : '')+
    sourceLinks(j) + (j.sources.length > 1 ? button("資料を並べて比較", "compare-sources", "link") : "") +
    (wait ? '<p class="arrival-summary">到着予定の見積　'+esc(wait.name)+'（'+esc(wait.library_name)+'）<br>待機期限　'+plannedTime(wait.deadline)+'（日本時間）</p>' : '') +
    '<hr class="hr"><p class="info">手順　' + esc(j.standard_procedure?.name ?? j.skill_name) + ' v' +
    esc(j.standard_procedure?.version ?? j.skill_version ?? "不明") + '<br>依頼者　' +
    esc(workspace.employee.name) +
    "<br>使用モデル　" +
    esc(j.model.name) +
    "（設定 v" +
    esc(j.model_version) +
    "）" + (j.scheduled_at ? "<br>予約日時　" + plannedTime(j.scheduled_at) + "（日本時間）" : "") +
    "</p></div>";
  let content;
  if (j.status === "cancelled") content = "<h2>依頼を取り消しました</h2>";
  else if (j.status === "source_waiting")
    content = '<h2>見積の到着を待っています</h2><p>期限までに指定の見積が届いたら、この依頼で比較を始めます。</p>'+
      button("資料待ちを取り消す","cancel-job");
  else if (j.status === "source_expired")
    content = '<h2>待機期限を過ぎました</h2><p>見積の比較は実行されていません。</p>';
  else if (wait?.reason && arrivalReasons[wait.reason])
    content = '<h2>資料待ちを停止しました</h2><p>'+arrivalReasons[wait.reason]+'</p>';
  else if (j.status === "waiting")
    content =
      '<div class="engine engine-note">' +
      icon("msg") +
      "Hermes からの確認</div><h3>" +
      esc(j.question) +
      '</h3>' + (j.team_denied ? '<p>所属が変わったため、回答はこの依頼にのみ保存します。</p>' :
        j.procedure_revoked ? '<p>手順の公開が取り消されました。回答はこの依頼に保存できます。</p>' : '') +
      '<form id="answer" method="post"><label class="formlabel">Hermesへの回答<textarea name="answer" class="field" required maxlength="500" placeholder="例：日付は未確定として先方への確認事項に入れる"></textarea></label><div class="actions"><button class="primary">' +
      (j.team_denied || j.procedure_revoked ? '回答を保存する' : '回答して作業を続ける') +
      icon("arrow") +
      "</button></div></form>" + (j.team_denied ? "" : button("あとで通知","set-reminder","secondary") +
      (j.reminder_at ? "<p>再通知予定　" + plannedTime(j.reminder_at) + "（日本時間）</p>" : ""));
  else if (["procedure_revoked", "membership_blocked", "account_blocked"].includes(j.status))
    content = '<h2>' + labels[j.status] + '</h2><p>この依頼からの追加送信は停止しました。</p>' +
      (j.answer ? '<h3>保存した回答</h3><p>' + esc(j.answer) + '</p>' : '');
  else if (j.status === "held" || j.status === "held_dispatched") {
    content =
      "<h2>" +
      labels[j.status] +
      "</h2>" +
      (j.answer ? "<h3>保存した回答</h3><p>" + esc(j.answer) + "</p>" : "") +
      (j.status === "held_dispatched"
        ? "<p>停止前に開始した実行があります。運用担当者が利用記録を確認してください。</p>"
        : j.model.stopped
          ? "<p>この段階は未送信です。モデルの停止解除後に再開できます。</p>" +
            button("状態を更新", "refresh")
          : "<p>同じモデルで作業を再開できます。</p>" +
            button("この依頼を再開", "resume"));
  } else if (j.status === "done")
    content = '<div id="memoPanel">' + memoPanel(j) + '</div><div class="actions">' +
      (!j.team_denied && (j.draft || !j.procedure_revoked && (j.kind==="renewal" ||
        workspace.quote_skills.some(skill=>skill.job===j.id && skill.version===j.adopted_version))) ?
        button(j.draft ? { draft: "草案を確認", pending: "申請中の手順を確認", published: "公開した手順を確認", revoked: "取消済みの手順を確認" }[j.draft.state] :
          j.kind==="renewal" ? "手順の草案を作る" : "チーム公開の草案を作る", "draft", "secondary") : "") +
      "</div>";
  else if (j.status === "closed_unconfirmed")
    content = '<h2>' + labels[j.status] + '</h2><h3>終了理由</h3><p class="doc-body">' + esc(j.closure_reason) + '</p>';
  else if (j.status === "unknown")
    content = '<h2>結果を確認中</h2><p>管理者が元の実行を照合します。再依頼は不要です。結果はこの仕事に反映されます。</p>';
  else if (j.status === "failed")
    content =
      "<h2>" +
      labels[j.status] +
      "</h2><p>同じ依頼の自動再送を停止しました。運用担当者が実行記録を確認できます。</p>";
  else
    content =
      "<h2>Hermes が作業中です</h2><p>" +
      esc(
        j.phase === "compose" ? "資料をもとに下書きを作成しています。" : j.phase === "review"
          ? "契約台帳と商談議事録を照合しています。"
          : j.phase.startsWith("inquiry-") ? "選んだ版から問い合わせの件名・本文・添付候補を準備しています。" : j.phase.startsWith("actions-") ? "会議メモの宿題と原文の根拠を確認しています。" : j.phase.startsWith("question-") ? "資料を確認して追加の質問に回答しています。" : j.phase.startsWith("revise-") ? "ご指定の内容でメモを修正しています。" : "回答を反映し、商談メモをまとめています。",
      ) +
      "</p>";
  if (j.status === "scheduled")
    content = "<h2>実行予約済み</h2><p>" + plannedTime(j.scheduled_at) + "（日本時間）に1回実行します。</p>" +
      button("予約日時を変更","edit-reservation","secondary") + button("依頼を取り消す","cancel-job","secondary");
  if (j.status === "queued" && ["review","compose"].includes(j.phase))
    content = '<h2>受付済み</h2><p>Hermes の作業開始を待っています。</p>' + (j.scheduled_at ? button("予約日時を変更","edit-reservation","secondary") : "") + button("依頼を取り消す","cancel-job","secondary");
  if (j.status === "failed" && j.memo)
    content = '<h2>' + (j.phase.startsWith('inquiry-') ? '起票案を作成できませんでした' : j.phase.startsWith('actions-') ? '宿題候補を抽出できませんでした' : j.phase.startsWith('question-') ? '質問の回答を取得できませんでした' : '修正版を作成できませんでした') + '</h2><p>直前のメモを表示しています。修正内容を変えてもう一度依頼できます。</p>';
  if (j.phase.startsWith("learn-quote-") && ["queued","dispatching","running","failed"].includes(j.status))
    content = j.status==="failed" ? "<h2>個人スキルを保存できませんでした</h2><p>採用した比較表から保存をやり直せます。</p>" :
      "<h2>個人スキルを保存中</h2><p>本人用のHermesが採用版から比較基準を取り出しています。</p>";
  if (j.memo && j.status !== "done")
    content += '<hr class="hr"><div id="memoPanel">' + memoPanel(j) + '</div>';
  const workActions = button("この依頼を削除","delete-one/jobs/"+j.id) + button("案件に整理","file-project","secondary") + button("新しい依頼に使う", "repeat", "secondary") +
    (versionTool(j,j.adopted_version ?? (j.versions.length===1 ? 1 : null))?.recipe && j.status==="done" && !j.team_denied ?
      button("集計条件を自分用に保存","save-csv-skill","secondary") : button("自分用の手順に保存", "save-template", "link")) +
    (j.versions.length ? button("共有を管理","sent-shares","link") : "");
  const userTurn = (text,label) => '<article class="job-user"><span class="job-sr-only">'+label+'</span><p class="doc-body">'+esc(text)+'</p></article>';
  const hermesTurn = (body) => '<article class="job-hermes"><span class="job-speaker">Hermes</span>'+body+'</article>';
  const questions = j.questions.map(q => userTurn(q.question,"あなたの追加質問")+
    hermesTurn('<p class="meta">第'+q.version+'版への回答</p><p class="note">'+(q.answer ? inquiries.citationText(q.answer,j,q.version) :
      j.phase === "question-"+q.number && ["queued","dispatching","running"].includes(j.status)
        ? "回答を作成中…" : "回答を取得できませんでした。")+'</p>')).join("");
  const version = displayedVersion(j);
  const currentInstruction = j.versions.find(v=>v.version===version)?.instruction;
  const attachmentNames = j.sources.filter(s=>s.attached).map(s=>s.title);
  const pendingRevision = j.pending_revision?.instruction;
  return (
    '<div class="job-chat"><header class="job-chat-head">'+
    '<a class="link back" href="#jobs">'+icon("back")+'依頼一覧</a>'+
    '<div class="heading"><h1>'+esc(j.kind === "renewal" ? j.company + "の更新商談" : j.ask)+'</h1>'+
    (version ? '<a class="secondary" href="#job/'+esc(j.id)+'/version/'+version+'" data-op="jump-result">'+
      (version === j.adopted_version ? "採用版" : "成果物")+'を開く · 第'+version+'版</a>' : '')+'</div>'+
    '<div class="job-chat-meta"><p class="meta">依頼 #'+esc(j.id)+'</p>'+status(j)+'</div></header>'+
    '<section class="job-thread" aria-label="この依頼の会話">'+userTurn(j.ask,"あなたの依頼")+
    (attachmentNames.length ? '<p class="job-attachments meta">添付資料　'+esc(attachmentNames.join("、"))+'</p>' : "")+
    (j.status !== "waiting" && j.question && j.answer ? hermesTurn('<p class="doc-body">'+esc(j.question)+'</p>')+
      userTurn(j.answer,"あなたの回答") : '')+
    (pendingRevision || currentInstruction ? userTurn(pendingRevision || currentInstruction,"あなたの修正依頼") : "")+
    hermesTurn('<div class="job-artifact panel pad doc" id="jobArtifact" tabindex="-1">'+content+
      '<div id="receiptSources">'+inquiries.receiptLinks(j,version)+'</div></div>')+
    questions+'</section>'+
    '<details class="job-record" id="jobRecord" data-job="'+esc(j.id)+'"><summary>この仕事の記録と操作</summary>'+info+
    '<div class="actions">'+workActions+'</div></details>'+
    '<div id="jobComposer" data-job="'+esc(j.id)+'" data-version="'+esc(version)+'">'+jobComposer(j)+'</div></div>'
  );
}
async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) {
    checkSessionResponse(data);
    throw Object.assign(new Error(data.error || "読み込めませんでした。"), { code: data.code, httpStatus: res.status });
  }
  return data;
}
let receiptLookup;
const receiptStorageKey = actor => "aihub:request-receipt:" + actor;
function receiptKey(actor) {
  return sessionStorage.getItem(receiptStorageKey(actor));
}
async function checkRequestReceipt(form, actor, key) {
  if (receiptLookup === key) return false;
  receiptLookup = key;
  const control = form.querySelector('[data-op="check-request"]');
  control.hidden = false;
  control.disabled = true;
  const feedback = form.querySelector(".form-error");
  feedback.textContent = "依頼の受付を確認しています…";
  try {
    const { id } = await api("/api/jobs/receipt", { headers: {"Idempotency-Key": key}, signal: AbortSignal.timeout(5000) });
    sessionStorage.removeItem(receiptStorageKey(actor));
    requestBody = null;
    if (form.isConnected && workspace?.employee.actor === actor) go("job/" + id);
    return true;
  } catch (error) {
    if (!showDisabled(error)) {
      feedback.textContent = error.httpStatus === 404 ?
        "受付済みの依頼が見つかりません。再送時も同じ受付キーで確認します。" :
        "依頼の受付を確認できませんでした。通信回復後に受付を確認してください。";
    }
    return false;
  } finally {
    receiptLookup = null;
    control.disabled = false;
  }
}
function notice(text) {
  $(".toast").textContent = text;
}
function showDisabled(error) {
  if (error.code !== "employee_disabled") return false;
  ++generation;
  clearTimeout(timer);
  lastView = workspace = job = requestKey = requestBody = null;
  retainedRequest = composerProcedure = composerDocument = catalogContext = null;
  $("#notifications").hidden = true;
  notificationActor = null;
  recentEvents = [];
  sharedEvents = [];
  if ($("#dialog").open) $("#dialog").close();
  $("#dlgbody").replaceChildren();
  $("#workspaceNav").hidden = true;
  setMenu(false);
  for (const el of document.querySelectorAll("#employee, .avatar, [data-team]")) el.textContent = "";
  $("#crumb").textContent = "利用停止中";
  document.title = "利用停止中｜AI Hub";
  $("#main").innerHTML = '<h1>利用停止中</h1><p>管理者が再有効化すると、新しい依頼を作成できます。</p>' +
    button("利用状態を確認", "refresh");
  notice(error.message);
  $("#main").focus();
  return true;
}
function display(ticket,shared) {
  const current = route(),
    page = current.startsWith("job/") || current.startsWith("jobs/") || ticket
      ? "jobs"
      : shared || current.startsWith("work/") ? "work" : Object.hasOwn(nav, current)
        ? current
        : "home";
  const mainNav = $("#workspaceNav");
  mainNav.hidden = false;
  for (const link of mainNav.children) {
    if (link.dataset.op === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  $("#employee").textContent = workspace.employee.name;
  document.querySelectorAll("[data-team]").forEach(el => { el.textContent = workspace.employee.team; });
  $(".avatar").textContent = workspace.employee.initials;
  const crumbRoot = $("#crumbRoot");
  crumbRoot.parentElement.toggleAttribute("data-nested", Boolean(job || ticket || shared));
  crumbRoot.href = job || ticket ? "#jobs" : shared ? "#work" : "#home";
  crumbRoot.textContent = job || ticket ? nav.jobs : shared ? nav.work : "ワークスペース";
  $("#crumb").textContent = ticket ? "問い合わせ受付票" : job ? "会話" : shared ? "共有された成果物" : nav[page];
  document.title = $("#crumb").textContent + " · AI Hub";
  if (notificationActor !== workspace.employee.actor) {
    notificationActor = workspace.employee.actor;
    recentEvents = [];
    sharedEvents = [];
    lastEvent = null;
    updateNotifications();
  }
  $("#notifications").hidden = false;
  const focused = document.activeElement,
    existingRequest = $("#request") || retainedRequest, existingPlanning = $("#workPlanning"), existingWorkMemory=$("#workMemory"),
    existingJobRecord = $("#jobRecord"), existingJobComposer = $("#jobComposer"),
    currentActor=workspace.employee.actor, currentTeam=workspace.employee.team,
    onCatalog=page==="catalog" || page==="skills",
    matchingRequest=!freshComposer && existingRequest?.dataset.actor===currentActor && existingRequest.dataset.ownerTeam===currentTeam;
  const viewer=currentActor+"\n"+currentTeam;
  if (libraryViewer!==viewer) {
    libraryViewer=viewer;
    Object.assign(catalogFilter,{query:"",group:"all",favorites:false});
    workDocumentQuery="";
  }
  if (!onCatalog || catalogContext?.actor!==currentActor || catalogContext?.team!==currentTeam) catalogContext=null;
  retainedRequest=(onCatalog || (page==="work" && !shared)) && matchingRequest ? existingRequest : null;
  $("#main").innerHTML = shared ? '<article class="panel pad"><h1>'+esc(shared.title)+'</h1><p>共有者　'+esc(shared.sender)+
    ' ・ 第'+shared.version+'版</p><p class="doc-body">'+esc(shared.memo)+'</p></article>' : ticket ? inquiries.ticketDetail(ticket,location.hash) : job
    ? detail(job)
    : page === "home"
      ? home()
      : page === "jobs"
        ? jobsPage(current)
        : page === "work" ? workPage(current) : catalogPage();
  if ($("#planningRoot")) {
    const planning=existingPlanning?.dataset.actor === workspace.employee.actor && existingPlanning.dataset.team === workspace.employee.team
      ? existingPlanning : workPlanning(workspace,api,go);
    planning.refreshItems(workspace.schedules);
    $("#planningRoot").append(planning);
  }
  if (job?.distribution || job?.reservation) installDistribution($("#main"),job,api,reload);
  if (onCatalog) {
    refreshCatalog();
    if (focused?.id==="catalogSearch") $("#catalogSearch").focus();
    if (focused?.id==="catalogFavorites") $("#catalogFavorites").focus();
  }
  if ($("#workDocSearch")) {
    refreshWorkDocuments($("#workDocSearch"));
    if (focused?.id==="workDocSearch") $("#workDocSearch").focus();
  }
  if (existingWorkMemory && $("#workMemory")?.dataset.snapshot===existingWorkMemory.dataset.snapshot) {
    $("#workMemory").replaceWith(existingWorkMemory);
    if (existingWorkMemory.contains(focused)) focused.focus();
  }
  if (focused?.id.startsWith("work-nav-")) $(".workspace-subnav a[aria-current=page]")?.focus();
  restoreJobsSearch(focused);
  if (job && existingJobRecord?.dataset.job === job.id && $("#jobRecord")) $("#jobRecord").open = existingJobRecord.open;
  if (job && existingJobComposer?.dataset.job === job.id && existingJobComposer.dataset.version === $("#jobComposer")?.dataset.version) {
    for (const id of ["ask", "revise"]) {
      const oldForm = existingJobComposer.querySelector("#"+id), newForm = $("#"+id);
      if (!oldForm || !newForm) continue;
      for (const key of ["question","instruction","lineIndex"]) {
        if (oldForm.elements[key] && newForm.elements[key]) {
          newForm.elements[key].value = oldForm.elements[key].value;
          if (oldForm.elements[key] === focused) newForm.elements[key].focus({preventScroll:true});
        }
      }
    }
  }
  if (matchingRequest && $("#request")) {
    $("#request").replaceWith(existingRequest);
    if (existingRequest.contains(focused)) focused.focus();
  }
  const request = $("#request");
  if (request && existingRequest !== request) {
    refreshSources(request);
    const key = receiptKey(workspace.employee.actor);
    if (key) checkRequestReceipt(request, workspace.employee.actor, key);
  }
  if (request) {
    freshComposer=false;
    fillComposerProcedure(request);
    fillComposerDocument(request);
    updatePreferencePreview(request);
    refreshModelChoices(request);
  }
}
async function reload() {
  const legacyTarget = legacyRoutes.get(location.hash.slice(1));
  if (legacyTarget) history.replaceState(history.state, "", "#" + legacyTarget);
  // Preserve bookmarked section links from when the admin page lived at /.
  if (!$("#adminMenu").hidden && ["procedures", "memberships", "recoveries", "employee-history", "usage", "changes"].includes(route())) {
    location.replace("/admin.html" + location.search + location.hash);
    return;
  }
  clearTimeout(timer);
  const seq = ++generation,
    hash = location.hash,
    current = route();
  if (focusedReply !== hash) focusedReply=null;
  leavePreviousJob(current);
  try {
    const [ws, j,ticket,shared] = await Promise.all([
      api("/api/workspace"),
      current.startsWith("job/")
        ? api("/api/jobs/" + encodeURIComponent(current.slice(4)))
        : null,
      current.startsWith("inquiry/") ? api("/api/inquiries/"+encodeURIComponent(current.slice(8))) : null,
      current.startsWith("shared/") ? api("/api/shared/"+encodeURIComponent(current.slice(7))) : null,
    ]);
    if (seq !== generation || location.hash !== hash) return;
    workspace = ws;
    job = j;
    const target=hash.match(/\/reply\/(\d+)(?:\/round\/(\d+))?$/);
    const replyId=Number(target?.[1]);
    const reply=j?.inquiries.find(i=>i.id===replyId && i.answer);
    if (reply) openedVersion={job:j.id,version:reply.version};
    const version=Number(hash.match(/\/version\/(\d+)$/)?.[1]);
    if (j?.versions.some(v=>v.version===version)) openedVersion={job:j.id,version};
    const dailyView = current === "home" || current === "work/actions";
    const view = JSON.stringify([hash, ws, j, ticket, shared, dailyView ? japanInput(Date.now()).slice(0,10) : null]);
    if (view !== lastView) {
      display(ticket,shared);
      lastView = view;
    }
    if (reply && focusedReply!==hash) {
      const round=reply.followups.find(t=>t.number===Number(target?.[2]) && t.answer);
      $("#inquiry-answer-"+reply.id+(round ? "-"+round.number : ""))?.focus();
      focusedReply=hash;
    }
    const receiptRound=Number(hash.match(/^#inquiry\/\d+\/round\/(\d+)(?:\?from=\d+)?$/)?.[1]);
    if (ticket && receiptRound && focusedReply!==hash) {
      const turn=ticket.followups.find(t=>t.number===receiptRound && t.answer);
      if (turn) $("#inquiry-question-"+ticket.id+"-"+turn.number)?.focus();
      focusedReply=hash;
    }
    const opened = j?.status === "done" && ws.jobs.find(item => item.id === j.id);
    if (opened && opened.done_seq > opened.viewed_seq && !document.hidden)
      await api("/api/jobs/" + j.id + "/viewed",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({seq:opened.done_seq})});
    if (shared && ws.shared.some(item=>item.id===current.slice(7) && !item.seen) && !document.hidden) {
      await api("/api/shared/"+encodeURIComponent(current.slice(7))+"/read",{method:"POST"});
      updateNotifications();
    }
    if (seq !== generation || location.hash !== hash) return;
    notice("");
    const rows = j ? [j,...j.comparisons,...(j.distribution?.parts || [])] : ws.jobs;
    if (
      rows.some((x) => ["queued", "dispatching", "running", "split_waiting"].includes(x.status))
    )
      timer = setTimeout(reload, 1200);
    else if ((ticket && !ticket.resolution) || (current==="jobs" && ws.received_inquiries.length) || j?.inquiries.some(t=>!t.resolution && t.followups?.at(-1)?.answer===null) ||
      shared || dailyView || current==="jobs/reservations" ||
      rows.some(x => ["unknown","scheduled","source_waiting"].includes(x.status))) timer = setTimeout(reload, 5000);
  } catch (e) {
    if (seq !== generation || showDisabled(e)) return;
    lastView = null;
    notice(e.message);
    $("#main").innerHTML = button("ホームへ", "home");
    timer = setTimeout(reload, 5000);
  }
}
let notificationActor, recentEvents = [], sharedEvents = [], lastEvent = null, noticeRequest = 0;
const eventName = e => e.status === "source_deadline" ? "見積比較の待機期限を過ぎました" : e.status === "inquiry_answered" ? "受付票 #"+e.inquiry+(e.round ? " の追加質問（"+e.round+"回目）に再回答が届きました" : " に回答が届きました") : e.status === "reminder" ? "確認待ちのリマインダー" : e.status === "waiting" ? "確認待ち" : e.phase.startsWith("inquiry-") ? "問い合わせの起票案が完成" : e.phase.startsWith("actions-") ? "宿題候補の準備完了" : e.phase.startsWith("question-") ? "質問への回答" : e.phase.startsWith("revise-") ? "修正版が完成" : "仕事が完了";
function notificationList() {
  return (sharedEvents.map(item=>button("成果物の共有 ・ "+item.title+(item.seen ? "" : "（未読）"),"shared-link/"+item.id,"listbtn")).join("")+
    recentEvents.map(e => '<button type="button" class="listbtn" data-op="event/' + e.seq + '"><span class="listtext"><b>' +
    esc(eventName(e)) + (e.seen ? "" : "（未読）") + '</b><small>' + esc(e.ask) + '</small></span></button>').join("")) || '<p>新しい通知はありません。</p>';
}
async function updateNotifications() {
  if (!notificationActor) return;
  const seq = ++noticeRequest, actor = notificationActor;
  try {
    const [events,shares] = await Promise.all([api("/api/notifications"),api("/api/shared")]);
    if (seq !== noticeRequest || actor !== notificationActor) return;
    recentEvents = events;
    sharedEvents = shares;
    const unread = events.filter(e => !e.seen).length + shares.filter(item=>!item.seen).length;
    $("#notifications").textContent = unread ? "通知（" + unread + "）" : "通知";
    if ($("#eventList")) $("#eventList").innerHTML = notificationList();
    const enabled = "Notification" in window && Notification.permission === "granted" && localStorage.getItem("notify-" + actor) === "yes";
    if (enabled && document.hidden && lastEvent !== null) {
      for (const e of events.filter(e => e.seq > lastEvent && !e.seen).reverse()) {
        const n = new Notification(eventName(e), { body: e.ask, tag: "hub-" + actor + "-" + e.seq });
        n.onclick = () => { window.focus(); openEvent(e.seq); n.close(); };
      }
    }
    lastEvent = events[0]?.seq || 0;
  } catch (err) { if (seq === noticeRequest && actor === notificationActor) showDisabled(err); }
}
setInterval(updateNotifications, 7000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) reload(); });
async function openEvent(seq) {
  try {
    const {job:id,inquiry,round} = await api("/api/notifications/" + seq + "/read", {method:"POST"});
    if ($("#dialog").open) $("#dialog").close();
    focusedReply=null;
    go("job/" + id + (inquiry ? "/reply/"+inquiry+(round ? "/round/"+round : "") : ""));
    updateNotifications();
  } catch (error) { if (!showDisabled(error)) notice(error.message); }
}
async function searchJobs(field) {
  const query = field.value.trim();
  try {
    const matches = query ? await api("/api/jobs/search?q=" + encodeURIComponent(query)) : workspace.jobs;
    if (field.isConnected && field.value.trim() === query) {
      const rows = requestListFilter === "waiting" ? matches.filter(j=>j.status==="waiting") : matches;
      $("#jobResults").innerHTML = jobResults(rows, query);
      $('[data-op="delete-picker/jobs"]').hidden=!rows.length;
      $("#jobSearchStatus").textContent = query ? "検索結果 "+rows.length+"件" : rows.length+"件の依頼";
    }
  } catch (error) {
    if (field.isConnected && field.value.trim() === query && !showDisabled(error))
      $("#jobSearchStatus").textContent = error.message;
  }
}
function queueJobSearch(field) {
  requestListQuery = field.value;
  clearTimeout(requestSearchTimer);
  requestSearchTimer = setTimeout(() => { if (field.isConnected) searchJobs(field); }, 180);
}
document.addEventListener("input", e => {
  if (e.target.id === "jobSearch" && !e.isComposing) queueJobSearch(e.target);
  if (e.target.id === "catalogSearch") {
    catalogFilter.query=e.target.value;
    refreshCatalog();
  }
  if (e.target.id === "workDocSearch") {
    workDocumentQuery=e.target.value;
    clearTimeout(workSearchTimer);
    ++workDocumentRequest;
    if (!e.isComposing) workSearchTimer=setTimeout(()=>refreshWorkDocuments(e.target),180);
  }
});
document.addEventListener("compositionend", e => {
  if (e.target.id === "jobSearch") queueJobSearch(e.target);
  if (e.target.id === "workDocSearch") {
    clearTimeout(workSearchTimer);
    workSearchTimer=setTimeout(()=>refreshWorkDocuments(e.target),180);
  }
});
async function readCsv(file) {
  if (!file?.size || !/\.csv$/i.test(file.name) || file.size>5*1024*1024) throw Error("5 MB以内のCSVを1件選んでください。");
  const doc=await api("/api/attachments/preview?format=csv",{method:"POST",body:file});
  return {name:file.name,text:doc.text};
}
function modal(title, body) {
  $("#dlgtitle").textContent = title;
  $("#dlgbody").innerHTML = body;
  const dialog = $("#dialog");
  if (!dialog.open) dialog.showModal();
}
function deletionDialog(kind,id) {
  const jobs=kind==="jobs";
  const label=jobs ? "依頼" : "手順";
  const entries=jobs ? workspace.jobs.map(j=>({id:j.id,name:j.ask})) :
    catalogEntries().filter(item=>item.key.startsWith("personal:"));
  const prefix=jobs ? "job/" : "catalog/personal:";
  const container=jobs ? "#jobResults" : "#catalogResults";
  const visible=new Set(Array.from(document.querySelectorAll(container+' [data-op^="'+prefix+'"]'),
    row=>row.dataset.op.slice(prefix.length)));
  const choices=entries.filter(item=>id ? item.id===id : visible.has(item.id));
  if (!choices.length) return;
  const list=id ? '<p>'+esc(choices[0].name)+'</p>' : '<fieldset><legend>削除する'+label+'を選択</legend>'+
    choices.map(item=>'<label><input type="checkbox" value="'+esc(item.id)+'"> '+esc(item.name)+'</label>').join("")+'</fieldset>';
  modal(label+'を削除','<form id="deleteItems">'+list+'<p>削除すると元に戻せません。'+
    (jobs ? '開始前の予約も取り消されます。' : '')+'</p><p role="alert" class="form-error"></p>'+
    '<div class="actions"><button type="button" class="secondary" autofocus>キャンセル</button>'+
    '<button type="submit" class="primary"'+(id ? '' : ' disabled')+'>'+ (id ? '削除する' : '選択した項目を削除')+'</button></div></form>');
  const form=$("#deleteItems"),cancel=form.querySelector('[type="button"]'),submit=form.querySelector('[type="submit"]');
  const selected=()=>id ? [id] : Array.from(form.querySelectorAll("input:checked"),input=>input.value);
  cancel.focus();
  cancel.onclick=()=>$("#dialog").close();
  form.onchange=()=>{
    const count=selected().length;
    submit.disabled=!count;
    submit.textContent=count ? count+"件を削除する" : "選択した項目を削除";
  };
  form.onsubmit=async event=>{
    event.preventDefault();
    if (submit.disabled) return;
    const ids=selected();
    const fieldset=form.querySelector("fieldset");
    if (fieldset) fieldset.disabled=true;
    submit.disabled=true;
    try {
      const result=await api(jobs ? "/api/jobs/delete" : "/api/personal-procedures/delete",{
        method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids})});
      if (form.isConnected) $("#dialog").close();
      if (jobs && id && route().startsWith("job/")) go("jobs");
      else await reload();
      notice(result.deleted+"件の"+label+"を削除しました。");
    } catch (error) {
      if (fieldset) fieldset.disabled=false;
      form.querySelector('[role="alert"]').textContent=error.message;
      submit.disabled=false;
    }
  };
}
document.addEventListener("change", event => {
  if (event.target.id==="catalogFavorites") {
    catalogFilter.favorites=event.target.checked;
    refreshCatalog();
  }
  if (event.target.name === "frequency") {
    const monthly = event.target.value === "monthly", f = event.target.form;
    for (const [field,hide] of [[f.elements.weekday,monthly],[f.elements.month_day,!monthly]]) {
      field.disabled = hide; field.closest("label").hidden = hide;
    }
  }
  if (event.target.form?.id === "fileProject" && event.target.name === "project") {
    const field=event.target.form.elements.name; field.disabled=!!event.target.value; field.closest("label").hidden=field.disabled;
  }
  if (event.target.name === "timing") {
    const form=event.target.form;
    form.querySelector("[data-planned-time]").innerHTML = event.target.value === "once" ? dateField() : "";
    if (form.elements.contractFile) refreshSources(form);
  }
  if (event.target.id !== "memoVersion") return;
  history.replaceState(null,"","#job/"+job.id+"/version/"+event.target.value);
  openedVersion = {job:job.id,version:Number(event.target.value)};
  display();
  $("#memoVersion").focus();
});
function exportText(target) {
  const version=Number($("#memoVersion")?.value || 1);
  const references = job.sources.map(s => "[" + s.id + "] " + s.title + "（" + s.version + "）")
    .concat(versionReceipts(job,version).map(t=>"["+t.source_id+"] 受付票 #"+t.id+(t.round ? " 再回答（"+t.round+"回目）" : "")+"　"+t.subject)).join("\n");
  const text=target.classList.contains("quote-table") ? job.versions.find(v=>v.version===1).memo : target.innerText;
  return text + "\n\n出典\n" + references;
}
async function copyMemo(target) {
  const feedback = $("#copyStatus");
  try {
    await navigator.clipboard.writeText(exportText(target));
    feedback.textContent = "出典付きでコピーしました。";
  } catch {
    feedback.textContent = "コピーできませんでした。ブラウザーの設定を確認してください。";
  }
}
if ("CommandEvent" in window) {
  document.addEventListener("command", e => {
    if (e.command === "--copy" && e.target.id === "memoText") copyMemo(e.target);
  }, true);
} else {
  document.addEventListener("click", e => {
    if (e.target.closest('button[command="--copy"]')) copyMemo($("#memoText"));
  });
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-op]");
  if (!b) return;
  const op = b.dataset.op;
  if (op.startsWith("delete-picker/") || op.startsWith("delete-one/")) {
    const [,kind,id]=op.split("/");
    deletionDialog(kind,id);
    return;
  }
  if (op.startsWith("request-filter/")) {
    requestListFilter = op.split("/")[1];
    if (!$("#jobSearch")) return;
    document.querySelectorAll(".request-filters [aria-current]").forEach(tab=>tab.removeAttribute("aria-current"));
    b.setAttribute("aria-current","page");
    searchJobs($("#jobSearch"));
    return;
  }
  if (op === "jump-result") {
    e.preventDefault();
    $("#jobArtifact").focus();
    return;
  }
  if (b.closest("#workspaceNav")) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setMenu(false);
    go(op);
    $("#main").focus({preventScroll:true});
    return;
  }
  if (op==="profile") {
    if (!workspace) return;
    try {showProfile((await api("/api/profile")).preferences);}
    catch(error) {if (!showDisabled(error)) notice(error.message);}
    return;
  }
  if (op.startsWith("remember-answer/")) {
    const version=Number(op.slice("remember-answer/".length));
    if (workspace.memory_enabled && job && acceptsJobFollowup(job) && job.versions.some(item=>item.version===version))
      showAnswerPreference(job,version);
    return;
  }
  if (op.startsWith("catalog-filter/")) {
    catalogFilter.group=op.slice("catalog-filter/".length);
    for (const filter of b.parentElement.children) filter.setAttribute("aria-pressed",String(filter===b));
    refreshCatalog();
    return;
  }
  if (op==="clear-document") {
    clearComposerDocument(b.form,true);
    refreshSources(b.form);
    b.form.elements.ask.focus();
    return;
  }
  if (op.startsWith("work-document/") || op.startsWith("ask-document/")) {
    const params=new URLSearchParams(op.slice(op.indexOf("/")+1)), from=location.hash;
    b.disabled=true;
    try {
      const doc=await api("/api/workspace/document?"+params);
      if (location.hash!==from) return;
      if (op.startsWith("work-document/")) modal(doc.name,'<p class="meta">'+esc([doc.folder,doc.scope].filter(Boolean).join(" ・ "))+'</p>'+
        '<p class="doc-body">'+esc(doc.text)+'</p><div class="actions">'+
        button("この資料に質問","ask-document/"+workDocumentParams(doc.library,doc.name),"primary")+'</div>');
      else {
        composerDocument={library:doc.library,name:doc.name};
        freshComposer=true;
        if ($("#dialog").open) $("#dialog").close();
        go("home");
      }
    } catch(error) { if (!showDisabled(error) && location.hash===from) notice(error.message); }
    finally { b.disabled=false; }
    return;
  }
  if (op.startsWith("catalog/") || op.startsWith("start-catalog/") || op.startsWith("carry-catalog/") ||
      op.startsWith("favorite-catalog/") || op.startsWith("apply-catalog-entry/")) {
    const key=op.slice(op.indexOf("/")+1), item=catalogEntries().find(entry=>entry.key===key);
    if (!item) return;
    if (op.startsWith("catalog/")) showCatalogEntry(item);
    else if (op.startsWith("start-catalog/") || op.startsWith("carry-catalog/")) {
      const keepAsk=op.startsWith("carry-catalog/");
      composerProcedure={key,keepAsk};
      $("#dialog").close();
      if (keepAsk && route()==="home" && $("#request")) fillComposerProcedure($("#request"));
      else {
        freshComposer=!keepAsk;
        if (route()==="home") lastView=null;
        go("home");
      }
    } else if (op.startsWith("apply-catalog-entry/")) {
      if (catalogContext?.eligible.some(entry=>entry.key===key && entry.version===item.version))
        showApplyCatalog(catalogContext,key);
    } else {
      b.disabled=true;
      try {
        await api("/api/procedure-favorites",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({entry:key,selected:!workspace.favorites.includes(key)})});
        await reload();
        const updated=catalogEntries().find(entry=>entry.key===key);
        if ($("#dialog").open && updated && $("#dlgtitle").textContent===item.name) {
          showCatalogEntry(updated);
          $('#dlgbody [data-op^="favorite-catalog/"]').focus();
        }
      } catch(error) {if (!showDisabled(error)) notice(error.message);}
      finally {b.disabled=false;}
    }
    return;
  }
  if (op.startsWith("consultation-catalog/")) {
    const version=Number(op.slice("consultation-catalog/".length));
    if (!job?.versions.some(item=>item.version===version)) return;
    catalogContext={...consultationCatalog(job,version),instruction:b.form.elements.instruction.value};
    $("#dialog").close();
    go("catalog");
    return;
  }
  if (op.startsWith("apply-catalog/")) {
    const version=Number(op.slice(14));
    if (job?.versions.some(item=>item.version===version)) showApplyCatalog(consultationCatalog(job,version));
    return;
  }
  if (op === "request-settings") {
    const panel = $("#requestOptions");
    panel.hidden = !panel.hidden;
    b.setAttribute("aria-expanded", String(!panel.hidden));
    return;
  }
  if (op === "check-request") {
    const actor = workspace.employee.actor;
    const key = receiptKey(actor);
    if (key) await checkRequestReceipt(b.form, actor, key);
    return;
  }
  const inquiryAction = inquiries.actionFor(op);
  if (inquiryAction) {
    await inquiryAction(b,job,workspace.inquiry_desks);
    return;
  }
  if (op.startsWith("next-occurrence/")) {
    const id=op.split("/")[1];
    try {
      const o=await api("/api/schedules/"+id+"/next");
      modal(o.name+"の次回分",'<form id="occurrence" data-id="'+id+'" data-slot="'+o.slot+'" data-revision="'+o.revision+'">'+
        dateField(japanInput(o.run_at))+(o.csv ? '<p>'+esc(o.file ? "登録済み　"+o.file : "この回のCSVは未登録です。")+'</p><label for="slotCsv">この回のCSV</label><input id="slotCsv" type="file" name="file" accept=".csv" '+(o.file ? '' : 'required')+'>' :
        '<fieldset><legend>現時点で使う予定の仕事</legend><p>今回除く仕事のチェックを外してください。</p>'+
        '<div data-occurrence-sources>'+occurrenceSources(o.sources,new Set(o.excluded))+'</div>'+
        '</fieldset>')+'<div class="actions"><button class="primary" value="change">今回の変更を保存</button><button class="secondary" value="skip" formnovalidate>今回は休む</button></div><p class="form-error" role="alert"></p></form>');
    } catch(error) { if (!showDisabled(error)) notice(error.message); }
    return;
  }
  if (op === "file-project") {
    modal("案件に整理",'<form id="fileProject" data-job="'+esc(job.id)+'"><label class="formlabel">案件<select name="project"><option value="">新しい案件</option>'+
      workspace.projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join("")+'</select></label>'+
      '<label class="formlabel">新しい案件名<input name="name" maxlength="80" required></label><button class="primary">案件に追加</button><p class="form-error" role="alert"></p></form>');
    return;
  }
  if (op.startsWith("project/")) {
    try {
      const p=await api("/api/projects/"+op.split("/")[1]);
      const work=p.jobs.map(j=>button(j.ask,"job/"+j.id,"listbtn")).join("");
      const docs=p.jobs.flatMap(j=>j.sources.map(s=>button(s.title+"（"+j.ask+"）","project-source/"+j.id+"/"+s.id,"listbtn"))).join("");
      const facts=p.jobs.map(j=>({j,facts:meetingDecisions(j.memo)})).filter(item=>item.facts).slice(0,5);
      const shared=p.shares.map(item=>button(item.title+" ・ 第"+item.version+"版","shared/"+item.id,"listbtn")).join("");
      modal(p.name,'<p>責任者　'+esc(p.responsible_name)+' ・ 期限　'+esc(p.due || "設定なし")+'</p>'+projectEditor(p)+
        "<h3>直近の決定事項</h3>"+(facts.map(({j,facts})=>'<article><b>'+esc(j.ask)+'</b><p class="note">'+esc(facts)+'</p>'+
        button("会議メモの該当版","origin/"+j.id+"/"+j.version,"link")+'</article>').join("") || "<p>決定事項を記載した会議メモはありません。</p>")+
        "<h3>未完了の宿題</h3>"+(actionRows(p.actions)||"<p>未完了の宿題はありません。</p>")+"<h3>関連する依頼</h3>"+
        (work || "<p>この案件に追加した依頼はありません。</p>")+"<h3>資料</h3>"+(docs || "<p>この案件の依頼に参照資料はありません。</p>")+
        (shared ? "<h3>共有された成果物</h3>"+shared : ""));
    } catch(error) { if (!showDisabled(error)) notice(error.message); }
    return;
  }
  if (op.startsWith("project-source/")) {
    const [,id,n]=op.split("/");
    try {
      const j=await api("/api/jobs/"+id), s=j.sources.find(s=>s.id===Number(n));
      if (!s) throw Error("出典が見つかりません。");
      modal(s.title,sourceExcerpt(s,""));
    } catch(error) { if (!showDisabled(error)) notice(error.message); }
    return;
  }
  if (op.startsWith("origin/")) {
    const [,id,version] = op.split("/");
    if ($("#dialog").open) $("#dialog").close();
    openedVersion = {job:id,version:Number(version)};
    lastView = null;
    go("job/" + id);
    return;
  }
  if (op.startsWith("action-toggle/")) {
    const item = workspace.actions.find(a => a.id === op.split("/")[1]);
    b.disabled = true;
    try {
      await api("/api/meeting-actions/" + item.id,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({done:!item.done})});
      if ($("#dialog").open) $("#dialog").close();
      await reload();
    } catch (error) { if (!showDisabled(error)) notice(error.message); }
    finally { b.disabled = false; }
    return;
  }
  if (op.startsWith("candidates/")) {
    const version = Number(op.split("/")[1]), set = job.candidate_sets.find(s=>s.version===version);
    if (!set) {
      b.disabled = true;
      try {
        await api("/api/jobs/"+job.id+"/candidates",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({version})});
        await reload();
      } catch (error) { if (!showDisabled(error)) notice(error.message); } finally { b.disabled=false; }
      return;
    }
    const items = set.items.map((a,i) => {
      const fullDate = a.due_text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
      const due = fullDate ? fullDate.slice(1).map(v=>v.padStart(2,"0")).join("-") : a.due_text;
      return '<fieldset><legend><label><input type="checkbox" name="candidate" value="'+i+'"> '+esc(a.line)+'</label></legend>' +
        '<p>[' + a.source + '] ' + esc(a.quote) + '</p><label class="formlabel">担当者<input name="assignee" maxlength="80" value="'+esc(a.assignee)+'"></label>' +
        '<label class="formlabel">期限'+(a.due_text ? '（原文 '+esc(a.due_text)+'）':'')+'<input type="date" name="due" value="'+
        (/^\d{4}-\d{2}-\d{2}$/.test(due) ? due : "")+'"></label></fieldset>';
    }).join("");
    modal("宿題候補を確認", items ? '<form id="registerCandidates" data-job="'+esc(job.id)+'" data-version="'+version+'">'+items+
      '<button class="primary">選んだ宿題を登録</button><p class="form-error" role="alert"></p></form>' : '<p>この版に宿題候補はありません。</p>');
    return;
  }
  if (op.startsWith("track/")) {
    const version = Number(op.split("/")[1]), memo = job.versions.find(v => v.version === version);
    modal("会議の宿題を登録",'<form id="trackAction" data-job="' + esc(job.id) + '" data-version="' + version + '">' +
      '<label class="formlabel">メモから選ぶ<select name="line">' + memo.memo.split("\n").map(s => s.trim()).filter(Boolean)
        .map(s => '<option>' + esc(s) + '</option>').join("") + '</select></label>' +
      '<label class="formlabel">担当者<input name="assignee" maxlength="80" required value="' + esc(workspace.employee.name) + '"></label>' +
      '<label class="formlabel">期限<input name="due" type="date" required></label><button class="primary">宿題を保存</button>' +
      '<p class="form-error" role="alert"></p></form>');
    return;
  }
  if (op === "compare-documents") {
    const inputs = ["旧版","新版"].map((label,i) => '<fieldset><legend>' + label + '</legend><label class="formlabel">資料名<input name="documentName" maxlength="200" required value="' +
      label + '"></label><label class="formlabel">ファイルから読み込む<input type="file" data-edition="' + i + '" accept=".pdf,.docx,.txt,.md"></label>' +
      '<label class="formlabel">比較する本文<textarea class="field" rows="5" name="documentText" maxlength="12000" required></textarea></label></fieldset>').join("");
    modal("新旧資料を比較",'<form id="compareDocuments" data-key="' + crypto.randomUUID() + '">' + inputs +
      '<label class="formlabel">依頼内容<textarea name="ask" maxlength="4000" required>日付・金額・担当者などの変更箇所を、旧版と新版の出典付きで整理して。</textarea></label>' +
      '<button class="primary">この2資料を比較</button><p class="form-error" role="alert"></p></form>');
    return;
  }
  if (op.startsWith("report-diff/")) {
    const origin=job.id;
    let ordered;
    try { ordered=await api("/api/jobs/"+origin+"/previous-reports"); }
    catch(error) { if (!showDisabled(error)) notice(error.message); return; }
    if (job?.id !== origin) return;
    modal("前回からの変化",ordered.length ? '<form id="reportDiff" data-key="'+crypto.randomUUID()+'" data-job="'+esc(job.id)+'" data-version="'+Number(op.split("/")[1])+'">'+
      '<label class="formlabel">前回の報告<select name="previous">'+ordered.map(j=>'<option value="'+j.id+'" data-version="'+j.memo_version+'">'+(j.same_schedule ? '同じ定期実行 ・ ' : '')+esc(j.ask)+'（'+plannedTime(j.created)+'・第'+j.memo_version+'版）</option>').join("")+'</select></label>'+
      '<p>今回　'+esc(job.ask)+'（第'+Number(op.split("/")[1])+'版）</p><button class="primary">変化をまとめる</button><p class="form-error" role="alert"></p></form>' : '<p>比較できる以前の成果物はありません。</p>');
    return;
  }
  if (op === "combine-work") {
    const items = workspace.jobs.filter(j => j.status === "done" && j.permitted);
    modal("複数の仕事から依頼", '<form id="combineWork" data-key="' + crypto.randomUUID() + '"><fieldset><legend>資料に使う成果物（最大12件）</legend>' +
      items.map(j => '<label><input type="checkbox" name="work" value="' + esc(j.id) + '" data-version="' + j.memo_version + '"> ' +
        esc(j.ask) + '（第' + j.memo_version + '版）</label>').join("<br>") + '</fieldset>' +
      '<label class="formlabel">依頼内容<textarea name="ask" maxlength="4000" required>選んだ仕事から案件の進捗をまとめてください。</textarea></label>' +
      '<button class="primary">選んだ成果物で依頼</button><p class="form-error" role="alert"></p></form>');
    return;
  }
  if (op === "save-request-draft") {
    const form = b.form, data = new FormData(form), file = attachments.get(form);
    if (!form.elements.contractFile.reportValidity() || (file && !file.text)) {
      notice("添付資料の読み込みを確認してください。"); return;
    }
    const content = {kind:data.get("kind") || "renewal", ask:data.get("ask") ?? workspace.employee.company + "の更新商談を準備して",
      minutes:data.get("minutes"),output_format:data.get("outputFormat"),planned_time:data.get("scheduledAt"),
      procedure_id:form.dataset.procedure || (form.id === "reuse" && form.dataset.id !== workspace.skill?.id ? form.dataset.id : null)};
    if (file) content.contract = {name:file.name,text:file.text};
    if (data.has("library")) content.library_ids=data.getAll("library");
    const document=selectedLibraryDocument(form,data);
    if (document) content.library_document=document;
    if (file?.second_attachment) content.second_attachment=file.second_attachment;
    form.dataset.draftId ||= crypto.randomUUID();
    b.disabled = true;
    try {
      const result = await api("/api/request-drafts/" + form.dataset.draftId,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({revision:Number(form.dataset.revision || 0),content})});
      form.dataset.revision = result.revision;
      if ($("#dialog").open) $("#dialog").close();
      go("jobs");
    } catch (error) { if (!showDisabled(error)) notice(error.message); }
    finally { b.disabled = false; }
    return;
  }
  if (op.startsWith("request-draft/")) {
    try {
      const d = await api("/api/request-drafts/" + op.split("/")[1]);
      reuseDialog("依頼の下書き",d,d.output_format);
      const f = $("#repeat");
      f.dataset.draftId = d.id; f.dataset.revision = d.revision;
      f.elements.minutes.value = d.minutes || "";
      if (d.contract) attachments.set(f,{...d.contract,second_attachment:d.second_attachment,status:[d.contract,d.second_attachment].filter(Boolean).map(doc=>doc.name).join("、")+"（保存済み）"});
      if (d.planned_time) {
        f.elements.timing.value = "once";
        f.querySelector("[data-planned-time]").innerHTML = dateField(d.planned_time);
      }
      refreshSources(f);
    } catch (error) { if (!showDisabled(error)) notice(error.message); }
    return;
  }
  if (op === "set-reminder") {
    modal("確認待ちの再通知",'<form id="questionReminder" data-job="' + esc(job.id) + '">' +
      dateField(job.reminder_at ? japanInput(job.reminder_at) : "").replace("実行予定日時","再通知日時") +
      '<button class="primary">再通知を設定</button><p class="form-error" role="alert"></p></form>');
    return;
  }
  if (op === "edit-reservation") {
    modal("予約日時を変更", '<form id="reschedule" data-job="' + esc(job.id) + '" data-previous="' + job.scheduled_at + '">' +
      dateField(japanInput(job.scheduled_at)) + '<button class="primary">変更を保存</button><p class="form-error" role="alert"></p></form>');
    return;
  }
  if (op === "cancel-job" || op.startsWith("schedule-toggle/")) {
    b.disabled = true;
    try {
      const schedule = workspace.schedules.find(s => s.id === op.split("/")[1]);
      if (op !== "cancel-job" && !schedule) return;
      await api(schedule ? "/api/schedules/" + schedule.id : "/api/jobs/" + job.id + "/cancel",
        {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(schedule ? {enabled:!schedule.enabled} : {})});
      await reload();
    } catch (err) { await reload(); if (!showDisabled(err)) notice(err.message); }
    finally { b.disabled = false; }
    return;
  }
  if (op.startsWith("template/")) {
    const t = workspace.templates.find(t => t.id === op.slice(9));
    if (t) reuseDialog(t.name, t, t.output_format);
    return;
  }
  if (op === "save-csv-skill") {
    const version=job.adopted_version ?? 1;
    const result=versionTool(job,version);
    const existing=workspace.templates.filter(template=>template.recipe);
    modal("集計条件を自分用に保存",'<form id="personalTemplate" aria-labelledby="dlgtitle"><input type="hidden" name="source_job" value="'+esc(job.id)+'">'+
      '<input type="hidden" name="source_version" value="'+version+'"><input type="hidden" name="base" value="">'+
      '<p>第'+version+'版の採用条件を新しいCSVで使います。</p>'+recipeDetails(result.recipe)+
      (existing.length ? '<label class="formlabel">保存先<select name="csvTarget"><option value="">新しい手順</option>'+
        existing.map(template=>'<option value="'+esc(template.id)+'">'+esc(template.name)+' ・ v'+template.version+'</option>').join("")+'</select></label>' : '')+
      '<label class="formlabel" for="csvName">手順名<input id="csvName" name="name" maxlength="80" required></label>'+
      '<button class="primary">自分用に保存</button><p class="form-error" role="alert"></p></form>');
    return;
  }
  if (op === "save-template") {
    const adopted=job?.adopted_version ?? (job?.versions.length===1 ? 1 : null);
    const selected=job?.versions.find(v=>v.version===adopted);
    const result=job ? versionTool(job,adopted) : null;
    const workflow=workspace.standardWorkflows?.find(item=>item.id===result?.workflow?.name && ["source-answer","document-draft"].includes(item.id));
    const options = [...(workspace.skill ? [{ ...workspace.skill, id:"renewal" }] : []), ...workspace.taskTypes];
    const standardProcedure=selected?.standard_procedure ?? job?.standard_procedure ?? workflow;
    const workflowDefaults=workflow?.id===standardProcedure?.id && workflow?.version===standardProcedure?.version ? workflow : null;
    modal("自分用の手順を保存", '<form id="personalTemplate"><label class="formlabel">手順名<input name="name" maxlength="80" required></label>' +
      (workflow ? '<p>'+esc(standardProcedure.name)+' ・ v'+esc(standardProcedure.version)+'</p><input type="hidden" name="source_job" value="'+esc(job.id)+
        '"><input type="hidden" name="source_version" value="'+adopted+'"><input type="hidden" name="source_workflow" value="'+esc(workflow.id)+'">' :
        '<label class="formlabel">依頼の種類<select name="kind">' + options.map(t => '<option value="' + esc(t.id) + '"' + (t.id === (job?.kind || "general") ? " selected" : "") + '>' + esc(t.name) + '</option>').join("") + '</select></label>') +
      '<label class="formlabel">毎回の依頼内容<textarea class="field" name="ask" required maxlength="4000">' + esc(workflowDefaults?.example || job?.ask || "") + '</textarea></label>' +
      '<label class="formlabel">出力形式<input name="output_format" maxlength="500" value="' + esc(workflowDefaults?.output || selected?.instruction || job?.output_format || "") + '"></label>' +
      '<div class="actions"><button class="primary">自分用に保存</button></div><p class="form-error" role="alert"></p></form>');
    return;
  }
  if (op.startsWith("template-schedule/")) {
    const t = workspace.templates.find(t => t.id === op.split("/")[1]);
    modal(t.name + "の定期実行",'<form id="templateSchedule" data-template="' + esc(t.id) + '">' +
      '<label class="formlabel">予定の名前<input name="name" required maxlength="80" value="' + esc(t.name) + '"></label>' +
      '<label class="formlabel">繰り返し<select name="frequency"><option value="weekly">毎週</option><option value="monthly">毎月</option></select></label>' +
      '<label class="formlabel">曜日<select name="weekday">' + weekdays.map((d,i) => '<option value="' + i + '">' + d + '曜日</option>').join("") + '</select></label>' +
      '<label hidden>実行日<select disabled name="month_day"><option value="0">月末</option>' + Array.from({length:31},(_,i) => '<option value="' + (i+1) + '">' + (i+1) + '日</option>').join("") + '</select></label>' +
      '<label class="formlabel">実行時刻（日本時間）<input type="time" name="time" required value="16:00"></label>' +
      (t.recipe ? '<p>「次回分を確認」からその回のCSVを登録してください。CSVを登録した回だけ集計します。</p>' : '<label class="formlabel">資料の対象期間<select name="window_days"><option value="7">直近7日間</option><option value="30">直近30日間</option></select></label>' +
      '<label class="formlabel">資料に使う完了した仕事<select name="source_kind"><option value="all">すべての用途</option><option value="renewal">更新商談</option>' +
      workspace.taskTypes.map(k => '<option value="' + esc(k.id) + '">' + esc(k.name) + '</option>').join("") + '</select></label>') +
      '<button class="primary">定期実行を登録</button><p class="form-error" role="alert"></p></form>');
    return;
  }
  if (op === "schedule-new") {
    modal("週報の定期実行", '<p>実行時点の直近7日間に完了した本人の依頼を使い、本人用の Hermes が週報の下書きを作成します。</p>' +
      '<form id="weeklySchedule"><label class="formlabel">名前<input name="name" maxlength="80" required value="週報"></label>' +
      '<div class="formlabel"><label for="weeklyDay">曜日</label><select id="weeklyDay" name="weekday">' + weekdays.map((d,i) => '<option value="' + i + '"' + (i === 5 ? ' selected' : '') + '>' + d + '曜日</option>').join("") + '</select></div>' +
      '<label class="formlabel">実行時刻（日本時間）<input name="time" type="time" required value="16:00"></label>' +
      '<label class="formlabel">依頼内容<textarea name="ask" class="field" required maxlength="4000">今週の仕事を完了・課題・来週の予定に分けて週報にまとめてください。</textarea></label>' +
      '<div class="actions"><button class="primary">定期実行を登録</button></div><p class="form-error" role="alert"></p></form>');
    return;
  }
  if (op.startsWith("shared-link/")) {
    if ($("#dialog").open) $("#dialog").close();
    go("shared/"+op.slice(12));
    return;
  }
  if (op === "sent-shares") {
    try {
      const shares=await api("/api/jobs/"+job.id+"/shares");
      modal("共有を管理",shares.map(share=>'<p>第'+share.version+'版 ・ '+esc(share.recipient)+' '+
        button("共有を取り消す","revoke-share/"+share.id,"secondary")+'</p>').join("") || "<p>現在有効な共有はありません。</p>");
    } catch(error) {if (!showDisabled(error)) notice(error.message);}
    return;
  }
  if (op.startsWith("revoke-share/")) {
    b.disabled=true;
    try {
      await api("/api/shared/"+op.slice(13)+"/revoke",{method:"POST"});
      b.closest("p").textContent="共有を取り消しました。";
    } catch(error) {if (!showDisabled(error)) notice(error.message);}
    finally {b.disabled=false;}
    return;
  }
  if (op.startsWith("share/") || op.startsWith("shared/")) {
    try {
      if (op.startsWith("shared/")) {
        const shared = await api("/api/shared/" + op.slice(7) + "/read",{method:"POST"});
        modal(shared.title, '<p>共有者　' + esc(shared.sender) + ' ・ 第' + shared.version + '版</p><p class="doc-body">' + esc(shared.memo) + '</p>');
      } else {
        const id = job.id, version = Number(op.slice(6)), selected = job.versions.find(v => v.version === version);
        const recipients = await api("/api/recipients");
        if (job?.id !== id) return;
        modal("共有内容の確認", '<p>第' + version + '版の本文を指定した相手に共有します。元の資料と会話は本人が確認できます。</p>' +
          '<p class="doc-body">' + esc(selected.memo) + '</p><form id="shareMemo" data-job="' + esc(id) + '" data-version="' + version + '">' +
          '<label class="formlabel">共有する相手<select name="recipient" required><option value="">相手を選択</option>' +
          recipients.map(r => '<option value="' + esc(r.actor) + '">' + esc(r.name) + '</option>').join("") + '</select></label>' +
          '<div class="actions"><button class="primary">この内容を共有する</button></div><p class="form-error" role="alert"></p></form>');
      }
    } catch (error) { if (!showDisabled(error)) notice(error.message); }
    return;
  }
  if (op === "notifications") {
    modal("通知", '<div id="eventList">' + notificationList() + '</div>' +
      ("Notification" in window ? button("ブラウザー通知を設定", "notify-permission", "secondary") : "") + '<p role="status" id="notifyResult"></p>');
    updateNotifications();
    return;
  }
  if (op === "notify-permission") {
    const key = "notify-" + notificationActor;
    if (localStorage.getItem(key) === "yes") {
      localStorage.removeItem(key);
      $("#notifyResult").textContent = "ブラウザー通知を停止しました。";
    } else {
      const permission = await Notification.requestPermission();
      if (permission === "granted") localStorage.setItem(key, "yes");
      $("#notifyResult").textContent = permission === "granted" ? "AI Hub を別タブで開いている間も通知します。" : "通知は AI Hub の通知一覧で確認できます。";
    }
    return;
  }
  if (op.startsWith("event/")) { await openEvent(op.slice(6)); return; }
  if (op === "repeat" || op.startsWith("repeat/")) {
    const current = location.hash;
    try {
      const id = op === "repeat" ? job.id : op.slice(7);
      const work = await api("/api/jobs/"+encodeURIComponent(id));
      if (location.hash !== current) return;
      const selected = work.versions.find(v => v.version === (work.adopted_version ?? work.versions.at(-1)?.version));
      reuseDialog("新しい依頼に使う", work, selected?.instruction || work.output_format);
    } catch (error) { if (!showDisabled(error) && location.hash === current) notice(error.message); }
    return;
  }
  if (op.startsWith("work-evidence/")) {
    const latest = await currentSourceJob();
    if (!latest) return;
    const version=displayedVersion(latest);
    const result=versionTool(latest,version);
    const item=result?.evidence[Number(op.split("/")[1])], source=latest.sources.find(s=>s.id===item?.source);
    if (!source) return;
    modal(source.title,item.ref ? libraryExcerpt(source,[item]) : sourceExcerpt(source,item.text));
    $("#dlgbody mark")?.focus(); return;
  }
  if (op.startsWith("quote-source/")) {
    const latest = await currentSourceJob();
    if (!latest) return;
    const [,row,col]=op.split("/"), cell=versionTool(latest,displayedVersion(latest))?.table?.rows[row].cells[col];
    const source=latest.sources.find(s=>s.id===cell?.source);
    if (!source) return;
    if (source.unavailable) { modal(source.title,sourceExcerpt(source,"")); return; }
    const start=cell.offset, end=start+cell.text.length;
    const marked=source.text.slice(start,end)===cell.text
      ? esc(source.text.slice(0,start))+'<mark tabindex="-1">'+esc(cell.text)+'</mark>'+esc(source.text.slice(end))
      : esc(source.text);
    modal(source.title,'<p class="note">'+marked+'</p>'); $("#dlgbody mark")?.focus(); return;
  }
  if (op === "export-memo") {
    const version = Number($("#memoVersion")?.value || 1);
    const text = "# " + memoTitle(job) + "（第" + version + "版）\n\n" + exportText($("#memoText")) + "\n";
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = job.company + "-メモ-v" + version + ".md";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return;
  }
  if (op.startsWith("quote-run/")) {
    const skill=workspace.quote_skills.find(s=>s.id===op.slice(10));
    if (!skill) return;
    quoteSkillDialog(skill);
    return;
  }
  if (op.startsWith("adopt/") || op.startsWith("adopt-quote/")) {
    try {
      await api("/api/jobs/" + job.id + "/adopt", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: Number(op.split("/")[1]),expected:job.adopted_version ?? job.versions.at(-1).version,save_quote_skill:op.startsWith("adopt-quote/") }) });
      await reload();
      notice(op.startsWith("adopt-quote/") ? "採用した比較基準を本人用のHermesが保存します。" : "表示中の版を採用しました。");
    } catch (error) { if (!showDisabled(error)) {await reload();notice(error.message);} }
    return;
  }
  if (op === "refresh") {
    await reload();
    return;
  }
  if (op === "resume") {
    b.disabled = true;
    try {
      await api("/api/jobs/" + job.id + "/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await reload();
    } catch (err) {
      if (!showDisabled(err)) notice(err.message);
    } finally {
      b.disabled = false;
    }
    return;
  }
  if (op === "draft") {
    const p = job.draft;
    if (p) {
      const submit = p.state === "draft" ? '<form id="submitDraft"><div class="actions"><button class="primary">管理者に公開を申請する</button></div></form>' : "";
      const instructions=p.layout==="quote-comparison" ? '<ul>'+JSON.parse(p.instruction).criteria.map(label=>'<li>'+esc(label)+'</li>').join("")+'</ul>' :
        '<p class="doc-body">'+esc(p.instruction)+'</p>';
      modal(p.name, '<p class="meta">' + esc(p.scope) + ' ・ ' + ({ draft: "個人の草案", pending: "管理者の確認待ち", published: "公開済み", revoked: "公開取消済み" })[p.state] +
        ' ・ v'+p.version+'</p>' + instructions + submit + '<p class="form-error" role="alert"></p>');
    } else if (job.kind==="assistant") {
      modal("見積比較をチームに共有",'<p>比較項目だけを公開用の草案にします。表示した版を管理者が確認します。</p>'+
        '<form id="makeDraft"><input type="hidden" name="layout" value="quote-comparison"><button class="primary">個人の草案に保存</button></form><p class="form-error" role="alert"></p>');
    } else {
      modal("完了した依頼から草案を作る",
        '<p>契約台帳と議事録を照合し、社員の判断を記す手順を保存します。案件の資料と回答は各社員が依頼するときに設定します。</p>' +
        '<form id="makeDraft"><label class="formlabel">メモの並び順<select name="layout"><option value="contract">契約条件を先に記載</option><option value="meeting">先方の希望を先に記載</option></select></label>' +
        '<div class="actions"><button class="primary">個人の草案に保存</button></div></form><p class="form-error" role="alert"></p>');
    }
    return;
  }
  if (op === "use" || op.startsWith("use/")) {
    const selected = op === "use" ? workspace.skill : [workspace.skill, ...workspace.procedures].find(p => p?.id === op.slice(4));
    if (!selected) return;
    modal(
      selected.name,
      '<p>' + esc(selected.scope) + ' ・ 公開版 v' + esc(selected.version) + '</p>' +
      (selected.instruction ? '<p class="doc-body">' + esc(selected.instruction) + '</p>' : '<ol class="steps"><li>契約条件と議事録を照合</li><li>不一致を依頼者に確認</li><li>資料の事実と社員の判断を分けて記録</li></ol>') +
      '<form id="reuse" method="post" data-id="' + esc(selected.id) + '"><label class="formlabel">対象案件<select name="company"><option>' +
        esc(workspace.employee.company) +
        '</option></select></label>' + minutesField("reuse") + '<div class="actions"><button class="primary">この手順で依頼する</button></div><p class="form-error" role="alert"></p></form>',
    );
  } else if (op === "compare-sources" || op.startsWith("compare-sources/")) {
    const selectedId = Number(op.split("/")[1]);
    const selectedPassage = $("#dlgbody mark")?.textContent || "";
    const latest = await currentSourceJob();
    if (!latest) return;
    modal("資料を並べて比較", '<div class="source-columns">' + latest.sources.map(s =>
      '<section><h3>[' + s.id + '] ' + esc(s.title) + '</h3>' + sourceExcerpt(s, s.id === selectedId ? selectedPassage : "") + '</section>').join("") + '</div>');
    $("#dlgbody mark")?.focus();
  } else if (op.startsWith("source/")) {
    const latest = await currentSourceJob();
    if (!latest) return;
    const s = latest.sources.find(x => x.id === Number(op.slice(7)));
    if (s?.edition && b.matches(".citation")) {
      const claim = comparisonContext(b);
      modal("変更箇所を比較",'<div class="source-columns">' + latest.sources.map(doc =>
        '<section><h3>' + esc(doc.version === doc.title ? doc.version : doc.version + ' ・ ' + doc.title) + '</h3>' + comparisonExcerpt(doc,claim) + '</section>').join("") + '</div>');
      $("#dlgbody mark")?.focus();
    } else if (s && latest.library_selection?.length && Number(b.dataset.sourceVersion || displayedVersion(latest))===1 && b.matches(".citation")) {
      modal(s.title,libraryExcerpt(s,latest.work_tool?.evidence || []));
      $("#dlgbody mark")?.focus();
    } else if (s) {
      const claim = b.matches(".citation") ? (b.previousSibling?.textContent || "").split("\n").at(-1).trim() : "";
      modal(s.title, sourceExcerpt(s, claim) +
        (latest.sources.length > 1 ? button("資料を並べて比較", "compare-sources/" + s.id, "secondary") : ""));
      $("#dlgbody mark")?.focus();
    }
  } else go(op);
});
document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (f.id==="saveAnswerPreference") {
    e.preventDefault();
    const submit=f.querySelector("button");
    if (submit.disabled) return;
    const content=f.elements.content.value.trim();
    if (f.dataset.sendContent!==content) {
      f.dataset.sendContent=content;
      f.dataset.requestKey=crypto.randomUUID();
    }
    submit.disabled=true;
    try {
      await api("/api/profile",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":f.dataset.requestKey},
        body:JSON.stringify({source_job:f.dataset.job,source_version:Number(f.dataset.version),content})});
      if (f.isConnected && $("#dialog").open) {
        modal("好みを保存しました",'<p>保存した内容は次の依頼から使われます。</p>'+
          '<a href="#work/memory">Hermesの記憶を開く</a>');
        $("#dlgbody a").focus();
      }
    } catch(error) {
      if (!showDisabled(error)) f.querySelector(".form-error").textContent=error.message;
    } finally {submit.disabled=false;}
    return;
  }
  if (f.matches(".preferenceForm")) {
    e.preventDefault();
    const submit=e.submitter || f.querySelector("button:not([type=button])");
    if (submit.disabled) return;
    const data=new FormData(f);
    submit.disabled=true;
    try {
      await api("/api/profile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
        ...(f.dataset.preference && {id:f.dataset.preference,revision:Number(f.dataset.revision)}),
        content:data.get("content"),project:data.get("project"),source_job:data.get("sourceJob"),deleted:submit.value==="delete",
      })});
      await reload();
      if ($("#dialog").open) showProfile(workspace.preferences);
    } catch(error) {if (!showDisabled(error)) f.querySelector(".form-error").textContent=error.message;}
    finally {submit.disabled=false;}
    return;
  }
  if (f.id==="applyCatalog") {
    e.preventDefault();
    const data=new FormData(f), submit=e.submitter || f.querySelector("button");
    if (submit.disabled) return;
    submit.disabled=true;
    const selected=f.elements.workflow.selectedOptions[0], procedureVersion=Number(selected.dataset.procedureVersion);
    const body=JSON.stringify({base:Number(f.dataset.version),latest:Number(f.dataset.latest),instruction:data.get("instruction"),
      ...(procedureVersion ? {catalog_procedure:{key:selected.value,version:procedureVersion}} : {standard_workflow:selected.value})});
    if (f.dataset.sendBody!==body) {
      f.dataset.sendBody=body;
      f.dataset.sendKey=crypto.randomUUID();
    }
    try {
      const result=await api("/api/jobs/"+f.dataset.job+"/revise",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":f.dataset.sendKey},body});
      $("#dialog").close();
      go("job/"+f.dataset.job+"/version/"+result.version);
    } catch(error) {if (!showDisabled(error)) f.querySelector(".form-error").textContent=error.message;}
    finally {submit.disabled=false;}
    return;
  }
  if (f.id==="projectSettings") {
    e.preventDefault();
    const data=new FormData(f), submit=e.submitter || f.querySelector("button");
    if (submit.disabled) return;
    submit.disabled=true;
    try {
      await api("/api/projects/"+f.dataset.project,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
        revision:Number(f.dataset.revision),responsible:data.get("responsible"),due:data.get("due"),reason:data.get("reason"),members:data.getAll("projectMember"),
      })});
      $("#dialog").close();
      await reload();
      notice("案件の変更を保存しました。");
    } catch(error) {if (!showDisabled(error)) f.querySelector(".form-error").textContent=error.message;}
    finally {submit.disabled=false;}
    return;
  }
  const inquirySubmission = inquiries.submissionFor(f.id);
  if (inquirySubmission) {
    e.preventDefault();
    await inquirySubmission(f,() => job);
    return;
  }
  if (f.id==="quoteRun") {
    e.preventDefault();
    const btn=e.submitter || f.querySelector("button");
    if (btn.disabled) return;
    btn.disabled=true;
    try {
      const [contract,second_attachment]=await Promise.all([f.elements.quote0.files[0],f.elements.quote1.files[0]].map(readAttachment));
      const body=JSON.stringify({company:workspace.employee.company,kind:"assistant",ask:"個人スキルの比較基準で今回の2社の見積を比較してください。",
        quote_skill_id:f.dataset.skill,contract,second_attachment});
      if (requestBody!==body) {requestBody=body; requestKey=crypto.randomUUID();}
      const result=await api("/api/jobs",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":requestKey},body});
      requestBody=null; $("#dialog").close(); go("job/"+result.id);
    } catch(error) {if (!showDisabled(error)) f.querySelector(".form-error").textContent=error.message;}
    finally {btn.disabled=false;}
    return;
  }
  if (f.id==="csvRun") {
    e.preventDefault();
    const btn=e.submitter || f.querySelector("button");
    if (btn.disabled) return;
    btn.disabled=true;
    const data=new FormData(f), file=data.get("file");
    try {
      const doc=await readCsv(file);
      const origin=f.dataset.origin ? {csv_reuse:{job:f.dataset.origin,version:Number(f.dataset.version)}} : {csv_template_id:f.dataset.template};
      const choice=data.get("csvOverride");
      const body=JSON.stringify({company:workspace.employee.company,kind:"assistant",ask:"保存した条件でCSVを集計してください。",...origin,
        ...(choice && {csv_override:{mode:choice,filter_column:data.get("csvColumn"),exclude_value:data.get("csvValue")}}),
        contract:doc,...(data.get("timing")==="once" && {scheduled_at:japanStamp(data.get("scheduledAt"))})});
      if (requestBody!==body) {requestBody=body; requestKey=crypto.randomUUID();}
      const result=await api("/api/jobs",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":requestKey},body});
      requestBody=null; $("#dialog").close(); go("job/"+result.id);
    } catch(error) { if (!showDisabled(error)) f.querySelector(".form-error").textContent=error.message; }
    finally {btn.disabled=false;}
    return;
  }
  if (f.id === "occurrence") {
    e.preventDefault();
    const submit=e.submitter; submit.disabled=true;
    try {
      const change={slot:Number(f.dataset.slot),revision:Number(f.dataset.revision),action:submit.value};
      if (change.action === "change") Object.assign(change,{run_at:japanStamp(f.elements.scheduledAt.value),
        excluded:[...f.querySelectorAll("input[name=include]:not(:checked)")].map(c=>c.value)});
      if (change.action==="change" && f.elements.file?.files[0]) change.contract=await readCsv(f.elements.file.files[0]);
      await api("/api/schedules/"+f.dataset.id+"/next",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(change)});
      $("#dialog").close(); await reload(); notice(change.action==="skip" ? "次回分を休みにしました。" : "次回分を変更しました。");
    } catch(error) { if (!showDisabled(error)) f.querySelector(".form-error").textContent=error.message; } finally {submit.disabled=false;}
    return;
  }
  if (["combineWork","compareDocuments","reportDiff"].includes(f.id)) {
    e.preventDefault();
    const refs = [...f.querySelectorAll("input:checked")].map(box => ({job:box.value,version:Number(box.dataset.version)}));
    if (f.id === "combineWork" && (!refs.length || refs.length > 12)) { f.querySelector(".form-error").textContent = "1〜12件の成果物を選んでください。"; return; }
    const btn = e.submitter; btn.disabled = true;
    try {
      const report = f.id === "reportDiff", previous = f.elements.previous?.selectedOptions[0];
      const sources = report ? {report_diff:true,work_refs:[{job:previous.value,version:Number(previous.dataset.version)},{job:f.dataset.job,version:Number(f.dataset.version)}]} : f.id === "combineWork" ? {work_refs:refs} : {compare_documents:[...f.querySelectorAll("fieldset")].map(group =>
        ({name:group.querySelector("[name=documentName]").value,text:group.querySelector("[name=documentText]").value}))};
      const result = await api("/api/jobs",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":f.dataset.key},
        body:JSON.stringify({kind:report ? "weekly" : "general",ask:report ? "前回の報告との変化をまとめて" : f.elements.ask.value,company:workspace.employee.company,...sources})});
      $("#dialog").close(); go("job/" + result.id);
    } catch (error) { if (!showDisabled(error)) f.querySelector(".form-error").textContent = error.message; }
    finally { btn.disabled = false; }
    return;
  }
  if (["reschedule","questionReminder"].includes(f.id)) {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      const stamp = japanStamp(f.elements.scheduledAt.value), reminder = f.id === "questionReminder";
      await api("/api/jobs/" + f.dataset.job + (reminder ? "/remind" : "/reschedule"),{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(reminder ? {due:stamp} : {previous_at:Number(f.dataset.previous),scheduled_at:stamp})});
      $("#dialog").close();
      await reload();
    } catch (error) { if (!showDisabled(error)) f.querySelector(".form-error").textContent = error.message; }
    finally { btn.disabled = false; }
    return;
  }
  if (["personalTemplate","weeklySchedule","shareMemo","fileProject","trackAction","registerCandidates","templateSchedule"].includes(f.id)) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f));
    let path = "/api/templates", message = "自分用の手順を保存しました。";
    if (f.id === "templateSchedule") {
      Object.assign(data,{template_id:f.dataset.template,window_days:Number(data.window_days || 7),month_day:Number(data.month_day || 0),weekday:Number(data.weekday || 0)});
    }
    if (["weeklySchedule","templateSchedule"].includes(f.id)) {
      path = "/api/schedules"; data.weekday = Number(data.weekday); message = "定期実行を登録しました。";
    }
    if (f.id === "fileProject") { path="/api/jobs/"+f.dataset.job+"/project"; message="案件に追加しました。"; }
    if (f.id === "registerCandidates") {
      path="/api/jobs/"+f.dataset.job+"/register-candidates"; data.version=Number(f.dataset.version);
      data.items=[...f.querySelectorAll("input:checked")].map(box=>{
        const group=box.closest("fieldset"); return {index:Number(box.value),assignee:group.querySelector("[name=assignee]").value,due:group.querySelector("[name=due]").value};
      }); message="選んだ宿題を登録しました。";
    }
    if (f.id === "trackAction") { path = "/api/jobs/" + f.dataset.job + "/track"; data.version = Number(f.dataset.version); message = "宿題を業務スペースの「承認・登録」に保存しました。"; }
    if (f.id === "shareMemo") {
      path = "/api/jobs/" + f.dataset.job + "/share"; data.version = Number(f.dataset.version); message = "指定した相手に共有しました。";
    }
    const submit = e.submitter || f.querySelector("button"); submit.disabled = true;
    try {
      await api(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
      $("#dialog").close(); await reload(); notice(message);
    } catch (error) { if (!showDisabled(error)) f.querySelector(".form-error").textContent = error.message; }
    finally { submit.disabled = false; }
    return;
  }
  if (["makeDraft", "submitDraft"].includes(f.id)) {
    e.preventDefault();
    const btn = f.querySelector("button");
    btn.disabled = true;
    try {
      const create = f.id === "makeDraft";
      await api("/api/jobs/" + job.id + (create ? "/draft" : "/submit-draft"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(create ? { layout: new FormData(f).get("layout") } : { hash: job.draft.hash }),
      });
      $("#dialog").close();
      await reload();
      if (create) document.querySelector('[data-op="draft"]')?.click();
    } catch (err) {
      if (!showDisabled(err)) $(".form-error").textContent = err.message;
    } finally { btn.disabled = false; }
    return;
  }
  if (!["request", "reuse", "repeat", "answer", "revise", "ask"].includes(f.id)) return;
  e.preventDefault();
  if (submitting) return;
  const data = new FormData(f),
    isAnswer = f.id === "answer", isRevision = f.id === "revise", isQuestion = f.id === "ask";
  const waits=data.get("timing")==="arrival";
  const formError=f.querySelector(".form-error");
  if (formError) formError.textContent="";
  if (f.dataset.libraryDocument && !selectedLibraryDocument(f,data)) {
    formError.textContent="指定した資料を現在の設定で参照できません。資料の指定を外すか、資料置き場を確認してください。";
    return;
  }
  if (waits && !attachments.get(f)?.text) {
    formError.textContent="先に届いた見積を1件添付してください。";
    f.elements.contractFile.focus();
    return;
  }
  const text = String(data.get(isAnswer ? "answer" : isRevision ? "instruction" : isQuestion ? "question" : "ask") || "").trim(),
    company = workspace.employee.company;
  if (f.id !== "reuse" && !text) {
    notice("内容を入力してください。");
    return;
  }
  const payload = isAnswer
    ? { answer: text }
    : isQuestion ? { version: Number(f.dataset.version), question: text }
    : isRevision ? { base: Number(f.dataset.base), latest: job.versions.at(-1).version, instruction: text, ...(data.get("lineIndex") && {line_index:Number(data.get("lineIndex"))}) }
    : {
        ...(f.dataset.draftId && {draft_id:f.dataset.draftId,draft_revision:Number(f.dataset.revision)}),
        ...(data.get("timing") === "once" && {scheduled_at:japanStamp(data.get("scheduledAt"))}),
        ...(waits && {arrival_wait:{library_id:data.get("arrivalLibrary"),name:data.get("arrivalName").trim(),deadline:japanStamp(data.get("arrivalDeadline"))}}),
        ...((data.get("outputFormat")?.trim() || f.dataset.outputFormat) && { output_format: data.get("outputFormat")?.trim() || f.dataset.outputFormat }),
        ...(f.dataset.procedure && { procedure_id: f.dataset.procedure }),
        ...(f.dataset.workflow && {standard_workflow:f.dataset.workflow}),
        ...(f.dataset.csvTemplate && {csv_template_id:f.dataset.csvTemplate}),
        ...(f.dataset.quoteSkill && {quote_skill_id:f.dataset.quoteSkill}),
        ...(f.dataset.personalTemplate && {personal_template:{id:f.dataset.personalTemplate,version:Number(f.dataset.personalTemplateVersion)}}),
        ...(data.get("skipProfile")==="on" && {skip_profile:true}),
        ...(data.get("profileProject") && {profile_project:data.get("profileProject")}),
        ...(data.get("dataClass") && {data_class:data.get("dataClass")==="general" ? "合成資料" : "限定合成資料"}),
        ...(data.get("modelRelease") && {model_release:Number(data.get("modelRelease"))}),
        ...(data.get("kind") && { kind: data.get("kind") }),
        ...(data.has("library") && {library_ids:data.getAll("library")}),
        ...(selectedLibraryDocument(f,data) && {library_document:f.dataset.libraryDocument}),
        ...(attachments.get(f)?.text && { contract: { name: attachments.get(f).name, text: attachments.get(f).text } }),
        ...(attachments.get(f)?.second_attachment && {second_attachment:attachments.get(f).second_attachment}),
        ...(data.get("minutes")?.trim() && { minutes: data.get("minutes").trim() }),
        ask: f.id === "reuse" ? company + "の更新商談を準備して" : text,
        company,
        ...(f.id === "reuse" && f.dataset.id !== workspace.skill?.id && { procedure_id: f.dataset.id }),
      };
  const body = JSON.stringify(payload);
  const receiptActor = f.id === "request" ? workspace.employee.actor : null;
  const storageKey = receiptActor && receiptStorageKey(receiptActor);
  const priorReceipt = receiptActor && receiptKey(receiptActor);
  if (priorReceipt && receiptLookup === priorReceipt) return;
  if (!isAnswer && requestBody !== body) {
    requestKey = crypto.randomUUID();
    requestBody = body;
  }
  const headers = { "Content-Type": "application/json" };
  if (!isAnswer) headers["Idempotency-Key"] = priorReceipt || requestKey;
  const submittedKey = receiptActor && (payload.draft_id ? "draft-" + payload.draft_id : headers["Idempotency-Key"]);
  const endpoint = isAnswer || isRevision || isQuestion
    ? "/api/jobs/" + job.id + "/" + f.id : "/api/jobs";
  submitting = true;
  const btn = e.submitter || f.querySelector('button:not([type="button"])');
  btn.disabled = true;
  if (storageKey) sessionStorage.setItem(storageKey, submittedKey);
  try {
    const result = await api(endpoint, { method: "POST", headers, body, ...(storageKey && {signal:AbortSignal.timeout(15000)}) });
    if (storageKey) {
      if (!result.id) throw Error("依頼の受付結果を読み取れません。");
      sessionStorage.removeItem(storageKey);
    }
    if ($("#dialog").open) $("#dialog").close();
    requestBody = null;
    if (isAnswer || isRevision || isQuestion) {
      f.reset();
      await reload();
    }
    else go("job/" + result.id);
  } catch (error) {
    if (showDisabled(error)) return;
    if (storageKey && (!error.httpStatus || error.httpStatus >= 500 || (priorReceipt && error.httpStatus === 409))) {
      await checkRequestReceipt(f, receiptActor, submittedKey);
      return;
    }
    if (storageKey && !priorReceipt) {
      sessionStorage.removeItem(storageKey);
      f.querySelector('[data-op="check-request"]').hidden = true;
    }
    const message = f.querySelector(".form-error");
    if (message) message.textContent = error.message;
    else notice(error.message);
  } finally {
    submitting = false;
    btn.disabled = false;
  }
});
document
  .querySelectorAll("[data-icon]")
  .forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
window.addEventListener("hashchange", () => {
  if ($("#dialog").open) $("#dialog").close();
  setMenu(false);
  reload();
  window.scrollTo(0, 0);
  $("#main").focus({preventScroll:true});
});
if (await verifyAccountSession()) reload();
