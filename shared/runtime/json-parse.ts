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
 * Parse JSON, or the one top-level `{...}` value when the whole text is not JSON.
 *
 * `String.trim()` runs first. Braces inside strings, and braces in surrounding
 * noise, are not the object's ends. Two top-level objects stay null so a log
 * object cannot replace the payload. A successful parse of the JSON value
 * `null` is also null. Callers that need to tell a real `null` from a failed
 * parse must not use this helper.
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

/** One balanced object that is valid JSON. Zero or several is null. */
function parseLoneEmbeddedObject(text: string): unknown {
  let found: unknown = null;
  let count = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "{") {
      index += 1;
      continue;
    }
    const end = matchingJsonCloser(text, index);
    if (end < 0) {
      index += 1;
      continue;
    }
    try {
      found = JSON.parse(text.slice(index, end + 1));
      count += 1;
      if (count > 1) return null;
    } catch {
      // Balanced text that is not JSON. The next object may follow this span.
    }
    index = end + 1;
  }
  return count === 1 ? found : null;
}

function matchingJsonCloser(text: string, open: number): number {
  const stack: string[] = [];
  let index = open;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const next = endOfJsonString(text, index);
      if (next < 0) return -1;
      index = next;
      continue;
    }
    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") {
      if (stack.length === 0 || stack[stack.length - 1] !== char) return -1;
      stack.pop();
      if (stack.length === 0) return index;
    }
    index += 1;
  }
  return -1;
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
