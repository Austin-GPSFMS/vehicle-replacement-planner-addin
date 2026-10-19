/**
 * The criteria sliders. Each criterion has an on/off toggle (a fleet may only
 * care about mileage, only about age, or both), a slider and an exact-value
 * box. Changing anything here re-evaluates the already-fetched data
 * instantly — no API calls — except the look-back, which needs a re-scan.
 *
 * Zenith has no slider primitive (its `Range` is a min/max popup), so the
 * track is a native <input type="range"> styled with Zenith tokens.
 */

import { Dropdown, TextInput, ToggleButton, type ISelectionItem } from "@geotab/zenith";
import type { Criteria, DistanceUnit } from "../types";
import { DEFAULT_CRITERIA } from "../utils/storage";

interface CriteriaBarProps {
  criteria: Criteria;
  onChange: (c: Criteria) => void;
  /** True while a scan is running (look-back changes are queued until it finishes). */
  busy: boolean;
  /** Called when the look-back changes so the parent can re-scan. */
  onLookbackChange: (months: number) => void;
}

const LOOKBACK_ITEMS: ISelectionItem[] = [
  { id: "3", name: "Last 3 months" },
  { id: "6", name: "Last 6 months" },
  { id: "12", name: "Last 12 months" },
  { id: "24", name: "Last 24 months" },
];

const UNIT_ITEMS: ISelectionItem[] = [
  { id: "mi", name: "Miles" },
  { id: "km", name: "Kilometres" },
];

const MILEAGE_MAX: Record<DistanceUnit, number> = { mi: 500000, km: 800000 };
const MILEAGE_STEP: Record<DistanceUnit, number> = { mi: 5000, km: 5000 };

