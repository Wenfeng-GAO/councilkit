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

/**
 * Live secret registry (F8). The AuthClient registers the current session cookie
 * pair and CSRF token value once extracted, so `redactString` scrubs the bare
 * token value wherever it appears in a string leaf — not only when it sits under
 * a known structural key. Without this, a raw token value embedded in an error
 * detail or stdout JSON would leak since neither the cookie-pair nor the CSRF
 * header-name pattern matches a bare token value.
 */
const liveSecrets = new Set<string>();

/** Register the current cookie pair + CSRF token value for string redaction.
 * Called by AuthClient when credentials are extracted. In-memory only. */
export function registerSecrets(auth: { cookie: string; csrfToken: string }): void {
  if (auth.cookie.length > 0) liveSecrets.add(auth.cookie);
  if (auth.csrfToken.length > 0) liveSecrets.add(auth.csrfToken);
}

/** Clear the live-secret registry (tests / credential rotation). */
export function clearSecrets(): void {
  liveSecrets.clear();
}

/** A structural key whose entire value is a secret (cookie pair / CSRF token /
 * access token). The value is replaced wholesale rather than pattern-matched. */
function isSecretValueKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower === "cookie" || lower === "csrf" || lower === "token") return true;
  return /cookie|csrf/.test(lower) || /token$/.test(lower);
}

function redactString(input: string): string {
  if (input.startsWith(COOKIE_PAIR_PREFIX) || input === "councilkit_session") {
    return REDACT_PLACEHOLDER;
  }
  let out = input.replace(COOKIE_PAIR_PATTERN, REDACT_PLACEHOLDER);
  out = out.replace(CSRF_KEY_PATTERN, REDACT_PLACEHOLDER);
  if (liveSecrets.size > 0) {
    for (const secret of liveSecrets) {
      if (secret.length > 0 && out.includes(secret)) {
        out = out.split(secret).join(REDACT_PLACEHOLDER);
      }
    }
  }
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
      // F8: a cookie/csrf/token structural key carries a whole secret value —
      // replace it wholesale so a bare token value is never pattern-matched
      // into a leak (e.g. { csrfToken: "CANARY" } must become { csrfToken:
      // "[redacted]" }, independent of any cookie presence).
      if (isSecretValueKey(key)) {
        out[keyRedacted] = REDACT_PLACEHOLDER;
      } else {
        out[keyRedacted] = redact(record[key]);
      }
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
