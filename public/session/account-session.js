const sessionChange = "aihub:session-change";
const networkError = "AI Hub に接続できませんでした。もう一度お試しください。";

function notifySessionChange() {
  try {
    localStorage.setItem(sessionChange, crypto.randomUUID());
  } catch {
    // Foreground checks also cover browsers that block local storage.
  }
}

async function sessionPost(action, payload) {
  const options = { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000) };
  if (payload) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(payload);
  }
  const response = await fetch("/api/session/" + action, options);
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || networkError), { status: response.status });
  return result;
}

function installMenu(trigger, panel) {
  const group = panel.firstElementChild;
  const actions = [...group.querySelectorAll("[data-account-action]")];
  const nativePopover = typeof panel.showPopover === "function";
  const nativeInvoker = nativePopover && "commandForElement" in HTMLButtonElement.prototype;
  const positionFallback = !nativePopover || !CSS.supports("position-area", "block-start");
  const isOpen = () => nativePopover ? panel.matches(":popover-open") : !panel.hidden;
  const available = () => actions.filter(action => !action.hidden && !action.disabled);
  let enterOnOpen;

  if (nativePopover) panel.hidden = false;
  else panel.removeAttribute("popover");

  function placeMenu() {
    if (!positionFallback || !isOpen()) return;
    const triggerBounds = trigger.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = panel;
    const mobile = matchMedia("(max-width: 680px)").matches;
    const preferredLeft = mobile ? triggerBounds.right - width : triggerBounds.left;
    const fitsAbove = triggerBounds.top >= height + 13;
    const fitsBelow = innerHeight - triggerBounds.bottom >= height + 13;
    const above = fitsAbove && (!mobile || !fitsBelow);
    const preferredTop = above ? triggerBounds.top - height - 5 : triggerBounds.bottom + 5;
    panel.style.left = Math.max(8, Math.min(preferredLeft, innerWidth - width - 8)) + "px";
    panel.style.top = Math.max(8, Math.min(preferredTop, innerHeight - height - 8)) + "px";
  }

  function update(open) {
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      placeMenu();
      if (enterOnOpen) available().at(enterOnOpen === "last" ? -1 : 0)?.focus();
    }
    enterOnOpen = null;
  }

  function close(restore = false) {
    if (!isOpen()) return;
    if (restore) trigger.focus({ preventScroll: true });
    if (nativePopover) panel.hidePopover();
    else {
      panel.hidden = true;
      update(false);
    }
  }

  if (nativePopover) panel.addEventListener("toggle", event => update(event.newState === "open"));
  trigger.addEventListener("click", event => {
    if (event.detail === 0) enterOnOpen ??= "first";
    if (nativeInvoker) return;
    event.preventDefault();
    if (isOpen()) close(true);
    else if (nativePopover) panel.showPopover({ source: trigger });
    else {
      panel.hidden = false;
      update(true);
    }
  });
  trigger.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const last = event.key === "ArrowUp";
    if (isOpen()) available().at(last ? -1 : 0)?.focus();
    else {
      enterOnOpen = last ? "last" : "first";
      trigger.click();
    }
  });
  trigger.parentElement.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !isOpen()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close(true);
  }, true);
  group.addEventListener("keydown", event => {
    const items = available();
    if (event.key === "Tab") {
      close(true);
      return;
    }
    const firstOrLast = { Home: items[0], End: items.at(-1) }[event.key];
    if (firstOrLast) {
      event.preventDefault();
      firstOrLast.focus();
    }
    if (["ArrowUp", "ArrowDown"].includes(event.key) && items.length) {
      event.preventDefault();
      const current = items.indexOf(document.activeElement);
      const step = event.key === "ArrowUp" ? -1 : 1;
      items[(current + step + items.length) % items.length].focus();
    }
    if (event.key === " " && event.target.matches("a[data-account-action]")) {
      event.preventDefault();
      event.target.click();
    }
  });
  panel.addEventListener("click", event => {
    const action = event.target.closest("[data-account-action]");
    if (action && !action.hasAttribute("data-logout")) close(true);
  });
  document.addEventListener("focusin", event => {
    if (event.target !== trigger && !panel.contains(event.target)) close();
  });
  if (positionFallback) {
    window.addEventListener("resize", placeMenu);
    document.addEventListener("scroll", placeMenu, true);
  }
  if (!nativePopover) {
    document.addEventListener("pointerdown", event => {
      if (!trigger.contains(event.target) && !panel.contains(event.target)) close();
    });
  }
}

function leaveWorkspace(path) {
  document.body.setAttribute("data-checking-session", "");
  location.replace(path);
}

export function checkSessionResponse(data) {
  if (data.code === "session_required") leaveWorkspace("/login");
  if (data.code === "session_port_mismatch") leaveWorkspace("/");
}

