// Browser test of the web app against tests/e2e/fake_backend.py.
//   python3 tests/e2e/fake_backend.py &   then   node tests/e2e/ui.spec.mjs
// Walks the demo: sign up, password reset, three invoices -> price alert,
// a broken invoice -> review -> confirm, error and empty states, phone layout.
import { chromium } from "playwright";
import fs, { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = process.env.BASE_URL || "http://localhost:8765";
const shots = process.env.SHOTS || path.join(root, "docs/screenshots");
mkdirSync(shots, { recursive: true });
const sample = (n) => path.join(root, "samples/demo", n);

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
// Reduced motion keeps screenshots deterministic: nothing is caught halfway through an entrance animation.
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "ru-RU", reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// Expected 4xx responses (wrong password, unknown invoice) are logged by the browser; JS errors are not expected.
page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
const shot = (name) => page.screenshot({ path: path.join(shots, name), fullPage: true });
const check = (cond, msg) => { if (!cond) throw new Error("FAILED: " + msg); console.log("ok -", msg); };

await page.goto(base);
await page.waitForSelector("#auth-form");
await shot("01-login.png");

await page.click("[data-mode=signup]");
await page.fill("#email", "owner@example.com");
await page.fill("#password", "demo1234");
await page.click("button[type=submit]");
await page.waitForSelector("#code");
await page.fill("#code", "123456");
await page.click("button[type=submit]");
await page.waitForSelector("#password");
await page.fill("#email", "owner@example.com");
await page.fill("#password", "demo1234");
await page.click("button[type=submit]");
// A new account first picks its business template.
await page.waitForSelector("#welcome");
check(true, "sign up, confirm and sign in");
check(!(await page.isVisible("#nav")), "welcome step hides the navigation until a template is chosen");
await page.click("#welcome button[type=submit]");
check((await page.textContent("#welcome-error")).includes("Выберите"), "welcome step asks to choose a business type");
await page.check("input[name=business_type][value=cafe]");
check((await page.textContent("#template-note")).includes("5%"), "template explains the alert threshold it sets");
await page.fill("#business-name", "Кофейня на Абая");
check(await page.isChecked("#load-demo"), "sample data is offered by default");
await page.uncheck("#load-demo");
await shot("10-welcome.png");
await page.click("#welcome button[type=submit]");
await page.waitForSelector("#drop");
check((await page.textContent("#list")).includes("кофейное зерно"), "empty invoice list carries the template hint");
check(await page.isVisible("text=Пока нет накладных"), "empty invoice list explains what to do");

// Password reset, then sign in with the new password.
await page.click("#logout");
await page.waitForSelector("#auth-form");
await page.click("text=Забыли пароль?");
await page.fill("#email", "owner@example.com");
await page.click("button[type=submit]");
await page.fill("#code", "654321");
await page.fill("#new-password", "newpass123");
await page.click("button[type=submit]");
await page.waitForSelector("#password");
await page.fill("#email", "owner@example.com");
await page.fill("#password", "demo1234");
await page.click("button[type=submit]");
await page.waitForSelector("#auth-error:not([hidden])");
check((await page.textContent("#auth-error")).includes("Неверный"), "old password rejected with an inline error");
await page.fill("#password", "newpass123");
await page.click("button[type=submit]");
await page.waitForSelector("#drop");
check(true, "password reset -> sign in with the new password");

async function upload(file, expectBadge) {
  await page.goto(base + "/#/invoices");
  await page.waitForSelector("#picker", { state: "attached" });
  await page.setInputFiles("#picker", sample(file));
  await page.waitForURL(/#\/invoices\/[\w-]+$/, { timeout: 30000 });
  await page.waitForSelector(`.badge:has-text("${expectBadge}")`, { timeout: 30000 });
  check(true, `${file} -> ${expectBadge}`);
}

await upload("1-dairy-september.png", "Проверено");
await upload("2-farm-october.png", "Проверено");
await upload("3-dairy-october-price-up.png", "Проверено");
await shot("02-invoice-checked.png");

await page.goto(base + "/#/alerts");
await page.waitForSelector(".alert-card");
const alertText = await page.textContent(".alert-card");
check(alertText.includes("+12%") && alertText.includes("Свежая ферма"), "alert: cream +12%, cheaper supplier shown");
check((await page.textContent("#alert-count")).trim() === "1", "alert count on the navigation tab");
await shot("03-alerts.png");

await page.goto(base + "/#/products");
await page.waitForSelector("tr[data-key]");
check((await page.$$("tr[data-key]")).length === 4, "4 products after matching names across suppliers");
await shot("04-products.png");
await page.click("tr[data-key]:has-text('сливки')");
await page.waitForSelector(".chart svg polyline");
await shot("05-product-history.png");
check(true, "price history chart rendered");

await upload("4-bakery-with-error.png", "Нужна проверка");
check((await page.$$("input.flagged")).length >= 1, "wrong row is highlighted");
check(await page.isVisible("#lines tbody tr:nth-child(2) [data-f=total].mismatch"), "quantity × price mismatch is marked on the line");
await shot("06-needs-review.png");
const totalInput = page.locator("#lines tbody tr").nth(1).locator("[data-f=total]");
await totalInput.fill("1740");
await page.fill("#f-total", "6340");
check((await page.textContent("#sum-check")).includes("Сходится"), "line sums match the total after the fix");
await page.click("#confirm");
await page.waitForSelector('.badge:has-text("Подтверждено")', { timeout: 30000 });
check(true, "review -> confirmed");

await page.goto(base + "/#/settings");
await page.waitForSelector("#threshold");
await page.fill("#threshold", "8");
await page.click("#settings button[type=submit]");
await page.waitForSelector("#toast:not([hidden])");
await shot("07-settings.png");
check(true, "settings saved");
check(await page.inputValue("#business-type") === "cafe" && await page.inputValue("#business-name") === "Кофейня на Абая",
  "settings keep the business template");

// Excel export, coming-soon sections and the admin panel.
await page.goto(base + "/#/invoices");
await page.waitForSelector("#export");
const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export")]);
const csv = fs.readFileSync(await download.path(), "utf8");
check(csv.charCodeAt(0) === 0xfeff && csv.includes("Поставщик;Номер") && csv.split("\r\n").length === 5,
  "invoices export to a CSV that Excel opens");
await page.click("[data-nav=more]");
await page.waitForSelector(".tiles");
check((await page.$$(".tile .badge.soon")).length === 1 && await page.isVisible(".tile:has-text('Админ-панель')")
  && await page.isVisible(".tile:has-text('Поставщики')") && await page.isVisible(".tile:has-text('Себестоимость')"),
  "«Ещё» lists the working sections, Telegram marked as not ready, and the admin panel");
await shot("11-more.png");
await page.click(".tile:has-text('Telegram')");
await page.waitForSelector(".soon-card");
check((await page.textContent(".soon-card")).includes("В разработке"), "a coming section says it is not ready yet");
await page.goto(base + "/#/admin");
await page.waitForSelector(".facts.four");
check((await page.textContent(".facts.four")).includes("Накладные") && (await page.$$("tbody tr")).length >= 4,
  "admin panel shows service-wide numbers");
await shot("12-admin.png");

await page.goto(base + "/#/invoices");
await page.waitForSelector("tr[data-id]");
await page.fill("#search", "хлеб");
check((await page.$$("tr[data-id]")).length === 1, "search finds the bakery invoice");
await page.fill("#search", "нет такого");
check(await page.isVisible("text=Ничего не найдено"), "empty search result is explained");
await page.fill("#search", "");

await page.goto(base + "/#/invoices/deadbeef-0000");
await page.waitForSelector(".error-state");
check((await page.textContent(".error-state")).includes("не найдена"), "unknown invoice shows a not-found state");

// Savings, recipes, plan and assistant (as the business owner).
await page.goto(base + "/#/savings");
await page.waitForSelector(".empty, .empty-state, .card");
check(await page.isVisible("text=Пока нет закупок за этот период"), "savings page explains an empty period");
// Sample data fills the app so the report, claims and contracts can be tried.
const authed = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const t = JSON.parse(localStorage.getItem("sr.session")).idToken;
  const r = await fetch("/api" + p, { method: m, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
}, [method, path, body]);
await authed("POST", "/demo");
await page.goto(base + "/#/invoices");
await page.reload();
await page.waitForSelector(".demo-banner");
check(true, "sample data shows a banner with a way to remove it");
await page.goto(base + "/#/savings");
await page.waitForSelector(".facts.four");
check((await page.textContent(".facts.four")).includes("Переплата"), "savings dashboard shows the overpay numbers");
await page.goto(base + "/#/recipes");
await page.waitForSelector("#new-recipe");
await page.click("#new-recipe");
await page.fill("#r-name", "Латте");
await page.fill("#r-portions", "2");
await page.fill("#r-price", "1500");
await page.fill("#ing-q-1", "2");
check((await page.textContent("#recipe-sum")).includes("Себестоимость порции"), "recipe form previews the cost");
await page.click("#recipe-form button[type=submit]");
await page.waitForSelector(".recipe");
check((await page.textContent(".recipe")).includes("Латте") && (await page.textContent(".recipe")).includes("Маржа"), "recipe saved with its cost and margin");
await shot("13-recipes.png");
await page.goto(base + "/#/assistant");
await page.waitForSelector(".empty");
check((await page.textContent(".empty")).includes("тариф Pro"), "assistant is offered on Pro only");
await page.goto(base + "/#/subscription");
await page.waitForSelector(".plans");
await page.click("[data-plan=pro]");
await page.waitForSelector("#demo-pay:not([hidden])");
check((await page.textContent("#demo-pay")).includes("не списываются"), "payment says it is a demo");
await shot("14-subscription.png");
await page.click("#pay-go");
await page.waitForSelector(".plan.current:has-text('Pro')");
check(true, "demo payment switches the plan to Pro");
await page.goto(base + "/#/assistant");
await page.waitForSelector("#ask");
await page.click("[data-q='Где я переплачиваю больше всего?']");
await page.waitForSelector(".bubble.bot");
check((await page.textContent(".bubble.bot")).includes("AI-помощника"), "assistant answers a question");
await shot("15-assistant.png");

// Report -> claim: contract price control, claim text, refund.
await page.goto(base + "/#/savings");
await page.waitForSelector(".payback");
check((await page.textContent(".payback")).includes("Вернём переплату"), "savings report has the «Вернём переплату» card");
check((await page.$$(".bar-cell")).length === 6, "monthly report lists the last six months");
await shot("20-savings.png");
await page.goto(base + "/#/contracts");
await page.waitForSelector("#contract-form");
await page.fill("#c-price", "1");
await page.fill("#c-tol", "2");
await page.click("#contract-form button[type=submit]");
await page.waitForSelector(".contract .badge.bad");
check(true, "a price above the contract is flagged");
await shot("21-contracts.png");
await page.click(".contract [data-claim]");
await page.waitForSelector(".claim .claim-text");
check((await page.textContent(".claim-text")).includes("₸"), "claim text carries the numbers");
await shot("22-claims.png");
await page.click(".claim [data-status=sent]");
await page.waitForSelector(".claim [data-status=resolve]");
await page.click(".claim [data-status=resolve]");
await page.fill(".claim .refund input", "500");
await page.click(".claim .refund button[type=submit]");
await page.waitForSelector(".claim .badge.ok");
check((await page.textContent(".claim")).includes("500"), "resolved claim shows the refunded amount");

// «Сеть»: several points, upload point picker, per-point comparison.
await page.goto(base + "/#/locations");
await page.waitForSelector(".empty");
check((await page.textContent(".empty")).includes("«Сеть»"), "points are offered on the Network plan");
await page.goto(base + "/#/subscription");
await page.waitForSelector("[data-plan=network]");
await page.click("[data-plan=network]");
await page.click("#pay-go");
await page.waitForSelector(".plan.current:has-text('Сеть')");
await page.goto(base + "/#/locations");
await page.waitForSelector("#loc-form");
await page.fill("#l-name", "Кофейня на Достык");
await page.click("#loc-save");
await page.waitForSelector("tr:has-text('Кофейня на Достык')");
check(true, "a second point is added on the Network plan");
await shot("23-locations.png");
await page.goto(base + "/#/invoices");
await page.waitForSelector("#upload-location");
check((await page.$$eval("#upload-location option", (o) => o.length)) === 2, "upload form offers the points");

// Sample data can be cleared again.
await page.click("#clear-demo");
await page.waitForSelector(".demo-banner", { state: "detached" });
check(true, "sample data can be cleared");
await authed("POST", "/demo"); // the accessibility run reuses this account with data in it

// Outgoing documents: receipt, expenses, stock order, tax draft and the accountant's package.
await page.goto(base + "/#/taxes");
await page.waitForSelector("#tax-form");
await page.fill("#t-regime", "Упрощённая декларация");
await page.fill("#t-rate", "3");
await page.fill("#t-bin", "1234 5678 9012");
await page.fill("#t-address", "Алматы, Абая 10");
await page.click("#tax-form button[type=submit]");
await page.waitForSelector("#t-rate[value='3']");
await page.click("[data-tpl='0']");
const soon = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
await page.fill("#dl-due", soon);
await page.click("#dl-form button[type=submit]");
await page.waitForSelector(".deadlines li");
check((await page.textContent(".deadlines")).includes("через 3 дня"), "tax calendar counts the days left");
await shot("28-taxes.png");
await page.goto(base + "/#/invoices");
await page.reload();
await page.waitForSelector(".deadline-note");
check((await page.textContent(".deadline-note")).includes("Сдать налоговую декларацию"), "a deadline within a week shows on the invoices page");

await page.click("[data-nav=pos]");
await page.waitForSelector("#sale-form");
check(await page.getAttribute("[data-nav=pos]", "aria-current") === "page", "«Касса» is a main navigation tab");
await page.selectOption("#s-item", "free");
await page.fill("#s-free", "Круассан");
await page.fill("#s-qty", "2");
await page.fill("#s-price", "900");
await page.click("#s-add");
await page.selectOption("#s-item", { label: "молоко 3.2% 1 л, 650 ₸" });
check((await page.inputValue("#s-price")) === "650", "a product's sale price is filled in");
await page.click("#s-add");
await page.fill("#s-discount", "50");
check((await page.textContent("#cart-total")).replace(/\s/g, "").includes("2400"), "cart total applies the discount");
await page.check("input[name=payment][value=card]");
await shot("24-pos.png");
await page.click("#s-pay");
await page.waitForSelector(".receipt");
const receipt = (await page.textContent(".receipt")).replace(/\s/g, " ");
check(receipt.includes("Чек №") && receipt.includes("123456789012") && receipt.replace(/ /g, "").includes("2400") && receipt.includes("Карта"),
  "receipt carries the number, BIN, total and payment");
await shot("25-receipt.png");
await page.click("#refund-open");
await page.click("#refund-form button[type=submit]");
check(await page.isVisible("#refund-error"), "a refund asks for the reason");
await page.fill("#refund-reason", "Ошибка кассира");
await page.click("#refund-form button[type=submit]");
await page.waitForSelector(".receipt .badge.bad");
check(true, "receipt can be refunded");

await page.goto(base + "/#/expenses");
await page.waitForSelector("#exp-form");
await page.selectOption("#e-cat", "salary");
await page.fill("#e-amount", "150000");
await page.fill("#e-note", "Бариста");
await page.check("#e-monthly");
await page.click("#exp-form button[type=submit]");
await page.waitForSelector("text=Ежемесячные платежи");
check(await page.isVisible(".badge.info:has-text('каждый месяц')"), "a monthly expense is listed with its repeat");

await page.goto(base + "/#/stock");
await page.waitForSelector(".stock-order");
check((await page.textContent(".stock-order")).includes("Просим привезти"), "low stock drafts an order to the supplier");
await shot("27-stock.png");

await page.goto(base + "/#/reports");
await page.waitForSelector(".tax-card");
const report = await page.textContent("#app");
check(report.includes("Выручка") && report.includes("Упрощённая декларация") && !(await page.textContent(".tax-lines .total")).includes("—"),
  "report shows revenue and a tax draft with the owner's rate");
const [journal] = await Promise.all([page.waitForEvent("download"), page.click("#exp-journal")]);
const journalCsv = fs.readFileSync(await journal.path(), "utf8");
check(journalCsv.includes("Продажа") && journalCsv.includes("Закупка") && journalCsv.includes("Расход"), "journal exports sales, purchases and expenses");
await shot("26-reports.png");

await page.goto(base + "/#/access");
await page.waitForSelector("#acc-form");
await page.fill("#acc-email", "accountant@example.com");
await page.click("#acc-form button[type=submit]");
await page.waitForSelector("[data-revoke]");
check(true, "owner opens read-only access for an accountant");

// A supplier signs up on its own, fills the catalog and receives an order.
async function signUp(pg, email, template, name) {
  await pg.goto(base);
  await pg.waitForSelector("#auth-form");
  await pg.click("[data-mode=signup]");
  await pg.fill("#email", email);
  await pg.fill("#password", "demo1234");
  await pg.click("button[type=submit]");
  await pg.waitForSelector("#code");
  await pg.fill("#code", "123456");
  await pg.click("button[type=submit]");
  await pg.waitForSelector("#password");
  await pg.fill("#email", email);
  await pg.fill("#password", "demo1234");
  await pg.click("button[type=submit]");
  await pg.waitForSelector("#welcome");
  await pg.check(`input[name=business_type][value=${template}]`);
  await pg.fill("#business-name", name);
  if (await pg.locator("#load-demo").count()) await pg.uncheck("#load-demo");
  await pg.click("#welcome button[type=submit]");
}
const supplier = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "ru-RU", reducedMotion: "reduce" });
await signUp(supplier, "supplier@example.com", "supplier", "ТОО Молочный двор");
await supplier.waitForSelector("#item-form");
check(!(await supplier.isVisible("[data-nav=invoices]")) && await supplier.isVisible("[data-nav=suppliers]"),
  "a supplier sees the cabinet navigation, not the business one");
