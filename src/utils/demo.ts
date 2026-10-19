/**
 * Synthetic fleet for the standalone preview (dist/index.html opened outside
 * MyGeotab) and for the headless smoke test's mocked API. Deterministic so
 * screenshots and test assertions are stable.
 */

import type { GeotabDevice, GeotabGroup, OdometerSample } from "../types";
import { ODOMETER_ADJ, ODOMETER_RAW } from "../api/geotab";
import { METERS_PER_MILE, addMonths } from "./format";
import type { VehicleData } from "./scan";

const MAKES: Array<[string, string[]]> = [
  ["FORD", ["F-150", "F-250", "F-350", "TRANSIT", "ESCAPE"]],
  ["CHEVROLET", ["SILVERADO 1500", "SILVERADO 2500HD", "EXPRESS 2500", "TAHOE"]],
  ["RAM", ["1500", "2500", "3500", "PROMASTER"]],
  ["INTERNATIONAL", ["MV607", "HV507"]],
  ["FREIGHTLINER", ["M2 106", "CASCADIA"]],
  ["TOYOTA", ["TACOMA", "TUNDRA"]],
];
const WMI: Record<string, string> = {
  FORD: "1FT",
  CHEVROLET: "1GC",
  RAM: "3C6",
  INTERNATIONAL: "1HT",
  FREIGHTLINER: "1FV",
  TOYOTA: "5TF",
};
const YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789";
const GROUPS = ["Tampa", "Orlando", "Jacksonville", "Fort Myers"];
const ROLES = ["Service", "Sales", "Delivery", "Supervisor"];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function vinFor(make: string, year: number, serial: number): string {
  const yc = YEAR_CODES[(year - 1980) % 30] ?? "A";
  const plant = year >= 2010 ? "K" : "5"; // letter at position 7 ⇒ 2010+
  const body = "EF" + plant + "0"; // positions 4–8 (4 chars) – keep it simple
  const check = "X";
  const tail = String(100000 + serial).slice(-6);
  return `${WMI[make]}${body}${check}${yc}A${tail}`.slice(0, 17).padEnd(17, "0");
}

export interface DemoFleet {
  groups: GeotabGroup[];
  devices: GeotabDevice[];
  /** DecodeVins answers. */
  vinTable: Record<string, { vin: string; make: string; model: string; year: number }>;
  /** Per device: samples now / at the baseline instant. */
  odometer: Record<string, { now: OdometerSample[]; base: OdometerSample[] }>;
  now: string;
}

export function makeDemoFleet(count = 36, seed = 7, nowDate = new Date("2026-10-16T14:00:00Z"), lookbackMonths = 6): DemoFleet {
  const r = rng(seed);
  const groups: GeotabGroup[] = [
    { id: "GroupCompanyId", name: "Company Group", children: GROUPS.map((_, i) => ({ id: `b${i + 1}` })) },
    ...GROUPS.map((name, i) => ({ id: `b${i + 1}`, name, children: ROLES.map((_, j) => ({ id: `b${i + 1}${j + 1}` })) })),
    ...GROUPS.flatMap((name, i) => ROLES.map((role, j) => ({ id: `b${i + 1}${j + 1}`, name: `${name} ${role}` }))),
  ];
  const devices: GeotabDevice[] = [];
  const vinTable: DemoFleet["vinTable"] = {};
  const odometer: DemoFleet["odometer"] = {};
  const baseInstant = addMonths(nowDate, -lookbackMonths);
  for (let i = 0; i < count; i++) {
    const [make, models] = MAKES[Math.floor(r() * MAKES.length)];
    const model = models[Math.floor(r() * models.length)];
    const year = 2012 + Math.floor(r() * 14); // 2012–2025
    const id = `b${1000 + i}`;
    const g = Math.floor(r() * GROUPS.length);
    const role = Math.floor(r() * ROLES.length);
    const name = `Truck ${String(i + 1).padStart(3, "0")}`;
    const vin = i % 9 === 8 ? "" : vinFor(make, year, i); // every 9th has no VIN
    devices.push({
      id,
      name,
      serialNumber: `G9${String(100000000 + i)}`,
      deviceType: "GO9",
      productId: 120,
      activeFrom: `${year}-03-01T00:00:00.000Z`,
      activeTo: "2050-01-01T00:00:00.000Z",
      groups: [{ id: `b${g + 1}${role + 1}` }],
      comment: i % 7 === 0 ? "Spare / pool vehicle" : "",
      licensePlate: `FL${String(1000 + i * 37).slice(-4)}`,
      vehicleIdentificationNumber: vin,
      engineVehicleIdentificationNumber: vin,
    });
    if (vin) vinTable[vin] = { vin, make, model, year };

    const ageYears = nowDate.getFullYear() - year;
    const perMonthMi = 600 + r() * 3400; // 600–4000 mi/mo
    const nowMi = Math.min(260000, ageYears * perMonthMi * 12 * (0.6 + r() * 0.6) + 5000);
    const baseMi = Math.max(0, nowMi - perMonthMi * lookbackMonths * (0.85 + r() * 0.3));
    const nowAt = new Date(nowDate.getTime() - r() * 2 * 86400000).toISOString();
    const baseAt = new Date(baseInstant.getTime() + (r() - 0.5) * 3 * 86400000).toISOString();
    const nowSamples: OdometerSample[] = [
      { meters: nowMi * METERS_PER_MILE, dateTime: nowAt, diagnosticId: ODOMETER_ADJ },
      { meters: nowMi * METERS_PER_MILE * 0.98, dateTime: nowAt, diagnosticId: ODOMETER_RAW },
    ];
    const baseSamples: OdometerSample[] =
      i % 11 === 10
        ? [] // every 11th has no history yet (installed recently)
        : [
            { meters: baseMi * METERS_PER_MILE, dateTime: baseAt, diagnosticId: ODOMETER_ADJ },
            { meters: baseMi * METERS_PER_MILE * 0.98, dateTime: baseAt, diagnosticId: ODOMETER_RAW },
          ];
    odometer[id] = { now: i % 13 === 12 ? [] : nowSamples, base: baseSamples };
  }
  return { groups, devices, vinTable, odometer, now: nowDate.toISOString() };
}

/** Convert the demo fleet straight into VehicleData (standalone preview path). */
export function demoVehicleData(fleet: DemoFleet): VehicleData[] {
  const byId = new Map(fleet.groups.map((g) => [g.id, g]));
  const toMap = (list: OdometerSample[]) => (list.length ? new Map(list.map((s) => [s.diagnosticId, s])) : undefined);
  return fleet.devices.map((d) => {
    const vin = d.vehicleIdentificationNumber ?? "";
    const dec = vin ? fleet.vinTable[vin] : undefined;
    return {
      device: d,
      groupNames: (d.groups ?? []).map((g) => byId.get(g.id)?.name ?? g.id),
      vin,
      vinInfo: dec ? { vin, make: dec.make, model: dec.model, year: dec.year, source: "geotab" } : null,
      nowSamples: toMap(fleet.odometer[d.id].now),
      baseSamples: toMap(fleet.odometer[d.id].base),
    };
  });
}
