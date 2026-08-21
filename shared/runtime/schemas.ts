/**
 * Runtime API request/response DTOs and their runtime schemas.
 *
 * Browser and Host validate the same payloads with these schemas. All
 * request schemas are `.strict()`: unknown fields — including executable,
 * argv, shell, env or token injection attempts — fail validation.
 */
import { z } from "zod";
import { landingRecordSchema, ledgerFindingSchema, planLockFileSchema } from "./cli-ledger";
import {
  ACK_DISPOSITIONS,
  ACK_STATES,
  CREDENTIAL_MODE,
  DRIVER_CAPABILITY_STATES,
  DRIVER_IDS,
  EXECUTION_STATES,
  INSTALLATION_STATES,
  LIMITS,
  PARTICIPANT_RUNTIME_STATES,
  PROFILE_READINESS_STATES,
  QUOTAS,
  SCOPE_STATES,
} from "./contracts";
import { usageSchema } from "./events";

// ---------------------------------------------------------------------------
// Health / capabilities
// ---------------------------------------------------------------------------

export const driverDescriptorSchema = z
  .object({
    driverId: z.enum(DRIVER_IDS),
    capability: z.enum(DRIVER_CAPABILITY_STATES),
  })
  .strict();
export type DriverDescriptor = z.infer<typeof driverDescriptorSchema>;

/** Public health: no paths, accounts, models or fingerprints. */
export const healthResponseSchema = z
  .object({
    apiVersion: z.literal("v1"),
    hostInstanceId: z.string().min(1),
    node: z.object({ version: z.string(), major: z.number().int() }).strict(),
    drivers: z.array(driverDescriptorSchema),
  })
  .strict();
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ---------------------------------------------------------------------------
// Installations (session-authenticated)
// ---------------------------------------------------------------------------

export const installationComponentSchema = z
  .object({
    role: z.enum(["wrapper", "claude-binary", "cfuse-binary"]),
    path: z.string().min(1),
    fingerprint: z.string().min(1),
  })
  .strict();
export type InstallationComponent = z.infer<typeof installationComponentSchema>;

export const installationDtoSchema = z
  .object({
    installationId: z.string().min(1),
    driverId: z.enum(DRIVER_IDS),
    state: z.enum(INSTALLATION_STATES),
    executablePath: z.string().nullable(),
    fingerprint: z.string().nullable(),
    components: z.array(installationComponentSchema),
    detail: z.string().max(1024).nullable(),
  })
  .strict();
export type InstallationDto = z.infer<typeof installationDtoSchema>;

export const installationsResponseSchema = z
  .object({ installations: z.array(installationDtoSchema) })
  .strict();
export type InstallationsResponse = z.infer<typeof installationsResponseSchema>;

// ---------------------------------------------------------------------------
// Model catalog (session-authenticated)
// ---------------------------------------------------------------------------

/** Closed canonical model catalog reported by a live Driver handshake. The
 * catalog is model-agnostic: it never carries accounts, paths or secrets.
 * `cachedAt` is the ISO timestamp the entry was cached at (every response
 * carries it — fresh or cache hit — so the UI needs no branch). */
export const modelCatalogResponseSchema = z
  .object({ catalog: z.array(z.string()), cachedAt: z.string().min(1) })
  .strict();
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;

// ---------------------------------------------------------------------------
// Execution Profiles
// ---------------------------------------------------------------------------

export const claudeRouteSchema = z.enum(["ant-glm5.2", "moonshot", "deepseek", "cfuse"]);
export type ClaudeRoute = z.infer<typeof claudeRouteSchema>;

export const claudeStreamJsonOptionsSchema = z.object({ route: claudeRouteSchema }).strict();
export type ClaudeStreamJsonOptions = z.infer<typeof claudeStreamJsonOptionsSchema>;

export const codexAppServerOptionsSchema = z
  .object({ reasoningEffort: z.string().min(1).max(64).optional() })
  .strict();
export type CodexAppServerOptions = z.infer<typeof codexAppServerOptionsSchema>;

/**
 * `kimi-stream-json` options: the Kimi model is selected by the Agent's
 * `modelId` against the closed K3 catalog — the Profile carries no model,
 * route, argv or token fields (strict empty object).
 */
export const kimiStreamJsonOptionsSchema = z.object({}).strict();
export type KimiStreamJsonOptions = z.infer<typeof kimiStreamJsonOptionsSchema>;

/**
 * `grok-stream-json` options: model is the Agent's `modelId` against the
 * closed grok catalog. Profile carries no model, argv or token fields.
 */
export const grokStreamJsonOptionsSchema = z.object({}).strict();
export type GrokStreamJsonOptions = z.infer<typeof grokStreamJsonOptionsSchema>;

