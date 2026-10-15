/**
 * Model ids that mean "use the driver's account default", not a concrete model.
 * Cursor omits `--model` and Codex omits `-m` for these three aliases.
 * The trimmed check is what spawn and catalog validation use. Init's placeholder
 * replacement stays exact, so a differently cased id is not rewritten.
 */
export const DEFAULT_MODEL_ALIASES = ["auto", "default", "configured"] as const;

const ALIAS_SET: ReadonlySet<string> = new Set(DEFAULT_MODEL_ALIASES);

export function isDefaultModelAlias(modelId: string): boolean {
  return ALIAS_SET.has(modelId.trim().toLowerCase());
}

export function isExactDefaultModelAlias(modelId: string): boolean {
  return (DEFAULT_MODEL_ALIASES as readonly string[]).includes(modelId);
}
