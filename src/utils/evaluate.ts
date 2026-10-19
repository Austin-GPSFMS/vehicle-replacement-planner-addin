/**
 * Pure "time to sell" evaluation — no API, no React — so it can be unit
 * tested (test/run.mjs) and reasoned about on its own.
 *
 * Inputs per vehicle: current odometer sample, a baseline sample from
 * ~lookback months ago, and the model year. Outputs: the monthly rate, the
 * projected month the mileage threshold is reached, the age threshold date,
 * and the verdict.
 *
 * Verdict rules (either/or — a fleet may use only one criterion):
 *   sell         any ENABLED criterion already met
 *   approaching  no criterion met, but one is projected within the horizon
 *   ok           every enabled criterion is evaluable and comfortably clear
 *   no-data      no enabled criterion could be evaluated (no odometer / no year)
 *
 * Age is whole model-years: calendar year − model year. A 2016 vehicle is
 * "10 years old" throughout 2026; it hits an 11-year threshold on 1 Jan 2027.
 */

import type { Criteria, OdometerSample, Verdict } from "../types";
import { addMonths, metersToUnit, monthsBetween, unitToMeters } from "./format";

export interface EvalInput {
  current: OdometerSample | null;
  baseline: OdometerSample | null;
  year: number | null;
}

export interface EvalOutput {
  odometerMeters: number | null;
  odometerAt: string | null;
  baselineMeters: number | null;
  baselineAt: string | null;
  metersPerMonth: number | null;
  spanMonths: number | null;
  ageYears: number | null;
  monthsToMileage: number | null;
  mileageDate: string | null;
  monthsToAge: number | null;
  ageDate: string | null;
  verdict: Verdict;
  reasons: string[];
}

/** Minimum span between samples before we trust the monthly rate. */
export const MIN_SPAN_MONTHS = 0.75;
/** Beyond this (50 years) a projection is shown as "> 50 yr" with no date. */
export const MAX_PROJECTION_MONTHS = 600;

function safeIso(d: Date): string | null {
  const t = d.getTime();
  return Number.isFinite(t) ? d.toISOString() : null;
}

export function evaluate(input: EvalInput, c: Criteria, now: Date): EvalOutput {
  const out: EvalOutput = {
    odometerMeters: input.current?.meters ?? null,
    odometerAt: input.current?.dateTime ?? null,
    baselineMeters: input.baseline?.meters ?? null,
    baselineAt: input.baseline?.dateTime ?? null,
    metersPerMonth: null,
    spanMonths: null,
    ageYears: null,
    monthsToMileage: null,
    mileageDate: null,
    monthsToAge: null,
    ageDate: null,
    verdict: "no-data",
    reasons: [],
  };

  // ---- Monthly rate from the two samples -------------------------------
  if (input.current && input.baseline) {
    const span = monthsBetween(input.baseline.dateTime, input.current.dateTime);
    const delta = input.current.meters - input.baseline.meters;
    out.spanMonths = span;
    if (span >= MIN_SPAN_MONTHS && delta >= 0) {
      out.metersPerMonth = delta / span;
    }
  }

  // ---- Age --------------------------------------------------------------
  if (input.year != null) {
    out.ageYears = now.getFullYear() - input.year;
  }

  // ---- Mileage criterion -----------------------------------------------
  let mileageMet = false;
  let mileageSoon = false;
  let mileageEvaluable = false;
  if (c.mileageOn) {
    const thresholdM = unitToMeters(c.mileageThreshold, c.units);
    if (out.odometerMeters != null) {
      mileageEvaluable = true;
      if (out.odometerMeters >= thresholdM) {
        mileageMet = true;
        out.monthsToMileage = 0;
        out.mileageDate = safeIso(now);
        out.reasons.push(
          `Odometer ${fmt(metersToUnit(out.odometerMeters, c.units))} ≥ ${fmt(c.mileageThreshold)} ${c.units}`
        );
      } else if (out.metersPerMonth != null && out.metersPerMonth > 0) {
        const months = (thresholdM - out.odometerMeters) / out.metersPerMonth;
        out.monthsToMileage = months;
        // A vehicle that barely moves projects thousands of years out; past the
        // cap there is no meaningful date (and Date would overflow and throw).
        out.mileageDate = months <= MAX_PROJECTION_MONTHS ? safeIso(addMonths(now, months)) : null;
        if (months <= c.horizonMonths) {
          mileageSoon = true;
          out.reasons.push(
            `Projected to reach ${fmt(c.mileageThreshold)} ${c.units} in ${Math.max(1, Math.round(months))} mo at ${fmt(metersToUnit(out.metersPerMonth, c.units))} ${c.units}/mo`
          );
        }
      } else if (out.metersPerMonth == null) {
        out.reasons.push(
          out.spanMonths != null && out.spanMonths < MIN_SPAN_MONTHS
            ? "Not enough odometer history to project"
            : out.baselineMeters == null
              ? "No baseline odometer reading"
              : "Odometer did not increase over the look-back"
        );
      }
    } else {
      out.reasons.push("No odometer reading");
    }
  }

  // ---- Age criterion ---------------------------------------------------
  let ageMet = false;
  let ageSoon = false;
  let ageEvaluable = false;
  if (c.ageOn) {
    if (out.ageYears != null && input.year != null) {
      ageEvaluable = true;
      const hitDate = new Date(input.year + c.ageThreshold, 0, 1);
      out.ageDate = safeIso(hitDate);
      const months = monthsBetween(now, hitDate);
      out.monthsToAge = Math.max(0, months);
      if (out.ageYears >= c.ageThreshold) {
        ageMet = true;
        out.monthsToAge = 0;
        out.reasons.push(`${out.ageYears} model-years old ≥ ${c.ageThreshold} yr`);
      } else if (months <= c.horizonMonths) {
        ageSoon = true;
        out.reasons.push(`Turns ${c.ageThreshold} in ${monthYear(hitDate)}`);
      }
    } else {
      out.reasons.push("No model year");
    }
  }

  // ---- Verdict ---------------------------------------------------------
  if (mileageMet || ageMet) out.verdict = "sell";
  else if (mileageSoon || ageSoon) out.verdict = "approaching";
  else if (mileageEvaluable || ageEvaluable) out.verdict = "ok";
  else out.verdict = "no-data";

  if (!c.mileageOn && !c.ageOn) {
    out.verdict = "no-data";
    out.reasons = ["No criteria enabled"];
  }
  return out;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString();
}

function monthYear(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** Choose the sample pair for the rate: same diagnostic at both instants, preferring the adjusted odometer. */
export function pickSamplePair(
  nowSamples: Map<string, OdometerSample> | undefined,
  baseSamples: Map<string, OdometerSample> | undefined,
  preferred: string[]
): { current: OdometerSample | null; baseline: OdometerSample | null } {
  let current: OdometerSample | null = null;
  let baseline: OdometerSample | null = null;
  for (const diag of preferred) {
    const n = nowSamples?.get(diag);
    const b = baseSamples?.get(diag);
    if (n && b) return { current: n, baseline: b };
    if (n && !current) current = n;
  }
  if (!current && nowSamples?.size) current = Array.from(nowSamples.values())[0];
  // No matching pair — keep the current reading (for the threshold check) but no baseline.
  return { current, baseline };
}