/** Typed Execution Profile DTO. Strict by construction: no executable, argv,
 * shell, raw env or token fields can pass validation. */
export const executionProfileSchema = z.discriminatedUnion("driverId", [
  z
    .object({
      driverId: z.literal("claude-stream-json"),
      installationId: z.string().min(1),
      credentialMode: z.literal(CREDENTIAL_MODE),
      options: claudeStreamJsonOptionsSchema,
    })
    .strict(),
  z
    .object({
      driverId: z.literal("codex-app-server"),
      installationId: z.string().min(1),
      credentialMode: z.literal(CREDENTIAL_MODE),
      options: codexAppServerOptionsSchema,
    })
    .strict(),
  z
    .object({
      driverId: z.literal("kimi-stream-json"),
      installationId: z.string().min(1),
      credentialMode: z.literal(CREDENTIAL_MODE),
      options: kimiStreamJsonOptionsSchema,
    })
    .strict(),
  z
    .object({
      driverId: z.literal("grok-stream-json"),
      installationId: z.string().min(1),
      credentialMode: z.literal(CREDENTIAL_MODE),
      options: grokStreamJsonOptionsSchema,
    })
    .strict(),
]);
export type ExecutionProfileDto = z.infer<typeof executionProfileSchema>;

export const profileReadinessSchema = z
  .object({
    state: z.enum(PROFILE_READINESS_STATES),
    detail: z.string().max(1024).nullable(),
  })
  .strict();
export type ProfileReadiness = z.infer<typeof profileReadinessSchema>;

// ---------------------------------------------------------------------------
// Resolved binding: the Host's trusted execution configuration
// ---------------------------------------------------------------------------

export const resolvedBindingSchema = z
  .object({
    bindingDigest: z.string().min(1),
    driverId: z.enum(DRIVER_IDS),
    installationId: z.string().min(1),
    installationFingerprint: z.string().min(1),
    capabilityDigest: z.string().min(1),
    requestedModel: z.string().min(1),
    canonicalModelId: z.string().min(1),
    modelAliases: z.array(z.string()),
    route: claudeRouteSchema.optional(),
    reasoningEffort: z.string().optional(),
  })
  .strict();
export type ResolvedBinding = z.infer<typeof resolvedBindingSchema>;

export const resolveProfileRequestSchema = z
  .object({
    profile: executionProfileSchema,
    modelId: z.string().min(1).max(256),
  })
  .strict();
export type ResolveProfileRequest = z.infer<typeof resolveProfileRequestSchema>;

export const resolveProfileResponseSchema = z
  .object({
    readiness: profileReadinessSchema,
    binding: resolvedBindingSchema.nullable(),
    /** ISO timestamp the cached entry was stamped at; present on every
     * response (fresh handshake = the moment, cache hit = the original cache
     * time), so the UI can render "checked Xs ago" without a branch. */
    cachedAt: z.string().min(1),
    /** Present on failure results: ms remaining until the backoff window ends.
     * A fresh failure carries the full window length (2s/10s/30s by consecutive
     * failure count); a cache hit inside the window carries the remaining ms.
     * Absent on successes. */
    retryAfterMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ResolveProfileResponse = z.infer<typeof resolveProfileResponseSchema>;

// ---------------------------------------------------------------------------
// Context Snapshot
// ---------------------------------------------------------------------------

export const snapshotItemSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(["user", "participant", "summary"]),
    participantId: z.string().optional(),
    content: z.string(),
    sourceExecutionId: z.string().optional(),
  })
  .strict();
export type SnapshotItem = z.infer<typeof snapshotItemSchema>;

export const contextSnapshotSchema = z
  .object({
    digestVersion: z.literal(1),
    roomContext: z
      .object({
        contextRevision: z.number().int().nonnegative(),
        contextDigest: z.string().min(1),
        topic: z.string().optional(),
        items: z.array(snapshotItemSchema),
      })
      .strict(),
    participant: z
      .object({
        participantId: z.string().min(1),
        participantSnapshotDigest: z.string().min(1),
        personaPrompt: z.string().optional(),
      })
      .strict(),
    instruction: z
      .object({
        kind: z.enum(["message", "summary"]),
        instructionDigest: z.string().min(1),
        text: z.string(),
      })
      .strict(),
  })
  .strict();
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;

// ---------------------------------------------------------------------------
// Scopes / participants / executions
// ---------------------------------------------------------------------------

const controllerFields = {
  controllerId: z.string().min(1),
  leaseEpoch: z.number().int().positive(),
} as const;

export const participantSpecSchema = z
  .object({
    participantId: z.string().min(1).max(128),
    profile: executionProfileSchema,
    modelId: z.string().min(1).max(256),
    personaPrompt: z
      .string()
      .max(64 * 1024)
      .optional(),
  })
  .strict();