await supplier.goto(base + "/#/invoices");
await supplier.waitForSelector("#item-form");
check(supplier.url().endsWith("#/suppliers"), "business pages send a supplier back to the catalog");
await supplier.fill("#i-name", "Молоко 3,2% 1 л");
await supplier.fill("#i-price", "380");
await supplier.click("#item-save");
await supplier.waitForSelector("tr[data-id]");
await supplier.setInputFiles("#import", { name: "price.csv", mimeType: "text/csv",
  buffer: Buffer.from("Название;Единица;Цена\r\nСыр голландский;кг;3000\r\nМасло 82%;шт;1200\r\n") });
await supplier.waitForSelector("tr[data-id]:nth-child(3)");
check((await supplier.$$("tr[data-id]")).length === 3, "catalog gets a new item and an imported CSV price list");
await supplier.click("tr[data-id]:has-text('Масло') [data-stock]");
await supplier.waitForSelector("tr[data-id]:has-text('Масло') .badge.bad");
check(true, "a supplier can mark an item out of stock");
await shot("16-catalog.png");

await page.goto(base + "/#/suppliers");
await page.waitForSelector("#sup-list a.tile");
check((await page.textContent("#sup-list")).includes("ТОО Молочный двор"), "business sees the supplier in the directory");
await page.click("#sup-list a.tile");
await page.waitForSelector("#order-form");
check((await page.textContent("#order-form")).includes("Ваша лучшая цена"), "catalog compares prices with the business's own best price");
check(await page.isDisabled("input[aria-label^='Количество: Масло']"), "an out-of-stock item cannot be ordered");
await page.fill("input[aria-label^='Количество: Молоко']", "5");
await page.fill("#note", "К 8 утра");
await shot("17-supplier-catalog.png");
await page.click("#order-form button[type=submit]");
await page.waitForSelector(".order");
check((await page.textContent(".order")).includes("Новая"), "order is sent to the supplier");

