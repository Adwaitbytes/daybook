// Screenshots every page and state at 360, 768 and 1440 into ../design/build-shots.
// Usage: node scripts/shots.mjs <base url> [name filter]
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:4317";
const only = process.argv[3];
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "design", "build-shots");
mkdirSync(out, { recursive: true });

const pages = [
  ["home", "/"],
  ["pay-settled", "/pay/2"],
  ["pay-missing", "/pay/999999"],
  ["ledger", "/ledger"],
  ["rules", "/rules"],
  ["health", "/health"],
  ["make", "/make"],
  ["not-found", "/nope"],
  ["states-waiting", "/design/states?s=waiting"],
  ["states-part-paid", "/design/states?s=part-paid"],
  ["states-seen", "/design/states?s=payment-seen"],
  ["states-wrong-token", "/design/states?s=wrong-token"],
  ["states-expired", "/design/states?s=expired"],
  ["states-overdue", "/design/states?s=overdue"],
  ["states-loading", "/design/states?s=loading"],
  ["states-rpc-error", "/design/states?s=rpc-error"],
  ["states-not-deployed", "/design/states?s=not-deployed"],
  ["states-rate-limited", "/design/states?s=rate-limited"],
  ["states-demo-error", "/design/states?s=demo-unconfigured"],
];
const widths = [360, 768, 1440];
const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  for (const [name, path] of pages) {
    if (only !== undefined && !name.includes(only)) continue;
    if (scheme === "dark" && !["home", "pay-settled", "states-waiting", "ledger"].includes(name)) continue;
    for (const w of widths) {
      if (scheme === "dark" && w !== 1440) continue;
      const ctx = await browser.newContext({
        viewport: { width: w, height: 900 },
        colorScheme: scheme,
        reducedMotion: "reduce",
      });
      const page = await ctx.newPage();
      await page.goto(base + path, { waitUntil: "load", timeout: 90_000 });
      await page
        .waitForFunction(() => document.querySelector("main [role=status] .caret") === null, null, { timeout: 60_000 })
        .catch(() => {});
      await page.waitForTimeout(900);
      const file = join(out, `${name}${scheme === "dark" ? "-dark" : ""}-${w}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
      await ctx.close();
    }
  }
}
await browser.close();