function clampInt(v: string, min: number, max: number, fallback: number): number {
  const n = parseInt(v.replace(/[^0-9]/g, ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

interface SliderProps {
  id: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  ariaLabel: string;
}

function Slider({ id, min, max, step, value, disabled, onChange, ariaLabel }: SliderProps) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <input
      id={id}
      className="vrp-slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{ ["--vrp-fill" as string]: `${pct}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function CriteriaBar({ criteria: c, onChange, busy, onLookbackChange }: CriteriaBarProps) {
  const set = <K extends keyof Criteria>(k: K, v: Criteria[K]) => onChange({ ...c, [k]: v });
  const unitLabel = c.units;

  const setUnits = (u: DistanceUnit) => {
    if (u === c.units) return;
    // Convert the threshold so the slider keeps the same physical distance.
    const factor = u === "km" ? 1.609344 : 1 / 1.609344;
    const converted = Math.round((c.mileageThreshold * factor) / MILEAGE_STEP[u]) * MILEAGE_STEP[u];
    onChange({ ...c, units: u, mileageThreshold: Math.max(MILEAGE_STEP[u], Math.min(MILEAGE_MAX[u], converted)) });
  };

  return (
    <section className="vrp-criteria" aria-label="Replacement criteria">
      {/* ---- Mileage ---- */}
      <div className={`vrp-criterion ${c.mileageOn ? "" : "vrp-criterion-off"}`}>
        <div className="vrp-criterion-head">
          <label className="vrp-toggle">
            <ToggleButton title="Mileage criterion" value={c.mileageOn} onChange={(v) => set("mileageOn", v)} />
            <span className="vrp-criterion-title">Mileage</span>
          </label>
          <span className="vrp-criterion-value">
            {c.mileageThreshold.toLocaleString()} {unitLabel}
          </span>
        </div>
        <Slider
          id="vrp-mileage"
          min={MILEAGE_STEP[c.units]}
          max={MILEAGE_MAX[c.units]}
          step={MILEAGE_STEP[c.units]}
          value={c.mileageThreshold}
          disabled={!c.mileageOn}
          ariaLabel={`Mileage threshold in ${unitLabel}`}
          onChange={(v) => set("mileageThreshold", v)}
        />
        <div className="vrp-criterion-foot">
          <TextInput
            label={`Sell at (${unitLabel})`}
            value={String(c.mileageThreshold)}
            disabled={!c.mileageOn}
            onChange={(e) =>
              set("mileageThreshold", clampInt(e.target.value, 1000, MILEAGE_MAX[c.units], c.mileageThreshold))
            }
          />
          <Dropdown
            value={[c.units]}
            dataItems={UNIT_ITEMS}
            onChange={(items: ISelectionItem[]) => setUnits((String(items[0]?.id ?? "mi") as DistanceUnit) || "mi")}
            errorHandler={(e) => console.error("[VRP] units:", e)}
            forceSelection
            multiselect={false}
            showSelection
            showCounterPill={false}
            placeholder="Units"
          />
        </div>
        <p className="vrp-criterion-hint">
          Also the projection target: each row shows the month it is expected to reach this odometer.
        </p>
      </div>

      {/* ---- Age ---- */}
      <div className={`vrp-criterion ${c.ageOn ? "" : "vrp-criterion-off"}`}>
        <div className="vrp-criterion-head">
          <label className="vrp-toggle">
            <ToggleButton title="Age criterion" value={c.ageOn} onChange={(v) => set("ageOn", v)} />
            <span className="vrp-criterion-title">Age</span>
          </label>
          <span className="vrp-criterion-value">
            {c.ageThreshold} {c.ageThreshold === 1 ? "year" : "years"}
          </span>
        </div>
        <Slider
          id="vrp-age"
          min={1}
          max={25}
          step={1}
          value={c.ageThreshold}
          disabled={!c.ageOn}
          ariaLabel="Age threshold in model-years"
          onChange={(v) => set("ageThreshold", v)}
        />
        <div className="vrp-criterion-foot">
          <TextInput
            label="Sell at (model-years)"
            value={String(c.ageThreshold)}
            disabled={!c.ageOn}
            onChange={(e) => set("ageThreshold", clampInt(e.target.value, 1, 40, c.ageThreshold))}
          />
        </div>
        <p className="vrp-criterion-hint">Age is calendar year minus model year, from the decoded VIN.</p>
      </div>

      {/* ---- Horizon + look-back ---- */}
      <div className="vrp-criterion vrp-criterion-aux">
        <div className="vrp-criterion-head">
          <span className="vrp-criterion-title">Flag as approaching within</span>
          <span className="vrp-criterion-value">
            {c.horizonMonths} {c.horizonMonths === 1 ? "month" : "months"}
          </span>
        </div>
        <Slider
          id="vrp-horizon"
          min={1}
          max={36}
          step={1}
          value={c.horizonMonths}
          ariaLabel="Approaching horizon in months"
          onChange={(v) => set("horizonMonths", v)}
        />
        <div className="vrp-criterion-foot">
          <div className="vrp-field">
            <span className="vrp-field-label">Average {unitLabel}/month over</span>
            <Dropdown
              value={[String(c.lookbackMonths)]}
              dataItems={LOOKBACK_ITEMS}
              onChange={(items: ISelectionItem[]) => {
                const m = parseInt(String(items[0]?.id ?? "6"), 10) || 6;
                if (m !== c.lookbackMonths) {
                  set("lookbackMonths", m);
                  onLookbackChange(m);
                }
              }}
              errorHandler={(e) => console.error("[VRP] lookback:", e)}
              forceSelection
              multiselect={false}
              showSelection
              showCounterPill={false}
              placeholder="Look-back"
              disabled={busy}
            />
          </div>
          <button
            type="button"
            className="vrp-link"
            onClick={() => {
              onChange({ ...DEFAULT_CRITERIA, units: c.units, lookbackMonths: c.lookbackMonths });
            }}
          >
            Reset sliders
          </button>
        </div>
        <p className="vrp-criterion-hint">
          A vehicle is flagged when <strong>any</strong> enabled criterion is met. Changing the look-back re-reads the
          odometer history.
        </p>
      </div>
    </section>
  );
}