await supplier.goto(base + "/#/orders");
await supplier.waitForSelector(".order");
check((await supplier.textContent(".order")).includes("К 8 утра"), "the supplier receives the order with its note");
await supplier.click("[data-status=accepted]");
await supplier.waitForSelector(".order .badge:has-text('Принята')");
await page.reload();
await page.waitForSelector(".order .badge:has-text('Принята')");
check(true, "the buyer sees the accepted status");
await shot("18-orders.png");
await supplier.close();

// The accountant signs up with the invited email and reads the owner's report, nothing else.
const accountant = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "ru-RU", reducedMotion: "reduce" });
await signUp(accountant, "accountant@example.com", "other", "");
await accountant.waitForSelector("#drop");
await accountant.goto(base + "/#/access");
await accountant.waitForSelector("a[href^='#/shared/']");
await accountant.click("a[href^='#/shared/']");
await accountant.waitForSelector(".tax-card");
check((await accountant.textContent("h1")).includes("Кофейня на Абая") && !(await accountant.isVisible("a[href='#/taxes']")),
  "the accountant sees the owner's report read-only");
await accountant.close();

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "ru-RU", reducedMotion: "reduce" });
await mobile.goto(base);
await mobile.evaluate((s) => localStorage.setItem("sr.session", s), await page.evaluate(() => localStorage.getItem("sr.session")));
await mobile.goto(base + "/#/invoices");
await mobile.waitForSelector("tr[data-id]");
const overflows = () => mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const navBox = await mobile.locator("#nav").boundingBox();
check(navBox && navBox.y > 700, "phone: navigation is a bottom tab bar");
await mobile.screenshot({ path: path.join(shots, "08-mobile.png"), fullPage: false });
check(!(await overflows()), "phone: no horizontal scroll on the invoice list");
await mobile.click("tr[data-id]:has-text('Хлебный')");
await mobile.waitForSelector("#lines");
check(!(await overflows()), "phone: no horizontal scroll on invoice review");
await mobile.screenshot({ path: path.join(shots, "09-mobile-invoice.png"), fullPage: true });

check(errors.length === 0, "no browser errors " + (errors.length ? JSON.stringify(errors) : ""));
await browser.close();
console.log("all UI checks passed");
