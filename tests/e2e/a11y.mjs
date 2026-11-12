// Accessibility check of every screen with axe-core (WCAG 2.0-2.2 A/AA rules), in both colour
// schemes, plus reflow at 320 px. Run after ui.spec.mjs against the same fake backend, which
// leaves a signed-up user with invoices, products and one alert:
//   python3 tests/e2e/fake_backend.py &  node tests/e2e/ui.spec.mjs && node tests/e2e/a11y.mjs
// Needs axe-core: `npm i --no-save axe-core`, or AXE=/path/to/axe.min.js.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const base = process.env.BASE_URL || "http://localhost:8765";
const axeSource = readFileSync(process.env.AXE || createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let failures = 0;
let session = null;
let newcomer = null;

async function audit(page, name) {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate((tags) => window.axe.run(document, { runOnly: { type: "tag", values: tags } }), TAGS);
  for (const v of result.violations) {
    failures += v.nodes.length;
    console.log(`FAILED - ${name}: ${v.id} (${v.impact}) ${v.help}`);
    v.nodes.slice(0, 4).forEach((n) => console.log(`    ${n.target.join(" ")}  ${(n.any[0] || n.all[0] || n.none[0] || {}).message || ""}`));
  }
  if (!result.violations.length) console.log(`ok - ${name}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) { failures += 1; console.log(`FAILED - ${name}: horizontal scroll`); }
}

for (const [label, options] of [
  ["light", { viewport: { width: 1280, height: 860 }, colorScheme: "light" }],
  ["dark", { viewport: { width: 1280, height: 860 }, colorScheme: "dark" }],
  ["phone 320px", { viewport: { width: 320, height: 640 }, colorScheme: "light" }],
]) {
  const page = await browser.newPage({ locale: "ru-RU", reducedMotion: "reduce", ...options });
  await page.goto(base);
  if (!session) {
    await page.waitForSelector("#auth-form");
    await audit(page, `${label}: sign in`);
    await page.click("[data-mode=signup]");
    await audit(page, `${label}: sign up`);
    await page.click("[data-mode=signin]");
    await page.click("[data-mode=forgot]");
    await audit(page, `${label}: password reset`);
    await page.click("[data-mode=signin]");
    await page.fill("#email", "owner@example.com");
    await page.fill("#password", "newpass123");
    await page.click("button[type=submit]");
    await page.waitForSelector("#drop");
    session = await page.evaluate(() => localStorage.getItem("sr.session"));
  } else {
    await page.evaluate((s) => localStorage.setItem("sr.session", s), session);
    if (label.startsWith("phone")) {
      await page.evaluate(() => localStorage.removeItem("sr.session"));
      await page.goto(base + "/#/login");
      await page.waitForSelector("#auth-form");
      await audit(page, `${label}: sign in`);
      await page.evaluate((s) => localStorage.setItem("sr.session", s), session);
    }
  }
  const visit = async (hash, selector, name) => {
    await page.goto(base + "/#" + hash);
    await page.waitForSelector(selector);
    await audit(page, `${label}: ${name}`);
  };
  await visit("/invoices", "tr[data-id]", "invoices");
  if (label === "light") {
    // Keyboard: the upload control must be reachable and show a focus ring.
    await page.focus("#picker");
    const ring = await page.evaluate(() => document.activeElement.id === "picker"
      && getComputedStyle(document.activeElement.closest("label")).outlineStyle !== "none");
    if (!ring) { failures += 1; console.log("FAILED - keyboard: file picker is not focusable or shows no focus ring"); }
    else console.log("ok - keyboard: file picker is focusable with a visible ring");
    await page.keyboard.press("Tab");
    const visible = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== "none");
    if (!visible) { failures += 1; console.log("FAILED - keyboard: focus ring missing on the next control"); }
  }
  await page.click("tr[data-id]:has-text('Молочный') a");
  await page.waitForSelector("#lines");
  await audit(page, `${label}: invoice (editable)`);
  await page.goto(base + "/#/invoices");
  await page.waitForSelector("tr[data-id]");
  await page.click("tr[data-id]:has-text('Хлебный') a");
  await page.waitForSelector("#lines");
  await audit(page, `${label}: invoice (confirmed)`);
  await visit("/products", "tr[data-key]", "products");
  await page.click("tr[data-key]:has-text('сливки') a");
  await page.waitForSelector(".chart svg");
  await audit(page, `${label}: product history`);
  await visit("/alerts", ".alert-card", "alerts");
  await visit("/settings", "#threshold", "settings");
  await visit("/more", ".tiles", "more");
  await visit("/subscription", ".soon-card", "coming section");
  await visit("/admin", ".facts.four", "admin panel");
  await visit("/invoices/deadbeef-0000", ".error-state", "not found");
  // The welcome step, as a second account that has not chosen a template yet.
  if (!newcomer) {
    await page.evaluate(() => localStorage.removeItem("sr.session"));
    await page.goto(base + "/#/login");
    await page.reload();
    await page.waitForSelector("#auth-form");
    await page.click("[data-mode=signup]");
    await page.fill("#email", "newcomer@example.com");
    await page.fill("#password", "demo1234");
    await page.click("button[type=submit]");
    await page.waitForSelector("#code");
    await page.fill("#code", "123456");
    await page.click("button[type=submit]");
    await page.waitForSelector("#password");
    await page.fill("#email", "newcomer@example.com");
    await page.fill("#password", "demo1234");
    await page.click("button[type=submit]");
    await page.waitForSelector("#welcome");
    newcomer = await page.evaluate(() => localStorage.getItem("sr.session"));
  } else {
    await page.evaluate((s) => localStorage.setItem("sr.session", s), newcomer);
    await page.goto(base + "/#/welcome");
    await page.reload();
    await page.waitForSelector("#welcome");
  }
  await page.check("input[name=business_type][value=shop]");
  await audit(page, `${label}: welcome`);
  await page.close();
}

await browser.close();
if (failures) { console.log(`${failures} accessibility problem(s)`); process.exit(1); }
console.log("all accessibility checks passed");
