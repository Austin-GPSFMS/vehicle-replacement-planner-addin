/**
 * The vehicle list: one row per device, sortable by column, with a verdict
 * pill and the projected month each threshold is reached.
 */

import { useMemo, useState } from "react";
import type { Criteria, VehicleRow } from "../types";
import { formatDate, formatInt, formatMonthYear, formatMonths, metersToUnit } from "../utils/format";
import { VERDICT_LABEL, VERDICT_TONE, VIN_STATUS_LABEL } from "../utils/labels";

type SortKey =
  | "name"
  | "groups"
  | "year"
  | "make"
  | "model"
  | "odometer"
  | "rate"
  | "age"
  | "mileageDate"
  | "ageDate"
  | "verdict";

interface VehicleTableProps {
  rows: VehicleRow[];
  criteria: Criteria;
  busy: boolean;
  myGeotabBase: string; // e.g. https://my.geotab.com/db/#device,id:
}

function cmp(a: string | number | null | undefined, b: string | number | null | undefined): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

const VERDICT_RANK: Record<VehicleRow["verdict"], number> = { sell: 0, approaching: 1, ok: 2, "no-data": 3 };

function sortValue(r: VehicleRow, k: SortKey): string | number | null {
  switch (k) {
    case "name":
      return r.name;
    case "groups":
      return r.groupNames.join(", ");
    case "year":
      return r.year;
    case "make":
      return r.make || null;
    case "model":
      return r.model || null;
    case "odometer":
      return r.odometerMeters;
    case "rate":
      return r.metersPerMonth;
    case "age":
      return r.ageYears;
    case "mileageDate":
      return r.monthsToMileage;
    case "ageDate":
      return r.monthsToAge;
    case "verdict":
      return VERDICT_RANK[r.verdict];
  }
}

function VerdictPill({ r }: { r: VehicleRow }) {
  return (
    <span className={`vrp-pill vrp-pill-${VERDICT_TONE[r.verdict]}`} title={r.reasons.join("\n")}>
      {VERDICT_LABEL[r.verdict]}
    </span>
  );
}

function VinCell({ r }: { r: VehicleRow }) {
  if (r.vinStatus === "decoded") return null;
  const label = VIN_STATUS_LABEL[r.vinStatus];
  const tone = r.vinStatus === "missing" ? "warn" : "muted";
  return (
    <span className={`vrp-pill vrp-pill-${tone} vrp-pill-small`} title={r.vin || "No VIN on the device"}>
      {label}
    </span>
  );
}

export function VehicleTable({ rows, criteria, busy, myGeotabBase }: VehicleTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("verdict");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const u = criteria.units;

  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const d = cmp(sortValue(a, sortKey), sortValue(b, sortKey)) * sortDir;
      if (d !== 0) return d;
      if (sortKey !== "verdict") {
        const v = VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict];
        if (v !== 0) return v;
      }
      return cmp(a.name, b.name);
    });
    return out;
  }, [rows, sortKey, sortDir]);

  const onSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(1);
    }
  };

  const Th = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th
      className={`${className ?? ""} ${sortKey === k ? "vrp-sorted" : ""}`}
      onClick={() => onSort(k)}
      aria-sort={sortKey === k ? (sortDir === 1 ? "ascending" : "descending") : "none"}
    >
      <span>{children}</span>
      {sortKey === k && <span className="vrp-sort-arrow">{sortDir === 1 ? "▲" : "▼"}</span>}
    </th>
  );

  if (!rows.length) {
    return <div className="vrp-empty">{busy ? "Scanning…" : "No vehicles match the current filters."}</div>;
  }

  return (
    <div className={`vrp-table-wrap ${busy ? "vrp-busy" : ""}`}>
      <table className="vrp-table">
        <thead>
          <tr>
            <Th k="verdict">Status</Th>
            <Th k="name">Asset</Th>
            <Th k="groups">Groups</Th>
            <Th k="year" className="vrp-num">
              Year
            </Th>
            <Th k="make">Make</Th>
            <Th k="model">Model</Th>
            <Th k="odometer" className="vrp-num">
              Odometer
            </Th>
            <Th k="rate" className="vrp-num">
              Avg {u}/mo
            </Th>
            <Th k="age" className="vrp-num">
              Age
            </Th>
            {criteria.mileageOn && (
              <Th k="mileageDate">Reaches {criteria.mileageThreshold.toLocaleString()} {u}</Th>
            )}
            {criteria.ageOn && <Th k="ageDate">Turns {criteria.ageThreshold} yr</Th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.deviceId} className={`vrp-row vrp-row-${r.verdict}`}>
              <td>
                <VerdictPill r={r} />
              </td>
              <td className="vrp-asset">
                {myGeotabBase ? (
                  <a href={`${myGeotabBase}${r.deviceId}`} target="_blank" rel="noreferrer" title="Open the vehicle in MyGeotab">
                    {r.name}
                  </a>
                ) : (
                  r.name
                )}
                {r.licensePlate && <span className="vrp-muted vrp-sub">{r.licensePlate}</span>}
              </td>
              <td className="vrp-groups" title={r.groupNames.join("\n")}>
                {r.groupNames.length ? r.groupNames.join(", ") : <span className="vrp-muted">—</span>}
              </td>
              <td className="vrp-num">{r.year ?? <span className="vrp-muted">—</span>}</td>
              <td>
                {r.make || <span className="vrp-muted">—</span>}
                <VinCell r={r} />
              </td>
              <td>{r.model || <span className="vrp-muted">—</span>}</td>
              <td className="vrp-num" title={r.odometerAt ? `Read ${formatDate(r.odometerAt)}` : undefined}>
                {r.odometerMeters != null ? formatInt(metersToUnit(r.odometerMeters, u)) : <span className="vrp-muted">—</span>}
              </td>
              <td
                className="vrp-num"
                title={
                  r.baselineAt && r.odometerAt
                    ? `${formatInt(metersToUnit(r.baselineMeters ?? 0, u))} on ${formatDate(r.baselineAt)} → ${formatInt(
                        metersToUnit(r.odometerMeters ?? 0, u)
                      )} on ${formatDate(r.odometerAt)} (${r.spanMonths?.toFixed(1)} mo)`
                    : "No baseline reading"
                }
              >
                {r.metersPerMonth != null ? formatInt(metersToUnit(r.metersPerMonth, u)) : <span className="vrp-muted">—</span>}
              </td>
              <td className="vrp-num">{r.ageYears != null ? `${r.ageYears} yr` : <span className="vrp-muted">—</span>}</td>
              {criteria.mileageOn && (
                <td>
                  {r.monthsToMileage == null ? (
                    <span className="vrp-muted">—</span>
                  ) : r.monthsToMileage <= 0 ? (
                    <span className="vrp-strong">Already past</span>
                  ) : (
                    <>
                      <span className="vrp-strong">{formatMonthYear(r.mileageDate)}</span>
                      <span className="vrp-muted vrp-sub">in {formatMonths(r.monthsToMileage)}</span>
                    </>
                  )}
                </td>
              )}
              {criteria.ageOn && (
                <td>
                  {r.monthsToAge == null ? (
                    <span className="vrp-muted">—</span>
                  ) : r.monthsToAge <= 0 ? (
                    <span className="vrp-strong">Already past</span>
                  ) : (
                    <>
                      <span className="vrp-strong">{formatMonthYear(r.ageDate)}</span>
                      <span className="vrp-muted vrp-sub">in {formatMonths(r.monthsToAge)}</span>
                    </>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
