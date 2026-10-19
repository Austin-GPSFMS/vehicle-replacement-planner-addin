/**
 * Promise-based wrappers around the MyGeotab Add-In `api.call` interface.
 *
 * Mirrors recall-harness-swap-addin/src/api/geotab.ts: every call goes
 * through `apiCall` / `apiMultiCall` so there is one place to pace requests
 * and surface typed errors.
 *
 * Quota notes: MyGeotab allows ~1000 API calls per user per minute and every
 * child of a multiCall counts individually. The odometer scan therefore reads
 * the whole fleet in a few windowed StatusData calls (50k rows each) and only
 * falls back to one call per vehicle, capped, for vehicles the windows
 * missed. The `Pacer` keeps the rolling one-minute count under the configured
 * cap so a big database takes longer instead of tripping "quota exceeded".
 */

import type {
  GeotabApi,
  GeotabDevice,
  GeotabGroup,
  GeotabSession,
  GeotabStatusData,
  OdometerSample,
  VinInfo,
} from "../types";
import { yearFromVin } from "../utils/vin";

const INTER_CALL_DELAY_MS = 40;
const RESULTS_LIMIT = 50000;
/** Devices per multiCall in the odometer lookup. */
const ODO_BATCH = 50;
/** VINs per DecodeVins call. */
const VIN_BATCH = 100;

/** What MyGeotab shows as the vehicle's odometer (raw × factor + manual adjustments). */
export const ODOMETER_ADJ = "DiagnosticOdometerAdjustmentId";
/** Raw engine/GPS odometer × factor — returned alongside the adjustment diagnostic. */
export const ODOMETER_RAW = "DiagnosticOdometerId";

const DEVICE_FIELDS = [
  "id",
  "name",
  "serialNumber",
  "deviceType",
  "productId",
  "activeFrom",
  "activeTo",
  "groups",
  "comment",
  "licensePlate",
  "vehicleIdentificationNumber",
  "engineVehicleIdentificationNumber",
];

// ---------------------------------------------------------------------------
// Rate pacing
// ---------------------------------------------------------------------------

export class Pacer {
  private stamps: number[] = [];
  public total = 0;
  constructor(private perMinute: number) {}

  /** Wait until `n` more calls fit in the rolling 60 s window, then book them. */
  async reserve(n: number, shouldCancel?: () => boolean): Promise<void> {
    const cap = Math.max(50, this.perMinute);
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60000);
      if (this.stamps.length + n <= cap) break;
      if (shouldCancel?.()) throw new Error("Cancelled");
      const oldest = this.stamps[0];
      const wait = Math.min(5000, Math.max(250, 60000 - (now - oldest) + 50));
      await new Promise((r) => setTimeout(r, wait));
    }
    const t = Date.now();
    for (let i = 0; i < n; i++) this.stamps.push(t);
    this.total += n;
  }
}

// ---------------------------------------------------------------------------
// Low-level call helpers
// ---------------------------------------------------------------------------

export function apiCall<T = unknown>(api: GeotabApi, method: string, params: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      api.call(
        method,
        params,
        (result) => setTimeout(() => resolve(result as T), INTER_CALL_DELAY_MS),
        (err) => reject(err)
      );
    } catch (err) {
      reject(err);
    }
  });
}

export function apiMultiCall<T = unknown>(
  api: GeotabApi,
  calls: Array<[string, unknown]>
): Promise<T[]> {
  if (typeof api.multiCall !== "function") {
    return calls.reduce<Promise<T[]>>(
      (p, c) => p.then((acc) => apiCall<T>(api, c[0], c[1]).then((r) => [...acc, r])),
      Promise.resolve([])
    );
  }
  return new Promise((resolve, reject) => {
    try {
      api.multiCall!(
        calls,
        (result) => setTimeout(() => resolve(result as T[]), INTER_CALL_DELAY_MS),
        (err) => reject(err)
      );
    } catch (err) {
      reject(err);
    }
  });
}

