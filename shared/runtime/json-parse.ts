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
 * Parse JSON, or the one `{...}` object when the whole text is not JSON.
 *
 * `String.trim()` runs first. Braces inside strings, and braces in surrounding
 * noise, are not the object's ends. Two JSON objects stay null so a log object
 * cannot replace the payload. A valid object nested in a non-JSON `{...}` span
 * counts toward that limit and is not returned by itself. A successful parse
 * of the JSON value `null` is also null. Callers that need to tell a real
 * `null` from a failed parse must not use this helper.
 */
export function jsonParseEmbedded(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return parseLoneEmbeddedObject(trimmed);
  }
}

/** Past this depth, further `{` are counted instead of stacked. */
const MAX_EMBEDDED_BRACE_DEPTH = 1024;

interface BraceSpan {
  start: number;
  end: number;
  kids: BraceSpan[];
}

/** One JSON object. Zero or several is null. One left-to-right pass. */
function parseLoneEmbeddedObject(text: string): unknown {
  const stack: BraceSpan[] = [];
  let overflow = 0;
  let found: unknown = null;
  let count = 0;
  let index = 0;

  const take = (span: BraceSpan): boolean => {
    try {
      found = JSON.parse(text.slice(span.start, span.end + 1));
      count += 1;
    } catch {
      // The span is not a payload. A nested object still counts, so a later
      // object cannot win alone, but the inner value is not promoted. It may
      // be a fragment of a broken object.
      if (spanHoldsJsonObject(text, span)) count += 1;
    }
    return count > 1;
  };

  while (index < text.length) {
    const char = text[index];
    if (char === '"' && (stack.length > 0 || overflow > 0)) {
      const next = endOfJsonString(text, index);
      if (next < 0) break;
      index = next;
      continue;
    }
    if (char === "{") {
      if (overflow > 0 || stack.length >= MAX_EMBEDDED_BRACE_DEPTH) overflow += 1;
      else stack.push({ start: index, end: -1, kids: [] });
      index += 1;
      continue;
    }
    if (char === "}") {
      if (overflow > 0) {
        overflow -= 1;
      } else if (stack.length > 0) {
        const span = stack.pop();
        if (span) {
          span.end = index;
          const parent = stack[stack.length - 1];
          if (parent) parent.kids.push(span);
          else if (take(span)) return null;
        }
      }
      index += 1;
      continue;
    }
    index += 1;
  }

  while (stack.length > 0) {
    const open = stack.pop();
    if (!open) break;
    const parent = stack[stack.length - 1];
    if (parent) {
      for (const kid of open.kids) parent.kids.push(kid);
      continue;
    }
    for (const kid of open.kids) {
      if (take(kid)) return null;
    }
  }
  return count === 1 ? found : null;
}

function spanHoldsJsonObject(text: string, span: BraceSpan): boolean {
  const pending = span.kids.slice();
  while (pending.length > 0) {
    const kid = pending.pop();
    if (!kid) break;
    try {
      JSON.parse(text.slice(kid.start, kid.end + 1));
      return true;
    } catch {
      for (const nested of kid.kids) pending.push(nested);
    }
  }
  return false;
}

function endOfJsonString(text: string, openQuote: number): number {
  let index = openQuote + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  return -1;
}
