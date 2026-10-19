/**
 * Headless smoke test: serves the built dist (with the absolute Pages base
 * rewritten to local paths) under a mocked MyGeotab `api` built from the
 * demo fleet, drives the sliders, and checks the table + tiles update.
 *   npm run build && npm run smoke   (needs playwright + chromium)
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, cpSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const site = resolve(here, ".build/site/dist");
const PAGES_BASE = "https://austin-gpsfms.github.io/vehicle-replacement-planner-addin/dist/";

// 1. Local copy of dist with the absolute base rewritten.
mkdirSync(site, { recursive: true });
cpSync(resolve(root, "dist"), site, { recursive: true });
for (const f of ["index.html", ...readdirSync(resolve(site, "assets")).map((a) => `assets/${a}`)]) {
  if (!/\.(html|js|css)$/.test(f)) continue;
  const p = resolve(site, f);
  writeFileSync(p, readFileSync(p, "utf8").split(PAGES_BASE).join("/"));
}

// 2. Demo fleet → fixture for the mocked API.
const bundle = resolve(here, ".build/rules.mjs");
await build({ entryPoints: [resolve(here, "rules-entry.ts")], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "silent" });
const m = await import(pathToFileURL(bundle).href);
const FLEET_SIZE = Number(process.env.FLEET || 2800);
const fleet = m.makeDemoFleet(FLEET_SIZE, 7, new Date(), 6);

const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".woff2": "font/woff2", ".woff": "font/woff", ".otf": "font/otf", ".map": "application/json" };
const server = createServer((req, res) => {
  const p = resolve(site, "." + (req.url === "/" ? "/index.html" : req.url.split("?")[0]));
  if (!existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(5181, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });

await page.addInitScript((fx) => {
  const nowMs = new Date(fx.now).getTime();
  function answer(method, params) {
    if (method === "Get") {
      switch (params.typeName) {
        case "Group": return fx.groups;
        case "Device": return fx.devices;
        case "StatusData": {
          const s = params.search ?? {};
          const from = new Date(s.fromDate).getTime();
          const to = new Date(s.toDate).getTime();
          const row = (id, r) => ({ device: { id }, diagnostic: { id: r.diagnosticId }, dateTime: r.dateTime, data: r.meters });
          if (s.deviceSearch) {
            // Per-device "nearest" lookup: return the records bounding the instant.
            const o = fx.odometer[s.deviceSearch.id];
            if (!o) return [];
            const list = Math.abs(from - nowMs) < 86400000 ? o.now : o.base;
            return list.map((r) => row(s.deviceSearch.id, r));
          }
          // Fleet-wide window: every reading inside [from, to].
          const out = [];
          for (const [id, o] of Object.entries(fx.odometer)) {
            for (const r of [...o.now, ...o.base]) {
              const t = new Date(r.dateTime).getTime();
              if (t >= from && t <= to) out.push(row(id, r));
            }
          }
          return out;
        }
      }
    }
    if (method === "DecodeVins") {
      return params.vins.map((vin) => fx.vinTable[vin] ?? { vin, make: "", model: "", year: null });
    }
    throw new Error("unmocked " + method + " " + JSON.stringify(params).slice(0, 80));
  }
  window.__calls = [];
  const api = {
    call(method, params, ok, fail) { window.__calls.push(method + ":" + (params?.typeName ?? "")); try { const r = answer(method, params); setTimeout(() => ok(r), 2); } catch (e) { fail(e); } },
    multiCall(calls, ok, fail) { window.__calls.push("multi:" + calls.length); try { ok(calls.map(([mm, p]) => answer(mm, p))); } catch (e) { fail(e); } },
    getSession(cb) { cb({ database: "gpsfms_pilot", userName: "tester@gpsfms.com", sessionId: "x" }, "my.geotab.com"); },
  };
  window.geotab = { addin: {} };
  window.addEventListener("DOMContentLoaded", () => {
    const tick = setInterval(() => {
      const f = window.geotab.addin.vehicleReplacementPlanner;
      if (f) { clearInterval(tick); const a = f(); a.initialize(api, {}, () => {}); a.focus(api, {}); }
    }, 20);
  });
}, fleet);

const t0 = Date.now();
await page.goto("http://127.0.0.1:5181/index.html");
await page.waitForSelector(".vrp-table", { timeout: 120000 });
console.log(`fleet of ${FLEET_SIZE}: table rendered ${((Date.now() - t0) / 1000).toFixed(1)}s after load`);
console.log("header:", await page.$eval(".vrp-page-header p", (e) => e.textContent.trim()));
await page.waitForTimeout(400);

const tilesBefore = await page.$$eval(".vrp-tile-value", (els) => els.map((e) => e.textContent.trim()));
const tabsBefore = await page.$$eval(".vrp-table .vrp-row", (els) => els.length);
console.log("tiles (sell/approaching/keep/no-data/due-12mo/avg):", tilesBefore);
console.log("rows on the Time-to-sell tab:", tabsBefore);
await page.screenshot({ path: resolve(here, ".build/smoke-1-default.png"), fullPage: true });

// Drag the mileage slider down to 50,000 → more vehicles should be flagged.
await page.$eval("#vrp-mileage", (el) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(el, "50000");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(200);
const tilesLow = await page.$$eval(".vrp-tile-value", (els) => els.map((e) => e.textContent.trim()));
console.log("after mileage → 50k:", tilesLow);
await page.screenshot({ path: resolve(here, ".build/smoke-2-mileage-50k.png"), fullPage: true });

// Turn the age criterion off → "Turns N yr" column disappears.
const ageToggle = (await page.$$(".vrp-criterion .zen-toggler"))[1];
if (ageToggle) await ageToggle.click({ force: true });
await page.waitForTimeout(200);
const headers = await page.$$eval(".vrp-table th", (els) => els.map((e) => e.textContent.trim()));
console.log("headers after age off:", headers);
await page.screenshot({ path: resolve(here, ".build/smoke-3-age-off.png"), fullPage: true });

// Switch to the All tab and check make/model/year rendered.
await page.click("text=All");
await page.waitForTimeout(200);
const sample = await page.$$eval(".vrp-table .vrp-row", (els) =>
  els.slice(0, 5).map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.trim()).join(" | "))
);
console.log("sample rows:\n  " + sample.join("\n  "));
const calls = await page.evaluate(() => window.__calls);
console.log("api calls:", calls.length, calls.slice(0, 8).join(", "), "…");
await page.screenshot({ path: resolve(here, ".build/smoke-4-all.png"), fullPage: true });

const assertMsgs = [];
if (!tilesBefore.length) assertMsgs.push("no summary tiles");
if (Number(tilesLow[0].replace(/,/g, "")) < Number(tilesBefore[0].replace(/,/g, ""))) assertMsgs.push("lowering the mileage threshold reduced the sell count");
if (headers.some((h) => /Turns/.test(h))) assertMsgs.push("age column still shown after toggling age off");
if (!sample.some((s) => /FORD|CHEVROLET|RAM|INTERNATIONAL|FREIGHTLINER|TOYOTA/.test(s))) assertMsgs.push("no decoded make in sample rows");
if (errors.length) assertMsgs.push("console errors: " + errors.join(" || "));
if (await page.$(".vrp-error")) assertMsgs.push("error boundary tripped");
const foot = await page.$(".vrp-table-foot");
if (FLEET_SIZE > 300 && !foot) assertMsgs.push("expected the show-more footer on a big fleet");

await browser.close();
server.close();
if (assertMsgs.length) {
  console.error("SMOKE FAILED:\n - " + assertMsgs.join("\n - "));
  process.exit(1);
}
console.log("SMOKE OK");
