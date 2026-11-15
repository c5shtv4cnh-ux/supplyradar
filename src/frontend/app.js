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
  // Series colours that stay readable on both the cream and the navy theme.
  const COLORS = ["#ff6b5b", "#4c7df0", "#e0a526", "#2fa37a", "#9b6be8", "#4bb3d6"];
  // Each series also gets its own line pattern, so the chart does not rely on colour alone.
  const DASHES = ["none", "7 4", "2 4", "10 4 2 4", "1 5", "12 6"];
  const REQUEST_TIMEOUT_MS = 20000;
  const PROCESSING_TIMEOUT_MS = 120000;

  const ICONS = {
    doc: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h7"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    chart: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16 9.5"/></svg>',
    calendar: '<svg viewBox="0 0 24 24"><path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z"/><path d="M4 4l16 16"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
    truck: '<svg viewBox="0 0 24 24"><path d="M2 6h11v10H2zM13 9h5l4 4v3h-9z"/><circle cx="6.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12.5h5"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9 6.6 19.8l1.1-6.1L3.2 9.4l6.1-.8z"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"/><path d="M9 12l2.2 2.2L15 10"/></svg>',
    cup: '<svg viewBox="0 0 24 24"><path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 10h2a2 2 0 0 1 0 4h-2M8 3v2M12 3v2"/></svg>',
    plate: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/></svg>',
    bag: '<svg viewBox="0 0 24 24"><path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
    bread: '<svg viewBox="0 0 24 24"><path d="M4 11a4 4 0 0 1 4-5h8a4 4 0 0 1 4 5c0 1-1 2-2 2v6H6v-6c-1 0-2-1-2-2z"/><path d="M10 6v3M14 6v3"/></svg>',
    box: '<svg viewBox="0 0 24 24"><path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
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
    return `<span class="delta ${up ? "up" : "down"}"><span class="sr-only">${up ? "Цена выросла: " : "Цена снизилась: "}</span><span aria-hidden="true">${up ? "▲" : "▼"}</span> ${up ? "+" : "−"}${value}%</span>`;
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
    // Errors stay until dismissed: nobody should have to read against a timer (WCAG 2.2.1).
    if (!isError) toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  }

  // Marks a button as working and returns a function that restores it.
  function busyButton(btn, text) {
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(text || btn.textContent)}`;
    return () => { btn.disabled = false; btn.removeAttribute("aria-busy"); btn.innerHTML = html; };
  }

  // Business templates: chosen once after sign-up, they set a sensible alert threshold and the hints the owner sees.
  const BUSINESS = {
    cafe: { label: "Кофейня", icon: "cup", threshold: 5,
      about: "Молоко, сливки, зерно, сиропы, выпечка",
      watch: "молоко, сливки и кофейное зерно: на них уходит большая часть закупок кофейни" },
    restaurant: { label: "Ресторан или кафе", icon: "plate", threshold: 5,
      about: "Мясо, рыба, овощи, бакалея, напитки",
      watch: "мясо, рыбу и овощи: их цены меняются чаще всего" },
    shop: { label: "Магазин", icon: "bag", threshold: 3,
      about: "Широкий ассортимент и много поставщиков",
      watch: "ходовые товары: при небольшой наценке заметен даже рост на 3%" },
    bakery: { label: "Пекарня или кондитерская", icon: "bread", threshold: 4,
      about: "Мука, масло, сахар, яйца, начинки",
      watch: "муку, сливочное масло и яйца: это основа себестоимости выпечки" },
    other: { label: "Другой бизнес", icon: "box", threshold: 5,
      about: "Любые регулярные закупки у поставщиков",
      watch: "товары, которые вы покупаете чаще всего" },
    supplier: { label: "Я поставщик", icon: "truck", threshold: 5,
      about: "Продаю товары кафе, магазинам и ресторанам",
      note: "Вы получите кабинет поставщика: каталог товаров с ценами и заявки от бизнеса." },
  };

  // Saves rows as a CSV file that Excel opens directly: UTF-8 with BOM, ";" separator, decimal comma.
  function downloadCsv(fileName, header, rows) {
    const cell = (v) => {
      let t = typeof v === "number" ? String(v).replace(".", ",") : String(v ?? "");
      if (typeof v !== "number" && /^[=+\-@\t]/.test(t)) t = "'" + t; // a cell must never start a formula
      return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const text = [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Файл ${fileName} сохранён`);
  }
  const today = () => new Date().toISOString().slice(0, 10);

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
    profile = null;
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

  // The signed-in account's settings: business template, admin flag. Loaded once, dropped on sign-out and on save.
  let profile = null;
  async function loadProfile() {
    profile ||= await api("GET", "/settings");
    return profile;
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
    [/^#\/welcome$/, renderWelcome, true, "Знакомство"],
    [/^#\/more$/, renderMore, true, "Ещё"],
    [/^#\/suppliers$/, renderSuppliers, true, "Поставщики"],
    [/^#\/suppliers\/([\w-]+)$/, renderSupplier, true, "Поставщик"],
    [/^#\/orders$/, renderOrders, true, "Заявки"],
    [/^#\/subscription$/, renderSubscription, true, "Подписка"],
    [/^#\/assistant$/, renderAssistant, true, "AI-помощник"],
    [/^#\/savings$/, renderSavings, true, "Переплаты"],
    [/^#\/claims$/, renderClaims, true, "Претензии"],
    [/^#\/contracts$/, renderContracts, true, "Контрактные цены"],
    [/^#\/locations$/, renderLocations, true, "Точки"],
    [/^#\/recipes$/, renderRecipes, true, "Себестоимость блюд"],
    [/^#\/(telegram)$/, renderSoon, true, "Скоро"],
    [/^#\/admin$/, renderAdmin, true, "Админ-панель"],
  ];
  // Pages that live under the «Ещё» tab.
  const MORE_SECTIONS = ["more", "suppliers", "orders", "subscription", "assistant", "savings", "claims", "contracts", "locations", "recipes", "telegram", "admin"];
  // Pages that only make sense for a business: a supplier account is sent to its catalog instead.
  const BUSINESS_ONLY = ["invoices", "products", "alerts", "savings", "claims", "contracts", "locations", "recipes", "assistant", "more", "admin"];
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
    document.body.className = needsAuth ? "app" : "landing";
    const section = hash.split("/")[1];
    const paintNav = () => {
      const tab = isSupplier() || !MORE_SECTIONS.includes(section) ? section : "more";
      document.getElementById("nav").hidden = section === "welcome";
      document.querySelectorAll("[data-for]").forEach((a) => {
        a.hidden = !!profile && a.dataset.for !== (isSupplier() ? "supplier" : "business");
      });
      document.querySelectorAll("[data-nav]").forEach((a) => {
        const on = a.dataset.nav === tab;
        a.classList.toggle("active", on);
        if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
      });
    };
    paintNav();
    if (needsAuth) refreshAlertCount();

    if (!samePage) {
      app.innerHTML = skeleton(section === "invoices" && hash.split("/").length > 2 ? "detail"
        : section === "invoices" ? "invoices" : "list");
      window.scrollTo(0, 0);
    }
    const args = hash.match(re).slice(1).map(decodeURIComponent);
    try {
      if (needsAuth) {
        // A new account chooses its business template before anything else.
        const p = await loadProfile();
        if (id !== renderId) return;
        if (!p.business_type !== (section === "welcome")) {
          location.hash = p.business_type ? homeFor(p) : "#/welcome";
          return;
        }
        if (p.business_type === "supplier" && BUSINESS_ONLY.includes(section) && !(section === "admin" && p.is_admin)) {
          location.hash = "#/suppliers";
          return;
        }
        paintNav();
      }
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


    const PERKS = [
      ["camera", "Фото или PDF", "прямо с телефона"],
      ["spark", "AI читает строки", "за 10–20 секунд"],
      ["check", "Сверка сумм", "ошибки подсвечены"],
      ["bell", "Алерт на email", "в день поставки"],
      ["calendar", "Сводка переплат", "каждый понедельник"],
    ];
    app.innerHTML = `
      <div class="hero">
        <div class="hero-bg" aria-hidden="true"></div>
        <header class="hero-top">
          <span class="brand"><img src="favicon.svg" alt="" width="30" height="30"><span>SupplyRadar</span></span>
          <nav class="hero-nav" aria-label="О сервисе">
            <button type="button" data-scroll="how">Как это работает</button>
            <button type="button" data-scroll="numbers">Цифры</button>
          </nav>
          <span class="hero-tag"><i aria-hidden="true"></i>AWS · Gemini AI</span>
        </header>
        <div class="auth">
          <section class="intro">
            <div class="preview" aria-hidden="true">
              <div class="preview-head"><span><i></i>Пример алерта</span><span>сегодня</span></div>
              <div class="preview-row"><b>Сливки 33%</b><span class="up">▲ +12%</span></div>
              <div class="preview-row sub"><span><s>1 250 ₸</s> → 1 400 ₸ за литр</span><span>Молочный двор</span></div>
              <div class="preview-tip">У «Свежей фермы» дешевле на 8%</div>
            </div>
            <h1>Цены поставщиков под присмотром.</h1>
            <p class="lead">Сфотографируйте накладную. SupplyRadar прочитает её, сверит цены с прошлыми поставками и подскажет, у кого дешевле.</p>
          </section>
          <div class="card" id="auth-card"></div>
        </div>
        <ul class="perks">
          ${PERKS.map(([icon, a, b]) => `<li><span aria-hidden="true">${ICONS[icon]}</span><div><b>${a}</b>${b}</div></li>`).join("")}
        </ul>
      </div>
      <section class="band" id="how">
        <p class="eyebrow">Как это работает</p>
        <h2>Три шага от бумажной накладной до письма «цена выросла»</h2>
        <ol class="how">
          <li><div><b>Снимите накладную</b><span>Фото с телефона или PDF от поставщика. Файл сжимается в браузере и уходит в защищённое хранилище.</span></div></li>
          <li><div><b>Проверьте, что прочитал AI</b><span>Каждая строка пересчитывается: количество × цена, сумма строк, итог. Ошибки подсвечены, их можно исправить.</span></div></li>
          <li><div><b>Получите алерт о росте цены</b><span>На сайте и по email, вместе с поставщиком, у которого тот же товар дешевле.</span></div></li>
        </ol>
      </section>
      <section class="band" id="numbers">
        <p class="eyebrow">Цифры</p>
        <dl class="numbers">
          <div><dt>99,2%</dt><dd>полей накладной AI прочитал верно на тестовом наборе из 12 накладных</dd></div>
          <div><dt>10–20 с</dt><dd>от фотографии до проверенных цен и алерта</dd></div>
          <div><dt>от 5%</dt><dd>порог роста цены для алерта, меняется в настройках</dd></div>
        </dl>
        <p class="foot small">SupplyRadar работает в облаке AWS, данные каждого аккаунта видит только его владелец.</p>
      </section>`;
    const card = app.querySelector("#auth-card");
    let focusForm = false;
    app.querySelectorAll("[data-scroll]").forEach((b) => b.addEventListener("click", () =>
      app.querySelector("#" + b.dataset.scroll).scrollIntoView({ behavior: "smooth", block: "start" })));

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

      card.innerHTML = `
            ${tabbed ? `
            <div class="tabs" role="group" aria-label="Вход или регистрация">
              <button type="button" data-mode="signin" aria-pressed="${mode === "signin"}">Вход</button>
              <button type="button" data-mode="signup" aria-pressed="${mode === "signup"}">Регистрация</button>
            </div>` : `<h2>${heading[0]}</h2><p class="small muted" style="margin:0">${heading[1]}</p>`}
            <form id="auth-form" novalidate>
              ${fields}
              <p class="field-error" id="auth-error" role="alert" hidden></p>
              <button class="primary" type="submit">${submit}<span class="arrow" aria-hidden="true">↗</span></button>
            </form>
            <div class="alt small">
              ${mode === "signin" ? '<button type="button" class="link" data-mode="forgot">Забыли пароль?</button>' : ""}
              ${mode === "confirm" || mode === "reset" ? '<button type="button" class="link" id="resend">Отправить код ещё раз</button>' : ""}
              ${tabbed ? "" : '<button type="button" class="link" data-mode="signin">Вернуться ко входу</button>'}
            </div>`;

      card.querySelectorAll("[data-mode]").forEach((b) =>
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
      // On a phone the keyboard would cover the page the visitor has not read yet.
      if (first && document.activeElement !== first && (focusForm || matchMedia("(min-width: 761px)").matches)) first.focus({ preventScroll: true });
      focusForm = true;

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
    const location_id = (document.getElementById("upload-location") || {}).value || undefined;
    const { invoice_id: id, upload } = await api("POST", "/uploads", { content_type: type, file_name: file.name, location_id });
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
    const locations = isNetwork() ? (await api("GET", "/locations").catch(() => ({ locations: [] }))).locations : [];
    const locName = Object.fromEntries(locations.map((l) => [l.location_id, l.name]));
    const real = invoices.filter((i) => !i.demo);
    const steps = [
      ["Загрузите первую накладную", real.length > 0, "#/invoices"],
      ["Укажите email для алертов", !!profile.email, "#/settings"],
      ["Добавьте накладную от второго поставщика: тогда появится сравнение цен", new Set(real.map((i) => i.supplier_name).filter(Boolean)).size > 1, "#/invoices"],
    ];
    const showStart = !storage.get("sr.startHidden") && steps.some(([, done]) => !done);

    app.innerHTML = `
      <div class="page-head"><h1>Накладные</h1></div>
      ${invoices.some((i) => i.demo) ? `<div class="card demo-banner" role="status">
        <div><b>Вы смотрите демо-данные.</b> <span class="small muted">Так выглядит сервис, когда накладные уже загружены. Свои накладные появятся рядом.</span></div>
        <button type="button" id="clear-demo">Удалить демо-данные</button></div>` : ""}
      ${showStart ? `<section class="card start" aria-labelledby="start-title">
        <div class="order-head"><h2 id="start-title" style="margin:0">Начало работы</h2><button type="button" class="link" id="hide-start">Скрыть</button></div>
        <ol class="steps">${steps.map(([text, done, href]) => `<li class="${done ? "done" : ""}">
          ${done ? '<span class="sr-only">Готово: </span>' : ""}${done ? esc(text) : `<a href="${href}">${esc(text)}</a>`}</li>`).join("")}</ol></section>` : ""}
      <div class="card upload" id="drop">
        <div class="upload-icon" aria-hidden="true">${ICONS.camera}</div>
        <div>
          <strong>Добавьте накладную</strong>
          <span class="small muted">Фото или PDF. AI прочитает строки и сверит цены за 10–20 секунд.</span>
        </div>
        <div class="actions">
          ${locations.length > 1 ? `<div class="loc-pick"><label for="upload-location">Точка</label>
            <select id="upload-location">${locations.map((l) => `<option value="${esc(l.location_id)}">${esc(l.name)}</option>`).join("")}</select></div>` : ""}
          <label class="button primary camera-only">
            Сфотографировать<input id="camera" class="sr-only" type="file" accept="image/*" capture="environment">
          </label>
          <label class="button">
            Выбрать файл<input id="picker" class="sr-only" type="file" accept="image/*,application/pdf">
          </label>
        </div>
        <div id="progress" class="progress" aria-live="polite"></div>
      </div>
      <div class="card flush" id="list"></div>`;

    const list = app.querySelector("#list");
    const drawList = () => {
      if (!invoices.length) {
        const tpl = BUSINESS[(profile || {}).business_type];
        list.innerHTML = emptyState("doc", "Пока нет накладных",
          "Загрузите первую накладную выше. Цены начнут сравниваться со второй поставки того же товара."
          + (tpl ? ` Для начала отслеживайте ${esc(tpl.watch)}.` : ""),
          '<button type="button" class="primary" id="seed-demo">Посмотреть на демо-данных</button>');
        return;
      }
      const q = listState.query.toLowerCase();
      const pred = FILTERS.find(([k]) => k === listState.filter)[2];
      const shown = invoices.filter((i) => pred(i) && (!q
        || [i.supplier_name, i.invoice_number, i.file_name].some((v) => String(v || "").toLowerCase().includes(q))));
      const rows = shown.map((i) => `
        <tr class="clickable" data-id="${esc(i.invoice_id)}">
          <td><a class="row-link" href="#/invoices/${esc(i.invoice_id)}">${esc(i.supplier_name || i.file_name || "Без названия")}</a>
            <span class="cell-sub">${locName[i.location_id] ? `${esc(locName[i.location_id])}, ` : ""}${i.invoice_number ? `№ ${esc(i.invoice_number)}` : ""}${i.lines ? `${i.invoice_number ? ", " : ""}${i.lines} ${plural(i.lines, "строка", "строки", "строк")}` : ""}</span></td>
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
            <button type="button" class="export" id="export">Скачать в Excel</button>
          </div>
          <div id="rows"></div>`;
        list.querySelector("#export").addEventListener("click", () => downloadCsv(`nakladnye-${today()}.csv`,
          ["Дата", "Поставщик", "Номер", "Сумма, ₸", "Строк", "Статус", "Замечаний"],
          invoices.map((i) => [(i.invoice_date || i.created_at || "").slice(0, 10), i.supplier_name || i.file_name || "",
            i.invoice_number || "", i.total == null ? "" : Number(i.total), i.lines || "", (STATUS[i.status] || [i.status])[0], i.issues || 0])));
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
    const demoBtn = (id, call, text) => app.querySelector(id)?.addEventListener("click", async (ev) => {
      const done = busyButton(ev.currentTarget, text);
      try { await call(); profile = null; reload(); } catch (err) { done(); if (!err.silent) toast(err.message, true); }
    });
    demoBtn("#seed-demo", () => api("POST", "/demo"), "Готовим…");
    demoBtn("#clear-demo", () => api("DELETE", "/demo"), "Удаляем…");
    app.querySelector("#hide-start")?.addEventListener("click", () => { storage.set("sr.startHidden", true); reload(); });

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
        <td class="num" data-label="Сумма"><input data-f="total" type="text" inputmode="decimal" value="${num(l.total)}" aria-label="Сумма" ${cls(i, "total")}><small class="cell-hint" hidden></small></td>
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
        const off = q != null && p != null && t != null && Math.abs(q * p - t) > 1;
        const hint = tr.querySelector(".cell-hint");
        tIn.classList.toggle("mismatch", off);
        hint.hidden = !off;
        hint.textContent = off ? `Кол-во × цена = ${money(Math.round(q * p * 100) / 100)}` : "";
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
        <span class="small muted">${items.length} ${plural(items.length, "товар", "товара", "товаров")}</span>
        <button type="button" class="export" id="export">Скачать в Excel</button></div>
      <div id="rows"></div>`;
    list.querySelector("#export").addEventListener("click", () => downloadCsv(`ceny-${today()}.csv`,
      ["Товар", "Единица", "Последняя цена, ₸", "Изменение, %", "Лучшая цена, ₸", "Лучший поставщик", "Поставщиков"],
      items.map((p) => {
        const { sup, change } = productStats(p);
        return [p.name, p.unit || "", p.last_price == null ? "" : Number(p.last_price),
          change == null ? "" : Math.round(change * 10) / 10, sup[0] ? Number(sup[0].price) : "", sup[0] ? sup[0].name : "", sup.length];
      })));
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
          return `<polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-dasharray="${DASHES[i % DASHES.length]}" points="${pts.map((p) => `${x(p.date)},${y(p.price)}`).join(" ")}"/>
            ${pts.map((p) => `<circle cx="${x(p.date)}" cy="${y(p.price)}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"><title>${esc(n)}: ${money(p.price)}, ${fmtDate(p.date)}</title></circle>`).join("")}`;
        }).join("")}
      </svg>`;
    const legend = names.map((n, i) => `<span><svg viewBox="0 0 28 10" aria-hidden="true"><line x1="0" y1="5" x2="28" y2="5" stroke="${COLORS[i % COLORS.length]}" stroke-width="2.5" stroke-dasharray="${DASHES[i % DASHES.length]}"/></svg>${esc(n)}</span>`).join("");
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
    const [data, contracts] = await Promise.all([api("GET", "/alerts"), api("GET", "/contracts").catch(() => null)]);
    if (!alive()) return;
    const alerts = data.alerts || [];
    alertCount.value = alerts.length;
    alertCount.at = Date.now();
    paintAlertCount();
    const total = alerts.reduce((s, a) => s + (a.new_price - a.old_price) * (a.quantity || 1), 0);
    app.innerHTML = `
      <div class="page-head"><h1>Алерты</h1></div>
      ${contracts && contracts.violations ? `<div class="card notice-card" role="status"><b>Цены выше договорных: ${contracts.violations}.</b>
        <a href="#/contracts">Посмотреть и написать претензию</a></div>` : ""}
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
            <button type="button" class="link claim-btn" data-claim data-invoice="${esc(a.invoice_id)}" data-product="${esc(a.product_key)}">Претензия поставщику</button>
          </div>
        </article>`).join("")
        : `<div class="card">${emptyState("bell", "Повышений цен пока нет",
          "Как только поставщик поднимет цену выше порога, алерт появится здесь и придёт на email.",
          '<a class="button" href="#/settings">Настроить порог</a>')}</div>`}`;
    app.querySelectorAll("[data-claim]").forEach((btn) => btn.addEventListener("click", () =>
      startClaim({ kind: "alert", invoice_id: btn.dataset.invoice, product_key: btn.dataset.product }, btn)));
  }

  // ------------------------------------------------------------ settings

  async function renderSettings(alive) {
    const s = await api("GET", "/settings");
    if (!alive()) return;
    profile = s;
    const supplier = s.business_type === "supplier";
    app.innerHTML = `
      <div class="page-head"><h1>Настройки</h1></div>
      <form class="card" id="settings" style="max-width:520px" novalidate>
        <h2>Бизнес</h2>
        <label for="business-type">Тип бизнеса</label>
        <select id="business-type">
          ${Object.entries(BUSINESS).map(([k, b]) => `<option value="${k}"${s.business_type === k ? " selected" : ""}>${b.label}</option>`).join("")}
        </select>
        <label for="business-name">Название</label>
        <input id="business-name" type="text" maxlength="80" autocomplete="organization" value="${esc(s.business_name || "")}">
        <p class="field-hint">Необязательно. Например, «Кофейня на Абая».</p>
        <label for="contact">${supplier ? "Контакты для заказов" : "Телефон или Telegram для связи с поставщиками"}</label>
        <input id="contact" type="text" maxlength="120" autocomplete="tel" value="${esc(s.contact || "")}">
        <p class="field-hint">Необязательно. ${supplier ? "Бизнесы видят это в вашем каталоге." : "Поставщик увидит это в вашей заявке."}</p>
        ${supplier ? "" : `<h2>Алерты</h2>
        <label for="threshold">Сообщать, если цена выросла больше чем на, %</label>
        <input id="threshold" type="number" inputmode="decimal" min="0.5" max="100" step="0.5" value="${esc(s.threshold_pct)}" required>
        <p class="field-hint">Например, 5 — алерт при росте цены больше чем на 5%.</p>
        <label for="email">Email для алертов и недельной сводки</label>
        <input id="email" type="email" inputmode="email" autocomplete="email" value="${esc(s.email || s.account_email || "")}">
        <p class="field-hint">Оставьте пустым, чтобы не получать письма.</p>
        ${s.email_pending ? '<p class="small notice" style="color:var(--warn);padding-left:10px">Подтвердите подписку: откройте письмо «AWS Notification - Subscription Confirmation» и нажмите ссылку.</p>' : ""}`}
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
      const threshold = supplier ? undefined : toNum(app.querySelector("#threshold").value);
      const email = supplier ? undefined : app.querySelector("#email").value.trim();
      const fail = (msg, input) => { errorEl.textContent = msg; errorEl.hidden = false; input.focus(); };
      if (!supplier && (threshold == null || threshold < 0.5 || threshold > 100)) return fail("Порог должен быть от 0,5 до 100%", app.querySelector("#threshold"));
      if (!supplier && email && !app.querySelector("#email").checkValidity()) return fail("Введите корректный email", app.querySelector("#email"));
      const done = busyButton(ev.submitter || form.querySelector("button[type=submit]"), "Сохраняем…");
      try {
        const r = await api("PUT", "/settings", { threshold_pct: threshold, email,
          business_type: app.querySelector("#business-type").value, business_name: app.querySelector("#business-name").value,
          contact: app.querySelector("#contact").value });
        profile = null;
        toast(r.message || "Настройки сохранены");
        reload();
      } catch (err) {
        done();
        if (!err.silent) { errorEl.textContent = err.message; errorEl.hidden = false; }
      }
    });
  }

  // ------------------------------------------------------------ welcome (business template)

  async function renderWelcome() {
    app.innerHTML = `
      <div class="page-head"><h1>Какой у вас бизнес?</h1>
        <p class="sub">Подберём порог алертов и подсказки под ваши закупки. Изменить выбор можно в настройках.</p></div>
      <form class="card" id="welcome" style="max-width:720px" novalidate>
        <fieldset class="templates">
          <legend>Тип бизнеса</legend>
          ${Object.entries(BUSINESS).map(([k, b]) => `
            <label class="template">
              <input type="radio" name="business_type" value="${k}">
              <span class="template-icon" aria-hidden="true">${ICONS[b.icon]}</span>
              <span><b>${b.label}</b><span class="small muted">${b.about}</span></span>
            </label>`).join("")}
        </fieldset>
        <p class="template-note small" id="template-note" aria-live="polite" hidden></p>
        <label for="business-name">Название <span class="muted">(необязательно)</span></label>
        <input id="business-name" type="text" maxlength="80" autocomplete="organization" placeholder="Кофейня на Абая">
        <label class="check"><input type="checkbox" id="load-demo" checked>
          <span>Показать сервис на демо-данных: пример накладных и алерт о росте цены. Удалить их можно в один клик.</span></label>
        <p class="field-error" id="welcome-error" role="alert" hidden></p>
        <div class="actionbar">
          <button class="primary" type="submit">Продолжить</button>
          <button class="link" type="button" id="skip">Пропустить</button>
        </div>
      </form>`;
    const form = app.querySelector("#welcome");
    const errorEl = app.querySelector("#welcome-error");
    const note = app.querySelector("#template-note");
    form.addEventListener("change", (e) => {
      if (e.target.name !== "business_type") return;
      const b = BUSINESS[e.target.value];
      errorEl.hidden = true;
      note.hidden = false;
      note.textContent = b.note || `Алерт придёт при росте цены больше чем на ${b.threshold}%. Советуем отслеживать ${b.watch}.`;
    });
    const save = async (type, btn) => {
      const done = busyButton(btn, "Сохраняем…");
      try {
        await api("PUT", "/settings", { business_type: type, threshold_pct: BUSINESS[type].threshold,
          business_name: app.querySelector("#business-name").value });
        if (type !== "supplier" && app.querySelector("#load-demo").checked) await api("POST", "/demo").catch(() => {});
        profile = null;
        location.hash = type === "supplier" ? "#/suppliers" : "#/invoices";
      } catch (err) {
        done();
        if (!err.silent) { errorEl.textContent = err.message; errorEl.hidden = false; }
      }
    };
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const picked = form.querySelector("input[name=business_type]:checked");
      if (!picked) {
        errorEl.textContent = "Выберите тип бизнеса";
        errorEl.hidden = false;
        form.querySelector("input[name=business_type]").focus();
        return;
      }
      save(picked.value, ev.submitter || form.querySelector("button[type=submit]"));
    });
    app.querySelector("#skip").addEventListener("click", (ev) => save("other", ev.currentTarget));
  }

  // ------------------------------------------------------------ suppliers, orders, plans, assistant, savings, recipes

  const isSupplier = () => (profile || {}).business_type === "supplier";
  const homeFor = (p) => (p && p.business_type === "supplier" ? "#/suppliers" : "#/invoices");
  const pct = (a, b) => (b ? (a - b) / b * 100 : 0);
  const stat = (label, value, hint) => `<div class="card"><div class="small muted">${label}</div><div class="v">${value}</div><div class="small muted">${hint || ""}</div></div>`;

  // A destructive button asks twice: the first press turns it into «Точно?», a second press within 4 s does it.
  function confirmButton(btn, action) {
    const label = btn.textContent;
    let timer = null;
    btn.addEventListener("click", () => {
      if (timer) { clearTimeout(timer); timer = null; btn.textContent = label; action(btn); return; }
      btn.textContent = "Точно?";
      timer = setTimeout(() => { timer = null; btn.textContent = label; }, 4000);
    });
  }

  // ---- directory (business side)

  async function renderSuppliers(alive) {
    if (isSupplier()) return renderCatalog(alive);
    const list = (await api("GET", "/suppliers")).suppliers || [];
    if (!alive()) return;
    app.innerHTML = `
      <div class="page-head"><h1>Поставщики</h1>
        <p class="sub">Каталоги поставщиков, которые зарегистрированы в SupplyRadar. Откройте каталог, выберите товары и отправьте заявку.</p></div>
      <div class="actionbar" style="margin:0 0 14px"><a class="button" href="#/orders">Мои заявки</a></div>
      ${list.length ? `
        <div class="card flush"><div class="toolbar"><div class="search"><input id="search" type="search" placeholder="Поставщик или товар" aria-label="Поиск поставщика"></div></div></div>
        <ul class="tiles" id="sup-list"></ul>`
        : `<div class="card">${emptyState("truck", "Каталогов пока нет",
          "Как только поставщики добавят товары, они появятся здесь. Поставщик регистрируется сам и выбирает «Я поставщик».")}</div>`}`;
    if (!list.length) return;
    const ul = app.querySelector("#sup-list");
    const draw = (q = "") => {
      const shown = list.filter((s) => `${s.name} ${(s.sample || []).join(" ")}`.toLowerCase().includes(q));
      ul.innerHTML = shown.length ? shown.map((s) => `
        <li><a class="card tile" href="#/suppliers/${esc(s.supplier_id)}">
          <span class="tile-icon" aria-hidden="true">${ICONS.truck}</span>
          <span class="tile-text"><b>${esc(s.name)}</b>
            <span class="small muted">${s.items_count} ${plural(s.items_count, "товар", "товара", "товаров")}: ${esc((s.sample || []).join(", "))}</span></span>
        </a></li>`).join("") : `<li class="card">${emptyState("search", "Ничего не найдено", "Попробуйте другое название.")}</li>`;
    };
    app.querySelector("#search").addEventListener("input", (e) => draw(e.target.value.trim().toLowerCase()));
    draw();
  }

  async function renderSupplier(id, alive) {
    if (isSupplier()) { location.hash = "#/suppliers"; return; }
    const s = await api("GET", `/suppliers/${encodeURIComponent(id)}`);
    if (!alive()) return;
    const compare = (i) => {
      const own = i.yours && i.yours.best_price;
      if (!own) return "";
      const d = pct(i.price, own);
      const text = d <= -0.5 ? `<span class="badge ok">дешевле вашей на ${Math.abs(d).toFixed(0)}%</span>`
        : d >= 0.5 ? `<span class="badge warn">дороже вашей на ${d.toFixed(0)}%</span>` : '<span class="muted small">цена как у вас</span>';
      return `<span class="cell-sub">${text} Ваша лучшая цена: ${money(own)}</span>`;
    };
    app.innerHTML = `
      <a class="back" href="#/suppliers">← Поставщики</a>
      <div class="page-head"><h1>${esc(s.name)}</h1>
        <p class="sub">${s.contact ? `Контакты: ${esc(s.contact)}. ` : ""}Укажите количество и отправьте заявку: цена берётся из каталога.</p></div>
      <form class="card flush" id="order-form" novalidate>
        <div class="table-wrap"><table>
          <thead><tr><th>Товар</th><th class="num">Цена</th><th class="num">Количество</th></tr></thead>
          <tbody>${s.items.map((i) => `
            <tr>
              <td>${esc(i.name)}${i.in_stock ? "" : ' <span class="badge bad">нет в наличии</span>'}${compare(i)}
                ${i.min_order ? `<span class="cell-sub">Минимальный заказ: ${esc(i.min_order)} ${esc(i.unit)}</span>` : ""}</td>
              <td class="num">${money(i.price)}<span class="cell-sub">за ${esc(i.unit)}</span></td>
              <td class="num"><input class="qty" type="number" inputmode="decimal" min="0" step="any" data-id="${esc(i.item_id)}" data-price="${esc(i.price)}"
                aria-label="Количество: ${esc(i.name)}" ${i.in_stock ? "" : "disabled"}></td>
            </tr>`).join("")}</tbody></table></div>
        <div class="order-foot">
          <label for="note">Комментарий поставщику <span class="muted">(необязательно)</span></label>
          <input id="note" maxlength="300" placeholder="Например: привезти к 8 утра">
          <p class="field-error" id="order-error" role="alert" hidden></p>
          <div class="actionbar"><button class="primary" type="submit">Отправить заявку</button>
            <span>Итого: <b id="order-total">0 ₸</b></span></div>
        </div>
      </form>`;
    const form = app.querySelector("#order-form");
    const errorEl = app.querySelector("#order-error");
    const lines = () => [...form.querySelectorAll("input.qty")].map((i) => ({ item_id: i.dataset.id, qty: toNum(i.value), price: Number(i.dataset.price) }))
      .filter((l) => l.qty && l.qty > 0);
    form.addEventListener("input", () => {
      errorEl.hidden = true;
      app.querySelector("#order-total").textContent = money(Math.round(lines().reduce((t, l) => t + l.qty * l.price, 0) * 100) / 100);
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const picked = lines();
      if (!picked.length) {
        errorEl.textContent = "Укажите количество хотя бы у одного товара";
        errorEl.hidden = false;
        form.querySelector("input.qty:not([disabled])")?.focus();
        return;
      }
      const done = busyButton(form.querySelector("button[type=submit]"), "Отправляем…");
      try {
        await api("POST", "/orders", { supplier_id: id, note: form.querySelector("#note").value,
          lines: picked.map(({ item_id, qty }) => ({ item_id, qty })) });
        toast("Заявка отправлена поставщику");
        location.hash = "#/orders";
      } catch (err) {
        done();
        if (!err.silent) { errorEl.textContent = err.message; errorEl.hidden = false; }
      }
    });
  }

  // ---- catalog (supplier side)

  async function renderCatalog(alive) {
    const data = await api("GET", "/catalog");
    if (!alive()) return;
    const items = data.items || [];
    app.innerHTML = `
      <div class="page-head"><h1>Каталог</h1>
        <p class="sub">Ваши товары и цены видят все бизнесы в SupplyRadar и могут отправить вам заявку.</p></div>
      <form class="card" id="item-form" style="max-width:640px" novalidate>
        <h2 id="item-form-title">Новый товар</h2>
        <label for="i-name">Название</label>
        <input id="i-name" maxlength="120" required placeholder="Молоко 3,2% 1 л">
        <div class="form-row">
          <div><label for="i-price">Цена, ₸</label><input id="i-price" type="number" inputmode="decimal" min="0" step="any" required></div>
          <div><label for="i-unit">Единица</label><input id="i-unit" maxlength="20" value="шт"></div>
          <div><label for="i-min">Мин. заказ <span class="muted">(необяз.)</span></label><input id="i-min" type="number" inputmode="decimal" min="0" step="any"></div>
        </div>
        <p class="field-error" id="item-error" role="alert" hidden></p>
        <div class="actionbar"><button class="primary" type="submit" id="item-save">Добавить</button>
          <button type="button" id="item-cancel" hidden>Отменить изменение</button></div>
      </form>
      <div class="card flush">
        <div class="toolbar"><h2 style="margin:0">Товары</h2>
          <span class="small muted">${items.length} из ${data.limit}${items.length >= data.limit && data.plan === "free" ? ' · <a href="#/subscription">Больше позиций на тарифе Pro</a>' : ""}</span>
          <label class="button export">Загрузить прайс (CSV)<input id="import" class="sr-only" type="file" accept=".csv,.txt,text/csv,text/plain"></label></div>
        ${items.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Товар</th><th class="num">Цена</th><th class="num">Действия</th></tr></thead>
          <tbody>${items.map((i) => `
            <tr data-id="${esc(i.item_id)}">
              <td>${esc(i.name)}${i.in_stock ? "" : ' <span class="badge bad">нет в наличии</span>'}
                <span class="cell-sub">за ${esc(i.unit)}${i.min_order ? `, от ${esc(i.min_order)}` : ""}</span></td>
              <td class="num">${money(i.price)}</td>
              <td class="num"><div class="row-actions">
                <button type="button" data-edit>Изменить</button>
                <button type="button" data-stock aria-pressed="${i.in_stock}">${i.in_stock ? "Убрать из наличия" : "Вернуть в наличие"}</button>
                <button type="button" data-delete>Удалить</button></div></td>
            </tr>`).join("")}</tbody></table></div>`
          : emptyState("box", "Каталог пуст", "Добавьте первый товар выше или загрузите прайс из CSV: «Название;Единица;Цена» в каждой строке.")}
      </div>`;
    const form = app.querySelector("#item-form");
    const errorEl = app.querySelector("#item-error");
    let editing = null;
    const setMode = (item) => {
      editing = item ? item.item_id : null;
      form.querySelector("#item-form-title").textContent = item ? "Изменить товар" : "Новый товар";
      form.querySelector("#item-save").textContent = item ? "Сохранить" : "Добавить";
      form.querySelector("#item-cancel").hidden = !item;
      form.querySelector("#i-name").value = item ? item.name : "";
      form.querySelector("#i-price").value = item ? item.price : "";
      form.querySelector("#i-unit").value = item ? item.unit : "шт";
      form.querySelector("#i-min").value = item && item.min_order ? item.min_order : "";
      errorEl.hidden = true;
    };
    form.querySelector("#item-cancel").addEventListener("click", () => setMode(null));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const price = toNum(form.querySelector("#i-price").value);
      const name = form.querySelector("#i-name").value.trim();
      const fail = (msg, el) => { errorEl.textContent = msg; errorEl.hidden = false; el.focus(); };
      if (!name) return fail("Введите название товара", form.querySelector("#i-name"));
      if (price == null || price <= 0) return fail("Укажите цену больше нуля", form.querySelector("#i-price"));
      const body = { name, price, unit: form.querySelector("#i-unit").value.trim() || "шт", min_order: toNum(form.querySelector("#i-min").value) };
      const done = busyButton(form.querySelector("#item-save"), "Сохраняем…");
      try {
        if (editing) await api("PUT", `/catalog/${editing}`, body); else await api("POST", "/catalog", body);
        toast(editing ? "Товар обновлён" : "Товар добавлен");
        reload();
      } catch (err) {
        done();
        if (!err.silent) fail(err.message, form.querySelector("#i-name"));
      }
    });
    app.querySelectorAll("tr[data-id]").forEach((tr) => {
      const item = items.find((i) => i.item_id === tr.dataset.id);
      tr.querySelector("[data-edit]").addEventListener("click", () => { setMode(item); form.scrollIntoView({ block: "center" }); form.querySelector("#i-name").focus(); });
      tr.querySelector("[data-stock]").addEventListener("click", async () => {
        try { await api("PUT", `/catalog/${item.item_id}`, { in_stock: !item.in_stock }); reload(); } catch (err) { if (!err.silent) toast(err.message, true); }
      });
      confirmButton(tr.querySelector("[data-delete]"), async () => {
        try { await api("DELETE", `/catalog/${item.item_id}`); toast("Товар удалён"); reload(); } catch (err) { if (!err.silent) toast(err.message, true); }
      });
    });
    // Price list import: one product per line, «Название;Единица;Цена» (or just «Название;Цена»), as Excel saves CSV.
    app.querySelector("#import").addEventListener("change", async (ev) => {
      const file = ev.target.files[0];
      ev.target.value = "";
      if (!file) return;
      const rows = (await file.text()).replace(/^﻿/, "").split(/\r?\n/).map((l) => l.split(/;|\t/)).slice(0, 200)
        .map((c) => (c.length === 1 ? c[0].split(",") : c).map((x) => x.trim().replace(/^"|"$/g, "")))
        .map((c) => ({ name: c[0], unit: c.length > 2 ? c[1] : "шт", price: toNum(c[c.length - 1]) }))
        .filter((r) => r.name && r.price > 0);
      if (!rows.length) { toast("В файле не нашлось строк «Название;Единица;Цена»", true); return; }
      let added = 0;
      try {
        for (const r of rows) { await api("POST", "/catalog", r); added++; }
        toast(`Добавлено товаров: ${added}`);
      } catch (err) {
        if (!err.silent) toast(`Добавлено ${added} из ${rows.length}. ${err.message}`, true);
      }
      reload();
    });
  }

  // ---- orders (both sides)

  const ORDER_STATUS = {
    new: ["Новая", "info"], accepted: ["Принята", "ok"], rejected: ["Отклонена", "bad"],
    delivered: ["Доставлена", "ok"], cancelled: ["Отменена", "warn"],
  };
  Object.assign(STATUS, ORDER_STATUS);

  async function renderOrders(alive) {
    const orders = (await api("GET", "/orders")).orders || [];
    if (!alive()) return;
    const seller = isSupplier();
    const actions = (o) => {
      if (seller && o.status === "new") return [["accepted", "Принять", "primary"], ["rejected", "Отклонить", ""]];
      if (seller && o.status === "accepted") return [["delivered", "Отметить доставленной", "primary"], ["rejected", "Отменить", ""]];
      if (!seller && o.status === "new") return [["cancelled", "Отменить заявку", ""]];
      return [];
    };
    app.innerHTML = `
      <div class="page-head"><h1>Заявки</h1>
        <p class="sub">${seller ? "Заявки от бизнеса. Принятую заявку отметьте доставленной." : "Ваши заявки поставщикам и их статусы."}</p></div>
      ${orders.length ? orders.map((o) => `
        <article class="card order" data-id="${esc(o.order_id)}">
          <div class="order-head">
            <div><div class="title">${esc(seller ? o.buyer_name : o.supplier_name)}</div>
              <div class="small muted">${fmtDate(o.created_at)}${seller && o.buyer_contact ? `, контакты: ${esc(o.buyer_contact)}` : ""}</div></div>
            <div>${badge(o.status)}<div class="order-total">${money(o.total)}</div></div>
          </div>
          ${o.note ? `<p class="small">Комментарий: ${esc(o.note)}</p>` : ""}
          <details><summary>Состав заявки (${o.lines.length})</summary>
            <table><thead><tr><th>Товар</th><th class="num">Кол-во</th><th class="num">Сумма</th></tr></thead>
            <tbody>${o.lines.map((l) => `<tr><td>${esc(l.name)}<span class="cell-sub">${money(l.price)} за ${esc(l.unit)}</span></td>
              <td class="num">${esc(l.qty)}</td><td class="num">${money(l.total)}</td></tr>`).join("")}</tbody></table></details>
          <div class="actionbar">${actions(o).map(([s, label, cls]) => `<button type="button" class="${cls}" data-status="${s}">${label}</button>`).join("")}</div>
        </article>`).join("")
        : `<div class="card">${emptyState("doc", "Заявок пока нет", seller
          ? "Когда бизнес отправит заявку, она появится здесь."
          : "Откройте каталог поставщика, выберите товары и отправьте первую заявку.",
        seller ? "" : '<a class="button primary" href="#/suppliers">К поставщикам</a>')}</div>`}`;
    app.querySelectorAll(".order").forEach((card) => card.querySelectorAll("[data-status]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const done = busyButton(btn, "Сохраняем…");
        try {
          await api("PUT", `/orders/${card.dataset.id}`, { status: btn.dataset.status });
          toast("Статус заявки обновлён");
          reload();
        } catch (err) { done(); if (!err.silent) toast(err.message, true); }
      })));
  }

  // ---- subscription (demo payment)

  const PLAN_FEATURES = {
    free: ["Накладные, сверка сумм и алерты на email", "Дашборд переплат, претензии поставщикам", "Заявки поставщикам", "До 3 рецептов и 3 договорных цен"],
    pro: ["Всё из бесплатного", "AI-помощник по вашим закупкам, до 30 вопросов в день", "Рецепты и договорные цены без ограничений"],
    network: ["Всё из Pro", "До 10 точек в одном аккаунте", "Накладные по точкам и сравнение точек"],
    supplier_free: ["Каталог до 20 товаров", "Заявки от бизнеса"],
    supplier_pro: ["Каталог до 200 товаров", "Всё из бесплатного"],
  };

  async function renderSubscription(alive) {
    const sub = await api("GET", "/subscription");
    if (!alive()) return;
    const features = (p) => PLAN_FEATURES[p.id === "free" && sub.role === "supplier" ? "supplier_free" : p.id] || [];
    const until = sub.plan_until ? fmtDate(sub.plan_until) : "";
    app.innerHTML = `
      <div class="page-head"><h1>Подписка</h1>
        <p class="sub">Сейчас оплата демонстрационная: деньги не списываются, данные карты не нужны.</p></div>
      <div class="plans">
        ${sub.plans.map((p) => `
          <article class="card plan${p.id === sub.plan ? " current" : ""}" aria-labelledby="plan-${p.id}">
            <h2 id="plan-${p.id}">${esc(p.name)} ${p.id === sub.plan ? '<span class="badge ok">Ваш тариф</span>' : ""}</h2>
            <div class="plan-price">${p.price ? `${money(p.price)} <span class="small muted">в месяц</span>` : "0 ₸"}</div>
            <ul class="plain">${features(p).map((f) => `<li>${f}</li>`).join("")}</ul>
            ${p.id === sub.plan ? `<p class="small muted">${until ? `Действует до ${until}` : "Включён всегда"}</p>`
              : p.price ? `<button type="button" class="primary" data-plan="${p.id}">Подключить ${esc(p.name)}</button>`
              : '<button type="button" data-plan="free">Вернуться на бесплатный</button>'}
          </article>`).join("")}
      </div>
      <div class="card" id="demo-pay" tabindex="-1" hidden style="max-width:640px">
        <h2 id="demo-title"></h2>
        <p>Это учебный проект: оплата демонстрационная. Деньги не списываются, карту вводить не нужно. Тариф включится на 30 дней.</p>
        <p class="field-error" id="pay-error" role="alert" hidden></p>
        <div class="actionbar"><button type="button" class="primary" id="pay-go"></button><button type="button" id="pay-cancel">Отмена</button></div>
      </div>
      ${sub.payments.length ? `<div class="card flush"><div class="toolbar"><h2 style="margin:0">История платежей</h2></div>
        <table><thead><tr><th>Дата</th><th>Тариф</th><th class="num">Сумма</th></tr></thead>
        <tbody>${sub.payments.map((p) => `<tr><td>${fmtDate(p.created_at)}</td><td>${esc((sub.plans.find((x) => x.id === p.plan) || {}).name || p.plan)} <span class="badge soon">демо</span></td>
          <td class="num">${money(p.amount)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
    const panel = app.querySelector("#demo-pay");
    const errorEl = app.querySelector("#pay-error");
    let chosen = null;
    const choose = async (id) => {
      const plan = sub.plans.find((p) => p.id === id);
      if (!plan.price) { // going back to free needs no payment
        try { await api("POST", "/subscription", { plan: id }); profile = null; toast("Вы на бесплатном тарифе"); reload(); } catch (err) { if (!err.silent) toast(err.message, true); }
        return;
      }
      chosen = id;
      panel.hidden = false;
      errorEl.hidden = true;
      app.querySelector("#demo-title").textContent = `Демо-оплата: ${plan.name}, ${money(plan.price)}`;
      app.querySelector("#pay-go").textContent = `Включить ${plan.name} на 30 дней`;
      panel.focus();
    };
    app.querySelectorAll("[data-plan]").forEach((b) => b.addEventListener("click", () => choose(b.dataset.plan)));
    app.querySelector("#pay-cancel").addEventListener("click", () => { panel.hidden = true; });
    app.querySelector("#pay-go").addEventListener("click", async (ev) => {
      const done = busyButton(ev.currentTarget, "Подключаем…");
      try {
        const r = await api("POST", "/subscription", { plan: chosen, demo: true });
        profile = null;
        toast(`Тариф включён до ${fmtDate(r.plan_until)}`);
        reload();
      } catch (err) { done(); if (!err.silent) { errorEl.textContent = err.message; errorEl.hidden = false; } }
    });
  }

  // ---- assistant

  const chat = [];
  const QUESTIONS = ["Где я переплачиваю больше всего?", "Что подорожало за последний месяц?", "У кого из поставщиков дешевле?", "Как снизить расходы на закупки?"];

  async function renderAssistant() {
    const p = await loadProfile();
    if (!isPro()) {
      app.innerHTML = `
        <a class="back" href="#/more">← Ещё</a>
        <div class="page-head"><h1>AI-помощник</h1></div>
        <div class="card" style="max-width:640px">${emptyState("chat", "Помощник входит в тариф Pro",
          "Он отвечает на вопросы по вашим накладным: где вы переплатили, что подорожало, у кого дешевле. Подключить Pro можно в демо-режиме, деньги не списываются.",
          '<a class="button primary" href="#/subscription">Посмотреть тарифы</a>')}</div>`;
      return;
    }
    app.innerHTML = `
      <a class="back" href="#/more">← Ещё</a>
      <div class="page-head"><h1>AI-помощник</h1>
        <p class="sub">Отвечает по данным ваших накладных за последние месяцы. Проверяйте важные цифры в разделах «Товары» и «Переплаты».</p></div>
      <div class="card chat-card">
        <div id="log" class="chat" role="log" aria-live="polite" aria-label="Диалог с помощником"></div>
        <div class="chips" role="group" aria-label="Примеры вопросов">${QUESTIONS.map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
        <form id="ask" novalidate>
          <label for="question">Ваш вопрос</label>
          <textarea id="question" rows="2" maxlength="500" placeholder="Например: сколько я переплатил за молоко?"></textarea>
          <p class="field-error" id="ask-error" role="alert" hidden></p>
          <div class="actionbar"><button class="primary" type="submit">Спросить</button><span class="small muted" id="remaining"></span></div>
        </form>
      </div>`;
    const logEl = app.querySelector("#log");
    const question = app.querySelector("#question");
    const errorEl = app.querySelector("#ask-error");
    const paint = () => {
      logEl.innerHTML = chat.length ? chat.map((m) => `<div class="bubble ${m.role}"><span class="sr-only">${m.role === "user" ? "Вы: " : "Помощник: "}</span>${esc(m.text)}</div>`).join("")
        : '<p class="muted small">Задайте вопрос или выберите пример ниже.</p>';
      logEl.scrollTop = logEl.scrollHeight;
    };
    paint();
    const ask = async (text) => {
      errorEl.hidden = true;
      if (!text) { errorEl.textContent = "Введите вопрос"; errorEl.hidden = false; question.focus(); return; }
      const btn = app.querySelector("#ask button[type=submit]");
      chat.push({ role: "user", text });
      paint();
      question.value = "";
      const done = busyButton(btn, "Думаю…");
      try {
        const r = await api("POST", "/assistant", { question: text });
        chat.push({ role: "bot", text: r.answer });
        app.querySelector("#remaining").textContent = `Осталось вопросов сегодня: ${r.remaining}`;
      } catch (err) {
        chat.pop();
        question.value = text;
        if (!err.silent) { errorEl.textContent = err.message; errorEl.hidden = false; }
      }
      done();
      paint();
    };
    app.querySelector("#ask").addEventListener("submit", (ev) => { ev.preventDefault(); ask(question.value.trim()); });
    app.querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => ask(b.dataset.q)));
  }

  // ------------------------------------------------------------ savings report, claims, contracts, points

  const isPro = () => ["pro", "network"].includes((profile || {}).plan);
  const isNetwork = () => (profile || {}).plan === "network";
  const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
  const pctText = (v) => String(v).replace(".", ",");

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Текст скопирован");
    } catch {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.append(ta);
      ta.select();
      try { document.execCommand("copy"); toast("Текст скопирован"); } catch { toast("Не удалось скопировать: выделите текст и скопируйте вручную", true); }
      ta.remove();
    }
  }

  // ---- savings: «Вернём переплату»

  async function renderSavings(alive) {
    const d = await api("GET", "/savings");
    if (!alive()) return;
    const empty = !d.spent;
    const pb = d.payback;
    const trend = d.previous_overpay
      ? ` В прошлом периоде было ${money(d.previous_overpay)}: ${d.overpay > d.previous_overpay ? "стало хуже" : d.overpay < d.previous_overpay ? "стало лучше" : "без изменений"}.`
      : "";
    const planText = isPro() ? "Ваш тариф уже включён, возвращённые деньги идут в плюс."
      : pb.pays_back ? `Это больше, чем стоит Pro (${money(pb.pro_price)} в месяц): подписка окупится.`
        : `Pro стоит ${money(pb.pro_price)} в месяц и окупится, когда вы вернёте столько же.`;
    const maxMonth = Math.max(1, ...d.by_month.map((m) => m.spent));
    app.innerHTML = `
      <a class="back" href="#/more">← Ещё</a>
      <div class="page-head"><h1>Переплаты</h1>
        <p class="sub">Сколько вы заплатили за ${d.period_days} дней сверх лучшей цены среди ваших поставщиков.</p></div>
      ${empty ? `<div class="card">${emptyState("chart", "Пока нет закупок за этот период",
        "Загрузите накладные: переплаты считаются по товарам, которые вы покупали у разных поставщиков. Или посмотрите на демо-данных.",
        '<a class="button primary" href="#/invoices">К накладным</a>')}</div>` : `
      <section class="card payback" aria-labelledby="pb-title">
        <h2 id="pb-title">Вернём переплату</h2>
        <p>${d.overpay
          ? `За ${d.period_days} дней вы заплатили сверх лучшей цены <b>${money(d.overpay)}</b> (${pctText(d.overpay_pct)}% закупок).${trend}
             Если вернуть хотя бы треть, это ${money(pb.recoverable)}. ${planText}`
          : `За ${d.period_days} дней вы покупали по лучшим ценам. Чтобы следить и за ростом цен, задайте договорные цены.`}</p>
        <div class="actionbar">
          <a class="button primary" href="#/alerts">${d.overpay ? "Написать претензии по алертам" : "Смотреть алерты"}</a>
          <a class="button" href="#/contracts">Контрактные цены</a>
          <a class="button" href="#/claims">Мои претензии</a>
          ${isPro() ? "" : '<a class="button" href="#/subscription">Тариф Pro</a>'}
        </div>
      </section>
      <div class="facts four">
        ${stat("Закупок", money(d.spent), `за ${d.period_days} дней`)}
        ${stat("Переплата", money(d.overpay), `${pctText(d.overpay_pct)}% от закупок`)}
        ${stat("Можно вернуть", money(pb.recoverable), "треть переплаты")}
        ${stat("Уже вернули", money(d.refunded), "по решённым претензиям")}
      </div>
      <div class="card flush"><div class="toolbar"><h2 style="margin:0">Где переплачено</h2>
          ${d.items.length ? '<button type="button" class="export" id="export">Скачать в Excel</button>' : ""}</div>
        ${d.items.length ? `<div class="table-wrap"><table class="responsive">
          <thead><tr><th>Товар</th><th class="num">Куплено</th><th class="num">Переплата</th><th class="num">Лучшая цена</th></tr></thead>
          <tbody>${d.items.map((i) => `<tr class="clickable" data-key="${esc(i.product_key)}">
            <td data-m="wide"><a class="row-link" href="#/products/${encodeURIComponent(i.product_key)}">${esc(i.name)}</a>
              <span class="cell-sub">Платили в среднем ${money(i.paid_avg)}</span></td>
            <td class="num" data-m="sub">${esc(i.qty)} ${esc(i.unit || "")}</td>
            <td class="num"><b>${money(i.overpay)}</b></td>
            <td class="num" data-m="hide">${money(i.best_price)}<span class="cell-sub">${esc(i.best_supplier || "")}</span></td></tr>`).join("")}</tbody></table></div>`
          : '<p class="muted" style="padding:16px 22px;margin:0">Переплат нет: вы покупали по лучшим ценам. Так держать.</p>'}</div>
      ${d.by_supplier.length ? `<div class="card flush" style="margin-top:16px"><div class="toolbar"><h2 style="margin:0">Переплата по поставщикам</h2></div>
        <table><thead><tr><th>Поставщик</th><th class="num">Переплата</th></tr></thead>
        <tbody>${d.by_supplier.map((s) => `<tr><td>${esc(s.supplier)}</td><td class="num">${money(s.overpay)}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <div class="card flush" style="margin-top:16px"><div class="toolbar"><h2 style="margin:0">Отчёт по месяцам</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Месяц</th><th class="num">Закупки</th><th class="num">Переплата</th><th class="hide-sm"><span class="sr-only">Доля месяца</span></th></tr></thead>
          <tbody>${d.by_month.map((m) => `<tr><td>${esc(monthName(m.month))}</td><td class="num">${money(m.spent)}</td><td class="num">${money(m.overpay)}</td>
            <td class="bar-cell hide-sm" aria-hidden="true"><span class="bar"><i style="width:${Math.round(m.spent / maxMonth * 100)}%"></i><b style="width:${Math.round(m.overpay / maxMonth * 100)}%"></b></span></td></tr>`).join("")}</tbody></table></div>
        <p class="small muted" style="padding:0 22px 16px">Переплата месяца считается по лучшей цене, доступной сейчас. Длинная полоса: закупки, тёмная часть: переплата.</p></div>`}`;
    app.querySelectorAll("tr[data-key]").forEach((tr) =>
      tr.addEventListener("click", (e) => { if (!e.target.closest("a")) location.hash = `#/products/${encodeURIComponent(tr.dataset.key)}`; }));
    const exp = app.querySelector("#export");
    if (exp) exp.addEventListener("click", () => downloadCsv(`pereplaty-${today()}.csv`,
      ["Товар", "Куплено", "Единица", "Платили в среднем, ₸", "Лучшая цена, ₸", "Лучший поставщик", "Переплата, ₸"],
      d.items.map((i) => [i.name, i.qty, i.unit || "", i.paid_avg, i.best_price, i.best_supplier || "", i.overpay])));
  }

  // ---- claims to suppliers

  const CLAIM_STATUS = { draft: ["Черновик", "warn"], sent: ["Отправлена", "warn"], resolved: ["Решена", "ok"], rejected: ["Отказ", "bad"] };
  Object.assign(STATUS, CLAIM_STATUS);
  let openClaim = null;

  async function startClaim(body, btn) {
    const done = busyButton(btn, "Готовим…");
    try {
      const c = await api("POST", "/claims", body);
      openClaim = c.claim_id;
      toast("Черновик претензии готов");
      location.hash = "#/claims";
    } catch (err) {
      done();
      if (!err.silent) toast(err.message, true);
    }
  }

  async function renderClaims(alive) {
    const data = await api("GET", "/claims");
    if (!alive()) return;
    const claims = data.claims || [];
    const open = openClaim;
    openClaim = null;
    const total = claims.reduce((t, c) => t + (c.amount || 0), 0);
    const actions = (c) => ({
      draft: [["sent", "Отметить отправленной", "primary"]],
      sent: [["resolve", "Поставщик вернул деньги", "primary"], ["rejected", "Поставщик отказал", ""]],
      resolved: [], rejected: [],
    }[c.status] || []);
    app.innerHTML = `
      <a class="back" href="#/more">← Ещё</a>
      <div class="page-head"><h1>Претензии поставщикам</h1>
        <p class="sub">Готовый текст с цифрами и номером накладной. Скопируйте его или откройте в почте и отправьте поставщику сами.</p></div>
      <div class="facts">
        ${stat("Претензий", claims.length, "всего")}
        ${stat("На сумму", money(total), "разница в ценах")}
        ${stat("Вернули", money(data.refunded), "по решённым")}
      </div>
      ${claims.length ? claims.map((c) => `
        <article class="card claim" data-id="${esc(c.claim_id)}">
          <div class="order-head">
            <div><div class="title">${esc(c.subject)}</div>
              <div class="small muted">${esc(c.supplier_name || "")} · ${fmtDate(c.created_at)}</div></div>
            <div>${badge(c.status)}<div class="order-total">${money(c.status === "resolved" ? c.refund : c.amount)}</div>
              ${c.status === "resolved" ? '<div class="small muted">возвращено</div>' : ""}</div>
          </div>
          <details${c.claim_id === open || c.status === "draft" ? " open" : ""}><summary>Текст претензии</summary>
            <pre class="claim-text">${esc(c.text)}</pre>
            <div class="actionbar">
              <button type="button" data-copy>Скопировать текст</button>
              <a class="button" href="mailto:?subject=${encodeURIComponent(c.subject)}&body=${encodeURIComponent(c.text)}">Открыть в почте</a>
              ${c.invoice_id ? `<a class="button" href="#/invoices/${esc(c.invoice_id)}">Накладная для вложения</a>` : ""}
            </div></details>
          <div class="actionbar">${actions(c).map(([s, label, cls]) => `<button type="button" class="${cls}" data-status="${s}">${label}</button>`).join("")}</div>
          <form class="refund" hidden novalidate>
            <label for="refund-${esc(c.claim_id)}">Сколько вернул поставщик, ₸</label>
            <input id="refund-${esc(c.claim_id)}" type="number" inputmode="decimal" min="0" step="any" value="${esc(c.amount)}">
            <div class="actionbar"><button class="primary" type="submit">Сохранить</button></div>
          </form>
        </article>`).join("")
        : `<div class="card">${emptyState("doc", "Претензий пока нет",
          "Откройте «Алерты» и нажмите «Претензия поставщику» у подорожавшего товара, или задайте договорные цены.",
          '<a class="button primary" href="#/alerts">К алертам</a>')}</div>`}`;
    app.querySelectorAll(".claim").forEach((card) => {
      const c = claims.find((x) => x.claim_id === card.dataset.id);
      card.querySelector("[data-copy]").addEventListener("click", () => copyText(c.text));
      const form = card.querySelector(".refund");
      const save = async (body, btn) => {
        const done = busyButton(btn, "Сохраняем…");
        try { await api("PUT", `/claims/${c.claim_id}`, body); toast("Статус претензии обновлён"); reload(); } catch (err) { done(); if (!err.silent) toast(err.message, true); }
      };
      card.querySelectorAll("[data-status]").forEach((btn) => btn.addEventListener("click", () => {
        if (btn.dataset.status === "resolve") { form.hidden = false; form.querySelector("input").focus(); return; }
        save({ status: btn.dataset.status }, btn);
      }));
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        save({ status: "resolved", refund: toNum(form.querySelector("input").value) }, form.querySelector("button[type=submit]"));
      });
    });
  }

  // ---- contract prices

  async function renderContracts(alive) {
    const d = await api("GET", "/contracts");
    if (!alive()) return;
    const status = (c) => c.status === "over" ? `<span class="badge bad">Выше договора на ${pctText(c.deviation_pct)}%</span>`
      : c.status === "ok" ? '<span class="badge ok">В норме</span>' : '<span class="badge soon">Нет данных</span>';
    app.innerHTML = `
      <a class="back" href="#/more">← Ещё</a>
      <div class="page-head"><h1>Контрактные цены</h1>
        <p class="sub">Укажите цену из договора с поставщиком. Если в накладной она выше допуска, вы увидите это сразу и сможете отправить претензию.</p></div>
      ${d.violations ? `<div class="card notice-card" role="status"><b>Выше договорных цен: ${d.violations} ${plural(d.violations, "товар", "товара", "товаров")}.</b>
        Переплата с начала контроля: ${money(d.overpay)}.</div>` : ""}
      <form class="card" id="contract-form" style="max-width:640px" novalidate>
        <h2>Новая договорная цена</h2>
        ${d.candidates.length ? `
          <label for="c-pair">Товар и поставщик</label>
          <select id="c-pair">${d.candidates.map((c, i) => `<option value="${i}">${esc(c.product_name)}: ${esc(c.supplier_name)} (сейчас ${money(c.last_price)})</option>`).join("")}</select>
          <div class="form-row">
            <div><label for="c-price">Цена по договору, ₸</label><input id="c-price" type="number" inputmode="decimal" min="0" step="any" required value="${esc(d.candidates[0].last_price)}"></div>
            <div><label for="c-tol">Допуск, %</label><input id="c-tol" type="number" inputmode="decimal" min="0" max="50" step="0.5" value="2"></div>
          </div>
          <p class="field-hint">Допуск: на сколько процентов цена может быть выше договорной без тревоги.</p>
          <p class="field-error" id="contract-error" role="alert" hidden></p>
          <div class="actionbar"><button class="primary" type="submit">Следить за ценой</button>
            <span class="small muted">${d.contracts.length} из ${d.limit}${d.contracts.length >= d.limit && d.limit < 100 ? ' · <a href="#/subscription">Без ограничений на тарифе Pro</a>' : ""}</span></div>`
          : '<p class="muted" style="margin:0">Товаров для договорных цен пока нет. Они появятся после первых накладных, а пока можно посмотреть демо-данные на странице «Накладные».</p>'}
      </form>
      ${d.contracts.map((c) => `
        <article class="card contract" data-id="${esc(c.contract_id)}">
          <div class="order-head"><div><div class="title">${esc(c.product_name)}</div><div class="small muted">${esc(c.supplier_name)}</div></div><div>${status(c)}</div></div>
          <div class="recipe-facts">
            <div><span class="small muted">По договору</span><b>${money(c.price)}</b></div>
            <div><span class="small muted">Сейчас в накладных</span><b>${money(c.actual_price)}</b></div>
            <div><span class="small muted">Допуск</span><b>${pctText(c.tolerance_pct)}%</b></div>
          </div>
          ${c.status === "over" ? `<p class="small notice-warn">В накладной от ${fmtDate(c.actual_date)} цена выше договорной. Переплата с начала контроля: ${money(c.overpay)}.</p>` : ""}
          <div class="actionbar">${c.status === "over" ? '<button type="button" class="primary" data-claim>Написать претензию</button>' : ""}
            <button type="button" data-delete>Удалить</button></div>
        </article>`).join("")}`;
    const form = app.querySelector("#contract-form");
    const pair = form.querySelector("#c-pair");
    if (pair) {
      pair.addEventListener("change", () => { form.querySelector("#c-price").value = d.candidates[pair.value].last_price; });
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const errorEl = form.querySelector("#contract-error");
        errorEl.hidden = true;
        const price = toNum(form.querySelector("#c-price").value);
        if (price == null || price <= 0) { errorEl.textContent = "Укажите цену по договору больше нуля"; errorEl.hidden = false; form.querySelector("#c-price").focus(); return; }
        const c = d.candidates[pair.value];
        const done = busyButton(form.querySelector("button[type=submit]"), "Сохраняем…");
        try {
          await api("PUT", "/contracts", { product_key: c.product_key, supplier_key: c.supplier_key, price, tolerance_pct: toNum(form.querySelector("#c-tol").value) });
          toast("Договорная цена сохранена");
          reload();
        } catch (err) { done(); if (!err.silent) { errorEl.textContent = err.message; errorEl.hidden = false; } }
      });
    }
    app.querySelectorAll(".contract").forEach((card) => {
      const id = card.dataset.id;
      const claim = card.querySelector("[data-claim]");
      if (claim) claim.addEventListener("click", () => startClaim({ kind: "contract", contract_id: id }, claim));
      confirmButton(card.querySelector("[data-delete]"), async () => {
        try { await api("DELETE", `/contracts/${id}`); toast("Договорная цена удалена"); reload(); } catch (err) { if (!err.silent) toast(err.message, true); }
      });
    });
  }

  // ---- points of a network

  async function renderLocations(alive) {
    const d = await api("GET", "/locations");
    if (!alive()) return;
    const network = d.plan === "network";
    const worst = d.locations.filter((l) => l.spent).sort((a, b) => b.overpay_pct - a.overpay_pct)[0];
    const extra = d.locations.filter((l) => !l.main).length;
    app.innerHTML = `
      <a class="back" href="#/more">← Ещё</a>
      <div class="page-head"><h1>Точки</h1>
        <p class="sub">Закупки и переплаты по каждой точке за 30 дней. Накладную относят к точке при загрузке.</p></div>
      <div class="card flush"><div class="toolbar"><h2 style="margin:0">Сравнение точек</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Точка</th><th class="num hide-sm">Накладных</th><th class="num hide-sm">Закупки</th><th class="num">Переплата</th></tr></thead>
          <tbody>${d.locations.map((l) => `
            <tr data-id="${esc(l.location_id)}">
              <td>${esc(l.name)}${l.main ? ' <span class="badge ok">основная</span>' : ""}${worst && worst === l && d.locations.length > 1 ? ' <span class="badge warn">больше переплат</span>' : ""}
                ${l.address ? `<span class="cell-sub">${esc(l.address)}</span>` : ""}
                <span class="cell-sub">Закупки ${money(l.spent)}, накладных: ${l.invoices}</span>
                ${l.main ? "" : '<span class="row-actions" style="justify-content:flex-start;margin-top:6px"><button type="button" data-edit>Изменить</button><button type="button" data-delete>Удалить</button></span>'}</td>
              <td class="num hide-sm">${l.invoices}</td><td class="num hide-sm">${money(l.spent)}</td>
              <td class="num">${money(l.overpay)}<span class="cell-sub">${pctText(l.overpay_pct)}%</span></td></tr>`).join("")}</tbody></table></div></div>
      ${network ? `
        <form class="card" id="loc-form" style="max-width:520px;margin-top:16px" novalidate>
          <h2 id="loc-title">Новая точка</h2>
          <label for="l-name">Название</label><input id="l-name" maxlength="60" required placeholder="Кофейня на Достык">
          <label for="l-address">Адрес <span class="muted">(необязательно)</span></label><input id="l-address" maxlength="120" autocomplete="street-address">
          <p class="field-error" id="loc-error" role="alert" hidden></p>
          <div class="actionbar"><button class="primary" type="submit" id="loc-save">Добавить точку</button><button type="button" id="loc-cancel" hidden>Отменить изменение</button>
            <span class="small muted">${extra + 1} из ${d.limit}</span></div>
        </form>`
        : `<div class="card" style="max-width:640px;margin-top:16px">${emptyState("box", "Несколько точек входят в тариф «Сеть»",
          "Заведите кофейни или магазины сети в одном аккаунте, относите накладные к точкам и сравнивайте, где закупки дороже. Подключить можно в демо-режиме.",
          '<a class="button primary" href="#/subscription">Посмотреть тарифы</a>')}</div>`}`;
    const form = app.querySelector("#loc-form");
    if (!form) return;
    const errorEl = form.querySelector("#loc-error");
    let editing = null;
    const setMode = (l) => {
      editing = l ? l.location_id : null;
      form.querySelector("#loc-title").textContent = l ? "Изменить точку" : "Новая точка";
      form.querySelector("#loc-save").textContent = l ? "Сохранить" : "Добавить точку";
      form.querySelector("#loc-cancel").hidden = !l;
      form.querySelector("#l-name").value = l ? l.name : "";
      form.querySelector("#l-address").value = l && l.address ? l.address : "";
      errorEl.hidden = true;
    };
    form.querySelector("#loc-cancel").addEventListener("click", () => setMode(null));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const name = form.querySelector("#l-name").value.trim();
      if (!name) { errorEl.textContent = "Введите название точки"; errorEl.hidden = false; form.querySelector("#l-name").focus(); return; }
      const body = { name, address: form.querySelector("#l-address").value };
      const done = busyButton(form.querySelector("#loc-save"), "Сохраняем…");
      try {
        if (editing) await api("PUT", `/locations/${editing}`, body); else await api("POST", "/locations", body);
        toast("Точка сохранена");
        reload();
      } catch (err) { done(); if (!err.silent) { errorEl.textContent = err.message; errorEl.hidden = false; } }
    });
    app.querySelectorAll("tr[data-id]").forEach((tr) => {
      const loc = d.locations.find((l) => l.location_id === tr.dataset.id);
      const edit = tr.querySelector("[data-edit]");
      if (!edit) return;
      edit.addEventListener("click", () => { setMode(loc); form.scrollIntoView({ block: "center" }); form.querySelector("#l-name").focus(); });
      confirmButton(tr.querySelector("[data-delete]"), async () => {
        try { await api("DELETE", `/locations/${loc.location_id}`); toast("Точка удалена, её накладные перешли в основную"); reload(); } catch (err) { if (!err.silent) toast(err.message, true); }
      });
    });
  }

  // ---- recipes: cost of a dish

  async function renderRecipes(alive) {
    const data = await api("GET", "/recipes");
    if (!alive()) return;
    const { recipes, products } = data;
    const byKey = Object.fromEntries(products.map((p) => [p.product_key, p]));
    const margin = (r) => {
      if (r.margin_pct == null) return "";
      const kind = r.margin_pct >= 60 ? "ok" : r.margin_pct >= 30 ? "warn" : "bad";
      return `<span class="badge ${kind}">Маржа ${String(r.margin_pct).replace(".", ",")}%</span>`;
    };
    app.innerHTML = `
      <a class="back" href="#/more">← Ещё</a>
      <div class="page-head"><h1>Себестоимость блюд</h1>
        <p class="sub">Составьте блюдо из товаров, которые вы покупаете. Себестоимость пересчитывается сама, когда меняются цены в накладных.</p></div>
      <div class="actionbar" style="margin:0 0 14px"><button type="button" class="primary" id="new-recipe">Добавить блюдо</button>
        <span class="small on-dark">${recipes.length} из ${data.limit}${recipes.length >= data.limit && data.limit < 100 ? ' · <a href="#/subscription">Без ограничений на тарифе Pro</a>' : ""}</span></div>
      <form class="card" id="recipe-form" hidden novalidate>
        <h2 id="recipe-title">Новое блюдо</h2>
        <label for="r-name">Название</label>
        <input id="r-name" maxlength="80" required placeholder="Латте">
        <div class="form-row">
          <div><label for="r-portions">Сколько порций выходит</label><input id="r-portions" type="number" inputmode="numeric" min="1" step="1" value="1"></div>
          <div><label for="r-price">Цена в меню, ₸ <span class="muted">(необяз.)</span></label><input id="r-price" type="number" inputmode="decimal" min="0" step="any"></div>
        </div>
        <fieldset class="ingredients"><legend>Ингредиенты на всё блюдо</legend>
          <div id="ing-rows"></div>
          <button type="button" id="add-ing">Добавить ингредиент</button>
          <p class="field-hint">Количество в единицах товара из накладной: штуки, килограммы или литры.</p>
        </fieldset>
        <p class="recipe-sum" id="recipe-sum" aria-live="polite"></p>
        <p class="field-error" id="recipe-error" role="alert" hidden></p>
        <div class="actionbar"><button class="primary" type="submit">Сохранить</button><button type="button" id="recipe-cancel">Отмена</button></div>
      </form>
      ${recipes.length ? recipes.map((r) => `
        <article class="card recipe" data-id="${esc(r.recipe_id)}">
          <div class="order-head">
            <div><div class="title">${esc(r.name)}</div><div class="small muted">${esc(r.portions)} ${plural(r.portions, "порция", "порции", "порций")}</div></div>
            <div>${margin(r)}</div>
          </div>
          <div class="recipe-facts">
            <div><span class="small muted">Себестоимость порции</span><b>${money(r.cost_per_portion)}</b></div>
            <div><span class="small muted">Цена в меню</span><b>${money(r.menu_price)}</b></div>
            <div><span class="small muted">Всё блюдо</span><b>${money(r.total_cost)}</b></div>
          </div>
          ${r.missing ? `<p class="small notice-warn">Нет цены у ${r.missing} ${plural(r.missing, "ингредиента", "ингредиентов", "ингредиентов")}: себестоимость неполная. Цены появятся после накладных с этими товарами.</p>` : ""}
          <details><summary>Состав</summary>
            <table><thead><tr><th>Ингредиент</th><th class="num">Кол-во</th><th class="num">Цена</th><th class="num">Стоимость</th></tr></thead>
            <tbody>${r.lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${esc(l.qty)} ${esc(l.unit || "")}</td>
              <td class="num">${money(l.price)}</td><td class="num">${money(l.cost)}</td></tr>`).join("")}</tbody></table></details>
          <div class="actionbar"><button type="button" data-edit>Изменить</button><button type="button" data-delete>Удалить</button></div>
        </article>`).join("")
        : `<div class="card">${emptyState("doc", "Блюд пока нет",
          products.length ? "Нажмите «Добавить блюдо» и выберите ингредиенты из своих товаров."
            : "Сначала загрузите накладные: ингредиенты берутся из товаров, которые вы покупали.",
          products.length ? "" : '<a class="button primary" href="#/invoices">Загрузить накладную</a>')}</div>`}`;

    const form = app.querySelector("#recipe-form");
    const rows = form.querySelector("#ing-rows");
    const errorEl = form.querySelector("#recipe-error");
    let editing = null;
    let seq = 0;
    const addRow = (key, qty) => {
      const n = ++seq;
      const row = document.createElement("div");
      row.className = "ing-row";
      row.innerHTML = `
        <label class="sr-only" for="ing-p-${n}">Товар</label>
        <select id="ing-p-${n}">${products.map((p) => `<option value="${esc(p.product_key)}"${p.product_key === key ? " selected" : ""}>${esc(p.name)} (${money(p.last_price)})</option>`).join("")}</select>
        <label class="sr-only" for="ing-q-${n}">Количество</label>
        <input id="ing-q-${n}" type="number" inputmode="decimal" min="0" step="any" value="${esc(qty ?? 1)}">
        <button type="button" class="link" data-remove>Убрать</button>`;
      rows.append(row);
      row.querySelector("[data-remove]").addEventListener("click", () => { row.remove(); sum(); });
    };
    const read = () => [...rows.querySelectorAll(".ing-row")].map((r) => ({ product_key: r.querySelector("select").value, qty: toNum(r.querySelector("input").value) }));
    const sum = () => {
      const portions = toNum(form.querySelector("#r-portions").value) || 1;
      const total = read().reduce((t, i) => t + ((byKey[i.product_key] || {}).last_price || 0) * (i.qty || 0), 0);
      const menu = toNum(form.querySelector("#r-price").value);
      const per = total / portions;
      form.querySelector("#recipe-sum").textContent = `Себестоимость порции: ${money(Math.round(per * 100) / 100)}`
        + (menu ? `, маржа ${((menu - per) / menu * 100).toFixed(0)}%` : "");
    };
    const open = (r) => {
      editing = r ? r.recipe_id : null;
      form.hidden = false;
      form.querySelector("#recipe-title").textContent = r ? "Изменить блюдо" : "Новое блюдо";
      form.querySelector("#r-name").value = r ? r.name : "";
      form.querySelector("#r-portions").value = r ? r.portions : 1;
      form.querySelector("#r-price").value = r && r.menu_price ? r.menu_price : "";
      rows.innerHTML = "";
      (r ? r.lines : [{ product_key: products[0] && products[0].product_key, qty: 1 }]).forEach((l) => addRow(l.product_key, l.qty));
      errorEl.hidden = true;
      sum();
      form.scrollIntoView({ block: "start" });
      form.querySelector("#r-name").focus();
    };
    app.querySelector("#new-recipe").addEventListener("click", () => {
      if (!products.length) { toast("Сначала загрузите накладные: нужны товары для ингредиентов", true); return; }
      open(null);
    });
    form.querySelector("#recipe-cancel").addEventListener("click", () => { form.hidden = true; });
    form.querySelector("#add-ing").addEventListener("click", () => { addRow(products[0].product_key, 1); sum(); });
    form.addEventListener("input", sum);
    form.addEventListener("change", sum);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fail = (msg, el) => { errorEl.textContent = msg; errorEl.hidden = false; el.focus(); };
      const name = form.querySelector("#r-name").value.trim();
      const ingredients = read();
      if (!name) return fail("Введите название блюда", form.querySelector("#r-name"));
      if (!ingredients.length) return fail("Добавьте хотя бы один ингредиент", form.querySelector("#add-ing"));
      if (ingredients.some((i) => !i.qty || i.qty <= 0)) return fail("У каждого ингредиента должно быть количество больше нуля", rows.querySelector("input"));
      const body = { name, ingredients, portions: toNum(form.querySelector("#r-portions").value) || 1, menu_price: toNum(form.querySelector("#r-price").value) };
      const done = busyButton(form.querySelector("button[type=submit]"), "Сохраняем…");
      try {
        if (editing) await api("PUT", `/recipes/${editing}`, body); else await api("POST", "/recipes", body);
        toast("Блюдо сохранено");
        reload();
      } catch (err) {
        done();
        if (!err.silent) fail(err.message, form.querySelector("#r-name"));
      }
    });
    app.querySelectorAll(".recipe").forEach((card) => {
      const r = recipes.find((x) => x.recipe_id === card.dataset.id);
      card.querySelector("[data-edit]").addEventListener("click", () => open(r));
      confirmButton(card.querySelector("[data-delete]"), async () => {
        try { await api("DELETE", `/recipes/${r.recipe_id}`); toast("Блюдо удалено"); reload(); } catch (err) { if (!err.silent) toast(err.message, true); }
      });
    });
  }

  // ------------------------------------------------------------ more: the menu of extra sections

  const SOON = {
    telegram: { icon: "chat", title: "Telegram-бот", lead: "Алерты и сводка прямо в Telegram.",
      points: ["Сообщение в Telegram в день, когда поставщик поднял цену",
        "Фото накладной можно отправить боту вместо загрузки на сайте",
        "Недельная сводка переплат в одном сообщении"],
      note: "Для бота нужен токен от @BotFather, поэтому раздел пока не подключён." },
  };
  const soonBadge = '<span class="badge soon">В разработке</span>';

  async function renderMore() {
    const p = profile || {};
    const tile = (href, icon, title, text, mark = "") => `
      <li><a class="card tile" href="${href}">
        <span class="tile-icon" aria-hidden="true">${ICONS[icon]}</span>
        <span class="tile-text"><b>${title}</b><span class="small muted">${text}</span></span>
        ${mark}
      </a></li>`;
    app.innerHTML = `
      <div class="page-head"><h1>Ещё</h1>
        <p class="sub">Поставщики, заявки, переплаты, рецепты и помощник.</p></div>
      <ul class="tiles">
        ${tile("#/suppliers", "truck", "Поставщики", "Каталоги и заявки в один клик")}
        ${tile("#/orders", "doc", "Мои заявки", "Статусы заявок поставщикам")}
        ${tile("#/savings", "chart", "Переплаты", "Сколько можно вернуть и сэкономить")}
        ${tile("#/claims", "doc", "Претензии", "Готовый текст поставщику с цифрами")}
        ${tile("#/contracts", "check", "Контрактные цены", "Следим, чтобы цена не вышла за договор", isPro() ? "" : '<span class="badge pro">3 бесплатно</span>')}
        ${tile("#/recipes", "cup", "Себестоимость блюд", "Рецепты и маржа по текущим ценам")}
        ${tile("#/assistant", "chat", "AI-помощник", "Отвечает по вашим накладным", isPro() ? "" : '<span class="badge pro">Pro</span>')}
        ${tile("#/locations", "bag", "Точки", "Сравнение закупок по точкам сети", isNetwork() ? "" : '<span class="badge pro">Сеть</span>')}
        ${tile("#/subscription", "star", "Подписка", `Тариф ${({ pro: "Pro", network: "Сеть" })[p.plan] || "бесплатный"}`)}
        ${Object.entries(SOON).map(([k, f]) => tile(`#/${k}`, f.icon, f.title, f.lead, soonBadge)).join("")}
        ${p.is_admin ? tile("#/admin", "shield", "Админ-панель", "Сводка по всему сервису. Видна только администратору.") : ""}
      </ul>`;
  }

  async function renderSoon(kind) {
    const f = SOON[kind];
    document.title = `${f.title} — SupplyRadar`;
    app.innerHTML = `
      <a class="back" href="#/more">← Ещё</a>
      <div class="page-head"><h1>${f.title}</h1></div>
      <div class="card soon-card" style="max-width:640px">
        <p>${soonBadge}</p>
        <p class="lead-text">${f.lead}</p>
        <h2>Что здесь появится</h2>
        <ul class="plain">${f.points.map((x) => `<li>${x}</li>`).join("")}</ul>
        <p class="small muted">${f.note}</p>
        <div class="actionbar"><a class="button" href="#/more">Назад</a></div>
      </div>`;
  }

  async function renderAdmin(alive) {
    if (!(profile || {}).is_admin) {
      app.innerHTML = `<div class="page-head"><h1>Админ-панель</h1></div>
        <div class="card">${emptyState("shield", "Раздел только для администратора",
          "У этого аккаунта нет прав администратора.", '<a class="button" href="#/invoices">К накладным</a>')}</div>`;
      return;
    }
    const d = await api("GET", "/admin/overview");
    if (!alive()) return;
    const count = (title, rows) => `
      <div class="card flush"><div class="toolbar"><h2 style="margin:0">${title}</h2></div>
        ${rows.length ? `<table><thead><tr><th>Значение</th><th class="num">Количество</th></tr></thead>
          <tbody>${rows.map(([label, n]) => `<tr><td>${label}</td><td class="num">${esc(n)}</td></tr>`).join("")}</tbody></table>`
          : '<p class="muted" style="padding:16px 22px;margin:0">Пока нет данных.</p>'}
      </div>`;
    const fact = (label, value, hint) => `<div class="card"><div class="small muted">${label}</div><div class="v">${esc(value)}</div><div class="small muted">${hint}</div></div>`;
    app.innerHTML = `
      <a class="back" href="#/more">← Ещё</a>
      <div class="page-head"><h1>Админ-панель</h1>
        <p class="sub">Сводка по всем аккаунтам. Содержимое чужих накладных и email здесь не показываются.</p></div>
      <div class="facts four">
        ${fact("Аккаунты", d.accounts, "с данными в сервисе")}
        ${fact("Накладные", d.invoices, "за всё время")}
        ${fact("За 7 дней", d.invoices_week, "новых накладных")}
        ${fact("Алерты", d.alerts, "о росте цен")}
        ${fact("Поставщики", d.suppliers || 0, "аккаунтов с каталогом")}
        ${fact("Заявки", d.orders || 0, "поставщикам, всего")}
      </div>
      <div class="grid-2">
        ${count("Накладные по статусам", Object.entries(d.by_status || {}).map(([k, n]) => [badge(k), n]))}
        ${count("Аккаунты по типу бизнеса", Object.entries(d.by_business_type || {}).map(([k, n]) => [esc(BUSINESS[k] ? BUSINESS[k].label : "Не выбран"), n]))}
      </div>
      <div class="grid-2" style="margin-top:16px">
        ${count("Аккаунты по тарифам (демо-оплата)", Object.entries(d.by_plan || {}).map(([k, n]) => [esc({ free: "Бесплатный", pro: "Pro", supplier_pro: "Поставщик Pro" }[k] || k), n]))}
      </div>
      <div class="card flush" style="margin-top:16px"><div class="toolbar"><h2 style="margin:0">Последние накладные</h2></div>
        ${(d.latest || []).length ? `<div class="table-wrap"><table class="responsive">
          <thead><tr><th>Поставщик</th><th class="num">Сумма</th><th>Загружена</th><th>Аккаунт</th><th class="num">Статус</th></tr></thead>
          <tbody>${d.latest.map((i) => `<tr><td data-m="wide">${esc(i.supplier_name || "Без названия")}</td><td class="num">${money(i.total)}</td>
            <td data-m="sub">${fmtDate(i.created_at)}</td><td data-m="sub">…${esc(i.account)}</td><td class="num">${badge(i.status)}</td></tr>`).join("")}</tbody></table></div>`
          : '<p class="muted" style="padding:16px 22px;margin:0">Накладных пока нет.</p>'}
      </div>`;
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
