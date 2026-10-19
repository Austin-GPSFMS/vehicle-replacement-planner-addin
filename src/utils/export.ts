/** CSV export of the rows currently shown. */

import type { Criteria, VehicleRow } from "../types";
import { formatMonthYear, metersToUnit } from "./format";
import { VERDICT_LABEL } from "./labels";

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: VehicleRow[], c: Criteria): string {
  const u = c.units;
  const header = [
    "Asset",
    "Groups",
    "Year",
    "Make",
    "Model",
    "VIN",
    "VIN status",
    `Odometer (${u})`,
    "Odometer read at",
    `Avg ${u}/month`,
    "Look-back span (months)",
    "Age (model-years)",
    `Months to ${c.mileageThreshold.toLocaleString()} ${u}`,
    `Reaches ${c.mileageThreshold.toLocaleString()} ${u}`,
    `Reaches ${c.ageThreshold} yr`,
    "Verdict",
    "Reasons",
    "License plate",
    "Comment",
    "Device id",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.name,
        r.groupNames.join("; "),
        r.year ?? "",
        r.make,
        r.model,
        r.vin,
        r.vinStatus,
        r.odometerMeters != null ? Math.round(metersToUnit(r.odometerMeters, u)) : "",
        r.odometerAt ?? "",
        r.metersPerMonth != null ? Math.round(metersToUnit(r.metersPerMonth, u)) : "",
        r.spanMonths != null ? r.spanMonths.toFixed(1) : "",
        r.ageYears ?? "",
        r.monthsToMileage != null ? r.monthsToMileage.toFixed(1) : "",
        r.mileageDate ? formatMonthYear(r.mileageDate) : "",
        r.ageDate ? formatMonthYear(r.ageDate) : "",
        VERDICT_LABEL[r.verdict],
        r.reasons.join("; "),
        r.licensePlate,
        r.comment,
        r.deviceId,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n");
}

export function exportRowsCsv(rows: VehicleRow[], c: Criteria, baseName: string): void {
  const csv = rowsToCsv(rows, c);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `${baseName}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
