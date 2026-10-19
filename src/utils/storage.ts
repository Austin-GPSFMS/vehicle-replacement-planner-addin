/** localStorage persistence for the criteria sliders and scan settings. */

import type { Criteria, Settings } from "../types";

const SETTINGS_KEY = "gpsfms.vehicleReplacementPlanner.settings.v1";

export const DEFAULT_CRITERIA: Criteria = {
  mileageOn: true,
  mileageThreshold: 150000,
  ageOn: true,
  ageThreshold: 10,
  horizonMonths: 12,
  lookbackMonths: 6,
  units: "mi",
};

export const DEFAULT_SETTINGS: Settings = {
  criteria: DEFAULT_CRITERIA,
  groupIds: [],
  callsPerMinute: 600,
  includeNoVin: true,
};

export function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      criteria: { ...DEFAULT_CRITERIA, ...(parsed.criteria ?? {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
