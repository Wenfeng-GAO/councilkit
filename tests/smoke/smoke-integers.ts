import { parseCanonicalPositiveInt } from "@shared/runtime/decimal-int";

/** Soak floor override. A non-canonical spelling keeps the real floor. */
export function positiveIntOverride(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = parseCanonicalPositiveInt(raw);
  return n === null ? fallback : n;
}

/** CLI flag that must be the canonical spelling of a positive integer. */
export function requiredPositiveInt(raw: string | undefined, flag: string): number {
  const n = raw === undefined ? null : parseCanonicalPositiveInt(raw);
  if (n === null) {
    throw new Error(`--${flag} requires a positive integer, got "${raw ?? ""}"`);
  }
  return n;
}
