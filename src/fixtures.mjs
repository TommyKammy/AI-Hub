export const renewalTeam = "営業企画部";
export const employees = {
  sato: {
    name: "佐藤 由衣",
    initials: "YS",
    company: "A社",
    team: renewalTeam,
  },
  tanaka: {
    name: "田中 翔",
    initials: "ST",
    company: "B社",
    team: renewalTeam,
  },
};

// The prefix keeps admin workspaces distinct even for an account named "sato".
export const adminActor = account => "admin-" + account;

export function registerAdminWorkspaces(accountIds, roles = {}) {
  for (const account of accountIds) {
    employees[adminActor(account)] = {
      name: account,
      role: roles[account] ?? "auditor",
      initials: account.slice(0, 2).toUpperCase(),
      company: "A社",
      team: renewalTeam,
    };
  }
}

const dossiers = {
  A社: [
    [
      "契約台帳",
      "11月10日版・更新条件 §2",
      "現行契約の満了日は12月31日。更新後は利用状況を毎月報告する。",
    ],
    [
      "商談議事録",
      "11月17日版・更新条件",
      "先方は12月15日の更新を希望。購買部の承認日は未定。",
    ],
  ],
  B社: [
    [
      "契約台帳",
      "11月12日版・契約期間 §3",
      "現行契約の満了日は3月31日。更新後は四半期ごとに利用者数を確認する。",
    ],
    [
      "商談議事録",
      "11月18日版・契約条件",
      "先方は4月15日の更新を希望。調達部との調整日を次回確認する。",
    ],
  ],
};

export function sourcesFor(actor, company) {
  if (employees[actor]?.company !== company) return null;
  return dossiers[company].map(([title, version, text], i) => ({
    id: i + 1,
    title: company + " " + title,
    version,
    text,
  }));
}
