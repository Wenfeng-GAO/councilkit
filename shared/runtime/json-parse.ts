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

/**
 * Parse JSON, or the outermost `{...}` span when the whole text is not JSON.
 *
 * `String.trim()` runs first. A successful parse of the JSON value `null` is
 * also null. Callers that need to tell a real `null` from a failed parse must
 * not use this helper.
 */
export function jsonParseEmbedded(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
