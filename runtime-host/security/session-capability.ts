import { randomBytes, timingSafeEqual } from "node:crypto";
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "@shared/runtime/contracts";

/**
 * Per-startup session + CSRF capabilities (>= 256-bit, CSPRNG).
 *
 * The session capability lives in an HttpOnly, SameSite=Strict cookie scoped
 * to Path=/ with no Domain attribute. It never appears in URLs, Referers or
 * logs, and becomes invalid the moment the Host restarts. State-changing
 * requests additionally require the CSRF capability header injected into the
 * first-party document at bootstrap.
 */
export interface SessionCapability {
  readonly sessionToken: string;
  readonly csrfToken: string;
  hasSession(cookieHeader: string | undefined): boolean;
  hasCsrf(headerValue: string | string[] | undefined): boolean;
  sessionCookieValue(): string;
}

export function createSessionCapability(
  entropy: { bytes(n: number): string } = { bytes: (n) => randomBytes(n).toString("base64url") },
): SessionCapability {
  const sessionToken = entropy.bytes(32);
  const csrfToken = entropy.bytes(32);

  function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  return {
    sessionToken,
    csrfToken,
    hasSession(cookieHeader) {
      if (!cookieHeader) return false;
      for (const part of cookieHeader.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name === SESSION_COOKIE_NAME && safeEqual(value, sessionToken)) {
          return true;
        }
      }
      return false;
    },
    hasCsrf(headerValue) {
      const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
      if (!value) return false;
      return safeEqual(value, csrfToken);
    },
    sessionCookieValue() {
      return `${SESSION_COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`;
    },
  };
}

export { CSRF_HEADER_NAME, SESSION_COOKIE_NAME };
