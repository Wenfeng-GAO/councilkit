/**
 * Unified Runtime error vocabulary and wire envelope.
 *
 * Errors are structured metadata only: messages must never carry prompts,
 * completions, credentials, cookies, full environment dumps or CLI config
 * contents. Host-side diagnostics are referenced by `diagnosticId`.
 */
import { z } from "zod";
import { DRIVER_IDS } from "./contracts";

export const RUNTIME_ERROR_CODES = [
  // generic HTTP/contract
  "BAD_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "PAYLOAD_TOO_LARGE",
  "RESOURCE_LIMIT",
  "RATE_LIMITED",
  "INTERNAL",
  // security boundary
  "HOST_HEADER_MISMATCH",
  "ORIGIN_MISMATCH",
  "CSRF_MISMATCH",
  "STALE_CONTROLLER",
  // installation / profile
  "INSTALLATION_NOT_FOUND",
  "INSTALLATION_INVALID",
  "INSTALLATION_CHANGED",
  "INSTALLATION_UNTRUSTED",
  "PROFILE_INVALID",
  "MODEL_UNAVAILABLE",
  "AUTH_REQUIRED",
  "INCOMPATIBLE_DRIVER",
  // scope / execution lifecycle
  "SCOPE_NOT_FOUND",
  "SCOPE_CLOSED",
  "PARTICIPANT_NOT_FOUND",
  "PARTICIPANT_BUSY",
  "EXECUTION_NOT_FOUND",
  "EXECUTION_CONFLICT",
  "ALREADY_TERMINAL",
  // driver / protocol
  "DRIVER_SPAWN_FAILED",
  "HANDSHAKE_TIMEOUT",
  "DISPATCH_TIMEOUT",
  "STREAM_IDLE_TIMEOUT",
  "TURN_TIMEOUT",
  "PROTOCOL_VIOLATION",
  "PROTOCOL_LIMIT",
  "DRIVER_CRASH",
  "CANCELLED",
  "EMPTY_OUTPUT",
  "MODEL_MISMATCH",
  "TOOL_STATE_UNKNOWN",
  "NEEDS_REBASE",
  // bootstrap
  "UNSUPPORTED_NODE",
  "PORT_IN_USE",
] as const;

export const runtimeErrorCodeSchema = z.enum(RUNTIME_ERROR_CODES);
export type RuntimeErrorCode = z.infer<typeof runtimeErrorCodeSchema>;

export const ERROR_PHASES = [
  "bootstrap",
  "security",
  "discovery",
  "prewarm",
  "dispatch",
  "stream",
  "commit",
  "cancel",
  "close",
  "quota",
] as const;

export const errorPhaseSchema = z.enum(ERROR_PHASES);
export type ErrorPhase = z.infer<typeof errorPhaseSchema>;

export const runtimeErrorSchema = z
  .object({
    code: runtimeErrorCodeSchema,
    phase: errorPhaseSchema,
    retryable: z.boolean(),
    message: z.string().max(1024),
    driverId: z.enum(DRIVER_IDS).optional(),
    executionId: z.string().optional(),
    participantId: z.string().optional(),
    diagnosticId: z.string().optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export type RuntimeError = z.infer<typeof runtimeErrorSchema>;

/** Success/error envelope used by every JSON endpoint. */
export const apiEnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: runtimeErrorSchema }).strict(),
]);
export type ApiEnvelope = z.infer<typeof apiEnvelopeSchema>;

export function makeError(
  code: RuntimeErrorCode,
  phase: ErrorPhase,
  message: string,
  extra: Partial<Omit<RuntimeError, "code" | "phase" | "message">> = {},
): RuntimeError {
  return { code, phase, message, retryable: extra.retryable ?? false, ...extra };
}
