// Browser test of the web app against tests/e2e/fake_backend.py.
//   python3 tests/e2e/fake_backend.py &   then   node tests/e2e/ui.spec.mjs
// Walks the demo: sign up, password reset, three invoices -> price alert,
// a broken invoice -> review -> confirm, error and empty states, phone layout.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const base = process.env.BASE_URL || "http://localhost:8765";
const shots = process.env.SHOTS || path.join(root, "docs/screenshots");
mkdirSync(shots, { recursive: true });
const sample = (n) => path.join(root, "samples/demo", n);

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "ru-RU" });
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
await page.waitForSelector("#drop");
check(true, "sign up, confirm and sign in");
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

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "ru-RU" });
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
