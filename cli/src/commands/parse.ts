/**
 * Shared command-argument parsing helpers (plan-a §8). Each leaf command uses
 * `node:util.parseArgs` with `strict: true` (no commander/yargs dependency),
 * then re-validates with zod. Unknown flags, missing values and surplus
 * positionals are rejected as usage errors (exit 2).
 */
import { parseArgs } from "node:util";
import type { z } from "zod";
import { errors } from "../errors";
import { zodFailureMessage } from "../output";

export interface ParseSpec {
  flags: Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>;
  /** Number of positional arguments expected; extras are a usage error. */
  allowPositionals?: number;
}

/** Strict parseArgs wrapper that turns parse failures into a usage CliError. */
export function parseFlags(
  spec: ParseSpec,
  argv: string[],
): {
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  positionals: string[];
} {
  try {
    const parsed = parseArgs({
      options: spec.flags,
      args: argv,
      strict: true,
      allowPositionals: spec.allowPositionals !== undefined,
    });
    const positionals = parsed.positionals ?? [];
    if (spec.allowPositionals !== undefined && positionals.length > spec.allowPositionals) {
      throw errors.usage(
        `too many positional arguments: expected at most ${spec.allowPositionals}, got ${positionals.length}`,
      );
    }
    return { values: parsed.values, positionals };
  } catch (error) {
    if (error instanceof Error && error.name === "CliError") throw error;
    throw errors.usage(error instanceof Error ? error.message : String(error));
  }
}

/** Parse a JSON-valued flag (`--agents '[...]'`) and validate with a zod schema. */
export function parseJsonFlag<T>(
  raw: string | undefined,
  schema: z.ZodType<T>,
  fieldName: string,
): T {
  if (raw === undefined) {
    throw errors.usage(`--${fieldName} is required (a JSON value)`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw errors.usage(`--${fieldName} is not valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw errors.usage(zodFailureMessage(parsed.error.issues, `--${fieldName}`));
  }
  return parsed.data;
}

/** Parse a positive-integer flag. Strict: the raw string must be a bare
 * decimal positive integer (no trailing garbage, no decimals, no sign), then it
 * is coerced via `Number` and verified as a safe integer. `Number.parseInt`
 * silently accepted `2oops`→2 and `1.9`→1, which would run a different number
 * of rounds than requested. */
export function parseIntFlag(raw: string | undefined, fieldName: string): number {
  if (raw === undefined) throw errors.usage(`--${fieldName} is required (a positive integer)`);
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw errors.usage(`--${fieldName} must be a positive integer, got "${raw}"`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw errors.usage(`--${fieldName} must be a positive integer, got "${raw}"`);
  }
  return n;
}

/** Coerce a possibly-undefined string flag to a trimmed string ("" if absent). */
export function strOrEmpty(raw: string | undefined): string {
  return (raw ?? "").trim();
}

/** Shared flags every leaf accepts. */
export const COMMON_FLAGS = {
  json: { type: "boolean" as const },
} satisfies Record<string, { type: "string" | "boolean" }>;
