/** KPI strip for the current evaluation, using Zenith SummaryTiles. */

import { SummaryTile, SummaryTileBar, SummaryTileType } from "@geotab/zenith";
import type { Criteria, ScanMeta, VehicleRow, Verdict } from "../types";
import { formatInt, metersToUnit } from "../utils/format";
import { VERDICT_LABEL } from "../utils/labels";

interface SummaryProps {
  rows: VehicleRow[];
  meta: ScanMeta | null;
  criteria: Criteria;
  active: Verdict | "all";
  onPick: (v: Verdict | "all") => void;
}

export function Summary({ rows, meta, criteria, active, onPick }: SummaryProps) {
  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  const tile = (v: Verdict | "all") => (active === v ? SummaryTileType.Active : SummaryTileType.Default);
  const rates = rows.map((r) => r.metersPerMonth).filter((m): m is number => m != null && m > 0);
  const avgRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  const next12 = rows.filter(
    (r) => r.verdict !== "sell" && ((r.monthsToMileage != null && r.monthsToMileage <= 12) || (r.monthsToAge != null && r.monthsToAge <= 12))
  ).length;

  return (
    <div className="vrp-summary">
      <SummaryTileBar aria-label="Evaluation summary">
        <SummaryTile title={VERDICT_LABEL.sell} tileType={tile("sell")} onClick={() => onPick("sell")}>
          <span className="vrp-tile-value vrp-tile-warn">{formatInt(count("sell"))}</span>
        </SummaryTile>
        <SummaryTile
          title={`${VERDICT_LABEL.approaching} (≤ ${criteria.horizonMonths} mo)`}
          tileType={tile("approaching")}
          onClick={() => onPick("approaching")}
        >
          <span className="vrp-tile-value vrp-tile-info">{formatInt(count("approaching"))}</span>
        </SummaryTile>
        <SummaryTile title={VERDICT_LABEL.ok} tileType={tile("ok")} onClick={() => onPick("ok")}>
          <span className="vrp-tile-value vrp-tile-ok">{formatInt(count("ok"))}</span>
        </SummaryTile>
        <SummaryTile
          title={VERDICT_LABEL["no-data"]}
          tileType={tile("no-data")}
          onClick={() => onPick("no-data")}
          tooltipText="No odometer reading and/or no model year (missing or undecodable VIN) for every enabled criterion."
        >
          <span className="vrp-tile-value vrp-tile-muted">{formatInt(count("no-data"))}</span>
        </SummaryTile>
        <SummaryTile title="Due in the next 12 months" tileType={tile("all")} onClick={() => onPick("all")}>
          <span className="vrp-tile-value">{formatInt(next12)}</span>
        </SummaryTile>
        <SummaryTile
          title={`Fleet avg ${criteria.units}/month`}
          tileType={SummaryTileType.Default}
          tooltipText={meta ? `Across ${rates.length} vehicles with ${meta.lookbackMonths} months of odometer history` : undefined}
        >
          <span className="vrp-tile-value">{avgRate != null ? formatInt(metersToUnit(avgRate, criteria.units)) : "—"}</span>
        </SummaryTile>
      </SummaryTileBar>
    </div>
  );
}
