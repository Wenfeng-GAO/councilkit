/**
 * Whole-string canonical decimal integers.
 *
 * `Number.parseInt("2abc")` is 2, `Number("1e2")` is 100, and
 * `Number("9007199254740993")` is 2^53. Callers that then treat that result
 * as the number the user wrote skip events, open the wrong repair round, or
 * adopt another process's pid. Reject anything that is not the exact decimal
 * spelling of a safe integer.
 */

const CANONICAL_INT = /^(0|[1-9][0-9]*)$/;

/** `"0"` and positive safe integers. `null` when the text is not that integer. */
export function parseCanonicalInt(raw: string): number | null {
  if (!CANONICAL_INT.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** Positive safe integers. Zero and every non-canonical spelling are `null`. */
export function parseCanonicalPositiveInt(raw: string): number | null {
  const n = parseCanonicalInt(raw);
  return n !== null && n > 0 ? n : null;
}
