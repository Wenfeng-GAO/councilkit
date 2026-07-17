import type { IncomingMessage } from "node:http";
import { CANONICAL_HOST_HEADER, CANONICAL_ORIGIN } from "@shared/runtime/contracts";
import { type RuntimeError, makeError } from "@shared/runtime/errors";
import type { SessionCapability } from "./session-capability";

/**
 * Loopback request guard. Runs before any large body is read and before any
 * discovery/subprocess action is triggered.
 *
 * - Exact Host header match against the canonical origin (rejects `localhost`,
 *   IPv6 forms, wrong ports and DNS-rebinding hostnames).
 * - No CORS allow headers are ever emitted; cross-site form/`text/plain`
 *   requests and preflights fail the Origin check.
 * - Everything except the minimal public health endpoint requires the session
 *   cookie; mutations additionally require the exact Origin and CSRF header.
 */
export type AuthLevel = "public" | "session" | "mutation";

export type GuardResult = { ok: true } | { ok: false; error: RuntimeError; status: number };

export interface GuardOptions {
  auth: AuthLevel;
  session: SessionCapability;
  hostHeader?: string;
  expectedOrigin?: string;
}

export function guardRequest(req: IncomingMessage, options: GuardOptions): GuardResult {
  const expectedHost = options.hostHeader ?? CANONICAL_HOST_HEADER;
  const host = req.headers.host;
  if (host !== expectedHost) {
    return {
      ok: false,
      status: 403,
      error: makeError("HOST_HEADER_MISMATCH", "security", "Unexpected Host header.", {
        retryable: false,
      }),
    };
  }

  if (options.auth === "public") {
    return { ok: true };
  }

  if (!options.session.hasSession(req.headers.cookie)) {
    return {
      ok: false,
      status: 401,
      error: makeError("UNAUTHENTICATED", "security", "Missing or invalid session capability.", {
        retryable: false,
      }),
    };
  }

  if (options.auth === "session") {
    return { ok: true };
  }

  // Mutation: exact Origin + CSRF capability. `Origin: null` and missing
  // Origin both fail; the method itself never downgrades the requirement.
  const expectedOrigin = options.expectedOrigin ?? CANONICAL_ORIGIN;
  const origin = req.headers.origin;
  if (origin !== expectedOrigin) {
    return {
      ok: false,
      status: 403,
      error: makeError("ORIGIN_MISMATCH", "security", "Missing or unexpected Origin header.", {
        retryable: false,
      }),
    };
  }

  if (!options.session.hasCsrf(req.headers["x-councilkit-csrf"])) {
    return {
      ok: false,
      status: 403,
      error: makeError("CSRF_MISMATCH", "security", "Missing or invalid CSRF capability.", {
        retryable: false,
      }),
    };
  }

  return { ok: true };
}

/** Preflights are never part of the API surface: refuse them outright. */
export function isPreflight(req: IncomingMessage): boolean {
  return req.method === "OPTIONS";
}
