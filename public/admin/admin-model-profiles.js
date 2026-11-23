const api = "/api/admin/model-profiles";
const routes = {
  direct: "直接API",
  cloudflare: "Cloudflare AI Gateway",
  bedrock: "AWS Bedrock",
  compatible: "OpenAI互換API",
};
const providers = {openai:"OpenAI", anthropic:"Anthropic", gemini:"Gemini"};

export function installModelProfiles({open, request, escape}) {
  const section = document.querySelector("#modelProfiles");
  const buttons = section.querySelector("#modelProfileRoutes");
  const rows = section.querySelector("#modelProfileRows");
  const notice = section.querySelector("#modelProfileNotice");
  const dialog = document.querySelector("#dialog");
  let profiles = [];

  const options = (values, selected) => Object.entries(values).map(([id, title]) =>
    `<option value="${id}"${id === selected ? " selected" : ""}>${title}</option>`,
  ).join("");
  const field = (name, title, value = "", {length = 300, pattern, placeholder, type = "text"} = {}) =>
    `<label class="formlabel" for="model-profile-${name}">${title}<input id="model-profile-${name}" name="${name}" type="${type}" required
      autocomplete="off" spellcheck="false" maxlength="${length}" value="${escape(value)}"
      ${pattern ? `pattern="${pattern}"` : ""}${placeholder ? ` placeholder="${placeholder}"` : ""}></label>`;
  const reference = (name, title, value) => field(name, title, value, {length:128, pattern:"[A-Z][A-Z0-9_]{1,127}", placeholder:"例：HUB_MODEL_KEY"});

  function routeFields(route, settings) {
    const {config = {}, model_id} = settings;
    const routeOptions = [];
    if (route === "direct" || route === "cloudflare") routeOptions.push(
      `<label class="formlabel" for="model-profile-provider">プロバイダー<select id="model-profile-provider" name="provider">${options(providers, config.provider)}</select></label>`,
    );
    if (route === "direct" || route === "compatible") routeOptions.push(reference("key_ref", "APIキー（参照名）", config.key_ref));
    if (route === "cloudflare") routeOptions.push(
      field("account", "Cloudflare アカウントID（32桁の16進数）", config.account, {length:32, pattern:"[a-fA-F0-9]{32}"}),
      field("gateway", "Gateway ID", config.gateway, {length:63}),
      reference("token_ref", "Gateway トークン（参照名）", config.token_ref),
      field("alias", "Gateway に登録済みの BYOK エイリアス", config.alias || "default", {length:128}),
    );
    if (route === "bedrock") routeOptions.push(
      field("region", "AWS リージョン", config.region || "ap-northeast-1"),
      field("role", "引き受ける IAM ロール ARN", config.role),
    );
    if (route === "compatible") routeOptions.push(field("base_url", "HTTPS ベースURL", config.base_url,
      {type:"url", placeholder:"https://inference.example.com/v1"}));
    routeOptions.push(field("model_id", route === "bedrock" ? "モデルID または推論プロファイルのID・ARN" : "モデルID", model_id));
    return routeOptions.join("");
  }

  async function load() {
    profiles = await request("", undefined, api);
    rows.innerHTML = profiles.map(profile => `<article class="panel pad model-profile-row">
      <div><h3>${escape(profile.name)}</h3><p class="meta">${routes[profile.route]} ／ ${escape(profile.model_id)} ／ 下書き v${profile.revision}</p></div>
      <button type="button" class="secondary" data-model-profile="${profile.id}" aria-label="${escape(profile.name)}の接続設定を編集">接続設定</button>
      </article>`).join("") || '<p class="meta">保存した接続設定はありません。</p>';
  }

  function openProfile(route, previous) {
    const routeDrafts = new Map(previous ? [[route, previous]] : []);
    open(previous ? "接続設定を編集" : "接続設定を作成", `<form id="modelProfileForm" aria-labelledby="dlgtitle">
      ${field("name", "表示名", previous?.name, {length:80})}
      <label class="formlabel" for="model-profile-route">接続方式<select id="model-profile-route" name="route">${options(routes, route)}</select></label>
      <fieldset id="modelProfileFields"><legend>接続先とモデル</legend></fieldset>
      <p class="meta">認証情報にはシークレットの参照名を指定します。入力内容の確認は形式の検証までです。</p>
      <div class="actions"><button type="submit" class="secondary" value="check">設定を確認</button>
        <button type="submit" class="primary" value="save">${previous ? "変更を保存" : "下書きに保存"}</button></div>
      <p class="form-error" role="alert"></p><p class="meta" data-profile-check role="status"></p>
    </form>`);
    const form = dialog.querySelector("#modelProfileForm");
    const fields = form.querySelector("#modelProfileFields");
    const feedback = form.querySelector(".form-error");
    const check = form.querySelector("[data-profile-check]");
    function payload() {
      const {name, route, model_id, ...config} = Object.fromEntries(new FormData(form));
      return {name, route, model_id, config, ...(previous && {id:previous.id, revision:previous.revision})};
    }
    function clearMessages() {
      feedback.textContent = check.textContent = "";
    }
    function draw() {
      fields.innerHTML = '<legend>接続先とモデル</legend>' + routeFields(route, routeDrafts.get(route) || {});
    }
    form.addEventListener("input", clearMessages);
    form.elements.route.addEventListener("change", () => {
      routeDrafts.set(route, payload());
      route = form.elements.route.value;
      draw();
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const controls = [...form.querySelectorAll("button[type=submit]")];
      if (controls.some(control => control.disabled)) return;
      clearMessages();
      const data = payload();
      controls.forEach(control => { control.disabled = true; });
      try {
        if (event.submitter?.value !== "save") {
          const checked = await request("/check", data, api);
          if (form.isConnected && JSON.stringify(data) === JSON.stringify(payload()))
            check.textContent = "入力形式を確認しました。接続先：" + checked.target;
          return;
        }
        const saved = await request("", data, api);
        if (form.isConnected) dialog.close();
        notice.textContent = "接続設定の下書き v" + saved.revision + " を保存しました。";
        try {
          await load();
          rows.querySelector('[data-model-profile="'+saved.id+'"]')?.focus();
        } catch (error) { notice.textContent += " " + error.message; }
      } catch (error) { feedback.textContent = error.message; }
      finally { controls.forEach(control => { control.disabled = false; }); }
    });
    draw();
    form.elements.name.focus();
  }

  buttons.innerHTML = Object.entries(routes).map(([id, title]) =>
    `<li><button type="button" class="secondary" data-profile-route="${id}">${id === "direct" ? title + "（OpenAI・Anthropic・Gemini）" : title}</button></li>`,
  ).join("");
  buttons.addEventListener("click", event => {
    const button = event.target.closest("[data-profile-route]");
    if (button) openProfile(button.dataset.profileRoute);
  });
  rows.addEventListener("click", event => {
    const button = event.target.closest("[data-model-profile]");
    const profile = button && profiles.find(item => item.id === button.dataset.modelProfile);
    if (profile) openProfile(profile.route, profile);
  });
  return load;
}
