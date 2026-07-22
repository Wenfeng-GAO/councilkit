/**
 * Secret hygiene (brief §2c, AC5). Cookie/CSRF live only in process memory and
 * must never reach disk, logs, `--json` stdout, error text or zod issue output.
 *
 * `redact` is applied to every value before it is written to a store file,
 * printed, serialized to JSON or embedded in an error. It recurses
 * structurally; string leaves are run through `redactString` which scrubs the
 * session cookie pair and the CSRF token value when they appear verbatim.
 */

const COOKIE_PAIR_PREFIX = "councilkit_session=";
const CSRF_KEY_PATTERN = /x-councilkit-csrf\b/gi;
/** The cookie pair value: `councilkit_session=<token>` up to the next `;` or end. */
const COOKIE_PAIR_PATTERN = /councilkit_session=[^;]+/g;

export const REDACT_PLACEHOLDER = "[redacted]";

function redactString(input: string): string {
  if (input.startsWith(COOKIE_PAIR_PREFIX) || input === "councilkit_session") {
    return REDACT_PLACEHOLDER;
  }
  let out = input.replace(COOKIE_PAIR_PATTERN, REDACT_PLACEHOLDER);
  out = out.replace(CSRF_KEY_PATTERN, REDACT_PLACEHOLDER);
  return out;
}

/** Redact a value of arbitrary shape in place-free fashion (returns a copy). */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const keyRedacted = redactString(key);
      out[keyRedacted] = redact(record[key]);
    }
    return out;
  }
  return value;
}

export interface SecretStore {
  /** Raw cookie pair (e.g. `councilkit_session=...`); never serialized. */
  cookie: string;
  /** Raw CSRF token value; never serialized. */
  csrfToken: string;
}

/**
 * A zod issue summary that is safe to print/store: it includes the path and the
 * issue code/message but never the received value (which could carry a secret).
 * The message itself is run through `redact` defensively.
 */
export function summarizeZodIssue(issue: {
  path?: PropertyKey[];
  code?: string;
  message?: string;
}): Record<string, unknown> {
  return {
    path: (issue.path ?? []).map((segment) => String(segment)),
    code: issue.code ?? "unknown",
    message: redactString(issue.message ?? ""),
  };
}

/** True when a string leaf still contains a known secret — used by secret-hygiene
 * tests to assert canary tokens never survived. The matcher is deliberately
 * conservative: the literal secret OR the cookie pair footprint. */
export function containsSecret(input: string, secret: string): boolean {
  if (secret.length > 0 && input.includes(secret)) return true;
  return COOKIE_PAIR_PATTERN.test(input) || /x-councilkit-csrf/i.test(input);
}
