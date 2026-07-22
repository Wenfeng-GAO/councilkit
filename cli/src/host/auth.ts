/**
 * Host authentication (brief §2c, plan-a §4). The CLI talks to the same Runtime
 * Host a browser would: it GETs the index document, extracts the `Set-Cookie`
 * session pair and the injected `<meta name="councilkit-csrf">` token, and holds
 * both in process memory only. Nothing is persisted, logged, or emitted.
 *
 * 401/403 (or a CSRF/session rejection) triggers exactly one re-extraction: the
 * old jar is discarded and a fresh GET / is performed. On the second failure the
 * raw Host error is returned so the caller surfaces a redacted structured error.
 *
 * The parser tolerates attribute ordering and single/double quotes (plan-a §11
 * risk: cookie/CSRF extraction fragility), but accepts only a unique, non-empty
 * result — never a guess.
 */
import { CANONICAL_ORIGIN, CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "@shared/runtime/contracts";
import { registerSecrets } from "../redact";

export interface HostAuth {
  /** Raw session cookie pair, e.g. `councilkit_session=<value>`. In-memory only. */
  readonly cookie: string;
  /** Raw CSRF token value. In-memory only. */
  readonly csrfToken: string;
}

export interface AuthFetchOptions {
  fetchFn?: typeof fetch;
  /** Per-request timeout (ms). Default 8_000. */
  timeoutMs?: number;
  /** G3: caller's bounded signal (e.g. the run-level shared cleanup signal).
   * When aborted, the in-flight GET / is aborted too, so a cold-rebuild during
   * a shared cleanup budget cannot out-wait the budget by independently waiting
   * for the auth timeout. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export class AuthClient {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private current: HostAuth | null = null;

  constructor(baseUrl: string = CANONICAL_ORIGIN, opts: AuthFetchOptions = {}) {
    this.baseUrl = baseUrl;
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** Force a fresh extraction, discarding any cached jar. */
  async refresh(opts: AuthFetchOptions = {}): Promise<HostAuth> {
    const auth = await this.extract(opts);
    this.current = auth;
    return auth;
  }

  /** Return cached auth, extracting on first use. */
  async get(opts: AuthFetchOptions = {}): Promise<HostAuth> {
    if (this.current === null) {
      this.current = await this.extract(opts);
    }
    return this.current;
  }

  /** Discard the cached jar (used before a forced re-extraction). */
  invalidate(): void {
    this.current = null;
  }

  private async extract(opts: AuthFetchOptions): Promise<HostAuth> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("auth-timeout"), timeoutMs);
    // G3: also abort when the caller's bounded signal fires, so a cold-rebuild
    // during a shared cleanup budget cannot out-wait the budget on its own
    // 8s timeout. The auth timeout and the caller signal are combined here.
    const callerSignal = opts.signal;
    const onCallerAbort = () => controller.abort(callerSignal?.reason ?? "caller-abort");
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason ?? "caller-abort");
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    try {
      const response = await this.fetchFn(`${this.baseUrl}/`, {
        headers: { Accept: "text/html" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`document GET / -> HTTP ${response.status}`);
      }
      const cookie = extractSessionCookie(response.headers);
      const html = await response.text();
      const csrfToken = extractCsrfToken(html);
      if (cookie.length === 0) {
        throw new Error("document response carried no councilkit_session cookie");
      }
      if (csrfToken.length === 0) {
        throw new Error("document carried no councilkit-csrf meta tag");
      }
      // F8: register the live cookie pair + CSRF token value so the redactor
      // scrubs the bare token anywhere it appears in a string leaf, not just
      // under a known structural key.
      registerSecrets({ cookie, csrfToken });
      return { cookie, csrfToken };
    } finally {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }
}

/** Extract the `councilkit_session` pair from Set-Cookie. Prefers the structured
 * `getSetCookie()` API (Node 22); falls back to the combined header string. */
export function extractSessionCookie(headers: Headers): string {
  if (typeof headers.getSetCookie === "function") {
    const pairs = headers.getSetCookie();
    for (const raw of pairs) {
      const pair = pairOf(raw, SESSION_COOKIE_NAME);
      if (pair) return pair;
    }
    return "";
  }
  const combined = headers.get("set-cookie");
  if (combined === null) return "";
  // Combined header: multiple cookies are comma-separated (fragile for
  // expires=...; take the first `councilkit_session=...` segment up to `;`).
  for (const raw of combined.split(/,(?=\s*\w+=)/)) {
    const pair = pairOf(raw.trim(), SESSION_COOKIE_NAME);
    if (pair) return pair;
  }
  return "";
}

function pairOf(raw: string, name: string): string | null {
  const prefix = `${name}=`;
  const trimmed = raw.trim();
  if (!trimmed.startsWith(prefix)) return null;
  const value = trimmed.slice(prefix.length).split(";")[0];
  return value.length > 0 ? `${prefix}${value}` : null;
}

/** Tolerantly extract the `councilkit-csrf` content attribute from the index
 * document. Accepts single/double quotes and either attribute order, but
 * requires exactly one non-empty match — never a guess. */
export function extractCsrfToken(html: string): string {
  const matches: string[] = [];
  const metaRe = /<meta\b[^>]*>/gi;
  for (const tag of html.matchAll(metaRe)) {
    const tagText = tag[0];
    if (!/\bname\s*=\s*["']councilkit-csrf["']/i.test(tagText)) continue;
    const contentMatch = tagText.match(/\bcontent\s*=\s*"([^"]*)"/);
    const contentMatchSingle = tagText.match(/\bcontent\s*=\s*'([^']*)'/);
    const value = (contentMatch?.[1] ?? contentMatchSingle?.[1] ?? "").trim();
    if (value.length > 0) matches.push(value);
  }
  if (matches.length === 0) return "";
  if (matches.length > 1) {
    // Ambiguous document — refuse rather than pick.
    return "";
  }
  return matches[0];
}

/** The cookie header value to send on requests: just the pair. */
export function cookieHeader(auth: HostAuth): string {
  return auth.cookie;
}

/** Mutation headers: cookie + Origin + CSRF + JSON content-type. */
export function mutationHeaders(auth: HostAuth): Record<string, string> {
  return {
    Cookie: auth.cookie,
    Origin: CANONICAL_ORIGIN,
    [CSRF_HEADER_NAME]: auth.csrfToken,
    "Content-Type": "application/json",
  };
}

/** Session-read headers: cookie only (no CSRF). */
export function sessionHeaders(auth: HostAuth): Record<string, string> {
  return { Cookie: auth.cookie };
}