export function friendlyError(err: unknown): string {
  if (err == null) return "Unknown error.";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const e = err as { name?: string; message?: string };
    if (e.name === "InvalidUserException" || /InvalidUser/i.test(String(err))) {
      return "Session expired — refresh the MyGeotab page to re-authenticate.";
    }
    if (/quota/i.test(e.message ?? "")) {
      return `${e.message} — wait a minute and try again (lower "calls per minute" in Settings).`;
    }
    if (e.message) return e.message;
  }
  return String(err);
}

export function fetchSession(api: GeotabApi): Promise<GeotabSession | null> {
  return new Promise((resolve) => {
    if (typeof api.getSession !== "function") {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (s: GeotabSession | null) => {
      if (settled) return;
      settled = true;
      resolve(s);
    };
    setTimeout(() => done(null), 3000);
    try {
      api.getSession((credentials, server) => {
        if (!credentials?.sessionId) {
          done(null);
          return;
        }
        done({
          server: server || "my.geotab.com",
          database: credentials.database,
          userName: credentials.userName,
          sessionId: credentials.sessionId,
        });
      });
    } catch {
      done(null);
    }
  });
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export async function fetchGroups(api: GeotabApi, pacer: Pacer): Promise<Map<string, GeotabGroup>> {
  await pacer.reserve(1);
  const groups = await apiCall<GeotabGroup[]>(api, "Get", {
    typeName: "Group",
    resultsLimit: 5000,
  });
  return new Map(groups.map((g) => [g.id, g]));
}

/** Active devices only (fromDate = now returns devices whose activeTo is in the future). */
export async function fetchActiveDevices(api: GeotabApi, pacer: Pacer): Promise<GeotabDevice[]> {
  await pacer.reserve(1);
  const now = new Date().toISOString();
  let devices: GeotabDevice[];
  try {
    devices = await apiCall<GeotabDevice[]>(api, "Get", {
      typeName: "Device",
      search: { fromDate: now },
      resultsLimit: RESULTS_LIMIT,
      propertySelector: { fields: DEVICE_FIELDS, isIncluded: true },
    });
  } catch {
    // Older databases reject propertySelector — fall back to the full entity.
    await pacer.reserve(1);
    devices = await apiCall<GeotabDevice[]>(api, "Get", {
      typeName: "Device",
      search: { fromDate: now },
      resultsLimit: RESULTS_LIMIT,
    });
  }
  return devices.filter((d) => d.id !== "NoDeviceId");
}

// ---------------------------------------------------------------------------
// VIN decoding — MyGeotab's own decoder (what the Vehicle edit page uses)
// ---------------------------------------------------------------------------

const VIN_CACHE_KEY = "gpsfms.vehicleReplacementPlanner.vinCache.v1";

function loadVinCache(): Record<string, VinInfo> {
  try {
    const raw = window.localStorage.getItem(VIN_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, VinInfo>) : {};
  } catch {
    return {};
  }
}

function saveVinCache(cache: Record<string, VinInfo>): void {
  try {
    window.localStorage.setItem(VIN_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
}

export function clearVinCache(): void {
  try {
    window.localStorage.removeItem(VIN_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** Case-insensitive property pick for the loosely-specified DecodeVins result. */
function pick(obj: Record<string, unknown>, names: string[]): unknown {
  for (const k of Object.keys(obj)) {
    if (names.includes(k.toLowerCase())) return obj[k];
  }
  return undefined;
}

function normalizeDecoded(vin: string, raw: unknown): VinInfo {
  const fallbackYear = yearFromVin(vin);
  if (!raw || typeof raw !== "object") {
    return { vin, make: "", model: "", year: fallbackYear, source: fallbackYear ? "vin-year" : "none" };
  }
  const o = raw as Record<string, unknown>;
  // Some builds wrap the decoded fields one level down (e.g. { vin, vehicle: {...} }).
  const inner = (pick(o, ["vehicle", "vehicleinfo", "info", "result"]) as Record<string, unknown> | undefined) ?? o;
  const make = String(pick(inner, ["make", "manufacturer", "vehiclemake"]) ?? "").trim();
  const model = String(pick(inner, ["model", "vehiclemodel"]) ?? "").trim();
  const yearRaw = pick(inner, ["year", "modelyear", "vehicleyear"]);
  const yearNum = typeof yearRaw === "number" ? yearRaw : parseInt(String(yearRaw ?? ""), 10);
  const year = Number.isFinite(yearNum) && yearNum > 1900 && yearNum < 2100 ? yearNum : fallbackYear;
  if (!make && !model) {
    return { vin, make: "", model: "", year, source: year ? "vin-year" : "none" };
  }
  return { vin, make, model, year, source: "geotab" };
}

export interface DecodeResult {
  byVin: Map<string, VinInfo>;
  available: boolean;
  error?: string;
}

/**
 * Decode VINs with MyGeotab's `DecodeVins` method ({ vins: string[] }). This is
 * the decoder behind the Vehicle edit page's make/model/year, but Geotab labels
 * it "not fully supported — may change or be removed without notice", so the
 * result shape is parsed defensively and the first raw result is logged to the
 * console for inspection. Decoded VINs are cached in localStorage (a VIN never
 * changes its make/model/year).
 */
export async function decodeVins(
  api: GeotabApi,
  vins: string[],
  pacer: Pacer,
  onProgress: (text: string, pct: number | null) => void,
  shouldCancel?: () => boolean
): Promise<DecodeResult> {
  const cache = loadVinCache();
  const byVin = new Map<string, VinInfo>();
  const todo: string[] = [];
  for (const vin of new Set(vins.map((v) => v.trim().toUpperCase()).filter(Boolean))) {
    const hit = cache[vin];
    if (hit && hit.source === "geotab") byVin.set(vin, hit);
    else todo.push(vin);
  }
  let available = true;
  let error: string | undefined;
  let logged = false;
  for (let i = 0; i < todo.length; i += VIN_BATCH) {
    if (shouldCancel?.()) throw new Error("Cancelled");
    const batch = todo.slice(i, i + VIN_BATCH);
    onProgress(
      `Decoding VINs (${Math.min(i + batch.length, todo.length)} / ${todo.length})…`,
      todo.length ? Math.round(((i + batch.length) / todo.length) * 100) : null
    );
    await pacer.reserve(1);
    let results: unknown;
    try {
      results = await apiCall<unknown>(api, "DecodeVins", { vins: batch });
    } catch (e) {
      available = false;
      error = friendlyError(e);
      console.warn("[VRP] DecodeVins failed — falling back to VIN model-year code only:", e);
      break;
    }
    if (!logged) {
      logged = true;
      console.info("[VRP] DecodeVins sample result:", Array.isArray(results) ? results[0] : results);
    }
    if (Array.isArray(results)) {
      // Match by the vin field when present, else by position.
      const positional = results.length === batch.length;
      results.forEach((item, idx) => {
        let vin = "";
        if (item && typeof item === "object") {
          const v = pick(item as Record<string, unknown>, ["vin", "vehicleidentificationnumber"]);
          if (typeof v === "string") vin = v.trim().toUpperCase();
        }
        if (!vin && positional) vin = batch[idx];
        if (!vin) return;
        byVin.set(vin, normalizeDecoded(vin, item));
      });
    } else if (results && typeof results === "object") {
      // Keyed by VIN.
      for (const [k, item] of Object.entries(results as Record<string, unknown>)) {
        const vin = k.trim().toUpperCase();
        if (batch.includes(vin)) byVin.set(vin, normalizeDecoded(vin, item));
      }
    }
  }
  for (const vin of todo) {
    if (!byVin.has(vin)) {
      const y = yearFromVin(vin);
      byVin.set(vin, { vin, make: "", model: "", year: y, source: y ? "vin-year" : "none" });
    }
  }
  // Persist only successful decodes.
  byVin.forEach((info, vin) => {
    if (info.source === "geotab") cache[vin] = info;
  });
  saveVinCache(cache);
  return { byVin, available, error };
}

// ---------------------------------------------------------------------------
// Odometer at an instant — fleet-wide windows first, per-device only as a
// capped fallback
// ---------------------------------------------------------------------------

/** Per device: best sample at `instant`, keyed by diagnostic id. */
export type OdometerAtResult = Map<string, Map<string, OdometerSample>>;

const DAY = 86400000;
const MAX_PAGES_PER_WINDOW = 12;
let statusPropertySelectorOk: boolean | null = null;

function timeOf(v: string | Date | undefined): number {
  if (v == null) return NaN;
  return typeof v === "string" ? new Date(v).getTime() : (v as Date).getTime();
}

/**
 * One fleet-wide StatusData query for the odometer diagnostic between two
 * instants, paged on dateTime when a page fills. Returns every row (both the
 * adjusted and the raw odometer series come back for this diagnostic search).
 */
async function fetchOdometerWindow(
  api: GeotabApi,
  pacer: Pacer,
  from: Date,
  to: Date,
  onPage: (page: number, rows: number) => void,
  shouldCancel?: () => boolean
): Promise<GeotabStatusData[]> {
  const out: GeotabStatusData[] = [];
  let cursor = from.getTime();
  const end = to.getTime();
  let page = 0;
  while (cursor < end && page < MAX_PAGES_PER_WINDOW) {
    if (shouldCancel?.()) throw new Error("Cancelled");
    page += 1;
    await pacer.reserve(1, shouldCancel);
    const base = {
      typeName: "StatusData",
      search: {
        diagnosticSearch: { id: ODOMETER_ADJ },
        fromDate: new Date(cursor).toISOString(),
        toDate: to.toISOString(),
      },
      resultsLimit: RESULTS_LIMIT,
    };
    let rows: GeotabStatusData[];
    if (statusPropertySelectorOk !== false) {
      try {
        rows = await apiCall<GeotabStatusData[]>(api, "Get", {
          ...base,
          propertySelector: { fields: ["device", "diagnostic", "dateTime", "data"], isIncluded: true },
        });
        statusPropertySelectorOk = true;
      } catch (e) {
        if (statusPropertySelectorOk === true) throw e;
        statusPropertySelectorOk = false;
        await pacer.reserve(1, shouldCancel);
        rows = await apiCall<GeotabStatusData[]>(api, "Get", base);
      }
    } else {
      rows = await apiCall<GeotabStatusData[]>(api, "Get", base);
    }
    onPage(page, rows.length);
    out.push(...rows);
    if (rows.length < RESULTS_LIMIT) break;
    let last = cursor;
    for (const r of rows) {
      const t = timeOf(r.dateTime);
      if (t > last) last = t;
    }
    cursor = Math.max(last, cursor + 1);
  }
  return out;
}

export interface OdometerFetchOptions {
  /** "latest": newest reading at or before the instant. "nearest": closest reading either side. */
  mode: "latest" | "nearest";
  /** Windows to scan, as [startOffsetDays, endOffsetDays] relative to the instant, in scan order. */
  windows: Array<[number, number]>;
  /** Max per-device fallback lookups for vehicles the windows didn't cover. */
  deepMax: number;
}

export const LATEST_WINDOWS: Array<[number, number]> = [
  [-0.5, 0],
  [-3, -0.5],
  [-14, -3],
];
export const NEAREST_WINDOWS: Array<[number, number]> = [
  [0, 1],
  [-2, 0],
  [1, 7],
  [-7, -2],
];

/**
 * Odometer per device at an instant.
 *
 * 1. Fleet-wide windows around the instant (a handful of 50k-row calls for
 *    the whole database) — "latest" keeps the newest reading per device and
 *    diagnostic, "nearest" the one closest to the instant.
 * 2. Devices still uncovered get one StatusData call each with
 *    fromDate == toDate == instant (MyGeotab returns the records bounding
 *    that moment), batched 50 per multiCall and capped by `deepMax`.
 *
 * The caller computes the rate over the *actual* span between its two
 * samples, so a vehicle installed after the baseline instant still gets a
 * correct rate.
 */
export async function fetchOdometerAt(
  api: GeotabApi,
  deviceIds: string[],
  instant: Date,
  pacer: Pacer,
  label: string,
  onProgress: (text: string, pct: number | null) => void,
  opts: OdometerFetchOptions,
  shouldCancel?: () => boolean
): Promise<{ samples: OdometerAtResult; deepLookups: number; rowsScanned: number }> {
  const out: OdometerAtResult = new Map();
  const wanted = new Set(deviceIds);
  const target = instant.getTime();
  let rowsScanned = 0;

  const better = (cur: OdometerSample | undefined, candidateTime: number): boolean => {
    if (!cur) return true;
    const curTime = timeOf(cur.dateTime);
    return opts.mode === "latest" ? candidateTime > curTime : Math.abs(candidateTime - target) < Math.abs(curTime - target);
  };
  const absorb = (rows: GeotabStatusData[]) => {
    for (const r of rows) {
      const id = r.device?.id;
      if (!id || !wanted.has(id) || typeof r.data !== "number" || r.dateTime == null) continue;
      const t = timeOf(r.dateTime);
      if (!Number.isFinite(t)) continue;
      if (opts.mode === "latest" && t > target + 60000) continue;
      const diag = r.diagnostic?.id ?? ODOMETER_ADJ;
      let perDiag = out.get(id);
      if (!perDiag) {
        perDiag = new Map();
        out.set(id, perDiag);
      }
      if (better(perDiag.get(diag), t)) {
        perDiag.set(diag, { meters: r.data, dateTime: new Date(t).toISOString(), diagnosticId: diag });
      }
    }
  };
  const covered = () => {
    let n = 0;
    for (const id of wanted) if (out.get(id)?.has(ODOMETER_ADJ)) n += 1;
    return n;
  };

  // 1. Fleet-wide windows.
  for (let w = 0; w < opts.windows.length; w++) {
    if (covered() >= wanted.size) break;
    const [a, b] = opts.windows[w];
    const from = new Date(target + a * DAY);
    const to = new Date(Math.min(target + b * DAY, Date.now()));
    if (from >= to) continue;
    const rows = await fetchOdometerWindow(
      api,
      pacer,
      from,
      to,
      (page, n) => onProgress(`${label} — window ${w + 1}/${opts.windows.length}, page ${page} (${n.toLocaleString()} readings)…`, null),
      shouldCancel
    );
    rowsScanned += rows.length;
    absorb(rows);
    onProgress(`${label} — ${covered().toLocaleString()} / ${wanted.size.toLocaleString()} vehicles covered…`, Math.round((covered() / Math.max(1, wanted.size)) * 100));
  }

  // 2. Per-device fallback for the remainder (vehicles silent across every window).
  const todo = deviceIds.filter((id) => !out.has(id)).slice(0, Math.max(0, opts.deepMax));
  const at = instant.toISOString();
  let deepLookups = 0;
  for (let i = 0; i < todo.length; i += ODO_BATCH) {
    if (shouldCancel?.()) throw new Error("Cancelled");
    const batch = todo.slice(i, i + ODO_BATCH);
    onProgress(
      `${label} — looking up ${Math.min(i + batch.length, todo.length)} / ${todo.length} vehicles individually…`,
      Math.round(((i + batch.length) / todo.length) * 100)
    );
    await pacer.reserve(batch.length, shouldCancel);
    const results = await apiMultiCall<GeotabStatusData[]>(
      api,
      batch.map((id) => [
        "Get",
        {
          typeName: "StatusData",
          search: { deviceSearch: { id }, diagnosticSearch: { id: ODOMETER_ADJ }, fromDate: at, toDate: at },
          resultsLimit: 10,
        },
      ])
    );
    deepLookups += batch.length;
    results.forEach((rows, idx) => absorb((rows ?? []).map((r) => ({ ...r, device: r.device ?? { id: batch[idx] } }))));
  }
  return { samples: out, deepLookups, rowsScanned };
}
