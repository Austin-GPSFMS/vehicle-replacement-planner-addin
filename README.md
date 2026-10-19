# Vehicle Replacement Planner — MyGeotab Add-In

Vite + React + TypeScript + Zenith MyGeotab add-in that answers "which
vehicles should we sell, and when will the rest get there?" against the
fleet's own criteria: a mileage threshold and/or an age threshold, each on a
slider that can be switched off, plus a per-vehicle projection of the month
the mileage threshold will be reached based on that vehicle's recent average.

Mirrors the stack and conventions of `recall-harness-swap-addin` and
`intelligent-zoning-addin`.

## What it does

| Piece | How it's computed |
|---|---|
| **Vehicles** | Active devices (`Get Device` with `fromDate = now`), scoped by the Zenith group picker (selected groups + descendants). |
| **Make / model / year** | MyGeotab's own VIN decoder — `DecodeVins { vins: [...] }` — the same data the Vehicle edit page shows. Batches of 100, cached per VIN in the browser. Geotab labels DecodeVins "not fully supported"; if it fails the page says so, make/model go blank and the year falls back to the VIN's model-year code. No VIN on the device → **Missing VIN** pill, evaluated on mileage only. |
| **Odometer** | `Get StatusData` for `DiagnosticOdometerAdjustmentId` (what MyGeotab displays; raw `DiagnosticOdometerId` comes back alongside and is used only when the adjusted series is missing at either end) with `fromDate == toDate == instant` — once at *now*, once at the look-back instant. Both are per-device calls batched 50 per `multiCall` and paced under the calls-per-minute cap. |
| **Avg per month** | (odometer now − odometer at baseline) ÷ the *actual* months between the two samples. A vehicle installed after the baseline instant still gets a correct rate; spans under ~3 weeks give no rate. |
| **Projection** | months to threshold = (threshold − odometer) ÷ avg per month → shown as the calendar month ("Reaches 150,000 mi: Mar 2027, in 5 mo"). The mileage slider is the projection target. |
| **Age** | Calendar year − model year. The age threshold date is 1 Jan of (model year + N). |
| **Verdict** | Either/or across the *enabled* criteria: **Time to sell** = any met · **Approaching** = projected within the horizon slider · **Keep** · **No data** (nothing evaluable). Hover a status pill for the reasons. |

Sliders re-evaluate the fetched data instantly (no API calls). Only *Run scan*
and a change of look-back (3/6/12/24 months) touch the API.

## API calls per scan

Groups ×1 (plus ×1 on load for the picker) · Devices ×1 · DecodeVins ×1 per
100 unique VINs (cache hits skip) · StatusData ×2 per vehicle (now +
baseline), batched 50 per multiCall. The scan paces itself under the
configurable calls-per-minute cap (default 600, MyGeotab's limit is ~1000
per user per minute) — a 400-vehicle database is ~810 calls and takes about
a minute and a half; it just takes longer on bigger ones instead of tripping
the quota.

## Project layout

```
vehicle-replacement-planner-addin/
├── package.json
├── tsconfig.json
├── vite.config.ts          ← base = absolute GitHub Pages URL (add-in is injected, not iframed)
├── index.html              ← Vite entry shell
├── config.json             ← MyGeotab Add-In manifest
├── .nojekyll
├── dist/                   ← committed build output served by GitHub Pages
├── test/
│   ├── run.mjs             ← offline evaluation checks (npm test)
│   ├── smoke.mjs           ← headless Chromium smoke test with a mocked MyGeotab api (npm run smoke)
│   └── rules-entry.ts
└── src/
    ├── main.tsx            ← lifecycle wiring (geotab.addin.vehicleReplacementPlanner) + standalone preview
    ├── App.tsx             ← header · settings · criteria · banners · summary · tabs · table
    ├── types.ts
    ├── styles.css          ← imports Zenith CSS + GPSFMS brand tokens + slider styling
    ├── api/geotab.ts       ← apiCall/multiCall, Pacer, devices, DecodeVins, odometer-at-instant
    ├── components/
    │   ├── CriteriaBar.tsx     ← the sliders (mileage / age / horizon / look-back / units)
    │   ├── GroupFilterPicker.tsx
    │   ├── Summary.tsx
    │   └── VehicleTable.tsx
    └── utils/
        ├── evaluate.ts     ← pure verdict + projection maths
        ├── scan.ts         ← runScan (API) / buildRows (pure)
        ├── demo.ts         ← synthetic fleet for the standalone preview + smoke test
        ├── export.ts, format.ts, groups.ts, labels.ts, storage.ts, vin.ts
```

## Build & deploy

```
npm install
npm run build        # tsc + vite → dist/
npm test             # evaluation maths
npm run smoke        # headless UI check (needs playwright + chromium)
```

Commit `dist/` and push to `github.com/Austin-GPSFMS/vehicle-replacement-planner-addin`
with GitHub Pages serving the repo root; install in MyGeotab with the
contents of `config.json` (Administration → System… → Add-Ins → New Add-In).
Opening `dist/index.html` directly renders a synthetic demo fleet.

## Notes & open ideas

- `DecodeVins` is undocumented; the first raw result is logged to the console
  (`[VRP] DecodeVins sample result`) so the parsed field names can be checked
  on the pilot database. The parser looks for make/manufacturer, model and
  year/modelYear case-insensitively, one level deep.
- Possible v2: cost/condition inputs (maintenance spend from Fleetio, fault
  counts), per-group criteria presets, engine-hours criterion for equipment,
  monthly sampling for a trend sparkline, scheduled email of the "Time to
  sell" list.
