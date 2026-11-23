export const changeLabels = {
  previous_release: "移行前の設定",
  register: "登録",
  publish: "標準モデルを公開",
  stop: "緊急停止",
  enable: "停止解除",
  restore: "標準設定を復元",
};

export const timestamp = (v) =>
  v
    ? new Date(v).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        hour12: false,
      })
    : "日時記録なし";

const memberActions = { transfer: "所属変更", responsibility: "担当変更", disable: "利用停止", enable: "再有効化",
  sync_enable: "ディレクトリの利用資格を再有効化", sync_disable: "ディレクトリの利用資格を停止" };
const auditActions = {
  employee: { ...memberActions, access: "利用状態の変更", "schedule-edit": "定期実行を変更", "schedule-create": "定期実行を作成", "runtime-change": "コンテナIDを変更" },
  model: { ...changeLabels, test: "接続テスト", "connection-profile-create": "接続設定を作成", "connection-profile-edit": "接続設定を変更" },
  procedure: { publish: "手順の公開", "preview-revision": "改訂案の確認", revise: "新版の公開", revoke: "公開取消" },
  job: { close_unconfirmed: "結果未確認で対応終了" },
  admin: { "GET /api/admin/memberships": "社員管理情報の閲覧", "GET /api/admin/models": "モデル台帳の閲覧",
    "POST /api/admin/models": "モデルの登録", "GET /api/admin/procedures": "手順の公開申請の閲覧" },
};

export function auditFields(event) {
  const applied = event.outcome === "applied";
  const scopeLabels = { group: "グループ", model_profile: "モデル接続", model: "モデル", procedure: "手順", admin: "管理API", job: "依頼" };
  const target = event.scope === "employee" && event.employee_name
    ? event.employee_name + "（" + event.target + "）"
    : [scopeLabels[event.scope], event.target].filter(Boolean).join(" ");
  const status = active => active ? "利用可能" : "利用停止中";
  const responsibility = value => value || "未設定";
  const changedResponsibility = event.before_responsibility !== event.after_responsibility;
  const transfer = (team, role) => changedResponsibility ? team + " ／ 担当 " + responsibility(role) : team;
  const before = event.action === "transfer" ? transfer(event.before_team, event.before_responsibility)
    : event.action === "responsibility" ? responsibility(event.before_responsibility) : status(event.before_active);
  const after = event.action === "transfer" ? transfer(event.after_team, event.after_responsibility)
    : event.action === "responsibility" ? responsibility(event.after_responsibility) : status(event.after_active);
  return {
    time: timestamp(event.time), operator: event.operator, target,
    action: auditActions[event.scope]?.[event.action] ?? event.action,
    outcome: applied ? "変更済み" : "拒否",
    before: event.before_value ?? (applied && !event.closure_job ? before : ""),
    after: event.after_value ?? (event.closure_job ? "結果未確認で対応終了" : applied ? after : ""),
    reason: applied ? event.reason : "管理操作の権限不足（HTTP 403）",
    stopped: applied && !event.closure_job && !event.change_reason ? event.stopped_jobs ?? 0 : "",
  };
}

export function exportHistoryFields(event) {
  const history = event.source === "history";
  const period = value => value ? value.replace("T", " ") : "指定なし";
  return {
    type: history ? "出力履歴のCSV保存" : "CSV出力",
    time: timestamp(event.started), exporter: event.exported_by,
    employee: event.employee ?? "すべて",
    operator: history ? "" : event.filter_operator ?? "すべて",
    outcome: history ? "" : ({ applied: "変更済み", denied: "拒否", closed_unconfirmed: "結果未確認で対応終了" }[event.outcome] ?? "すべて"),
    filterSource: history ? ({ audit: "監査ログのCSV出力", history: "出力履歴のCSV保存" }[event.filter_source] ?? "すべて") : "",
    filterExporter: history ? event.filter_exporter ?? "すべて" : "",
    from: period(event.from_jst), to: period(event.to_jst),
    count: event.completed === null ? "送信完了未確認" : event.row_count,
  };
}
