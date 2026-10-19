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
  const COLORS = ["#0f766e", "#d97706", "#7c3aed", "#dc2626", "#2563eb", "#65a30d"];

  // ------------------------------------------------------------ helpers

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (v) => (v == null || v === "" ? "—"
    : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + " ₸");
  const num = (v) => (v == null ? "" : String(v));
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
    return isNaN(d) ? iso : d.toLocaleDateString("ru-RU");
  };
  const badge = (status) => {
    const [label, kind] = STATUS[status] || [status, "info"];
    return `<span class="badge ${kind}">${esc(label)}</span>`;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const storage = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  let toastTimer;
  function toast(message, isError = false) {
    const el = document.getElementById("toast");
    el.textContent = message;
    el.className = "toast" + (isError ? " error" : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3500);
  }

  // ------------------------------------------------------------ auth (Cognito)

  const COGNITO_ERRORS = {
    UsernameExistsException: "Пользователь с таким email уже существует",
    NotAuthorizedException: "Неверный email или пароль",
    UserNotFoundException: "Неверный email или пароль",
    UserNotConfirmedException: "Email не подтверждён: введите код из письма",
    CodeMismatchException: "Неверный код",
    ExpiredCodeException: "Код устарел, запросите новый",
    InvalidPasswordException: "Пароль: минимум 8 символов, строчные буквы и цифры",
    LimitExceededException: "Слишком много попыток, попробуйте позже",
    TooManyRequestsException: "Слишком много попыток, попробуйте позже",
  };

  async function cognito(action, body) {
    const resp = await fetch(cfg.cognitoEndpoint || `https://cognito-idp.${cfg.region}.amazonaws.com/`, {
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
      const err = new Error(COGNITO_ERRORS[type] || data.message || "Ошибка входа");
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

  async function idToken() {
    const s = session.get();
    if (!s) throw new Error("not signed in");
    if (Date.now() < s.expiresAt) return s.idToken;
    const data = await cognito("InitiateAuth", {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      AuthParameters: { REFRESH_TOKEN: s.refreshToken },
    });
    session.save(data.AuthenticationResult);
    return data.AuthenticationResult.IdToken;
  }

  function logout() {
    session.clear();
    location.hash = "#/login";
  }

  // ------------------------------------------------------------ API

  async function api(method, path, body) {
    let token;
    try { token = await idToken(); } catch { logout(); throw new Error("Войдите снова"); }
    const resp = await fetch(cfg.apiUrl + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 401) { logout(); throw new Error("Сессия истекла, войдите снова"); }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || data.message || `Ошибка ${resp.status}`);
    return data;
  }

  // ------------------------------------------------------------ router

  const routes = [
    [/^#\/login$/, renderLogin, false],
    [/^#\/invoices$/, renderInvoices, true],
    [/^#\/invoices\/([\w-]+)$/, renderInvoice, true],
    [/^#\/products$/, renderProducts, true],
    [/^#\/products\/(.+)$/, renderProduct, true],
    [/^#\/alerts$/, renderAlerts, true],
    [/^#\/settings$/, renderSettings, true],
  ];
  let renderId = 0;

  async function router() {
    const id = ++renderId;
    const hash = location.hash || "#/invoices";
    const signedIn = !!session.get();
    const match = routes.find(([re]) => re.test(hash));
    if (!match) { location.hash = signedIn ? "#/invoices" : "#/login"; return; }
    const [re, render, needsAuth] = match;
    if (needsAuth && !signedIn) { location.hash = "#/login"; return; }
    if (!needsAuth && signedIn) { location.hash = "#/invoices"; return; }

    document.getElementById("topbar").hidden = !needsAuth;
    const section = hash.split("/")[1];
    document.querySelectorAll("[data-nav]").forEach((a) =>
      a.classList.toggle("active", a.dataset.nav === section));

    app.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    const args = hash.match(re).slice(1).map(decodeURIComponent);
    try {
      await render(...args, () => id === renderId);
    } catch (err) {
      if (id === renderId) app.innerHTML = `<div class="card empty">${esc(err.message)}</div>`;
    }
  }

  // ------------------------------------------------------------ login

  function renderLogin() {
    let mode = "signin";
    let pendingEmail = "";

    const draw = () => {
      const confirm = mode === "confirm";
      app.innerHTML = `
        <div class="auth">
          <div class="row" style="justify-content:center;margin-bottom:14px">
            <img src="favicon.svg" alt="" width="36" height="36">
            <h1 style="margin:0">SupplyRadar</h1>
          </div>
          <p class="muted" style="text-align:center">Сфотографируйте накладную и узнайте, если поставщик поднял цену.</p>
          <div class="card">
            ${confirm ? "" : `
            <div class="tabs">
              <button type="button" data-mode="signin" class="${mode === "signin" ? "active" : ""}">Вход</button>
              <button type="button" data-mode="signup" class="${mode === "signup" ? "active" : ""}">Регистрация</button>
            </div>`}
            <form id="auth-form">
              ${confirm ? `
                <p class="small">Мы отправили код на <b>${esc(pendingEmail)}</b>.</p>
                <label for="code">Код из письма</label>
                <input id="code" inputmode="numeric" autocomplete="one-time-code" required>` : `
                <label for="email">Email</label>
                <input id="email" type="email" autocomplete="email" required value="${esc(pendingEmail)}">
                <label for="password">Пароль</label>
                <input id="password" type="password" minlength="8" required
                  autocomplete="${mode === "signup" ? "new-password" : "current-password"}">
                ${mode === "signup" ? '<p class="small muted">Минимум 8 символов, строчные буквы и цифры.</p>' : ""}`}
              <div class="row" style="margin-top:14px">
                <button class="primary" type="submit">${confirm ? "Подтвердить" : mode === "signup" ? "Создать аккаунт" : "Войти"}</button>
                ${confirm ? '<button type="button" class="link" id="resend">Отправить код ещё раз</button>' : ""}
              </div>
            </form>
          </div>
        </div>`;

      app.querySelectorAll("[data-mode]").forEach((b) =>
        b.addEventListener("click", () => { mode = b.dataset.mode; draw(); }));
      const resend = app.querySelector("#resend");
      if (resend) resend.addEventListener("click", async () => {
        try { await cognito("ResendConfirmationCode", { Username: pendingEmail }); toast("Код отправлен"); }
        catch (e) { toast(e.message, true); }
      });

      app.querySelector("#auth-form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const btn = ev.target.querySelector("button[type=submit]");
        btn.disabled = true;
        try {
          if (mode === "confirm") {
            await cognito("ConfirmSignUp", { Username: pendingEmail, ConfirmationCode: app.querySelector("#code").value.trim() });
            toast("Email подтверждён, войдите");
            mode = "signin";
            draw();
            return;
          }
          const email = app.querySelector("#email").value.trim().toLowerCase();
          const password = app.querySelector("#password").value;
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
          session.save(data.AuthenticationResult, email);
          location.hash = "#/invoices";
        } catch (err) {
          if (err.type === "UserNotConfirmedException") { mode = "confirm"; draw(); }
          toast(err.message, true);
        } finally {
          btn.disabled = false;
        }
      });
    };
    draw();
  }

  // ------------------------------------------------------------ invoices

  async function prepareFile(file) {
    if (file.type === "application/pdf") return { blob: file, type: file.type };
    if (!file.type.startsWith("image/")) throw new Error("Нужна фотография или PDF");
    // Resize in the browser: smaller upload, fewer AI tokens, same readability.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    return { blob, type: "image/jpeg" };
  }

  async function uploadFile(file, onStatus) {
    if (file.size > 25 * 1024 * 1024) throw new Error("Файл больше 25 МБ");
    onStatus("Подготовка файла…");
    const { blob, type } = await prepareFile(file);
    if (blob.size > 10 * 1024 * 1024) throw new Error("После сжатия файл больше 10 МБ");
    const { invoice_id: id, upload } = await api("POST", "/uploads", { content_type: type, file_name: file.name });
    onStatus("Загрузка…");
    const form = new FormData();
    Object.entries(upload.fields).forEach(([k, v]) => form.append(k, v));
    form.append("file", blob, file.name || "invoice");
    const resp = await fetch(upload.url, { method: "POST", body: form });
    if (!resp.ok) throw new Error("S3 отклонил загрузку");
    return id;
  }

  async function waitForResult(id, onStatus, alive) {
    const started = Date.now();
    while (Date.now() - started < 120000 && alive()) {
      const inv = await api("GET", `/invoices/${id}`);
      onStatus(`${(STATUS[inv.status] || [inv.status])[0]}… ${Math.round((Date.now() - started) / 1000)} с`);
      if (FINAL.includes(inv.status)) return inv;
      await sleep(2000);
    }
    return null;
  }

  async function renderInvoices(alive) {
    const data = await api("GET", "/invoices");
    if (!alive()) return;
    const rows = data.invoices.map((i) => `
      <tr class="clickable" data-id="${esc(i.invoice_id)}">
        <td>${fmtDate(i.invoice_date || i.created_at)}</td>
        <td>${esc(i.supplier_name || i.file_name || "—")}</td>
        <td>${esc(i.invoice_number || "")}</td>
        <td class="num">${money(i.total)}</td>
        <td>${badge(i.status)}${i.issues ? ` <span class="small muted">${i.issues} замеч.</span>` : ""}</td>
      </tr>`).join("");

    app.innerHTML = `
      <h1>Накладные</h1>
      <div class="card">
        <div class="upload" id="drop">
          <strong>Сфотографируйте накладную или выберите файл</strong>
          <span class="small muted">JPEG, PNG или PDF. Проверка занимает около 10 секунд.</span>
          <div class="row">
            <label class="button primary" style="margin:0;color:var(--accent-text)">
              Сфотографировать<input id="camera" type="file" accept="image/*" capture="environment" hidden>
            </label>
            <label class="button" style="margin:0;color:var(--text)">
              Выбрать файл<input id="picker" type="file" accept="image/*,application/pdf" hidden>
            </label>
          </div>
          <div id="progress" class="small muted" aria-live="polite"></div>
        </div>
      </div>
      <div class="card">
        ${rows ? `<div class="table-wrap"><table>
          <thead><tr><th>Дата</th><th>Поставщик</th><th>№</th><th class="num">Сумма</th><th>Статус</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
        : '<div class="empty">Пока нет накладных. Загрузите первую.</div>'}
      </div>`;

    app.querySelectorAll("tr[data-id]").forEach((tr) =>
      tr.addEventListener("click", () => { location.hash = `#/invoices/${tr.dataset.id}`; }));

    const progress = app.querySelector("#progress");
    const busy = (on) => app.querySelectorAll("#drop input").forEach((i) => { i.disabled = on; });
    const handle = async (file) => {
      if (!file) return;
      busy(true);
      const setStatus = (t) => { progress.innerHTML = `<span class="spinner"></span> ${esc(t)}`; };
      try {
        const id = await uploadFile(file, setStatus);
        const inv = await waitForResult(id, setStatus, alive);
        if (!alive()) return;
        if (inv && inv.status === "checked") toast("Накладная проверена");
        else if (inv && inv.status === "needs_review") toast("Проверьте отмеченные поля");
        else if (inv && inv.status === "failed") toast(inv.error || "Не удалось прочитать накладную", true);
        location.hash = `#/invoices/${id}`;
      } catch (err) {
        progress.textContent = "";
        toast(err.message, true);
      } finally {
        busy(false);
      }
    };
    ["camera", "picker"].forEach((id) =>
      app.querySelector(`#${id}`).addEventListener("change", (e) => handle(e.target.files[0])));
    const drop = app.querySelector("#drop");
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drag"); handle(e.dataTransfer.files[0]); });
  }

  async function renderInvoice(id, alive) {
    let inv = await api("GET", `/invoices/${id}`);
    if (!FINAL.includes(inv.status)) {
      app.innerHTML = `<div class="card empty"><span class="spinner"></span> ${esc((STATUS[inv.status] || [inv.status])[0])}…</div>`;
      inv = (await waitForResult(id, () => {}, alive)) || inv;
    }
    if (!alive()) return;

    const issues = inv.issues || [];
    const flagged = new Set(issues.map((i) => i.field));
    const lineFlagged = (i, f) => flagged.has(`lines.${i}.${f}`) || flagged.has(`lines.${i}`);
    const editable = ["needs_review", "failed", "checked"].includes(inv.status);
    const field = (name, label, value, type = "text") => `
      <label for="f-${name}">${label}</label>
      <input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}"
        ${flagged.has(name) ? 'class="flagged"' : ""} ${editable ? "" : "disabled"}>`;
    const lines = inv.lines && inv.lines.length ? inv.lines
      : [{ name: "", quantity: null, unit: "", price: null, total: null }];

    const original = inv.content_type === "application/pdf"
      ? `<p><a class="button" href="${esc(inv.file_url)}" target="_blank" rel="noopener">Открыть PDF</a></p>`
      : `<img src="${esc(inv.file_url)}" alt="Оригинал накладной">`;

    app.innerHTML = `
      <div class="row"><a href="#/invoices">← Накладные</a></div>
      <div class="row" style="margin:8px 0 16px"><h1 style="margin:0">Накладная ${esc(inv.invoice_number || "")}</h1>${badge(inv.status)}</div>
      ${issues.length ? `<div class="card"><h2>Что проверить</h2><ul class="issues">${issues.map((i) => `<li>${esc(i.message)}</li>`).join("")}</ul></div>` : ""}
      ${inv.status === "failed" ? `<div class="card"><p>${esc(inv.error || "AI не смог прочитать файл.")} Можно ввести данные вручную.</p></div>` : ""}
      <div class="grid-2">
        <div class="card original"><h2>Оригинал</h2>${original}</div>
        <form class="card" id="review">
          <h2>Данные</h2>
          ${field("supplier_name", "Поставщик", inv.supplier_name)}
          <div class="grid-2" style="gap:8px">
            <div>${field("supplier_bin", "БИН", inv.supplier_bin)}</div>
            <div>${field("invoice_number", "Номер", inv.invoice_number)}</div>
            <div>${field("invoice_date", "Дата", inv.invoice_date, "date")}</div>
            <div>${field("total", "Итого, ₸", num(inv.total), "number")}</div>
          </div>
        </form>
      </div>
      <div class="card">
        <h2>Строки</h2>
        <div class="table-wrap"><table id="lines">
          <thead><tr><th>Товар</th><th class="num">Кол-во</th><th>Ед.</th><th class="num">Цена</th><th class="num">Сумма</th></tr></thead>
          <tbody>${lines.map((l, i) => editable ? `
            <tr data-i="${i}">
              <td><input data-f="name" value="${esc(l.name)}" ${lineFlagged(i, "name") ? 'class="flagged"' : ""}></td>
              <td class="num"><input data-f="quantity" type="number" step="any" value="${num(l.quantity)}" ${lineFlagged(i, "quantity") ? 'class="flagged"' : ""}></td>
              <td><input data-f="unit" value="${esc(l.unit)}" style="min-width:50px"></td>
              <td class="num"><input data-f="price" type="number" step="any" value="${num(l.price)}" ${lineFlagged(i, "price") ? 'class="flagged"' : ""}></td>
              <td class="num"><input data-f="total" type="number" step="any" value="${num(l.total)}" ${lineFlagged(i, "total") ? 'class="flagged"' : ""}></td>
            </tr>` : `
            <tr>
              <td>${esc(l.name)}${l.product_key ? `<div class="small"><a href="#/products/${encodeURIComponent(l.product_key)}">${esc(l.canonical_name || "")}</a></div>` : ""}</td>
              <td class="num">${esc(l.quantity)}</td><td>${esc(l.unit)}</td>
              <td class="num">${money(l.price)}</td><td class="num">${money(l.total)}</td>
            </tr>`).join("")}
          </tbody>
        </table></div>
        ${editable ? `<div class="row" style="margin-top:12px">
          <button type="button" id="add-line">+ строка</button><span class="spacer"></span>
          <button class="primary" type="button" id="confirm">${inv.status === "checked" ? "Сохранить исправления" : "Подтвердить"}</button>
        </div>
        <p class="small muted">Алерты строятся только по проверенным или подтверждённым вами накладным.</p>` : ""}
      </div>`;

    if (!editable) return;
    app.querySelector("#add-line").addEventListener("click", () => {
      const tbody = app.querySelector("#lines tbody");
      const tr = tbody.lastElementChild.cloneNode(true);
      tr.querySelectorAll("input").forEach((i) => { i.value = ""; i.classList.remove("flagged"); });
      tbody.appendChild(tr);
    });
    app.querySelector("#confirm").addEventListener("click", async (ev) => {
      const form = app.querySelector("#review");
      const body = Object.fromEntries(["supplier_name", "supplier_bin", "invoice_number", "invoice_date", "total"]
        .map((k) => [k, form.elements[k].value.trim()]));
      body.lines = [...app.querySelectorAll("#lines tbody tr")].map((tr) => {
        const get = (f) => tr.querySelector(`[data-f=${f}]`).value.trim();
        return { name: get("name"), quantity: get("quantity"), unit: get("unit"), price: get("price"), total: get("total") };
      }).filter((l) => l.name);
      ev.target.disabled = true;
      try {
        await api("PUT", `/invoices/${id}`, body);
        toast("Отправлено на сохранение");
        router();
      } catch (err) {
        toast(err.message, true);
        ev.target.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------ products

  function supplierRows(product) {
    return Object.values(product.suppliers || {}).sort((a, b) => a.price - b.price);
  }

  async function renderProducts(alive) {
    const data = await api("GET", "/products");
    if (!alive()) return;
    const items = data.products.sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"));
    app.innerHTML = `
      <h1>Товары</h1>
      <div class="card">${items.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Товар</th><th class="num">Последняя цена</th><th class="num">Изменение</th><th class="num">Лучшая цена</th><th>Поставщиков</th></tr></thead>
        <tbody>${items.map((p) => {
          const sup = supplierRows(p);
          const latest = sup.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || {};
          const change = latest.prev_price ? (latest.price - latest.prev_price) / latest.prev_price * 100 : null;
          return `<tr class="clickable" data-key="${esc(p.product_key)}">
            <td>${esc(p.name)}</td>
            <td class="num">${money(p.last_price)}</td>
            <td class="num">${change == null ? "—" : `<span class="${change > 0 ? "up" : "down"}">${change > 0 ? "+" : ""}${change.toFixed(1)}%</span>`}</td>
            <td class="num">${money(sup[0] && sup[0].price)}</td>
            <td>${sup.length}</td></tr>`;
        }).join("")}</tbody></table></div>`
        : '<div class="empty">Товары появятся после первой проверенной накладной.</div>'}
      </div>`;
    app.querySelectorAll("tr[data-key]").forEach((tr) =>
      tr.addEventListener("click", () => { location.hash = `#/products/${encodeURIComponent(tr.dataset.key)}`; }));
  }

  function priceChart(history) {
    if (history.length < 2) return '<p class="muted small">График появится, когда будет хотя бы две цены.</p>';
    const W = 640, H = 220, L = 56, R = 12, T = 12, B = 28;
    const dates = [...new Set(history.map((h) => h.date))].sort();
    const prices = history.map((h) => h.price);
    let lo = Math.min(...prices), hi = Math.max(...prices);
    const pad = (hi - lo) * 0.15 || hi * 0.05 || 1;
    lo -= pad; hi += pad;
    const x = (d) => L + (dates.length === 1 ? 0 : dates.indexOf(d) / (dates.length - 1)) * (W - L - R);
    const y = (p) => T + (1 - (p - lo) / (hi - lo)) * (H - T - B);
    const groups = {};
    history.forEach((h) => { (groups[h.supplier || h.supplier_key] ||= []).push(h); });
    const names = Object.keys(groups);
    const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
    const svg = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="История цены">
        ${ticks.map((t) => `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>
          <text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${Math.round(t).toLocaleString("ru-RU")}</text>`).join("")}
        ${[dates[0], dates[dates.length - 1]].map((d, i) => `<text x="${x(d)}" y="${H - 8}" text-anchor="${i ? "end" : "start"}">${fmtDate(d)}</text>`).join("")}
        ${names.map((n, i) => {
          const pts = groups[n].sort((a, b) => a.date.localeCompare(b.date));
          const color = COLORS[i % COLORS.length];
          return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts.map((p) => `${x(p.date)},${y(p.price)}`).join(" ")}"/>
            ${pts.map((p) => `<circle cx="${x(p.date)}" cy="${y(p.price)}" r="3.5" fill="${color}"><title>${esc(n)}: ${money(p.price)}, ${fmtDate(p.date)}</title></circle>`).join("")}`;
        }).join("")}
      </svg>`;
    const legend = names.map((n, i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(n)}</span>`).join("");
    return `<div class="chart">${svg}<div class="legend">${legend}</div></div>`;
  }

  async function renderProduct(key, alive) {
    const data = await api("GET", `/products/${encodeURIComponent(key)}`);
    if (!alive()) return;
    const p = data.product;
    const sup = supplierRows(p);
    app.innerHTML = `
      <div class="row"><a href="#/products">← Товары</a></div>
      <h1>${esc(p.name)}</h1>
      <div class="card"><h2>История цены</h2>${priceChart(data.history)}</div>
      <div class="grid-2">
        <div class="card"><h2>Сравнение поставщиков</h2>
          <table><thead><tr><th>Поставщик</th><th class="num">Цена</th><th>Дата</th></tr></thead>
          <tbody>${sup.map((s, i) => `<tr><td>${esc(s.name)}${i === 0 && sup.length > 1 ? ' <span class="badge ok">дешевле всех</span>' : ""}</td>
            <td class="num">${money(s.price)}</td><td>${fmtDate(s.date)}</td></tr>`).join("")}</tbody></table>
        </div>
        <div class="card"><h2>Все цены</h2>
          <div class="table-wrap"><table><thead><tr><th>Дата</th><th>Поставщик</th><th class="num">Цена</th><th class="num">Кол-во</th></tr></thead>
          <tbody>${data.history.slice().reverse().map((h) => `<tr class="clickable" data-id="${esc(h.invoice_id)}">
            <td>${fmtDate(h.date)}</td><td>${esc(h.supplier)}</td><td class="num">${money(h.price)}</td><td class="num">${esc(h.quantity ?? "")}</td></tr>`).join("")}
          </tbody></table></div>
        </div>
      </div>`;
    app.querySelectorAll("tr[data-id]").forEach((tr) =>
      tr.addEventListener("click", () => { location.hash = `#/invoices/${tr.dataset.id}`; }));
  }

  // ------------------------------------------------------------ alerts

  async function renderAlerts(alive) {
    const data = await api("GET", "/alerts");
    if (!alive()) return;
    const total = data.alerts.reduce((s, a) => s + (a.new_price - a.old_price) * (a.quantity || 1), 0);
    app.innerHTML = `
      <h1>Алерты</h1>
      <div class="card row"><div><div class="muted small">Переплата по последним алертам</div><div class="stat">${money(Math.round(total))}</div></div></div>
      ${data.alerts.length ? data.alerts.map((a) => `
        <div class="card alert-card">
          <div class="row"><strong>${esc(a.product)}</strong><span class="up">+${esc(a.change_pct)}%</span><span class="spacer"></span>
            <span class="small muted">${fmtDate(a.invoice_date)}</span></div>
          <div>${esc(a.supplier)}: ${money(a.old_price)} → <b>${money(a.new_price)}</b></div>
          ${a.cheaper_supplier ? `<div class="small">У поставщика ${esc(a.cheaper_supplier)} дешевле на ${esc(a.cheaper_pct)}%: ${money(a.cheaper_price)}</div>` : ""}
          <div class="row small" style="margin-top:6px">
            <a href="#/products/${encodeURIComponent(a.product_key)}">История цены</a>
            <a href="#/invoices/${esc(a.invoice_id)}">Накладная</a>
          </div>
        </div>`).join("")
        : '<div class="card empty">Повышений цен пока нет.</div>'}`;
  }

  // ------------------------------------------------------------ settings

  async function renderSettings(alive) {
    const s = await api("GET", "/settings");
    if (!alive()) return;
    app.innerHTML = `
      <h1>Настройки</h1>
      <form class="card" id="settings" style="max-width:480px">
        <label for="threshold">Сообщать, если цена выросла больше чем на, %</label>
        <input id="threshold" type="number" min="0.5" max="100" step="0.5" value="${esc(s.threshold_pct)}" required>
        <label for="email">Email для алертов и недельной сводки</label>
        <input id="email" type="email" value="${esc(s.email || s.account_email || "")}">
        ${s.email_pending ? '<p class="small" style="color:var(--warn)">Подтвердите подписку: откройте письмо «AWS Notification - Subscription Confirmation».</p>' : ""}
        <div class="row" style="margin-top:14px"><button class="primary" type="submit">Сохранить</button></div>
        <p class="small muted">Аккаунт: ${esc(s.account_email || "")}</p>
      </form>`;
    app.querySelector("#settings").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        const r = await api("PUT", "/settings", {
          threshold_pct: Number(app.querySelector("#threshold").value),
          email: app.querySelector("#email").value.trim(),
        });
        toast(r.message || "Сохранено");
        router();
      } catch (err) { toast(err.message, true); }
    });
  }

  // ------------------------------------------------------------ start

  document.getElementById("logout").addEventListener("click", logout);
  window.addEventListener("hashchange", router);
  if (!cfg.apiUrl || !cfg.clientId) {
    app.innerHTML = '<div class="card empty">Нет config.js: разверните стек Terraform или скопируйте config.example.js.</div>';
  } else {
    router();
  }
})();