export type ParticipantSpec = z.infer<typeof participantSpecSchema>;

export const createScopeRequestSchema = z
  .object({
    scopeRequestId: z.string().min(8).max(128),
    participants: z.array(participantSpecSchema).min(1).max(QUOTAS.maxParticipantsPerScope),
  })
  .strict();
export type CreateScopeRequest = z.infer<typeof createScopeRequestSchema>;

export const participantStatusSchema = z
  .object({
    participantId: z.string(),
    runtime: z.enum(PARTICIPANT_RUNTIME_STATES),
    binding: resolvedBindingSchema.nullable(),
    readiness: profileReadinessSchema.nullable(),
  })
  .strict();
export type ParticipantStatus = z.infer<typeof participantStatusSchema>;

export const scopeStatusSchema = z
  .object({
    scopeId: z.string(),
    state: z.enum(SCOPE_STATES),
    hostInstanceId: z.string(),
    leaseEpoch: z.number().int().positive(),
    participants: z.array(participantStatusSchema),
  })
  .strict();
export type ScopeStatus = z.infer<typeof scopeStatusSchema>;

export const createScopeResponseSchema = z
  .object({
    scopeId: z.string().min(1),
    controllerId: z.string().min(1),
    leaseEpoch: z.number().int().positive(),
    scope: scopeStatusSchema,
  })
  .strict();
export type CreateScopeResponse = z.infer<typeof createScopeResponseSchema>;

export const takeoverControllerRequestSchema = z
  .object({ controllerId: z.string().min(1).max(128) })
  .strict();
export type TakeoverControllerRequest = z.infer<typeof takeoverControllerRequestSchema>;

export const takeoverControllerResponseSchema = z
  .object({
    scopeId: z.string(),
    controllerId: z.string(),
    leaseEpoch: z.number().int().positive(),
  })
  .strict();
export type TakeoverControllerResponse = z.infer<typeof takeoverControllerResponseSchema>;

export const executeRequestSchema = z
  .object({
    ...controllerFields,
    executionId: z.string().min(8).max(128),
    participantId: z.string().min(1).max(128),
    snapshot: contextSnapshotSchema,
  })
  .strict();
export type ExecuteRequest = z.infer<typeof executeRequestSchema>;

export const executionStatusSchema = z
  .object({
    executionId: z.string(),
    participantId: z.string(),
    state: z.enum(EXECUTION_STATES),
    lastSeq: z.number().int().nonnegative(),
  })
  .strict();
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const executeResponseSchema = z.object({ execution: executionStatusSchema }).strict();
export type ExecuteResponse = z.infer<typeof executeResponseSchema>;

export const ackRequestSchema = z
  .object({
    ...controllerFields,
    finalSeq: z.number().int().positive(),
    disposition: z.enum(ACK_DISPOSITIONS),
  })
  .strict();
export type AckRequest = z.infer<typeof ackRequestSchema>;

export const ackResponseSchema = z
  .object({
    executionId: z.string(),
    ackState: z.enum(ACK_STATES),
    disposition: z.enum(ACK_DISPOSITIONS).nullable(),
  })
  .strict();
export type AckResponse = z.infer<typeof ackResponseSchema>;

export const controllerRequestSchema = z.object({ ...controllerFields }).strict();
export type ControllerRequest = z.infer<typeof controllerRequestSchema>;

export const closeScopeResponseSchema = z
  .object({ scopeId: z.string(), state: z.enum(SCOPE_STATES) })
  .strict();
export type CloseScopeResponse = z.infer<typeof closeScopeResponseSchema>;

// ---------------------------------------------------------------------------
// Diagnostics export (session-authenticated, S6)
// ---------------------------------------------------------------------------

/** One sanitized warn/error line from the Host problems ring. `context` stays
 * free-form (already sanitizeValue-capped at write time); the rest is fixed
 * vocabulary. */
