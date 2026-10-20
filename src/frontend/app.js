/* SupplyRadar web app: plain JavaScript, no build step.
 * Auth: Amazon Cognito (JSON API, USER_PASSWORD_AUTH over HTTPS).
 * Data: API Gateway HTTP API with the Cognito ID token as Bearer.
 */
(() => {
  "use strict";

  const cfg = window.SUPPLYRADAR_CONFIG || {};
  const app = document.getElementById("app");
  const FINAL = ["checked", "needs_review", "confirmed", "failed"];
  const STATUS = {
    uploading: ["Загрузка", "info"],
    extracting: ["AI читает", "info"],
    validating: ["Проверка", "info"],
    confirming: ["Сохранение", "info"],
    checked: ["Проверено", "ok"],
    confirmed: ["Подтверждено", "ok"],
    needs_review: ["Нужна проверка", "warn"],
    failed: ["Ошибка", "bad"],
  };
  const COLORS = ["#0b6e5f", "#d97706", "#7c3aed", "#dc2626", "#2563eb", "#65a30d"];
  const REQUEST_TIMEOUT_MS = 20000;
  const PROCESSING_TIMEOUT_MS = 120000;

  const ICONS = {
    doc: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    chart: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z"/><path d="M4 4l16 16"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  };

  // ------------------------------------------------------------ helpers

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (v) => (v == null || v === "" || isNaN(Number(v)) ? "—"
    : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " ₸");
  const num = (v) => (v == null ? "" : String(v));
  const toNum = (v) => {
    const s = String(v ?? "").replace(/\s/g, "").replace(",", ".");
    return s === "" || isNaN(Number(s)) ? null : Number(s);
  };
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
    return isNaN(d) ? iso : d.toLocaleDateString("ru-RU");
  };
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };
  const badge = (status) => {
    const [label, kind] = STATUS[status] || [status, "info"];
    return `<span class="badge ${kind}">${esc(label)}</span>`;
  };
  const delta = (pct) => {
    if (pct == null || !isFinite(pct)) return '<span class="delta flat">—</span>';
    if (Math.abs(pct) < 0.05) return '<span class="delta flat">0%</span>';
    const up = pct > 0;
    const value = Math.abs(pct).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
    return `<span class="delta ${up ? "up" : "down"}" title="${up ? "Цена выросла" : "Цена снизилась"}">${up ? "▲ +" : "▼ −"}${value}%</span>`;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const emptyState = (icon, title, text, actions = "") => `
    <div class="empty">
      <div class="art" aria-hidden="true">${ICONS[icon]}</div>
      <b>${esc(title)}</b>
      ${text ? `<p>${text}</p>` : ""}
      ${actions ? `<div class="row">${actions}</div>` : ""}
    </div>`;

  const storage = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  let toastTimer;
  function toast(message, isError = false) {
    const el = document.getElementById("toast");
    el.innerHTML = `<span>${esc(message)}</span><button type="button" aria-label="Закрыть">×</button>`;
    el.className = "toast" + (isError ? " error" : "");
    el.setAttribute("role", isError ? "alert" : "status");
    el.hidden = false;
    el.querySelector("button").onclick = () => { el.hidden = true; };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 3500);
  }

  // Marks a button as working and returns a function that restores it.
  function busyButton(btn, text) {
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(text || btn.textContent)}`;
    return () => { btn.disabled = false; btn.removeAttribute("aria-busy"); btn.innerHTML = html; };
  }

  // ------------------------------------------------------------ auth (Cognito)

  const COGNITO_ERRORS = {
    UsernameExistsException: "Пользователь с таким email уже существует. Войдите или восстановите пароль.",
    NotAuthorizedException: "Неверный email или пароль",
    UserNotFoundException: "Неверный email или пароль",
    UserNotConfirmedException: "Email не подтверждён: введите код из письма",
    CodeMismatchException: "Неверный код. Проверьте письмо и введите код ещё раз.",
    ExpiredCodeException: "Код устарел, запросите новый",
    InvalidPasswordException: "Пароль: минимум 8 символов, строчные буквы и цифры",
    InvalidParameterException: "Проверьте введённые данные",
    LimitExceededException: "Слишком много попыток. Подождите несколько минут.",
    TooManyRequestsException: "Слишком много попыток. Подождите несколько минут.",
    CodeDeliveryFailureException: "Не удалось отправить письмо. Проверьте email.",
  };

  async function request(url, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } catch (err) {
      const e = new Error(err.name === "AbortError"
        ? "Сервер не ответил вовремя. Повторите попытку."
        : navigator.onLine === false ? "Нет подключения к интернету"
          : "Нет связи с сервером. Проверьте интернет и повторите.");
      e.network = true;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function cognito(action, body) {
    const resp = await request(cfg.cognitoEndpoint || `https://cognito-idp.${cfg.region}.amazonaws.com/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
      },
      body: JSON.stringify({ ClientId: cfg.clientId, ...body }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const type = String(data.__type || "").split("#").pop();
      const err = new Error(COGNITO_ERRORS[type] || data.message || "Не удалось выполнить вход");
      err.type = type;
      throw err;
    }
    return data;
  }

  const session = {
    get: () => storage.get("sr.session"),
    save(result, email) {
      const old = session.get() || {};
      storage.set("sr.session", {
        idToken: result.IdToken,
        refreshToken: result.RefreshToken || old.refreshToken,
        expiresAt: Date.now() + (result.ExpiresIn || 3600) * 1000 - 60000,
        email: email || old.email,
      });
    },
    clear: () => storage.del("sr.session"),
  };

  // One refresh at a time, even when several API calls notice the expired token together.
  let refreshing = null;
  async function idToken() {
    const s = session.get();
    if (!s || !s.idToken) throw new Error("not signed in");
    if (Date.now() < s.expiresAt) return s.idToken;
    if (!s.refreshToken) throw new Error("no refresh token");
    refreshing ||= cognito("InitiateAuth", {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      AuthParameters: { REFRESH_TOKEN: s.refreshToken },
    }).then((data) => {
      session.save(data.AuthenticationResult);
      return data.AuthenticationResult.IdToken;
    }).finally(() => { refreshing = null; });
    return refreshing;
  }

  function logout(message) {
    const s = session.get();
    session.clear();
    leaveGuard = null;
    alertCount.value = null;
    // Revoke the refresh token so a copied session cannot be reused. Best effort.
    if (s && s.refreshToken) cognito("RevokeToken", { Token: s.refreshToken }).catch(() => {});
    if (message) toast(message, true);
    location.hash = "#/login";
  }

  // ------------------------------------------------------------ API

  async function api(method, path, body) {
    let token;
    try {
      token = await idToken();
    } catch (err) {
      if (err.network) throw err;
      logout("Сессия истекла, войдите снова");
      throw Object.assign(new Error("Сессия истекла, войдите снова"), { silent: true });
    }
    const resp = await request(cfg.apiUrl + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 401) {
      logout("Сессия истекла, войдите снова");
      throw Object.assign(new Error("Сессия истекла, войдите снова"), { silent: true });
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.error || data.message
        || (resp.status >= 500 ? "Сервер временно недоступен. Повторите через минуту." : `Ошибка ${resp.status}`));
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  // Number of price alerts, shown on the navigation tab. Refreshed at most once a minute.
  const alertCount = { value: null, at: 0 };
  async function refreshAlertCount(force) {
    if (!session.get() || (!force && Date.now() - alertCount.at < 60000)) return paintAlertCount();
    alertCount.at = Date.now();
    try {
      const data = await api("GET", "/alerts");
      alertCount.value = data.alerts.length;
    } catch { /* not important enough to bother the user */ }
    paintAlertCount();
  }
  function paintAlertCount() {
    const el = document.getElementById("alert-count");
    const n = alertCount.value;
    el.hidden = !n;
    el.textContent = n > 99 ? "99+" : String(n || "");
    el.setAttribute("aria-label", n ? `${n} ${plural(n, "алерт", "алерта", "алертов")}` : "");
  }

  // ------------------------------------------------------------ router

  const routes = [
    [/^#\/login$/, renderLogin, false, "Вход"],
    [/^#\/invoices$/, renderInvoices, true, "Накладные"],
    [/^#\/invoices\/([\w-]+)$/, renderInvoice, true, "Накладная"],
    [/^#\/products$/, renderProducts, true, "Товары"],
    [/^#\/products\/(.+)$/, renderProduct, true, "Товар"],
    [/^#\/alerts$/, renderAlerts, true, "Алерты"],
    [/^#\/settings$/, renderSettings, true, "Настройки"],
  ];
  let renderId = 0;
  let currentHash = null;
  // A page with unsaved edits sets this; the router asks before leaving it.
  let leaveGuard = null;

  function skeleton(kind) {
    const lines = (n) => Array.from({ length: n }, (_, i) => `<div class="sk" style="width:${90 - (i % 3) * 18}%"></div>`).join("");
    if (kind === "detail") {
      return `<div class="skeleton" aria-hidden="true"><div class="sk h1"></div>
        <div class="grid-2"><div class="sk block" style="height:320px"></div><div class="card skeleton">${lines(6)}</div></div></div>`;
    }
    return `<div class="skeleton" aria-hidden="true"><div class="sk h1"></div>
      ${kind === "invoices" ? '<div class="sk block"></div>' : ""}
      <div class="card skeleton">${lines(7)}</div></div>`;
  }

  function errorView(err) {
    const notFound = err.status === 404;
    return emptyState(err.network ? "cloud" : "warn",
      notFound ? "Не найдено" : err.network ? "Нет связи" : "Не удалось загрузить",
      esc(err.message),
      notFound ? '<a class="button" href="#/invoices">К накладным</a>'
        : '<button type="button" class="primary" data-retry>Повторить</button>');
  }

  async function router() {
    const hash = location.hash || "#/invoices";
    if (leaveGuard && hash !== currentHash) {
      if (!leaveGuard()) { history.replaceState(null, "", currentHash); return; }
    }
    leaveGuard = null;
    const id = ++renderId;
    const signedIn = !!session.get();
    const match = routes.find(([re]) => re.test(hash));
    if (!match) { location.hash = signedIn ? "#/invoices" : "#/login"; return; }
    const [re, render, needsAuth, title] = match;
    if (needsAuth && !signedIn) { location.hash = "#/login"; return; }
    if (!needsAuth && signedIn) { location.hash = "#/invoices"; return; }

    const samePage = hash === currentHash;
    currentHash = hash;
    document.title = `${title} — SupplyRadar`;
    document.getElementById("topbar").hidden = !needsAuth;
    const section = hash.split("/")[1];
    document.querySelectorAll("[data-nav]").forEach((a) => {
      const on = a.dataset.nav === section;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (needsAuth) refreshAlertCount();

    if (!samePage) {
      app.innerHTML = skeleton(section === "invoices" && hash.split("/").length > 2 ? "detail"
        : section === "invoices" ? "invoices" : "list");
      window.scrollTo(0, 0);
    }
    const args = hash.match(re).slice(1).map(decodeURIComponent);
    try {
      await render(...args, () => id === renderId);
      if (id === renderId && !samePage) {
        const h1 = app.querySelector("h1");
        if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); }
      }
    } catch (err) {
      if (id !== renderId || err.silent) return;
      app.innerHTML = `<div class="card error-state">${errorView(err)}</div>`;
      const retry = app.querySelector("[data-retry]");
      if (retry) retry.addEventListener("click", () => { currentHash = null; router(); });
    }
  }

  // Re-render the current page in place (after a save), keeping scroll position.
  const reload = () => router();

  // ------------------------------------------------------------ login

  function renderLogin() {
    let mode = "signin"; // signin | signup | confirm | forgot | reset
    let pendingEmail = "";

    const passwordField = (id, autocomplete, label = "Пароль") => `
      <label for="${id}">${label}</label>
      <div class="password">
        <input id="${id}" type="password" minlength="8" required autocomplete="${autocomplete}">
        <button type="button" class="link" data-toggle="${id}" aria-pressed="false">Показать</button>
      </div>`;

    const draw = () => {
      const tabbed = mode === "signin" || mode === "signup";
      const heading = {
        confirm: ["Подтвердите email", `Мы отправили код на <b>${esc(pendingEmail)}</b>.`],
        forgot: ["Восстановление пароля", "Пришлём код для сброса пароля на ваш email."],
        reset: ["Новый пароль", `Введите код из письма, отправленного на <b>${esc(pendingEmail)}</b>, и придумайте новый пароль.`],
      }[mode];
      const submit = {
        signin: "Войти", signup: "Создать аккаунт", confirm: "Подтвердить",
        forgot: "Отправить код", reset: "Сохранить пароль",
      }[mode];

      let fields = "";
      if (mode === "signin" || mode === "signup") {
        fields = `
          <label for="email">Email</label>
          <input id="email" type="email" autocomplete="email" inputmode="email" required value="${esc(pendingEmail)}">
          ${passwordField("password", mode === "signup" ? "new-password" : "current-password")}
          ${mode === "signup" ? '<p class="field-hint">Минимум 8 символов, строчные буквы и цифры.</p>' : ""}`;
      } else if (mode === "confirm") {
        fields = `
          <label for="code">Код из письма</label>
          <input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="10" required>`;
      } else if (mode === "forgot") {
        fields = `
          <label for="email">Email</label>
          <input id="email" type="email" autocomplete="email" inputmode="email" required value="${esc(pendingEmail)}">`;
      } else {
        fields = `
          <label for="code">Код из письма</label>
          <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required>
          ${passwordField("new-password", "new-password", "Новый пароль")}
          <p class="field-hint">Минимум 8 символов, строчные буквы и цифры.</p>`;
      }

      app.innerHTML = `
        <div class="auth">
          <section class="intro">
            <img src="favicon.svg" alt="" width="44" height="44">
            <h1>Узнайте, когда поставщик поднял цену</h1>
            <p class="lead">Сфотографируйте накладную. SupplyRadar прочитает её, сверит цены с прошлыми поставками и подскажет, где дешевле.</p>
            <ol class="how">
              <li><div><b>Снимите накладную</b><span>Фото с телефона или PDF от поставщика.</span></div></li>
              <li><div><b>Проверьте, что прочитал AI</b><span>Ошибки в суммах подсвечиваются, их можно исправить.</span></div></li>
              <li><div><b>Получите алерт о росте цены</b><span>На сайте и по email, с поставщиком, у которого дешевле.</span></div></li>
            </ol>
          </section>
          <div class="card">
            ${tabbed ? `
            <div class="tabs" role="tablist">
              <button type="button" role="tab" data-mode="signin" aria-selected="${mode === "signin"}" class="${mode === "signin" ? "active" : ""}">Вход</button>
              <button type="button" role="tab" data-mode="signup" aria-selected="${mode === "signup"}" class="${mode === "signup" ? "active" : ""}">Регистрация</button>
            </div>` : `<h2>${heading[0]}</h2><p class="small muted" style="margin:0">${heading[1]}</p>`}
            <form id="auth-form" novalidate>
              ${fields}
              <p class="field-error" id="auth-error" role="alert" hidden></p>
              <button class="primary" type="submit">${submit}</button>
            </form>
            <div class="alt small">
              ${mode === "signin" ? '<button type="button" class="link" data-mode="forgot">Забыли пароль?</button>' : ""}
              ${mode === "confirm" || mode === "reset" ? '<button type="button" class="link" id="resend">Отправить код ещё раз</button>' : ""}
              ${tabbed ? "" : '<button type="button" class="link" data-mode="signin">Вернуться ко входу</button>'}
            </div>
          </div>
        </div>`;

      app.querySelectorAll("[data-mode]").forEach((b) =>
        b.addEventListener("click", () => {
          const email = app.querySelector("#email");
          if (email) pendingEmail = email.value.trim();
          mode = b.dataset.mode;
          draw();
        }));
      app.querySelectorAll("[data-toggle]").forEach((b) =>
        b.addEventListener("click", () => {
          const input = app.querySelector("#" + b.dataset.toggle);
          const show = input.type === "password";
          input.type = show ? "text" : "password";
          b.textContent = show ? "Скрыть" : "Показать";
          b.setAttribute("aria-pressed", String(show));
        }));
      const resend = app.querySelector("#resend");
      if (resend) resend.addEventListener("click", async () => {
        const done = busyButton(resend);
        try {
          await cognito(mode === "reset" ? "ForgotPassword" : "ResendConfirmationCode", { Username: pendingEmail });
          toast("Код отправлен на " + pendingEmail);
        } catch (e) { toast(e.message, true); } finally { done(); }
      });

      const form = app.querySelector("#auth-form");
      const errorEl = app.querySelector("#auth-error");
      const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = !msg; };
      const first = form.querySelector("input:not([value]), input[value='']") || form.querySelector("input");
      if (first && document.activeElement !== first) first.focus({ preventScroll: true });

      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        showError("");
        const invalid = [...form.querySelectorAll("input")].find((i) => !i.checkValidity());
        if (invalid) {
          showError(invalid.type === "email" ? "Введите корректный email"
            : invalid.id === "code" ? "Введите код из письма"
              : "Пароль: минимум 8 символов, строчные буквы и цифры");
          invalid.focus();
          return;
        }
        const done = busyButton(ev.submitter || form.querySelector("button[type=submit]"));
        const val = (id) => form.querySelector("#" + id).value;
        try {
          if (mode === "confirm") {
            await cognito("ConfirmSignUp", { Username: pendingEmail, ConfirmationCode: val("code").replace(/\s/g, "") });
            toast("Email подтверждён, теперь войдите");
            mode = "signin";
            draw();
            return;
          }
          if (mode === "forgot") {
            pendingEmail = val("email").trim().toLowerCase();
            await cognito("ForgotPassword", { Username: pendingEmail });
            mode = "reset";
            draw();
            return;
          }
          if (mode === "reset") {
            await cognito("ConfirmForgotPassword", {
              Username: pendingEmail, ConfirmationCode: val("code").replace(/\s/g, ""), Password: val("new-password"),
            });
            toast("Пароль изменён, войдите с новым паролем");
            mode = "signin";
            draw();
            return;
          }
          const email = val("email").trim().toLowerCase();
          const password = val("password");
          pendingEmail = email;
          if (mode === "signup") {
            await cognito("SignUp", { Username: email, Password: password, UserAttributes: [{ Name: "email", Value: email }] });
            mode = "confirm";
            draw();
            return;
          }
          const data = await cognito("InitiateAuth", {
            AuthFlow: "USER_PASSWORD_AUTH",
            AuthParameters: { USERNAME: email, PASSWORD: password },
          });
          if (!data.AuthenticationResult) throw new Error("Для этого аккаунта нужен дополнительный шаг входа, который приложение не поддерживает");
          session.save(data.AuthenticationResult, email);
          location.hash = "#/invoices";
        } catch (err) {
          if (err.type === "UserNotConfirmedException") {
            mode = "confirm";
            draw();
            cognito("ResendConfirmationCode", { Username: pendingEmail }).catch(() => {});
            toast("Email не подтверждён. Мы отправили новый код.", true);
            return;
          }
          if (form.isConnected) { done(); showError(err.message); }
          else toast(err.message, true);
        }
      });
    };
    draw();
  }

  // ------------------------------------------------------------ invoices

  async function prepareFile(file) {
    if (file.type === "application/pdf") return { blob: file, type: file.type };
    if (!file.type.startsWith("image/")) throw new Error("Этот формат не подходит. Нужна фотография (JPEG, PNG, HEIC) или PDF.");
    // Resize in the browser: smaller upload, fewer AI tokens, same readability.
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      throw new Error("Браузер не смог открыть это фото. Сохраните его как JPEG или сделайте снимок камерой.");
    }
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    if (!blob) throw new Error("Не удалось подготовить фото. Попробуйте другой файл.");
    return { blob, type: "image/jpeg" };
  }

  async function uploadFile(file, onStep) {
    if (file.size > 25 * 1024 * 1024) throw new Error("Файл больше 25 МБ. Сделайте фото заново или сожмите PDF.");
    onStep("prepare");
    const { blob, type } = await prepareFile(file);
    if (blob.size > 10 * 1024 * 1024) throw new Error("После сжатия файл больше 10 МБ. Для PDF уберите лишние страницы.");
    const { invoice_id: id, upload } = await api("POST", "/uploads", { content_type: type, file_name: file.name });
    onStep("upload");
    const form = new FormData();
    Object.entries(upload.fields).forEach(([k, v]) => form.append(k, v));
    form.append("file", blob, file.name || "invoice");
    const resp = await request(upload.url, { method: "POST", body: form });
    if (!resp.ok) throw new Error("Хранилище не приняло файл. Повторите загрузку.");
    return id;
  }

  // Polls until the invoice reaches a final status. Survives a few network blips.
  async function waitForResult(id, onStatus, alive) {
    const started = Date.now();
    let failures = 0;
    while (Date.now() - started < PROCESSING_TIMEOUT_MS && alive()) {
      try {
        const inv = await api("GET", `/invoices/${id}`);
        failures = 0;
        onStatus(inv.status, Math.round((Date.now() - started) / 1000));
        if (FINAL.includes(inv.status)) return inv;
      } catch (err) {
        if (err.silent || err.status === 404 || ++failures >= 4) throw err;
      }
      await sleep(Math.min(2000 + failures * 2000, 8000));
    }
    return null;
  }

  const UPLOAD_STEPS = [
    ["prepare", "Подготовка"],
    ["upload", "Загрузка"],
    ["extracting", "AI читает"],
    ["validating", "Проверка"],
  ];
  function stepsView(current, seconds) {
    const idx = UPLOAD_STEPS.findIndex(([k]) => k === current);
    return `<ol class="steps">${UPLOAD_STEPS.map(([, label], i) =>
      `<li class="${i < idx ? "done" : i === idx ? "now" : ""}"${i === idx ? ' aria-current="step"' : ""}>${label}${i === idx && seconds ? ` <span class="elapsed">${seconds} с</span>` : ""}</li>`).join("")}
      </ol>${seconds > 30 ? '<p class="note">Обычно это занимает 10–20 секунд. Страницу можно не закрывать: результат появится в списке.</p>' : ""}`;
  }

  const FILTERS = [
    ["all", "Все", () => true],
    ["needs_review", "Нужна проверка", (i) => i.status === "needs_review" || i.status === "failed"],
    ["ok", "Проверено", (i) => i.status === "checked" || i.status === "confirmed"],
    ["processing", "В обработке", (i) => !FINAL.includes(i.status)],
  ];
  const listState = { filter: "all", query: "" };

  async function renderInvoices(alive) {
    const data = await api("GET", "/invoices");
    if (!alive()) return;
    const invoices = data.invoices || [];

    app.innerHTML = `
      <div class="page-head"><h1>Накладные</h1></div>
      <div class="card upload" id="drop">
        <div class="upload-icon" aria-hidden="true">${ICONS.camera}</div>
        <div>
          <strong>Добавьте накладную</strong>
          <span class="small muted">Фото или PDF. AI прочитает строки и сверит цены за 10–20 секунд.</span>
        </div>
        <div class="actions">
          <label class="button primary camera-only">
            Сфотографировать<input id="camera" type="file" accept="image/*" capture="environment" hidden>
          </label>
          <label class="button">
            Выбрать файл<input id="picker" type="file" accept="image/*,application/pdf" hidden>
          </label>
        </div>
        <div id="progress" class="progress" aria-live="polite"></div>
      </div>
      <div class="card flush" id="list"></div>`;

    const list = app.querySelector("#list");
    const drawList = () => {
      if (!invoices.length) {
        list.innerHTML = emptyState("doc", "Пока нет накладных",
          "Загрузите первую накладную выше. Цены начнут сравниваться со второй поставки того же товара.");
        return;
      }
      const q = listState.query.toLowerCase();
      const pred = FILTERS.find(([k]) => k === listState.filter)[2];
      const shown = invoices.filter((i) => pred(i) && (!q
        || [i.supplier_name, i.invoice_number, i.file_name].some((v) => String(v || "").toLowerCase().includes(q))));
      const rows = shown.map((i) => `
        <tr class="clickable" data-id="${esc(i.invoice_id)}">
          <td><a class="row-link" href="#/invoices/${esc(i.invoice_id)}">${esc(i.supplier_name || i.file_name || "Без названия")}</a>
            <span class="cell-sub">${i.invoice_number ? `№ ${esc(i.invoice_number)}` : ""}${i.lines ? `${i.invoice_number ? ", " : ""}${i.lines} ${plural(i.lines, "строка", "строки", "строк")}` : ""}</span></td>
          <td class="num">${money(i.total)}</td>
          <td data-m="sub">${fmtDate(i.invoice_date || i.created_at)}</td>
          <td class="num">${badge(i.status)}${i.issues ? `<span class="cell-sub">${i.issues} ${plural(i.issues, "замечание", "замечания", "замечаний")}</span>` : ""}</td>
        </tr>`).join("");
      const counts = Object.fromEntries(FILTERS.map(([k, , p]) => [k, invoices.filter(p).length]));
      const toolbar = list.querySelector(".toolbar");
      if (!toolbar) {
        list.innerHTML = `
          <div class="toolbar">
            <div class="search"><input id="search" type="search" placeholder="Поставщик или номер" aria-label="Поиск по накладным" value="${esc(listState.query)}"></div>
            <div class="chips" role="group" aria-label="Фильтр по статусу"></div>
          </div>
          <div id="rows"></div>`;
        list.querySelector("#search").addEventListener("input", (e) => { listState.query = e.target.value; drawList(); });
      }
      list.querySelector(".chips").innerHTML = FILTERS.filter(([k]) => k === "all" || counts[k]).map(([k, label]) =>
        `<button type="button" class="chip" data-filter="${k}" aria-pressed="${listState.filter === k}">${label} <span class="n">${counts[k]}</span></button>`).join("");
      list.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { listState.filter = b.dataset.filter; drawList(); }));
      list.querySelector("#rows").innerHTML = rows ? `<div class="table-wrap"><table class="responsive">
          <thead><tr><th>Поставщик</th><th class="num">Сумма</th><th>Дата</th><th class="num">Статус</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
        : emptyState("search", "Ничего не найдено", "Измените запрос или выберите другой фильтр.");
      list.querySelectorAll("tr[data-id]").forEach((tr) =>
        tr.addEventListener("click", (e) => { if (!e.target.closest("a")) location.hash = `#/invoices/${tr.dataset.id}`; }));
    };
    if (!FILTERS.some(([k]) => k === listState.filter)) listState.filter = "all";
    drawList();

    const drop = app.querySelector("#drop");
    const progress = app.querySelector("#progress");
    let working = false;
    const handle = async (file) => {
      if (!file || working) return;
      working = true;
      drop.classList.add("busy");
      app.querySelectorAll("#drop input").forEach((i) => { i.disabled = true; });
      const paint = (s, sec) => {
        const step = s === "uploading" ? "upload" : s === "confirming" ? "validating" : s;
        if (UPLOAD_STEPS.some(([k]) => k === step)) progress.innerHTML = stepsView(step, sec);
      };
      try {
        const id = await uploadFile(file, paint);
        paint("extracting");
        const inv = await waitForResult(id, paint, alive);
        if (!alive()) return;
        if (!inv) toast("Обработка идёт дольше обычного. Откройте накладную чуть позже.");
        else if (inv.status === "checked") toast("Накладная проверена");
        else if (inv.status === "needs_review") toast("Проверьте отмеченные поля");
        else if (inv.status === "failed") toast(inv.error || "AI не смог прочитать накладную. Данные можно ввести вручную.", true);
        refreshAlertCount(true);
        location.hash = `#/invoices/${id}`;
      } catch (err) {
        if (!alive()) return;
        progress.innerHTML = "";
        if (!err.silent) toast(err.message, true);
      } finally {
        working = false;
        if (drop.isConnected) {
          drop.classList.remove("busy");
          app.querySelectorAll("#drop input").forEach((i) => { i.disabled = false; i.value = ""; });
        }
      }
    };
    ["camera", "picker"].forEach((id) =>
      app.querySelector(`#${id}`).addEventListener("change", (e) => handle(e.target.files[0])));
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
    drop.addEventListener("dragleave", (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove("drag"); });
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drag"); handle(e.dataTransfer.files[0]); });
  }

  const FIELD_NAMES = { total: "Итого", quantity: "Кол-во", price: "Цена", name: "Товар" };

  async function renderInvoice(id, alive) {
    let inv = await api("GET", `/invoices/${id}`);
    if (!FINAL.includes(inv.status)) {
      const paintWait = (status, sec) => {
        app.innerHTML = `
          <a class="back" href="#/invoices">← Накладные</a>
          <div class="page-head"><h1>Накладная обрабатывается</h1>${badge(status)}</div>
          <div class="card">${stepsView(status === "confirming" ? "validating" : status === "uploading" ? "upload" : status, sec)}</div>`;
      };
      paintWait(inv.status);
      inv = await waitForResult(id, paintWait, alive);
      if (!alive()) return;
      if (!inv) {
        app.innerHTML = `
          <a class="back" href="#/invoices">← Накладные</a>
          <div class="card">${emptyState("doc", "Обработка идёт дольше обычного",
            "Так бывает при большой нагрузке на AI. Обновите страницу через минуту.",
            '<button type="button" class="primary" data-retry>Обновить</button>')}</div>`;
        app.querySelector("[data-retry]").addEventListener("click", reload);
        return;
      }
    }
    if (!alive()) return;

    const issues = inv.issues || [];
    const flagged = new Set(issues.map((i) => i.field));
    const lineFlagged = (i, f) => flagged.has(`lines.${i}.${f}`) || flagged.has(`lines.${i}`);
    const editable = ["needs_review", "failed", "checked"].includes(inv.status);
    const field = (name, label, value, type = "text", extra = "") => `
      <label for="f-${name}">${label}</label>
      <input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}
        ${flagged.has(name) ? 'class="flagged" aria-invalid="true"' : ""} ${editable ? "" : "disabled"}>`;
    const lines = inv.lines && inv.lines.length ? inv.lines
      : [{ name: "", quantity: null, unit: "", price: null, total: null }];
    const cls = (i, f) => (lineFlagged(i, f) ? 'class="flagged" aria-invalid="true"' : "");
    const editRow = (l, i) => `
      <tr data-i="${i}">
        <td class="name" data-label="Товар"><input data-f="name" value="${esc(l.name)}" aria-label="Товар" ${cls(i, "name")}></td>
        <td class="num" data-label="Кол-во"><input data-f="quantity" type="text" inputmode="decimal" value="${num(l.quantity)}" aria-label="Количество" ${cls(i, "quantity")}></td>
        <td class="unit" data-label="Ед."><input data-f="unit" value="${esc(l.unit)}" aria-label="Единица"></td>
        <td class="num" data-label="Цена"><input data-f="price" type="text" inputmode="decimal" value="${num(l.price)}" aria-label="Цена" ${cls(i, "price")}></td>
        <td class="num" data-label="Сумма"><input data-f="total" type="text" inputmode="decimal" value="${num(l.total)}" aria-label="Сумма" ${cls(i, "total")}></td>
        <td class="del"><button type="button" class="icon" data-del aria-label="Удалить строку">${ICONS.trash}</button></td>
      </tr>`;

    const original = !inv.file_url ? '<p class="muted small">Файл недоступен.</p>'
      : inv.content_type === "application/pdf"
        ? `<div class="pdf">${ICONS.doc.replace("<svg", '<svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6"')}<a class="button" href="${esc(inv.file_url)}" target="_blank" rel="noopener">Открыть PDF</a></div>`
        : `<a class="zoom" href="${esc(inv.file_url)}" target="_blank" rel="noopener" title="Открыть в полном размере"><img src="${esc(inv.file_url)}" alt="Фото накладной"></a>`;

    const notice = inv.status === "failed"
      ? `<div class="card notice bad"><b>AI не смог прочитать накладную.</b> <span class="muted">${esc(inv.error || "")}</span> Введите данные вручную и подтвердите, чтобы цены попали в сравнение.</div>`
      : issues.length
        ? `<div class="card notice"><h2>Что проверить</h2><ul class="issues">${issues.map((i) => `<li>${esc(i.message)}</li>`).join("")}</ul>
            <p class="small muted" style="margin:10px 0 0">Поля с ошибками подсвечены. Сверьте их с фото и нажмите «Подтвердить».</p></div>`
        : "";

    app.innerHTML = `
      <a class="back" href="#/invoices">← Накладные</a>
      <div class="page-head">
        <h1>Накладная${inv.invoice_number ? ` № ${esc(inv.invoice_number)}` : ""}</h1>${badge(inv.status)}
        <p class="sub">${esc(inv.supplier_name || "Поставщик не указан")}${inv.invoice_date ? `, ${fmtDate(inv.invoice_date)}` : ""}</p>
      </div>
      ${notice}
      <div class="grid-2">
        <div class="card original"><h2>Фото</h2>${original}</div>
        <div class="stack" style="margin:0">
          <form class="card" id="review" novalidate>
            <h2>Реквизиты</h2>
            <div class="fields">
              <div class="wide">${field("supplier_name", "Поставщик", inv.supplier_name, "text", 'autocomplete="organization"')}</div>
              <div>${field("supplier_bin", "БИН", inv.supplier_bin, "text", 'inputmode="numeric" maxlength="12"')}</div>
              <div>${field("invoice_number", "Номер", inv.invoice_number)}</div>
              <div>${field("invoice_date", "Дата", inv.invoice_date, "date")}</div>
              <div>${field("total", "Итого, ₸", num(inv.total), "text", 'inputmode="decimal"')}</div>
            </div>
          </form>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>Строки</h2><span class="small muted">${lines.length} ${plural(lines.length, "позиция", "позиции", "позиций")}</span></div>
        ${editable ? `<div class="table-wrap"><table class="lines" id="lines">
          <thead><tr><th>Товар</th><th class="num">Кол-во</th><th>Ед.</th><th class="num">Цена</th><th class="num">Сумма</th><th><span class="sr-only">Удалить</span></th></tr></thead>
          <tbody>${lines.map(editRow).join("")}</tbody>
          <tfoot><tr><td colspan="6"><div class="sum-check" id="sum-check"></div></td></tr></tfoot>
        </table></div>
        <div class="actionbar sticky">
          <button type="button" id="add-line">+ Строка</button><span class="spacer"></span>
          <button class="primary" type="button" id="confirm">${inv.status === "checked" ? "Сохранить исправления" : "Подтвердить"}</button>
        </div>
        <p class="field-error" id="review-error" role="alert" hidden></p>
        <p class="small muted" style="margin:10px 0 0">Алерты строятся только по проверенным или подтверждённым вами накладным.</p>`
        : `<div class="table-wrap"><table class="responsive" id="lines">
          <thead><tr><th>Товар</th><th class="num">Кол-во × цена</th><th class="num">Сумма</th></tr></thead>
          <tbody>${lines.map((l) => `
            <tr>
              <td data-m="wide">${esc(l.name)}${l.product_key ? `<span class="cell-sub"><a href="#/products/${encodeURIComponent(l.product_key)}">История цены${l.canonical_name && l.canonical_name !== l.name ? `: ${esc(l.canonical_name)}` : ""}</a></span>` : ""}</td>
              <td class="num" data-m="sub">${esc(l.quantity)} ${esc(l.unit)} × ${money(l.price)}</td>
              <td class="num">${money(l.total)}</td>
            </tr>`).join("")}
          </tbody></table></div>`}
      </div>`;

    if (!editable) return;

    const tbody = app.querySelector("#lines tbody");
    const form = app.querySelector("#review");
    const totalInput = form.elements.total;
    let dirty = false;
    leaveGuard = () => !dirty || confirm("Исправления не сохранены. Уйти со страницы?");
    const onBeforeUnload = (e) => { if (dirty && app.contains(form)) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", onBeforeUnload);

    // Live arithmetic check: quantity × price against the line sum, and lines against the invoice total.
    const sumCheck = () => {
      let sum = 0;
      tbody.querySelectorAll("tr").forEach((tr) => {
        const [q, p, t] = ["quantity", "price", "total"].map((f) => toNum(tr.querySelector(`[data-f=${f}]`).value));
        const tIn = tr.querySelector("[data-f=total]");
        tIn.classList.toggle("mismatch", q != null && p != null && t != null && Math.abs(q * p - t) > 1);
        tIn.title = tIn.classList.contains("mismatch") ? `Кол-во × цена = ${money(q * p)}` : "";
        sum += t || 0;
      });
      const total = toNum(totalInput.value);
      const ok = total != null && Math.abs(sum - total) <= 1;
      app.querySelector("#sum-check").innerHTML = `
        <span>Сумма строк: <b class="num-text">${money(Math.round(sum * 100) / 100)}</b></span>
        <span>Итого в накладной: <b class="num-text">${money(total)}</b></span>
        ${total == null ? "" : ok ? '<span class="ok">Сходится</span>' : `<span class="bad">Разница ${money(Math.round((total - sum) * 100) / 100)}</span>`}`;
    };
    sumCheck();

    const onEdit = (e) => {
      if (e.target.tagName !== "INPUT") return;
      dirty = true;
      e.target.classList.remove("flagged");
      e.target.removeAttribute("aria-invalid");
      sumCheck();
    };
    form.addEventListener("input", onEdit);
    tbody.addEventListener("input", onEdit);
    tbody.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (!del) return;
      if (tbody.children.length === 1) {
        del.closest("tr").querySelectorAll("input").forEach((i) => { i.value = ""; });
      } else {
        del.closest("tr").remove();
      }
      dirty = true;
      sumCheck();
    });
    app.querySelector("#add-line").addEventListener("click", () => {
      const tmp = document.createElement("tbody");
      tmp.innerHTML = editRow({ name: "", quantity: null, unit: "", price: null, total: null }, tbody.children.length);
      tmp.querySelectorAll("input").forEach((i) => { i.classList.remove("flagged"); i.removeAttribute("aria-invalid"); });
      tbody.appendChild(tmp.firstElementChild);
      tbody.lastElementChild.querySelector("input").focus();
      dirty = true;
    });

    const errorEl = app.querySelector("#review-error");
    app.querySelector("#confirm").addEventListener("click", async (ev) => {
      errorEl.hidden = true;
      const body = Object.fromEntries(["supplier_name", "supplier_bin", "invoice_number", "invoice_date", "total"]
        .map((k) => [k, form.elements[k].value.trim()]));
      const problems = [];
      const markBad = (input) => { input.classList.add("flagged"); input.setAttribute("aria-invalid", "true"); };
      if (toNum(body.total) == null) { problems.push("Укажите итог накладной числом"); markBad(totalInput); }
      body.lines = [];
      tbody.querySelectorAll("tr").forEach((tr, i) => {
        const get = (f) => tr.querySelector(`[data-f=${f}]`).value.trim();
        if (!get("name") && !get("quantity") && !get("price") && !get("total")) return;
        const line = { name: get("name"), quantity: get("quantity"), unit: get("unit"), price: get("price"), total: get("total") };
        ["name", "quantity", "price", "total"].forEach((f) => {
          const bad = f === "name" ? !line[f] : toNum(line[f]) == null;
          if (bad) { problems.push(`Строка ${i + 1}: заполните «${FIELD_NAMES[f]}»`); markBad(tr.querySelector(`[data-f=${f}]`)); }
        });
        body.lines.push(line);
      });
      if (!body.lines.length) problems.push("Добавьте хотя бы одну строку");
      if (problems.length) {
        errorEl.textContent = problems.slice(0, 3).join(". ") + (problems.length > 3 ? ` и ещё ${problems.length - 3}` : "") + ".";
        errorEl.hidden = false;
        const firstBad = app.querySelector("#review .flagged, #lines .flagged");
        if (firstBad) firstBad.focus();
        return;
      }
      const done = busyButton(ev.currentTarget, "Сохраняем…");
      try {
        await api("PUT", `/invoices/${id}`, body);
        dirty = false;
        window.removeEventListener("beforeunload", onBeforeUnload);
        toast("Отправлено на проверку");
        leaveGuard = null;
        reload();
      } catch (err) {
        done();
        if (!err.silent) { errorEl.textContent = err.message; errorEl.hidden = false; }
      }
    });
  }

  // ------------------------------------------------------------ products

  function supplierRows(product) {
    return Object.values(product.suppliers || {}).sort((a, b) => a.price - b.price);
  }

  function productStats(p) {
    const sup = supplierRows(p);
    const latest = sup.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || {};
    const change = latest.prev_price ? (latest.price - latest.prev_price) / latest.prev_price * 100 : null;
    return { sup, latest, change };
  }

  async function renderProducts(alive) {
    const data = await api("GET", "/products");
    if (!alive()) return;
    const items = (data.products || []).sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"));
    app.innerHTML = `
      <div class="page-head"><h1>Товары</h1>
        <p class="sub">Последняя цена каждого товара и лучшее предложение среди ваших поставщиков.</p></div>
      <div class="card flush" id="list"></div>`;
    const list = app.querySelector("#list");
    if (!items.length) {
      list.innerHTML = emptyState("chart", "Товаров пока нет",
        "Они появятся после первой проверенной накладной.", '<a class="button primary" href="#/invoices">Загрузить накладную</a>');
      return;
    }
    let query = "";
    list.innerHTML = `
      <div class="toolbar"><div class="search"><input id="search" type="search" placeholder="Найти товар" aria-label="Поиск товара"></div>
        <span class="small muted">${items.length} ${plural(items.length, "товар", "товара", "товаров")}</span></div>
      <div id="rows"></div>`;
    const draw = () => {
      const shown = items.filter((p) => String(p.name).toLowerCase().includes(query));
      list.querySelector("#rows").innerHTML = shown.length ? `<div class="table-wrap"><table class="responsive products">
        <thead><tr><th>Товар</th><th class="num">Последняя цена</th><th class="num">Изменение</th><th class="num">Лучшая цена</th></tr></thead>
        <tbody>${shown.map((p) => {
          const { sup, change } = productStats(p);
          const best = sup[0];
          return `<tr class="clickable" data-key="${esc(p.product_key)}">
            <td data-m="wide"><a class="row-link" href="#/products/${encodeURIComponent(p.product_key)}">${esc(p.name)}</a>
              <span class="cell-sub">${sup.length} ${plural(sup.length, "поставщик", "поставщика", "поставщиков")}${p.unit ? `, за ${esc(p.unit)}` : ""}${sup.length > 1 ? `<span class="m-only">Дешевле всего: ${money(best.price)}, ${esc(best.name)}</span>` : ""}</span></td>
            <td class="num">${money(p.last_price)}</td>
            <td class="num">${delta(change)}</td>
            <td class="num" data-m="hide">${sup.length > 1 ? `${money(best.price)}<span class="cell-sub">${esc(best.name)}</span>` : '<span class="muted">—</span>'}</td></tr>`;
        }).join("")}</tbody></table></div>`
        : emptyState("search", "Ничего не найдено", "Попробуйте другое название.");
      list.querySelectorAll("tr[data-key]").forEach((tr) =>
        tr.addEventListener("click", (e) => { if (!e.target.closest("a")) location.hash = `#/products/${encodeURIComponent(tr.dataset.key)}`; }));
    };
    list.querySelector("#search").addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); draw(); });
    draw();
  }

  function priceChart(history) {
    if (history.length < 2) return emptyState("chart", "Пока одна цена", "График появится после второй поставки этого товара.");
    const W = 640, H = 220, L = 60, R = 12, T = 12, B = 28;
    const dates = [...new Set(history.map((h) => h.date))].sort();
    const prices = history.map((h) => h.price);
    let lo = Math.min(...prices), hi = Math.max(...prices);
    const pad = (hi - lo) * 0.15 || hi * 0.05 || 1;
    lo -= pad; hi += pad;
    const x = (d) => L + (dates.length === 1 ? (W - L - R) / 2 : dates.indexOf(d) / (dates.length - 1) * (W - L - R));
    const y = (p) => T + (1 - (p - lo) / (hi - lo)) * (H - T - B);
    const groups = {};
    history.forEach((h) => { (groups[h.supplier || h.supplier_key] ||= []).push(h); });
    const names = Object.keys(groups);
    const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
    const svg = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="История цены по поставщикам">
        ${ticks.map((t) => `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>
          <text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${Math.round(t).toLocaleString("ru-RU")} ₸</text>`).join("")}
        ${[dates[0], dates[dates.length - 1]].map((d, i) => `<text x="${x(d)}" y="${H - 6}" text-anchor="${i ? "end" : "start"}">${fmtDate(d)}</text>`).join("")}
        ${names.map((n, i) => {
          const pts = groups[n].sort((a, b) => a.date.localeCompare(b.date));
          const color = COLORS[i % COLORS.length];
          return `<polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" points="${pts.map((p) => `${x(p.date)},${y(p.price)}`).join(" ")}"/>
            ${pts.map((p) => `<circle cx="${x(p.date)}" cy="${y(p.price)}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"><title>${esc(n)}: ${money(p.price)}, ${fmtDate(p.date)}</title></circle>`).join("")}`;
        }).join("")}
      </svg>`;
    const legend = names.map((n, i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(n)}</span>`).join("");
    return `<div class="chart">${svg}<div class="legend">${legend}</div></div>`;
  }

  async function renderProduct(key, alive) {
    const data = await api("GET", `/products/${encodeURIComponent(key)}`);
    if (!alive()) return;
    const p = data.product;
    const history = data.history || [];
    const { sup, change } = productStats(p);
    app.innerHTML = `
      <a class="back" href="#/products">← Товары</a>
      <div class="page-head"><h1>${esc(p.name)}</h1></div>
      <div class="facts">
        <div class="card"><div class="small muted">Последняя цена</div><div class="v">${money(p.last_price)}</div><div class="small muted">${fmtDate(p.last_date)}</div></div>
        <div class="card"><div class="small muted">Изменение</div><div class="v">${delta(change)}</div><div class="small muted">к прошлой поставке</div></div>
        <div class="card"><div class="small muted">Лучшая цена</div><div class="v">${money(sup[0] && sup[0].price)}</div><div class="small muted">${esc(sup[0] ? sup[0].name : "")}</div></div>
      </div>
      <div class="card"><h2>История цены</h2>${priceChart(history)}</div>
      <div class="grid-2">
        <div class="card flush"><div class="toolbar"><h2 style="margin:0">Поставщики</h2></div>
          <table class="responsive"><thead><tr><th>Поставщик</th><th class="num">Цена</th><th>Дата</th></tr></thead>
          <tbody>${sup.map((s, i) => `<tr><td data-m="wide">${esc(s.name)}${i === 0 && sup.length > 1 ? ' <span class="badge ok">дешевле всех</span>' : ""}</td>
            <td data-m="sub">${fmtDate(s.date)}</td><td class="num">${money(s.price)}</td></tr>`).join("")}</tbody></table>
        </div>
        <div class="card flush"><div class="toolbar"><h2 style="margin:0">Все поставки</h2></div>
          <div class="table-wrap"><table class="responsive"><thead><tr><th>Дата</th><th>Поставщик</th><th class="num">Цена</th><th class="num">Кол-во</th></tr></thead>
          <tbody>${history.slice().reverse().map((h) => `<tr class="clickable" data-id="${esc(h.invoice_id)}">
            <td><a class="row-link" href="#/invoices/${esc(h.invoice_id)}">${fmtDate(h.date)}</a></td><td data-m="sub">${esc(h.supplier)}</td>
            <td class="num">${money(h.price)}</td><td class="num" data-m="sub">${esc(h.quantity ?? "")}</td></tr>`).join("")}
          </tbody></table></div>
        </div>
      </div>`;
    app.querySelectorAll("tr[data-id]").forEach((tr) =>
      tr.addEventListener("click", (e) => { if (!e.target.closest("a")) location.hash = `#/invoices/${tr.dataset.id}`; }));
  }

  // ------------------------------------------------------------ alerts

  async function renderAlerts(alive) {
    const data = await api("GET", "/alerts");
    if (!alive()) return;
    const alerts = data.alerts || [];
    alertCount.value = alerts.length;
    alertCount.at = Date.now();
    paintAlertCount();
    const total = alerts.reduce((s, a) => s + (a.new_price - a.old_price) * (a.quantity || 1), 0);
    app.innerHTML = `
      <div class="page-head"><h1>Алерты</h1></div>
      <div class="card overpay">
        <div>
          <div class="small muted">Переплата по последним повышениям</div>
          <div class="stat ${alerts.length ? "" : "zero"}">${money(Math.round(total))}</div>
        </div>
        <p class="small muted">${alerts.length
          ? `${alerts.length} ${plural(alerts.length, "повышение", "повышения", "повышений")} цены. Считаем разницу с прошлой ценой, умноженную на количество в накладной.`
          : "Поставщики не поднимали цены выше вашего порога."}</p>
      </div>
      ${alerts.length ? alerts.map((a) => `
        <article class="card alert-card">
          <div>
            <div class="title">${esc(a.product)}</div>
            <div class="muted small">${esc(a.supplier)}</div>
          </div>
          <div class="change">${delta(Number(a.change_pct))}</div>
          <div class="prices"><s>${money(a.old_price)}</s> → <b>${money(a.new_price)}</b>${a.quantity ? ` <span class="muted small">× ${esc(a.quantity)}</span>` : ""}</div>
          <div class="date small muted">${fmtDate(a.invoice_date)}</div>
          ${a.cheaper_supplier ? `<div class="tip">У поставщика ${esc(a.cheaper_supplier)} дешевле на ${esc(a.cheaper_pct)}%: ${money(a.cheaper_price)}</div>` : ""}
          <div class="links">
            <a href="#/products/${encodeURIComponent(a.product_key)}">История цены</a>
            <a href="#/invoices/${esc(a.invoice_id)}">Накладная</a>
          </div>
        </article>`).join("")
        : `<div class="card">${emptyState("bell", "Повышений цен пока нет",
          "Как только поставщик поднимет цену выше порога, алерт появится здесь и придёт на email.",
          '<a class="button" href="#/settings">Настроить порог</a>')}</div>`}`;
  }

  // ------------------------------------------------------------ settings

  async function renderSettings(alive) {
    const s = await api("GET", "/settings");
    if (!alive()) return;
    app.innerHTML = `
      <div class="page-head"><h1>Настройки</h1></div>
      <form class="card" id="settings" style="max-width:520px" novalidate>
        <h2>Алерты</h2>
        <label for="threshold">Сообщать, если цена выросла больше чем на, %</label>
        <input id="threshold" type="number" inputmode="decimal" min="0.5" max="100" step="0.5" value="${esc(s.threshold_pct)}" required>
        <p class="field-hint">Например, 5 — алерт при росте цены больше чем на 5%.</p>
        <label for="email">Email для алертов и недельной сводки</label>
        <input id="email" type="email" inputmode="email" autocomplete="email" value="${esc(s.email || s.account_email || "")}">
        <p class="field-hint">Оставьте пустым, чтобы не получать письма.</p>
        ${s.email_pending ? '<p class="small notice" style="color:var(--warn);padding-left:10px">Подтвердите подписку: откройте письмо «AWS Notification - Subscription Confirmation» и нажмите ссылку.</p>' : ""}
        <p class="field-error" id="settings-error" role="alert" hidden></p>
        <div class="actionbar"><button class="primary" type="submit">Сохранить</button></div>
      </form>
      <div class="card" style="max-width:520px">
        <h2>Аккаунт</h2>
        <p class="muted" style="margin:0 0 12px">${esc(s.account_email || (session.get() || {}).email || "")}</p>
        <button type="button" id="logout-2">Выйти из аккаунта</button>
      </div>`;
    app.querySelector("#logout-2").addEventListener("click", () => logout());
    const form = app.querySelector("#settings");
    const errorEl = app.querySelector("#settings-error");
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      errorEl.hidden = true;
      const threshold = toNum(app.querySelector("#threshold").value);
      const email = app.querySelector("#email").value.trim();
      const fail = (msg, input) => { errorEl.textContent = msg; errorEl.hidden = false; input.focus(); };
      if (threshold == null || threshold < 0.5 || threshold > 100) return fail("Порог должен быть от 0,5 до 100%", app.querySelector("#threshold"));
      if (email && !app.querySelector("#email").checkValidity()) return fail("Введите корректный email", app.querySelector("#email"));
      const done = busyButton(ev.submitter || form.querySelector("button[type=submit]"), "Сохраняем…");
      try {
        const r = await api("PUT", "/settings", { threshold_pct: threshold, email });
        toast(r.message || "Настройки сохранены");
        reload();
      } catch (err) {
        done();
        if (!err.silent) { errorEl.textContent = err.message; errorEl.hidden = false; }
      }
    });
  }

  // ------------------------------------------------------------ start

  const offline = document.getElementById("offline");
  const syncOnline = () => { offline.hidden = navigator.onLine !== false; };
  window.addEventListener("online", () => { syncOnline(); toast("Связь восстановлена"); });
  window.addEventListener("offline", syncOnline);
  syncOnline();

  document.getElementById("logout").addEventListener("click", () => logout());
  window.addEventListener("hashchange", router);
  if (!cfg.apiUrl || !cfg.clientId) {
    app.innerHTML = `<div class="card">${emptyState("warn", "Приложение не настроено",
      "Нет config.js. Разверните стек Terraform или скопируйте config.example.js в config.js.")}</div>`;
  } else {
    router();
  }
})();
