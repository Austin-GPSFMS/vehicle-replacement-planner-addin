/**
 * Promise-based wrappers around the MyGeotab Add-In `api.call` interface.
 *
 * Mirrors recall-harness-swap-addin/src/api/geotab.ts: every call goes
 * through `apiCall` / `apiMultiCall` so there is one place to pace requests
 * and surface typed errors.
 *
 * Quota notes: MyGeotab allows ~1000 API calls per user per minute and every
 * child of a multiCall counts individually. The odometer scan issues two
 * StatusData lookups per vehicle (now + baseline), so the `Pacer` below keeps
 * the rolling one-minute count under the configured cap and simply takes
 * longer on big databases instead of tripping "API calls quota exceeded".
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
    const list: unknown[] = Array.isArray(results)
      ? results
      : results && typeof results === "object"
        ? Object.values(results as Record<string, unknown>)
        : [];
    // Match by the vin field when present, else by position.
    const positional = list.length === batch.length;
    list.forEach((item, idx) => {
      let vin = "";
      if (item && typeof item === "object") {
        const v = pick(item as Record<string, unknown>, ["vin", "vehicleidentificationnumber"]);
        if (typeof v === "string") vin = v.trim().toUpperCase();
      }
      if (!vin && positional) vin = batch[idx];
      if (!vin) return;
      byVin.set(vin, normalizeDecoded(vin, item));
    });
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
// Odometer at an instant
// ---------------------------------------------------------------------------

/** Per device: nearest sample at `instant`, keyed by diagnostic id. */
export type OdometerAtResult = Map<string, Map<string, OdometerSample>>;

/**
 * One StatusData call per device with fromDate == toDate == instant: MyGeotab
 * returns the records that bound that moment (the last one before and, when
 * one exists, the first after). We keep the nearest per diagnostic; the
 * caller computes the average over the *actual* span between samples, so a
 * vehicle installed after the baseline instant still gets a correct rate.
 */
export async function fetchOdometerAt(
  api: GeotabApi,
  deviceIds: string[],
  instant: Date,
  pacer: Pacer,
  label: string,
  onProgress: (text: string, pct: number | null) => void,
  shouldCancel?: () => boolean
): Promise<OdometerAtResult> {
  const out: OdometerAtResult = new Map();
  const at = instant.toISOString();
  const target = instant.getTime();
  for (let i = 0; i < deviceIds.length; i += ODO_BATCH) {
    if (shouldCancel?.()) throw new Error("Cancelled");
    const batch = deviceIds.slice(i, i + ODO_BATCH);
    onProgress(
      `${label} (${Math.min(i + batch.length, deviceIds.length)} / ${deviceIds.length})…`,
      Math.round(((i + batch.length) / deviceIds.length) * 100)
    );
    await pacer.reserve(batch.length, shouldCancel);
    const results = await apiMultiCall<GeotabStatusData[]>(
      api,
      batch.map((id) => [
        "Get",
        {
          typeName: "StatusData",
          search: {
            deviceSearch: { id },
            diagnosticSearch: { id: ODOMETER_ADJ },
            fromDate: at,
            toDate: at,
          },
          resultsLimit: 10,
        },
      ])
    );
    results.forEach((rows, idx) => {
      const id = batch[idx];
      const perDiag = new Map<string, OdometerSample>();
      for (const r of rows ?? []) {
        if (typeof r.data !== "number" || !r.dateTime) continue;
        const diag = r.diagnostic?.id ?? ODOMETER_ADJ;
        const cur = perDiag.get(diag);
        const dist = Math.abs(new Date(r.dateTime).getTime() - target);
        if (!cur || dist < Math.abs(new Date(cur.dateTime).getTime() - target)) {
          perDiag.set(diag, { meters: r.data, dateTime: r.dateTime, diagnosticId: diag });
        }
      }
      if (perDiag.size) out.set(id, perDiag);
    });
  }
  return out;
}
