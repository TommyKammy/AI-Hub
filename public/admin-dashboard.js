const number = new Intl.NumberFormat("ja-JP");
const decimals = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 6 });
const stamp = new Intl.DateTimeFormat("ja-JP", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Tokyo" });
const status = { ok: "成功", error: "失敗", blocked: "送信前に拒否", unknown: "結果未確定", sending: "送信中" };
const html = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const yen = value => value === null ? "未算定" : money.format(value / 1_000_000) + " 円";
const costLabel = totals => totals.calls && !totals.settled_calls ? "未算定" : yen(totals.settled ?? 0);
const rate = metrics => metrics.successes + metrics.failures
  ? decimals.format(100 * metrics.successes / (metrics.successes + metrics.failures)) + "%" : "—";
const count = (value, unit) => number.format(value) + " " + unit;
const tokens = value => value === null ? "未計測" : number.format(value);
const elapsed = value => value === null ? "未計測" : count(value, "ms");
const requestLink = id => "./admin.html?" + new URLSearchParams({ job: id }) + "#usage";
const dateLabel = date => date.replaceAll("-", "/");
const reportUrl = options => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) if (value) query.set(key, value);
  return "./admin.html?" + query + "#usage-overview";
};
const currentReport = () => Object.fromEntries(new URLSearchParams(location.search));

const activeRequests = new WeakMap();
async function fetchReport(root, options, render) {
  activeRequests.get(root)?.abort();
  const controller = new AbortController();
  activeRequests.set(root, controller);
  root.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/api/admin/usage-report?" + new URLSearchParams(options), { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "利用記録を取得できませんでした。");
    if (!controller.signal.aborted) render(data);
  } catch (error) {
    if (controller.signal.aborted) return;
    root.innerHTML = '<p role="alert">' + html(error.message) + '</p><button type="button" class="secondary">再読み込み</button>';
    root.querySelector("button").onclick = () => fetchReport(root, options, render);
  } finally {
    if (activeRequests.get(root) === controller) root.removeAttribute("aria-busy");
  }
}

function options(entries, selected) {
  return entries.map(([key, label]) =>
    '<option value="' + html(key) + '"' + (String(key) === String(selected) ? " selected" : "") + '>' + html(label) + '</option>'
  ).join("");
}

function cards(items) {
  return '<dl class="ua-kpis">' + items.map(([label, value, unit = ""]) =>
    '<div><dt>' + html(label) + '</dt><dd>' + html(value) + (unit ? '<small>' + html(unit) + '</small>' : "") + '</dd></div>'
  ).join("") + '</dl>';
}

function monthPanel(month, to, canManage) {
  let ratio = "未設定";
  if (month.budget) {
    ratio = month.unpriced && !month.settled_calls && !month.pending_calls ? "未算定" :
      decimals.format(100 * (month.settled + month.pending) / month.budget.limit) + "%";
  }
  const from = month.month + "-01";
  return '<section class="ua-month" aria-label="今月の予算"><div><span>今月の概算費用</span><strong>' + costLabel(month) +
    '</strong><small>' + html(dateLabel(from) + " ～ " + dateLabel(to)) + '（日本時間）</small></div>' +
    '<div><span>予算消化率</span><strong>' + ratio + '</strong><small>' +
    (month.budget ? "月間上限 " + yen(month.budget.limit) : "月間上限は未設定") + '</small></div>' +
    '<div class="ua-month-actions"><a class="secondary" href="' + html(reportUrl({ view: "cost", from, to })) + '">今月の費用内訳 →</a>' +
    (canManage ? '<a href="#usage-policy">予算を変更</a>' : "") + '</div>' +
    '<small class="ua-month-note">概算費用は精算済みの合成評価額です。予算消化率には未精算の予約 ' + yen(month.pending) + '（' +
    count(month.pending_calls, "件") + '）を含みます。' +
    (month.unpriced ? "費用未算定 " + count(month.unpriced, "回") + "。" : "") + '</small></section>';
}

