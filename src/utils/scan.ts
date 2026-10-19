/**
 * Scan orchestration — the expensive part (API fetches) is separated from
 * the cheap part (evaluation) so the sliders re-evaluate instantly without
 * another round of API calls.
 *
 *   runScan(api, settings)  → VehicleData[] + ScanMeta       (API)
 *   buildRows(data, criteria, now) → VehicleRow[]            (pure)
 */

import type {
  Criteria,
  GeotabApi,
  GeotabDevice,
  GeotabGroup,
  OdometerSample,
  Progress,
  ScanMeta,
  Settings,
  VehicleRow,
  VinInfo,
} from "../types";
import {
  LATEST_WINDOWS,
  NEAREST_WINDOWS,
  ODOMETER_ADJ,
  ODOMETER_RAW,
  Pacer,
  decodeVins,
  fetchActiveDevices,
  fetchGroups,
  fetchOdometerAt,
} from "../api/geotab";
import { evaluate, pickSamplePair } from "./evaluate";
import { expandGroupIds, groupNames } from "./groups";
import { isStandardVin, pickVin } from "./vin";
import { addMonths } from "./format";

/** Everything fetched for one vehicle; evaluation happens later. */
export interface VehicleData {
  device: GeotabDevice;
  groupNames: string[];
  vin: string;
  vinInfo: VinInfo | null;
  /** Nearest samples at "now", keyed by diagnostic id. */
  nowSamples: Map<string, OdometerSample> | undefined;
  /** Nearest samples at the baseline instant, keyed by diagnostic id. */
  baseSamples: Map<string, OdometerSample> | undefined;
}

export interface ScanResult {
  data: VehicleData[];
  meta: ScanMeta;
  groupsById: Map<string, GeotabGroup>;
}

export async function runScan(
  api: GeotabApi,
  settings: Settings,
  onProgress: (p: Progress) => void,
  shouldCancel: () => boolean
): Promise<ScanResult> {
  const progress = (text: string, pct: number | null) => onProgress({ text, pct });
  const pacer = new Pacer(settings.callsPerMinute);
  const now = new Date();

  progress("Loading groups…", null);
  const groupsById = await fetchGroups(api, pacer);
  if (shouldCancel()) throw new Error("Cancelled");

  progress("Loading vehicles…", null);
  const all = await fetchActiveDevices(api, pacer);
  if (shouldCancel()) throw new Error("Cancelled");

  // Scope to the selected groups (plus descendants). Empty = whole company.
  const scope =
    settings.groupIds.length && !settings.groupIds.includes("GroupCompanyId")
      ? expandGroupIds(settings.groupIds, groupsById)
      : null;
  const devices = all.filter((d) => {
    if (!scope) return true;
    return (d.groups ?? []).some((g) => scope.has(g.id));
  });

  // VINs → make/model/year via MyGeotab's decoder.
  const vinByDevice = new Map<string, string>();
  for (const d of devices) {
    const vin = pickVin(d.vehicleIdentificationNumber, d.engineVehicleIdentificationNumber);
    if (vin) vinByDevice.set(d.id, vin);
  }
  const standardVins = Array.from(new Set(Array.from(vinByDevice.values()).filter(isStandardVin)));
  const decoded = await decodeVins(api, standardVins, pacer, progress, shouldCancel);
  if (shouldCancel()) throw new Error("Cancelled");

  // Odometer now + baseline.
  const ids = devices.map((d) => d.id);
  const nowRes = await fetchOdometerAt(
    api,
    ids,
    now,
    pacer,
    "Reading current odometer",
    progress,
    { mode: "latest", windows: LATEST_WINDOWS, deepMax: settings.deepLookupMax },
    shouldCancel
  );
  if (shouldCancel()) throw new Error("Cancelled");
  const baselineInstant = addMonths(now, -settings.criteria.lookbackMonths);
  const baseRes = await fetchOdometerAt(
    api,
    ids,
    baselineInstant,
    pacer,
    `Reading odometer ${settings.criteria.lookbackMonths} months ago`,
    progress,
    { mode: "nearest", windows: NEAREST_WINDOWS, deepMax: settings.deepLookupMax },
    shouldCancel
  );
  const nowAt = nowRes.samples;
  const baseAt = baseRes.samples;

  const data: VehicleData[] = devices.map((d) => {
    const vin = vinByDevice.get(d.id) ?? "";
    return {
      device: d,
      groupNames: groupNames(d.groups, groupsById),
      vin,
      vinInfo: vin ? (decoded.byVin.get(vin) ?? null) : null,
      nowSamples: nowAt.get(d.id),
      baseSamples: baseAt.get(d.id),
    };
  });

  let vinsDecoded = 0;
  let vinsMissing = 0;
  for (const v of data) {
    if (v.vinInfo?.source === "geotab") vinsDecoded += 1;
    if (!v.vin) vinsMissing += 1;
  }

  const meta: ScanMeta = {
    devicesTotal: all.length,
    devicesInScope: devices.length,
    vinsDecoded,
    vinsMissing,
    vinDecodeAvailable: decoded.available,
    vinDecodeError: decoded.error,
    odometerReadings: nowAt.size,
    baselineReadings: baseAt.size,
    deepLookups: nowRes.deepLookups + baseRes.deepLookups,
    rowsScanned: nowRes.rowsScanned + baseRes.rowsScanned,
    apiCalls: pacer.total,
    ranAt: now.getTime(),
    lookbackMonths: settings.criteria.lookbackMonths,
  };
  progress("Evaluating…", null);
  return { data, meta, groupsById };
}

const PREFERRED_DIAGNOSTICS = [ODOMETER_ADJ, ODOMETER_RAW];

/** Pure: evaluate every fetched vehicle against the current criteria. */
export function buildRows(data: VehicleData[], criteria: Criteria, now: Date): VehicleRow[] {
  return data.map((v) => {
    const pair = pickSamplePair(v.nowSamples, v.baseSamples, PREFERRED_DIAGNOSTICS);
    const year = v.vinInfo?.year ?? null;
    const ev = evaluate({ current: pair.current, baseline: pair.baseline, year }, criteria, now);
    const vinStatus: VehicleRow["vinStatus"] = !v.vin
      ? "missing"
      : v.vinInfo?.source === "geotab"
        ? "decoded"
        : v.vinInfo?.source === "vin-year"
          ? "year-only"
          : "undecoded";
    return {
      deviceId: v.device.id,
      name: v.device.name ?? v.device.id,
      groupNames: v.groupNames,
      groupIds: (v.device.groups ?? []).map((g) => g.id),
      vin: v.vin,
      vinStatus,
      make: v.vinInfo?.make ?? "",
      model: v.vinInfo?.model ?? "",
      year,
      ...ev,
      comment: v.device.comment ?? "",
      licensePlate: v.device.licensePlate ?? "",
    };
  });
}
