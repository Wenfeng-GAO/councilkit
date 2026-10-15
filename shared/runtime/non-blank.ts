/**
 * Blank environment values are missing, not explicit settings.
 * `""` and `"   "` must not hide the next config file or built-in default.
 * The returned text has surrounding whitespace removed. Internal spaces stay.
 */

export function nonBlank(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function firstNonBlank(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const picked = nonBlank(value);
    if (picked !== undefined) return picked;
  }
  return undefined;
}
