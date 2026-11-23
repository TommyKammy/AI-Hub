const formats = ["image/png", "image/jpeg"];
const sizeLimit = 4 * 1024 * 1024;
const textFallback = "本文に画面の表示を入力して続けられます。";

export const screenshotFields = `
  <fieldset class="inquiry-screenshot">
    <legend>スクリーンショット（任意）</legend>
    <p id="screenshotHint" class="meta">この画面に1枚貼り付けるか、画像を選択してください。PNG・JPEG、4 MB以下。</p>
    <label for="inquiryScreenshot">画像を選択・差し替え</label>
    <input id="inquiryScreenshot" type="file" accept="image/png,image/jpeg" aria-describedby="screenshotHint">
    <div data-screenshot-controls hidden>
      <img alt="選択したスクリーンショット" hidden>
      <div class="actions">
        <button type="button" class="secondary" data-screenshot-remove>画像を取り除く</button>
        <button type="button" class="secondary" data-screenshot-analyze>画像から下書きを作る</button>
      </div>
      <p class="meta">画像は社内のローカルモデルで読み取ります。窓口には確認した文章が届きます。</p>
    </div>
    <p data-screenshot-status role="status"></p>
    <div data-screenshot-findings hidden>
      <label for="screenshotFindings">画像から読み取った表示</label>
      <textarea id="screenshotFindings" name="screen_findings" class="field" rows="3" maxlength="600"></textarea>
    </div>
  </fieldset>
  <label for="inquirySteps">ご自身が行った操作（任意）</label>
  <textarea id="inquirySteps" name="steps" class="field" rows="3" maxlength="1600"></textarea>`;

export function enableScreenshot(form, api, showDisabled) {
  const input = form.querySelector("#inquiryScreenshot");
  const status = form.querySelector("[data-screenshot-status]");
  const controls = form.querySelector("[data-screenshot-controls]");
  const preview = controls.querySelector("img");
  const remove = controls.querySelector("[data-screenshot-remove]");
  const analyze = controls.querySelector("[data-screenshot-analyze]");
  const findings = form.querySelector("[data-screenshot-findings]");
  const dialog = form.closest("dialog");
  let file, previewUrl, request, selection = 0;

  function clear() {
    request?.abort();
    request = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    file = previewUrl = null;
    preview.removeAttribute("src");
    preview.hidden = controls.hidden = findings.hidden = true;
    form.elements.screen_findings.value = "";
    analyze.disabled = false;
  }

  async function select(files) {
    if (!files.length) return;
    if (files.length !== 1 || !formats.includes(files[0].type)) {
      status.textContent = "PNGまたはJPEGの画像を1枚選んでください。" + textFallback;
      return;
    }
    const candidate = files[0];
    if (!candidate.size || candidate.size > sizeLimit) {
      status.textContent = "画像は4 MB以下を選んでください。" + textFallback;
      return;
    }
    const selected = ++selection;
    const url = URL.createObjectURL(candidate);
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
      if (image.naturalWidth > 4096 || image.naturalHeight > 4096) throw new Error();
      if (selected !== selection || !form.isConnected || !dialog.open || input.matches(":disabled")) return;
      clear();
      file = candidate;
      previewUrl = url;
      preview.width = image.naturalWidth;
      preview.height = image.naturalHeight;
      preview.src = url;
      controls.hidden = preview.hidden = false;
      status.textContent = "画像を選択しました。";
    } catch {
      if (selected === selection && form.isConnected && dialog.open)
        status.textContent = "画像を読み込めません。縦・横ともに4096ピクセル以下の画像を選んでください。" + textFallback;
    } finally {
      if (previewUrl !== url) URL.revokeObjectURL(url);
    }
  }

  input.addEventListener("change", () => {
    void select(Array.from(input.files));
    input.value = "";
  });
  dialog.addEventListener("paste", event => {
    if (!form.isConnected || input.matches(":disabled")) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    void select(files);
  }, {signal:setupLifetime(dialog, () => { selection++; clear(); })});
  remove.addEventListener("click", () => {
    selection++;
    clear();
    input.focus();
    status.textContent = "画像を取り除きました。";
  });
  analyze.addEventListener("click", async () => {
    if (!file || request) return;
    const pending = new AbortController();
    request = pending;
    analyze.disabled = true;
    status.textContent = "画像を読み取っています…";
    try {
      const result = await api("/api/jobs/"+form.dataset.job+"/inquiry/"+form.dataset.version+"/screenshot", {
        method:"POST", headers:{"Content-Type":file.type}, body:file, signal:pending.signal,
      });
      if (request !== pending || !dialog.open || !form.isConnected || input.matches(":disabled")) return;
      form.elements.screen_findings.value = result.findings;
      findings.hidden = false;
      status.textContent = "読み取った表示を確認し、必要に応じて修正してください。";
    } catch (error) {
      if (request === pending && dialog.open && form.isConnected && !showDisabled(error))
        status.textContent = error.httpStatus === 413 ? "画像は4 MB以下を選んでください。" + textFallback :
          error.httpStatus ? error.message : "画像を読み取れませんでした。" + textFallback;
    } finally {
      if (request === pending) {
        request = null;
        analyze.disabled = false;
        if (input.matches(":disabled")) status.textContent = "";
      }
    }
  });
}

function setupLifetime(dialog, cleanup) {
  const lifetime = new AbortController();
  dialog.addEventListener("close", () => {
    lifetime.abort();
    cleanup();
  }, {once:true});
  return lifetime.signal;
}
