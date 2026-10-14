/**
 * `JSON.parse` that returns null on invalid text.
 *
 * A successful parse of the JSON value `null` is also null. Callers that
 * need to tell those apart must not use this helper.
 */
export function jsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