export function installAccountSession({ onDisabled } = {}) {
  const trigger = document.querySelector("#accountTrigger");
  const menu = document.querySelector("#accountMenu");
  const logout = menu.querySelector("[data-logout]");
  const errorMessage = menu.querySelector(".account-error");
  const status = document.querySelector("#sessionStatus");
  let principal, pending, previousFocus, leaving = false;

  installMenu(trigger, menu);

  function hideWorkspace() {
    if (!principal || document.body.hasAttribute("data-checking-session")) return;
    previousFocus = document.activeElement;
    document.body.setAttribute("data-checking-session", "");
  }

  function revalidate() {
    if (leaving) return;
    hideWorkspace();
    return pending ??= (async () => {
      try {
        const response = await fetch("/api/session", { cache: "no-store", signal: AbortSignal.timeout(5000) });
        const current = await response.json();
        if (current.code === "employee_disabled" && onDisabled) {
          logout.hidden = false;
          document.body.removeAttribute("data-checking-session");
          status.hidden = true;
          onDisabled(current);
          return false;
        }
        if (response.status === 401 || current.code === "session_port_mismatch" || current.code === "employee_disabled") {
          leaving = true;
          leaveWorkspace(current.code === "session_port_mismatch" ? "/" : "/login");
          return false;
        }
        if (!response.ok) throw new Error(networkError);
        const identity = JSON.stringify([current.kind, current.actor, current.account, current.role]);
        if (principal && principal !== identity) {
          leaving = true;
          leaveWorkspace(location.pathname);
          return false;
        }
        principal = identity;
        logout.hidden = false;
        if (!document.hidden) {
          document.body.removeAttribute("data-checking-session");
          if (previousFocus?.isConnected && document.activeElement === document.body) previousFocus.focus({ preventScroll: true });
          previousFocus = null;
        }
        status.hidden = true;
        return true;
      } catch {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "secondary";
        retry.textContent = "接続を再確認";
        retry.addEventListener("click", () => {
          status.hidden = true;
          revalidate().then(ready => {
            if (ready) location.reload();
          });
        });
        const message = document.createElement("p");
        message.textContent = networkError;
        document.body.setAttribute("data-checking-session", "");
        status.replaceChildren(message, retry);
        status.hidden = false;
        return false;
      } finally {
        pending = null;
      }
    })();
  }

  logout.addEventListener("click", async () => {
    logout.disabled = true;
    errorMessage.textContent = "";
    try {
      const { redirect } = await sessionPost("logout");
      leaving = true;
      notifySessionChange();
      leaveWorkspace(redirect);
    } catch (error) {
      if (error.status === 401) {
        leaving = true;
        leaveWorkspace("/login");
        return;
      }
      errorMessage.textContent = "ログアウトを確認できませんでした。もう一度お試しください。";
      logout.disabled = false;
      if (trigger.getAttribute("aria-expanded") === "true" && document.activeElement === document.body) logout.focus();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hideWorkspace();
    else if (principal) revalidate();
  });
  window.addEventListener("pagehide", hideWorkspace);
  window.addEventListener("pageshow", event => {
    if (event.persisted && principal) {
      leaving = false;
      revalidate();
    }
  });
  window.addEventListener("focus", () => {
    if (principal && !document.hidden) revalidate();
  });
  window.addEventListener("storage", event => {
    if (!principal || event.key !== sessionChange) return;
    if (pending) pending.then(revalidate);
    else revalidate();
  });
  return revalidate;
}

function installLogin(form) {
  const accounts = document.querySelector("#employeeAccounts");
  const employeeStatus = document.querySelector("#employeeLoginStatus");
  const adminStatus = document.querySelector("#adminLoginStatus");
  const submit = document.querySelector("#adminLoginSubmit");
  const retry = document.querySelector("#retryAccounts");
  let pending = false;

  function setPending(value) {
    pending = value;
    submit.disabled = value;
    for (const button of accounts.querySelectorAll("button")) button.disabled = value;
  }

  async function login(payload, status, control) {
    if (pending) return;
    setPending(true);
    status.textContent = "ログインしています。";
    try {
      const result = await sessionPost("login", payload);
      form.elements.password.value = "";
      notifySessionChange();
      location.replace(result.redirect);
    } catch (error) {
      setPending(false);
      status.textContent = error.status
        ? error.status === 401 && payload.kind === "admin"
          ? "アカウントまたはパスワードを確認してください。"
          : error.message
        : networkError;
      control?.focus();
    }
  }

  async function loadAccounts() {
    retry.hidden = true;
    employeeStatus.textContent = "アカウントを読み込んでいます。";
    try {
      const response = await fetch("/api/session/accounts", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(networkError);
      const { employees } = await response.json();
      accounts.replaceChildren(...employees.map(employee => {
        const button = document.createElement("button");
        const chevron = document.createElement("span");
        button.type = "button";
        button.disabled = pending;
        button.textContent = employee.name;
        chevron.className = "account-chevron";
        chevron.setAttribute("aria-hidden", "true");
        button.append(chevron);
        button.addEventListener("click", () => login({ kind: "employee", actor: employee.actor }, employeeStatus, button));
        return button;
      }));
      employeeStatus.textContent = employees.length ? "" : "選択できる社員アカウントがありません。";
    } catch {
      employeeStatus.textContent = networkError;
      retry.hidden = false;
    }
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    const values = new FormData(form);
    login({ kind: "admin", account: values.get("account"), password: values.get("password") }, adminStatus, submit);
  });
  retry.addEventListener("click", loadAccounts);
  window.addEventListener("pagehide", () => { form.elements.password.value = ""; });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    setPending(false);
    adminStatus.textContent = "";
    loadAccounts();
  });
  setPending(false);
  loadAccounts();
}

const loginForm = document.querySelector("#adminLogin");
if (loginForm) installLogin(loginForm);
