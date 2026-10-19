/**
 * Domain types for Vehicle Replacement Planner.
 *
 * The MyGeotab Add-In API is loosely typed; we narrow at the boundary in
 * api/geotab.ts. Shapes mirror recall-harness-swap-addin/src/types.ts.
 */

export interface GeotabApi {
  call: (
    method: string,
    params: unknown,
    success: (result: unknown) => void,
    failure: (err: unknown) => void
  ) => void;
  multiCall?: (
    calls: Array<[string, unknown]>,
    success: (result: unknown[]) => void,
    failure: (err: unknown) => void
  ) => void;
  getSession?: (
    callback: (
      credentials: { database: string; userName: string; sessionId: string },
      server: string
    ) => void
  ) => void;
}

export interface GeotabSession {
  server: string;
  database: string;
  userName: string;
  sessionId: string;
}

export interface GeotabPageState {
  getGroupFilter?: (cb: (groups: unknown) => void) => void;
  setGroupFilter?: (groups: unknown) => void;
  getState?: (cb: (state: unknown) => void) => void;
  setState?: (state: unknown) => void;
  translate?: (key: string) => string;
}

export interface GeotabGroup {
  id: string;
  name?: string;
  children?: Array<{ id: string }>;
}

export interface GeotabDevice {
  id: string;
  name?: string;
  serialNumber?: string;
  deviceType?: string;
  productId?: number;
  activeFrom?: string;
  activeTo?: string;
  groups?: Array<{ id: string }>;
  comment?: string;
  licensePlate?: string;
  vehicleIdentificationNumber?: string;
  engineVehicleIdentificationNumber?: string;
}

export interface GeotabStatusData {
  id?: string;
  device?: { id: string };
  diagnostic?: { id: string };
  dateTime?: string;
  data?: number;
}

/** One odometer sample (meters, as Geotab stores it). */
export interface OdometerSample {
  meters: number;
  dateTime: string;
  diagnosticId: string;
}

/** Decoded vehicle identity for one VIN. */
export interface VinInfo {
  vin: string;
  make: string;
  model: string;
  year: number | null;
  /** "geotab" = DecodeVins answered; "vin-year" = only the model-year code was readable. */
  source: "geotab" | "vin-year" | "none";
}

// ---------------------------------------------------------------------------
// Criteria (the sliders)
// ---------------------------------------------------------------------------

export type DistanceUnit = "mi" | "km";

export interface Criteria {
  /** Mileage criterion on/off and the threshold in display units. */
  mileageOn: boolean;
  mileageThreshold: number;
  /** Age criterion on/off and the threshold in whole model-years. */
  ageOn: boolean;
  ageThreshold: number;
  /** Flag a vehicle as "approaching" when a threshold is projected within this many months. */
  horizonMonths: number;
  /** Months of odometer history used for the monthly average. */
  lookbackMonths: number;
  units: DistanceUnit;
}

export interface Settings {
  criteria: Criteria;
  /** Selected group ids (empty = whole company). */
  groupIds: string[];
  /** Quota guard: max MyGeotab calls per minute the scan will issue. */
  callsPerMinute: number;
  /** Max per-vehicle fallback lookups (per instant) for vehicles the fleet-wide windows missed. */
  deepLookupMax: number;
  /** Include devices whose VIN decode fails (they show as "Missing VIN"). */
  includeNoVin: boolean;
}

// ---------------------------------------------------------------------------
// Evaluated output
// ---------------------------------------------------------------------------

export type Verdict = "sell" | "approaching" | "ok" | "no-data";

export interface VehicleRow {
  deviceId: string;
  name: string;
  groupNames: string[];
  groupIds: string[];
  vin: string;
  vinStatus: "decoded" | "year-only" | "undecoded" | "missing";
  make: string;
  model: string;
  year: number | null;
  /** Current odometer in meters (null = no reading). */
  odometerMeters: number | null;
  odometerAt: string | null;
  /** Baseline odometer sample used for the average. */
  baselineMeters: number | null;
  baselineAt: string | null;
  /** Average meters per month across the actual sample span. */
  metersPerMonth: number | null;
  /** Actual span between the two samples, in months. */
  spanMonths: number | null;
  /** Whole model-years old (calendar year − model year). */
  ageYears: number | null;
  /** Projection to the mileage threshold. */
  monthsToMileage: number | null;
  mileageDate: string | null; // ISO
  /** When the vehicle reaches the age threshold (Jan 1 of model year + N). */
  monthsToAge: number | null;
  ageDate: string | null; // ISO
  verdict: Verdict;
  reasons: string[];
  comment: string;
  licensePlate: string;
}

export interface ScanMeta {
  devicesTotal: number;
  devicesInScope: number;
  vinsDecoded: number;
  vinsMissing: number;
  vinDecodeAvailable: boolean;
  vinDecodeError?: string;
  odometerReadings: number;
  baselineReadings: number;
  deepLookups: number;
  rowsScanned: number;
  apiCalls: number;
  ranAt: number;
  lookbackMonths: number;
}

export interface Progress {
  text: string;
  pct: number | null;
}
