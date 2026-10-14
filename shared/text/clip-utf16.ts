/**
 * Clip text on UTF-16 code-unit boundaries without leaving a lone surrogate.
 *
 * `string.length` and `slice` count UTF-16 code units. A cut between a high
 * surrogate (U+D800–U+DBFF) and its low surrogate (U+DC00–U+DFFF) yields a
 * string that zod `.max()` rejects and that renders as a broken character.
 */

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Keep at most `max` UTF-16 code units from the start of `value`.
 *
 * `max <= 0` returns `""`. A value that already fits is returned unchanged
 * and `suffix` is not applied. When the value is longer, `suffix.length`
 * counts toward `max`: the prefix is shortened so prefix + suffix stays
 * inside the budget, backing off one unit if the cut would end on a high
 * surrogate.
 */
export function clipUtf16(value: string, max: number, suffix = ""): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const tail = suffix;
  let budget = max - tail.length;
  if (budget <= 0) {
    return tail.length <= max ? tail : clipUtf16(tail, max);
  }
  if (isHighSurrogate(value.charCodeAt(budget - 1))) budget -= 1;
  return value.slice(0, budget) + tail;
}

/**
 * Keep at most `max` UTF-16 code units from the end of `value`.
 *
 * `max <= 0` returns `""`. A value that already fits is returned unchanged
 * and `prefix` is not applied. When the value is longer, `prefix.length`
 * counts toward `max`. A cut that would start on a low surrogate skips that
 * unit so the result does not begin with a lone surrogate.
 */
export function clipUtf16Tail(value: string, max: number, prefix = ""): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  const head = prefix;
  const budget = max - head.length;
  if (budget <= 0) {
    return head.length <= max ? head : clipUtf16(head, max);
  }
  let start = value.length - budget;
  if (isLowSurrogate(value.charCodeAt(start))) start += 1;
  if (start >= value.length) return head;
  return head + value.slice(start);
}