function dailyChart(data) {
  const byDay = new Map(data.daily.map(row => [row.day, row]));
  const date = new Date(data.from + "T00:00:00Z");
  const peak = Math.max(2, 2 * Math.ceil(Math.max(0, ...data.daily.map(row => row.calls)) / 2));
  const days = Array.from({ length: data.days }, () => {
    const day = date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + 1);
    const { calls = 0, failures = 0, uncertain = 0, blocked = 0 } = byDay.get(day) || {};
    const label = dateLabel(day) + "、" + count(calls, "回") + "、失敗 " + failures + "、結果未確定・送信中 " + uncertain +
      "、送信前に拒否 " + blocked;
    return '<a href="' + html(reportUrl({ from: day, to: day })) + '" title="' + html(label) + '" aria-label="' + html(label) +
      '" data-bar="' + 100 * calls / peak + '" data-failure="' + (calls ? 100 * failures / calls : 0) +
      '" data-uncertain="' + (calls ? 100 * uncertain / calls : 0) + '"><span><i></i><i></i></span></a>';
  });
  return '<div class="ua-plot"><div class="ua-scale" aria-hidden="true"><span>' + count(peak, "回") +
    '</span><span>' + number.format(peak / 2) + '</span><span>0</span></div><div class="ua-chart">' + days.join("") +
    '</div></div><div class="ua-axis"><span>' + html(data.from.slice(5)) + '</span><span>' + html(data.to.slice(5)) +
    '</span></div><p class="ua-key"><span>成功 ' + count(data.total.successes, "回") + '</span><span>失敗 ' +
    count(data.total.failures, "回") + '</span><span>結果未確定・送信中 ' + count(data.total.uncertain, "回") + '</span></p>';
}

export function loadDashboard(root, { canManage = false, days = 7, focus = false } = {}) {
  root.classList.add("ua");
  return fetchReport(root, { view: "dashboard", days }, data => {
    const { from, to, total, groups } = data;
    const ranked = groups.filter(row => row.calls);
    root.innerHTML = monthPanel(data.month, to, canManage) +
      '<div class="ua-tools"><p class="ua-period">' + html(dateLabel(from) + " ～ " + dateLabel(to)) +
      ' <small>日本時間</small></p><label>集計期間 <select id="dashboard-period">' +
      options([[7, "直近7日"], [30, "直近30日"]], days) + '</select></label></div>' +
      cards([["利用社員", number.format(total.users), "人"], ["依頼", number.format(total.jobs), "件"],
        ["モデル呼び出し", number.format(total.calls), "回"], ["呼び出し成功率", rate(total)]]) +
      '<div class="ua-split"><section><h2>日別の呼び出し</h2>' + dailyChart(data) + '</section><section><h2>部門別の呼び出し</h2>' +
      (ranked.length ? ranked.map(row => '<a class="ua-rank" href="' + html(reportUrl({ from, to, department: row.key })) +
        '" data-rank="' + 100 * row.calls / ranked[0].calls + '"><span>' + html(row.name) + '</span><b>' + count(row.calls, "回") +
        ' ›</b><i aria-hidden="true"></i></a>').join("") : '<p class="ua-note">利用記録はありません。</p>') + '</section></div>' +
      '<footer class="ua-foot"><small>業務依頼の利用記録を集計。送信前の拒否 ' + count(total.blocked, "回") +
      '。成功率は結果が確定した呼び出しが対象です。</small><a class="secondary" href="' + html(reportUrl({ from, to })) +
      '">期間の明細を見る →</a></footer>';
    for (const bar of root.querySelectorAll("[data-bar]")) {
      bar.style.setProperty("--bar", bar.dataset.bar + "%");
      bar.style.setProperty("--failure", bar.dataset.failure + "%");
      bar.style.setProperty("--uncertain", bar.dataset.uncertain + "%");
    }
    for (const rank of root.querySelectorAll("[data-rank]"))
      rank.style.setProperty("--rank", rank.dataset.rank + "%");
    const period = root.querySelector("#dashboard-period");
    period.onchange = () => loadDashboard(root, { canManage, days: Number(period.value), focus: true });
    if (focus) period.focus();
  });
}

