import type { Verdict } from "../types";

export const VERDICT_ORDER: Verdict[] = ["sell", "approaching", "ok", "no-data"];

export const VERDICT_LABEL: Record<Verdict, string> = {
  sell: "Time to sell",
  approaching: "Approaching",
  ok: "Keep",
  "no-data": "No data",
};

export const VERDICT_TONE: Record<Verdict, "warn" | "info" | "ok" | "muted"> = {
  sell: "warn",
  approaching: "info",
  ok: "ok",
  "no-data": "muted",
};

export const VIN_STATUS_LABEL = {
  decoded: "Decoded",
  "year-only": "Year from VIN only",
  undecoded: "VIN not decoded",
  missing: "Missing VIN",
} as const;
