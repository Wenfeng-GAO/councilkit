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

/** Default autonomous-run budget (review/apply, non-Codex seats). */
export const DEFAULT_AUTONOMOUS_TIMEOUT_MS = 45 * 60 * 1000;

/** Codex review seats are slower (clone + long exec); keep a separate default. */
export const DEFAULT_CODEX_TIMEOUT_MS = 90 * 60 * 1000;

/** Node's setTimeout 32-bit signed ceiling (2^31 - 1 ms ≈ 24.8 days). */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Parse `--timeout 30m|600s|1h|5000ms`. `undefined` → `defaultMs`. */
export function parseTimeoutMs(
  raw: string | undefined,
  defaultMs: number = DEFAULT_AUTONOMOUS_TIMEOUT_MS,
  flagName = "timeout",
): number {
  if (raw === undefined) return defaultMs;
  const match = /^(\d+)(ms|s|m|h)$/.exec(raw);
  if (match === null) {
    throw errors.usage(`--${flagName} must look like 30m|600s|1h|5000ms, got "${raw}"`);
  }
  const n = Number(match[1]);
  const unit = match[2];
  const ms = n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw errors.usage(`--${flagName} must be a positive duration, got "${raw}"`);
  }
  if (ms > MAX_TIMEOUT_MS) {
    throw errors.usage(`--${flagName} must be <= ${MAX_TIMEOUT_MS}ms, got "${raw}"`);
  }
  return ms;
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