function table(name, headers, rows) {
  if (!rows.length) return '<p class="ua-note">条件に一致する記録はありません。</p>';
  return '<div class="ua-scroll" role="region" aria-label="' + html(name) + '" tabindex="0"><table aria-label="' +
    html(name) + '"><thead><tr>' + headers.map(value => '<th scope="col">' + html(value) + '</th>').join("") +
    '</tr></thead><tbody>' + rows.map(([first, ...rest]) => '<tr><th scope="row">' + first + '</th>' +
      rest.map(value => '<td>' + value + '</td>').join("") + '</tr>').join("") + '</tbody></table></div>';
}

function analyticsFilters(data, filters) {
  const select = (name, label, entries) => '<label>' + label + '<select name="' + name + '">' +
    options([["", "すべて"], ...entries], filters[name]) + '</select></label>';
  return '<form class="ua-filters"><label>開始日（日本時間）<input required type="date" name="from" value="' + html(data.from) +
    '"></label><label>終了日（日本時間）<input required type="date" name="to" value="' + html(data.to) + '"></label>' +
    select("department", "部門", data.departments.map(value => [value, value])) +
    select("model", "モデル", data.models.map(({key, name}) => [key, name])) +
    select("outcome", "結果", Object.entries(status)) +
    '<div class="ua-filter-actions"><button class="secondary" type="submit">適用</button><a href="' +
    html(reportUrl({ view: filters.view, group: filters.group })) + '">条件をクリア</a></div></form>';
}

function detailReports(data, filters, cost) {
  const byDepartment = data.group === "department";
  const headers = [byDepartment ? "部門" : "モデル", ...(cost
    ? ["概算費用", "未精算の予約", "未算定", "依頼", "呼び出し"]
    : ["呼び出し", "利用社員", "依頼", "成功率", "平均処理時間", "計測済みトークン"])];
  const groups = data.groups.map(row => [
    '<a href="' + html(reportUrl({ ...filters, [data.group]: row.key, page: 0 })) + '">' + html(row.name) + '</a>',
    ...(cost
      ? [costLabel(row), yen(row.pending ?? 0), count(row.unpriced, "回"), number.format(row.jobs), number.format(row.calls)]
      : [number.format(row.calls), number.format(row.users), number.format(row.jobs), rate(row), elapsed(row.average_ms), tokens(row.tokens)]),
  ]);
  const calls = data.rows.map(row => [
    html(stamp.format(row.started)),
    row.job ? '<a href="' + html(requestLink(row.job)) + '">' + html(row.job) + '</a>' : "接続テスト",
    html(row.department),
    '<details><summary>' + html(row.model_name) + '</summary><dl class="ua-call-facts">' +
      [["照合ID", row.call_id], ["実行者ID", row.actor], ["工程", row.phase], ["設定版", row.version ?? "—"],
        ["要求モデル", row.requested], ["応答モデル", row.served ?? "記録なし"]]
        .map(([key, value]) => '<div><dt>' + key + '</dt><dd>' + html(value) + '</dd></div>').join("") + '</dl></details>',
    html(status[row.outcome] || row.outcome),
    ...(cost ? [yen(row.actual), yen(row.pending ?? 0)] : [elapsed(row.elapsed), tokens(row.total_tokens)]),
  ]);
  const offset = data.page * data.pageSize;
  const last = offset + data.rows.length;
  const pageLink = (page, label) => '<a class="secondary" href="' + html(reportUrl({ ...filters, page })) + '">' + label + '</a>';
  const jobs = cost && data.jobs.length ? '<h2>依頼ごとの費用（上位10件）</h2>' +
    table("依頼ごとの費用", ["依頼ID", "部門", "概算費用", "未精算の予約", "未算定"], data.jobs.map(row =>
      ['<a href="' + html(requestLink(row.job)) + '">' + html(row.job) + '</a>', html(row.department), costLabel(row),
        yen(row.pending ?? 0), count(row.unpriced, "回")])) : "";
  return '<div class="ua-tools"><h2>' + (cost ? "費用の内訳" : "利用内訳") +
    '</h2><label>集計単位 <select id="analytics-group">' + options([["department", "部門別"], ["model", "モデル別"]], data.group) +
    '</select></label></div>' + table("集計の内訳", headers, groups) + jobs +
    '<div class="ua-tools"><h2>呼び出し明細</h2><small>' +
    (last ? number.format(offset + 1) + "–" + number.format(last) + " / " : "") + count(data.total.records, "件") +
    '</small></div>' + table("呼び出し明細", ["時刻（日本時間）", "依頼ID", "部門", "モデル", "結果",
      ...(cost ? ["概算費用", "未精算の予約"] : ["処理時間", "トークン"])], calls) +
    '<div class="ua-foot">' + (offset ? pageLink(data.page - 1, "前へ") : "") +
    (last < data.total.records ? pageLink(data.page + 1, "次へ") : "") + '</div>';
}

