/**
 * Shared Runtime API contract constants and state vocabulary.
 *
 * These constants are compatibility promises once shipped (see
 * docs/plans/2026-07-17-001): the canonical origin, limits and quotas may only
 * change together with their tests and a migration decision.
 */

export const API_VERSION = "v1" as const;
export const API_BASE = "/api/v1" as const;

export const CANONICAL_PORT = 43127 as const;
export const CANONICAL_ORIGIN = "http://127.0.0.1:43127" as const;
export const CANONICAL_HOST_HEADER = "127.0.0.1:43127" as const;

export const SUPPORTED_NODE_MAJOR = 22 as const;

/** Session capability cookie + CSRF header names (U2 security boundary). */
export const SESSION_COOKIE_NAME = "councilkit_session" as const;
export const CSRF_HEADER_NAME = "x-councilkit-csrf" as const;

/** V1 protocol/resource limits. Exceeding any of these rejects only the
 * offending request/Participant execution with a structured protocol failure. */
export const LIMITS = {
  httpBodyBytes: 4 * 1024 * 1024,
  ndjsonLineBytes: 8 * 1024 * 1024,
  jsonMaxDepth: 64,
  executionBufferBytes: 32 * 1024 * 1024,
  stderrRingBytes: 256 * 1024,
  diagnosticStringBytes: 4 * 1024,
} as const;

/** V1 Host-level quotas. Exceeding them returns structured RESOURCE_LIMIT/429;
 * health, cancel, ACK and close stay available. */
export const QUOTAS = {
  maxActiveScopes: 4,
  maxParticipantsPerScope: 8,
  maxDriverProcesses: 16,
  maxConcurrentExecutions: 4,
  maxEventConnections: 32,
  scopeCreatesPerMinute: 10,
} as const;

/** V1 fixed driver/supervision timeouts (ms). */
export const TIMEOUTS = {
  handshakeMs: 15_000,
  dispatchAckMs: 5_000,
  streamIdleMs: 60_000,
  turnMs: 600_000,
  interruptGraceMs: 5_000,
  shutdownGraceMs: 10_000,
  reapAfterHostDeathMs: 5_000,
  creatingScopeTtlMs: 30_000,
} as const;

export const DRIVER_IDS = ["claude-stream-json", "codex-app-server"] as const;
export type DriverId = (typeof DRIVER_IDS)[number];

/** Runtime Installation trust: only describes local path + fingerprint. */
export const INSTALLATION_STATES = [
  "discovering",
  "discovered",
  "trusted",
  "changed",
  "not_found",
  "invalid",
] as const;
export type InstallationState = (typeof INSTALLATION_STATES)[number];

/** Driver capability: produced by the real driver handshake, never persisted. */
export const DRIVER_CAPABILITY_STATES = [
  "checking",
  "ready",
  "auth_required",
  "incompatible",
] as const;
export type DriverCapabilityState = (typeof DRIVER_CAPABILITY_STATES)[number];

/** Execution Profile readiness = static binding + driver capability. */
export const PROFILE_READINESS_STATES = [
  "ready",
  "invalid_binding",
  "model_unavailable",
  "runtime_unavailable",
] as const;
export type ProfileReadinessState = (typeof PROFILE_READINESS_STATES)[number];

export const PARTICIPANT_RUNTIME_STATES = [
  "cold",
  "prewarming",
  "ready",
  "busy",
  "failed",
] as const;
export type ParticipantRuntimeState = (typeof PARTICIPANT_RUNTIME_STATES)[number];

export const SCOPE_STATES = ["creating", "active", "closing", "closed"] as const;
export type ScopeState = (typeof SCOPE_STATES)[number];

/** Dispatch state: was the request provably handed to the runtime? */
export const DISPATCH_STATES = ["not_dispatched", "accepted", "unknown"] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

/** Tool activity state of an execution (Codex built-in tools stay allowed). */
export const TOOL_STATES = ["none", "active", "completed", "unknown"] as const;
export type ToolState = (typeof TOOL_STATES)[number];

export const ACK_STATES = ["pending", "acknowledged", "expired"] as const;
export type AckState = (typeof ACK_STATES)[number];

export const ACK_DISPOSITIONS = ["committed", "discarded"] as const;
export type AckDisposition = (typeof ACK_DISPOSITIONS)[number];

/** Session reconciliation states; V1 never auto-rebases an active scope. */
export const SESSION_RECONCILE_STATES = ["cold", "in_sync", "needs_rebase"] as const;
export type SessionReconcileState = (typeof SESSION_RECONCILE_STATES)[number];

/** Host-side execution lifecycle (browser persists its own richer model). */
export const EXECUTION_STATES = ["running", "completed", "failed", "interrupted"] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const CREDENTIAL_MODE = "installation-managed" as const;
