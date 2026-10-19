import type { DistanceUnit } from "../types";

export const METERS_PER_MILE = 1609.344;
export const DAYS_PER_MONTH = 30.4375;

export function metersToUnit(m: number, unit: DistanceUnit): number {
  return unit === "mi" ? m / METERS_PER_MILE : m / 1000;
}

export function unitToMeters(v: number, unit: DistanceUnit): number {
  return unit === "mi" ? v * METERS_PER_MILE : v * 1000;
}

export function formatInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString();
}

export function formatDistance(meters: number | null | undefined, unit: DistanceUnit): string {
  if (meters == null || !Number.isFinite(meters)) return "—";
  return `${formatInt(metersToUnit(meters, unit))} ${unit}`;
}

export function formatMonthYear(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "3 mo", "1.5 yr" style relative duration from a month count. */
export function formatMonths(months: number | null | undefined): string {
  if (months == null || !Number.isFinite(months)) return "—";
  if (months <= 0) return "now";
  if (months < 1) return "< 1 mo";
  if (months < 24) return `${Math.round(months)} mo`;
  return `${(months / 12).toFixed(1)} yr`;
}

export function monthsBetween(fromIso: string | Date, toIso: string | Date): number {
  const a = typeof fromIso === "string" ? new Date(fromIso).getTime() : fromIso.getTime();
  const b = typeof toIso === "string" ? new Date(toIso).getTime() : toIso.getTime();
  return (b - a) / 86400000 / DAYS_PER_MONTH;
}

export function addMonths(from: Date, months: number): Date {
  return new Date(from.getTime() + months * DAYS_PER_MONTH * 86400000);
}
