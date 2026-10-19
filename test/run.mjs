/**
 * Offline evaluation check: bundles the pure evaluate/scan utilities with
 * esbuild and asserts the verdict + projection maths on known inputs.
 *   npm test
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, ".build");
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, "rules.mjs");
await build({
  entryPoints: [resolve(here, "rules-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
  logLevel: "silent",
});
const m = await import(pathToFileURL(outFile).href);

const MI = 1609.344;
const now = new Date("2026-10-16T12:00:00Z");
const base = (miles, monthsAgo) => ({
  meters: miles * MI,
  dateTime: new Date(now.getTime() - monthsAgo * 30.4375 * 86400000).toISOString(),
  diagnosticId: "DiagnosticOdometerAdjustmentId",
});
const cur = (miles) => ({ meters: miles * MI, dateTime: now.toISOString(), diagnosticId: "DiagnosticOdometerAdjustmentId" });
const crit = { ...m.DEFAULT_CRITERIA, mileageThreshold: 150000, ageThreshold: 10, horizonMonths: 12, lookbackMonths: 6, units: "mi" };

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log("  ✓", name); };

// 1. The example from the brief: 2,000 mi/mo for 6 months, now at 100,000 → 150k in 25 months.
check("100k @ 2,000 mi/mo reaches 150k in 25 months", () => {
  const r = m.evaluate({ current: cur(100000), baseline: base(88000, 6), year: 2020 }, crit, now);
  assert.equal(Math.round(r.metersPerMonth / MI), 2000);
  assert.equal(Math.round(r.monthsToMileage), 25);
  const d = new Date(r.mileageDate);
  assert.equal(d.getUTCFullYear(), 2028);
  assert.equal(d.getUTCMonth(), 10); // November 2028
  assert.equal(r.verdict, "ok"); // 25 mo > 12 mo horizon, 6 yr < 10 yr
});

// 2. Same vehicle with a 120k target → 10 months → approaching.
check("120k target → 10 months → approaching", () => {
  const r = m.evaluate({ current: cur(100000), baseline: base(88000, 6), year: 2020 }, { ...crit, mileageThreshold: 120000 }, now);
  assert.equal(Math.round(r.monthsToMileage), 10);
  assert.equal(r.verdict, "approaching");
  assert.match(r.reasons[0], /Projected to reach 120,000 mi in 10 mo/);
});

// 3. Mileage already past → sell, even with age off.
check("odometer past threshold → sell (age off)", () => {
  const r = m.evaluate({ current: cur(151000), baseline: base(140000, 6), year: 2024 }, { ...crit, ageOn: false }, now);
  assert.equal(r.verdict, "sell");
  assert.equal(r.monthsToMileage, 0);
});

// 4. Age only: 2016 is 10 model-years old in 2026 → sell; 2017 turns 10 on 1 Jan 2027 → approaching.
check("age criterion: 2016 → sell, 2017 → approaching (Jan 2027)", () => {
  const a = m.evaluate({ current: null, baseline: null, year: 2016 }, { ...crit, mileageOn: false }, now);
  assert.equal(a.verdict, "sell");
  assert.equal(a.ageYears, 10);
  const b = m.evaluate({ current: null, baseline: null, year: 2017 }, { ...crit, mileageOn: false }, now);
  assert.equal(b.verdict, "approaching");
  assert.equal(new Date(b.ageDate).getFullYear(), 2027);
  assert.ok(b.monthsToAge > 2 && b.monthsToAge < 3);
});

// 5. Either/or: mileage on + age on, only age met → sell.
check("either/or: only age met → sell", () => {
  const r = m.evaluate({ current: cur(40000), baseline: base(34000, 6), year: 2014 }, crit, now);
  assert.equal(r.verdict, "sell");
  assert.ok(r.reasons.some((s) => /model-years old/.test(s)));
});

// 6. No odometer + no year → no-data; no odometer but year → evaluated on age only.
check("no-data vs. partial data", () => {
  assert.equal(m.evaluate({ current: null, baseline: null, year: null }, crit, now).verdict, "no-data");
  const r = m.evaluate({ current: null, baseline: null, year: 2022 }, crit, now);
  assert.equal(r.verdict, "ok");
  assert.ok(r.reasons.includes("No odometer reading"));
});

// 7. Too-short span → no rate, still threshold-checked.
check("span under the minimum → no projection", () => {
  const r = m.evaluate({ current: cur(100000), baseline: base(99900, 0.3), year: 2022 }, crit, now);
  assert.equal(r.metersPerMonth, null);
  assert.equal(r.monthsToMileage, null);
  assert.ok(r.reasons.includes("Not enough odometer history to project"));
});

// 8. km units: threshold 200,000 km with a 100k-mile vehicle (= 160,934 km) → not met.
check("km units convert correctly", () => {
  const r = m.evaluate({ current: cur(100000), baseline: base(88000, 6), year: 2022 }, { ...crit, units: "km", mileageThreshold: 200000 }, now);
  assert.equal(r.verdict, "ok");
  assert.equal(Math.round(r.monthsToMileage), 12); // 39,066 km left at 3,219 km/mo ≈ 12.1 mo
});

// 9. pickSamplePair prefers the adjusted odometer and only pairs like-for-like.
check("pickSamplePair pairs the same diagnostic", () => {
  const adj = cur(50000), raw = { ...cur(49000), diagnosticId: "DiagnosticOdometerId" };
  const bRaw = { ...base(43000, 6), diagnosticId: "DiagnosticOdometerId" };
  const p = m.pickSamplePair(new Map([[adj.diagnosticId, adj], [raw.diagnosticId, raw]]), new Map([[bRaw.diagnosticId, bRaw]]), ["DiagnosticOdometerAdjustmentId", "DiagnosticOdometerId"]);
  assert.equal(p.current.diagnosticId, "DiagnosticOdometerId");
  assert.equal(p.baseline.diagnosticId, "DiagnosticOdometerId");
});

// 10. Demo fleet end-to-end through buildRows + CSV.
check("demo fleet builds rows and CSV", () => {
  const fleet = m.makeDemoFleet(36, 7, now, 6);
  const rows = m.buildRows(m.demoVehicleData(fleet), crit, now);
  assert.equal(rows.length, 36);
  const verdicts = new Set(rows.map((r) => r.verdict));
  assert.ok(verdicts.has("sell") && verdicts.has("ok"), "expected a mix of verdicts: " + [...verdicts]);
  assert.ok(rows.some((r) => r.vinStatus === "missing"));
  assert.ok(rows.every((r) => r.vinStatus !== "decoded" || (r.make && r.model && r.year)));
  const csv = m.rowsToCsv(rows, crit);
  assert.equal(csv.split("\r\n").length, 37);
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  console.log("    demo verdicts:", counts);
});

console.log(`${n} checks passed`);
