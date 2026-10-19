/**
 * VIN helpers. Make/model come from MyGeotab's DecodeVins; this file only
 * covers the model-year code (10th character) used when the decoder is
 * unavailable, and the "is this a real VIN" check that drives the
 * "Missing VIN" status.
 */

const VIN_YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789";

/** True for a standard 17-character VIN (no I/O/Q, not all zeros). Equipment PINs fail this. */
export function isStandardVin(vin: string | undefined): boolean {
  if (!vin) return false;
  const v = vin.trim().toUpperCase();
  return v.length === 17 && !/[IOQ]/.test(v) && !/^0+$/.test(v) && /^[A-Z0-9]+$/.test(v);
}

/** The VIN MyGeotab is using for the vehicle: the user-entered one, else the engine-reported one. */
export function pickVin(user: string | undefined, engine: string | undefined): string {
  const u = (user ?? "").trim().toUpperCase();
  if (u && !/^0+$/.test(u)) return u;
  const e = (engine ?? "").trim().toUpperCase();
  if (e && !/^0+$/.test(e)) return e;
  return "";
}

/**
 * Decode the model year from a standard VIN. Returns null for non-standard
 * identifiers. Years are disambiguated to the 1980–2039 range using the 7th
 * character rule (a letter at position 7 ⇒ 2010+).
 */
export function yearFromVin(vin: string | undefined): number | null {
  if (!vin) return null;
  const v = vin.trim().toUpperCase();
  if (!isStandardVin(v)) return null;
  const code = v[9];
  const idx = VIN_YEAR_CODES.indexOf(code);
  if (idx < 0) return null;
  const base = 1980 + idx; // 1980..2009
  const modern = /[A-Z]/.test(v[6]); // letter at position 7 ⇒ 2010–2039
  return modern ? base + 30 : base;
}