export function loadAnalytics(root, filters = currentReport(), focus) {
  root.classList.add("ua");
  root.classList.remove("panel", "pad");
  const cost = filters.view === "cost";
  const safeFilters = Object.fromEntries(["from", "to", "department", "model", "outcome", "group", "page"]
    .filter(key => filters[key]).map(key => [key, filters[key]]));
  return fetchReport(root, { ...safeFilters, view: cost ? "cost" : "usage" }, data => {
    const applied = { ...safeFilters, view: cost ? "cost" : "usage", from: data.from, to: data.to, group: data.group };
    const total = data.total;
    root.innerHTML = '<div class="ua-modes" aria-label="分析対象">' + [["usage", "利用状況"], ["cost", "費用"]].map(([key, label]) =>
      '<a href="' + html(reportUrl({ ...applied, view: key, page: 0 })) + '"' +
      (key === applied.view ? ' aria-current="page"' : "") + '>' + label + '</a>').join("") + '</div>' +
      analyticsFilters(data, applied) +
      (cost ? cards([["期間内の概算費用", costLabel(total)], ["未精算の予約", yen(total.pending ?? 0)], [
        "業務依頼", number.format(total.jobs), "件"], ["費用未算定", number.format(total.unpriced), "回"]]) +
        '<p class="ua-note">合成評価額はポリシー版の単価と計測済みトークンから算定。予算に計上される接続テストを含みます。</p>' :
        cards([["モデル呼び出し", number.format(total.calls), "回"], ["失敗", number.format(total.failures), "回"],
          ["平均処理時間", elapsed(total.average_ms)], ["計測済みトークン", tokens(total.tokens)]]) +
        '<p class="ua-note">処理時間は ' + count(total.timed, "回") + '、トークン数は ' + count(total.measured, "回") +
        ' の計測値を集計。接続テストは対象外です。送信前の拒否 ' + count(total.blocked, "回") + '。</p>') +
      detailReports(data, applied, cost) + (cost ? data.month.alerts.map(alert =>
        '<p class="ua-note">今月のしきい値到達 ' + html(stamp.format(alert.time)) + '（日本時間） ／ v' + number.format(alert.policy) +
        ' ／ 精算と予約の合計 ' + yen(alert.amount) + '</p>').join("") : "");
    const form = root.querySelector("form");
    const update = (next, selector) => {
      history.replaceState(history.state, "", reportUrl(next));
      return loadAnalytics(root, next, selector);
    };
    form.oninput = () => form.elements.to.setCustomValidity("");
    form.onsubmit = event => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(form));
      if (fields.from > fields.to || Date.parse(fields.to) - Date.parse(fields.from) > 365 * 86_400_000) {
        form.elements.to.setCustomValidity("終了日を開始日から366日以内で選んでください。");
        form.elements.to.reportValidity();
        return;
      }
      void update({ ...applied, ...fields, page: 0 }, 'button[type="submit"]');
    };
    root.querySelector("#analytics-group").onchange = event =>
      update({ ...applied, group: event.target.value, page: 0 }, "#analytics-group");
    if (focus) root.querySelector(focus)?.focus();
  });
}