export const diagnosticLogRecordSchema = z
  .object({
    at: z.string().min(1),
    level: z.enum(["warn", "error"]),
    event: z.string().min(1),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type DiagnosticLogRecord = z.infer<typeof diagnosticLogRecordSchema>;

/** Same-machine operator bundle, sanitized by construction: never carries
 * prompts, model output, tokens, cookies, secrets or env dumps, and Host
 * config paths (distDir/watchdogProgram/driverWorkRoot) stay out — only
 * installations keep realpaths (Q10: required for same-machine
 * self-diagnosis, documented in README). */
export const diagnosticsResponseSchema = z
  .object({
    generatedAt: z.string().min(1),
    health: healthResponseSchema,
    config: z
      .object({
        mode: z.enum(["development", "production"]),
        port: z.number().int().positive(),
        node: z.object({ version: z.string(), major: z.number().int() }).strict(),
        startedAt: z.string().min(1),
        uptimeMs: z.number().int().nonnegative(),
      })
      .strict(),
    installations: z.array(installationDtoSchema),
    scopes: z
      .object({
        activeScopes: z.number().int().nonnegative(),
        liveDriverProcesses: z.number().int().nonnegative(),
        runningExecutions: z.number().int().nonnegative(),
        eventConnections: z.number().int().nonnegative(),
      })
      .strict(),
    logs: z.object({ recent: z.array(diagnosticLogRecordSchema) }).strict(),
  })
  .strict();
export type DiagnosticsResponse = z.infer<typeof diagnosticsResponseSchema>;

// ---------------------------------------------------------------------------
// CLI runs (session-authenticated read of ~/.config/councilkit/runs)
// ---------------------------------------------------------------------------

export const cliRunKindSchema = z.enum(["review", "discuss", "unknown"]);
export const cliRunStatusSchema = z.enum([
  "completed",
  "failed",
  "interrupted",
  "running",
  "unknown",
]);

export const cliRunAttemptProgressSchema = z
  .object({
    attemptId: z.string().min(1),
    agentName: z.string().min(1),
    driverId: z.string().min(1),
    modelId: z.string().min(1),
    role: z.enum(["attempt", "aggregator"]),
    status: z.enum(["pending", "queued", "running", "success", "failure"]),
    durationMs: z.number().int().nonnegative().nullable(),
    lastActivity: z.string().max(240).nullable().optional(),
  })
  .strict();

export const cliRunProgressSchema = z
  .object({
    phase: z.enum([
      "attempts",
      "aggregating",
      "done",
      "planning",
      "plan-review",
      "plan-aggregating",
      "applying",
      "re-reviewing",
    ]),
    attempts: z.array(cliRunAttemptProgressSchema),
    updatedAt: z.string().nullable(),
  })
  .strict();

export const cliRunPipelineSchema = z
  .object({
    phase: z.enum([
      "planning",
      "plan-review",
      "plan-aggregating",
      "applying",
      "re-reviewing",
      "done",
    ]),
    round: z.number().int().nonnegative(),
    maxRounds: z.number().int().positive(),
    planVerdict: z.enum(["approve", "changes-requested", "comment"]).nullable(),
    applyStatus: z.enum(["pending", "running", "success", "failure", "skipped"]).nullable(),
    followUpRunId: z.string().min(1).nullable(),
    summary: z.string().nullable(),
    updatedAt: z.string().min(1),
  })
  .strict();

export const cliRunSummarySchema = z
  .object({
    runId: z.string().min(1),
    kind: cliRunKindSchema,
    status: cliRunStatusSchema,
    title: z.string(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    hasReport: z.boolean(),
    hasPlan: z.boolean().default(false),
    hasFindings: z.boolean().default(false),
    hasPlanLock: z.boolean().default(false),
    reportUrl: z.string().min(1),
    progress: cliRunProgressSchema.nullable(),
    pipeline: cliRunPipelineSchema.nullable().default(null),
  })
  .strict();
export type CliRunSummaryDto = z.infer<typeof cliRunSummarySchema>;
export type CliRunStatusDto = z.infer<typeof cliRunStatusSchema>;
export type CliRunPipelineDto = z.infer<typeof cliRunPipelineSchema>;

export const cliRunsListResponseSchema = z.object({ runs: z.array(cliRunSummarySchema) }).strict();
export type CliRunsListResponse = z.infer<typeof cliRunsListResponseSchema>;

export const cliRunDetailResponseSchema = cliRunSummarySchema.extend({
  markdown: z.string(),
  truncated: z.boolean(),
  planMarkdown: z.string().default(""),
  planTruncated: z.boolean().default(false),
  findings: z.array(ledgerFindingSchema).default([]),
  planLock: planLockFileSchema.nullable().default(null),
  landings: z.array(landingRecordSchema).default([]),
});
export type CliRunDetailResponse = z.infer<typeof cliRunDetailResponseSchema>;

export const cliRunActionRequestSchema = z
  .object({
    action: z.enum(["fix", "re-review"]),
  })
  .strict();
export type CliRunActionRequest = z.infer<typeof cliRunActionRequestSchema>;

export const cliRunActionResponseSchema = z
  .object({
    action: z.enum(["fix", "re-review"]),
    runId: z.string().min(1),
    started: z.literal(true),
  })
  .strict();
export type CliRunActionResponse = z.infer<typeof cliRunActionResponseSchema>;

// Re-export for handler convenience.
export { LIMITS, usageSchema };
