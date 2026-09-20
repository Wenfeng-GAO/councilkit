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
import { findingGroupsFileSchema } from "./finding-groups";
import { reviewEvidenceSchema } from "./review-case";

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

/**
 * `cursor-stream-json` options: model is the Agent's `modelId` against the
 * live `cursor-agent models` catalog. `auto` means omit `--model` and use
 * Cursor's account default. Profile carries no model, argv or token fields.
 */
export const cursorStreamJsonOptionsSchema = z.object({}).strict();
export type CursorStreamJsonOptions = z.infer<typeof cursorStreamJsonOptionsSchema>;

export const driverSelectionSchema = z.discriminatedUnion("driverId", [
  z
    .object({ driverId: z.literal("claude-stream-json"), options: claudeStreamJsonOptionsSchema })
    .strict(),
  z
    .object({ driverId: z.literal("codex-app-server"), options: codexAppServerOptionsSchema })
    .strict(),
  z
    .object({ driverId: z.literal("kimi-stream-json"), options: kimiStreamJsonOptionsSchema })
    .strict(),
  z
    .object({ driverId: z.literal("grok-stream-json"), options: grokStreamJsonOptionsSchema })
    .strict(),
  z
    .object({ driverId: z.literal("cursor-stream-json"), options: cursorStreamJsonOptionsSchema })
    .strict(),
]);
export type DriverSelection = z.infer<typeof driverSelectionSchema>;

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
  z
    .object({
      driverId: z.literal("cursor-stream-json"),
      installationId: z.string().min(1),
      credentialMode: z.literal(CREDENTIAL_MODE),
      options: cursorStreamJsonOptionsSchema,
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

export const diagnosticEntrySchema = z
  .object({
    diagnosticId: z.string().min(1),
    at: z.string().min(1),
    kind: z.string().min(1),
    message: z.string().min(1),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type DiagnosticEntryDto = z.infer<typeof diagnosticEntrySchema>;

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
    logs: z
      .object({
        recent: z.array(diagnosticLogRecordSchema),
        diagnostics: z.array(diagnosticEntrySchema),
      })
      .strict(),
  })
  .strict();
export type DiagnosticsResponse = z.infer<typeof diagnosticsResponseSchema>;

// ---------------------------------------------------------------------------
// CLI runs (session-authenticated read of ~/.config/councilkit/runs)
// ---------------------------------------------------------------------------

export const cliRunKindSchema = z.enum([
  "review",
  "discuss",
  "squad",
  "ideate",
  "repair",
  "unknown",
]);
export const cliRunStatusSchema = z.enum([
  "completed",
  "failed",
  "interrupted",
  "running",
  "unknown",
  "awaiting_orchestrator",
  "closed",
]);

/** Read-only squad observe projection. Extra keys are stripped; omit missing fields. */
export const cliRunHandoffSchema = z.object({
  epoch: z.number().int().nonnegative().optional(),
  candidateSha: z.string().min(1).max(64).optional(),
  candidateStatus: z.enum(["intended", "completed", "invalidated"]).optional(),
  invalidatedReason: z.string().min(1).max(2000).optional(),
  taskBaseSha: z.string().min(1).max(64).optional(),
  parentCandidateSha: z.string().min(1).max(64).optional(),
  currentFix: z
    .union([
      z.string().min(1).max(240),
      z
        .object({
          round: z.number().int().nonnegative().optional(),
          operationId: z.string().min(1).max(200).optional(),
        })
        .strict(),
    ])
    .optional(),
  next: z.string().min(1).max(2000).optional(),
  approved: z.boolean().optional(),
  reviewerVerdict: z.string().min(1).max(500).optional(),
  verifierVerdict: z.string().min(1).max(500).optional(),
  remainingBlockers: z.array(z.string().min(1).max(500)).max(32).optional(),
  reviewRunId: z.string().min(1).max(80).optional(),
  seatNotes: z
    .array(
      z
        .object({
          attemptId: z.string().min(1).max(80),
          purpose: z.string().min(1).max(200).optional(),
          note: z.string().min(1).max(500).optional(),
        })
        .strict(),
    )
    .max(32)
    .optional(),
});
export type CliRunHandoffDto = z.infer<typeof cliRunHandoffSchema>;

export const cliRunAttemptResultSchema = z
  .object({
    parseStatus: z.enum(["parsed", "unparsed", "empty"]),
    summary: z.string().max(240).nullable(),
    findingCount: z.number().int().nonnegative().nullable(),
    blockingCount: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const cliRunAttemptProgressSchema = z
  .object({
    attemptId: z.string().min(1),
    agentName: z.string().min(1),
    driverId: z.string().min(1),
    modelId: z.string().min(1),
    role: z.enum(["attempt", "aggregator"]),
    status: z.enum(["pending", "queued", "running", "success", "failure", "cancelled"]),
    durationMs: z.number().int().nonnegative().nullable(),
    lastActivity: z.string().max(240).nullable().optional(),
    lastTokenAt: z.string().max(40).nullable().optional(),
    lastToolAt: z.string().max(40).nullable().optional(),
    lastArtifactAt: z.string().max(40).nullable().optional(),
    activitySpanMs: z.number().int().nonnegative().nullable().optional(),
    requestedModelId: z.string().max(200).nullable().optional(),
    observedModelId: z.string().max(200).nullable().optional(),
    result: cliRunAttemptResultSchema.optional(),
  })
  .strict();

export const cliRunProgressSchema = z
  .object({
    phase: z.enum([
      "preflight",
      "attempts",
      "aggregating",
      "done",
      "planning",
      "plan-review",
      "plan-aggregating",
      "applying",
      "re-reviewing",
      "briefing",
      "implementing",
      "reviewing",
      "auditing",
      "snapshotting",
      "fixing",
      "integrating",
      "proposing",
      "debating",
      "repair-preparing",
      "repair-squad-repair",
      "repair-squad-verify",
      "repair-publishing",
      "repair-reviewing",
      "repair-diagnosing",
      "repair-finalizing",
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

export const ideateIntegritySchema = z
  .object({
    plannedProposals: z.number().int().nonnegative(),
    successfulProposals: z.number().int().nonnegative(),
    plannedDebates: z.number().int().nonnegative(),
    successfulDebates: z.number().int().nonnegative(),
    configuredModels: z.number().int().nonnegative(),
    successfulModels: z.number().int().nonnegative(),
    incomplete: z.boolean(),
    degradedReasons: z.array(z.string()),
    contextTruncated: z.boolean(),
    failedSeats: z.array(
      z
        .object({
          stage: z.enum(["proposal", "debate", "aggregate"]),
          attemptId: z.string().min(1),
          agentName: z.string().min(1),
          code: z.string().min(1),
          message: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type IdeateIntegrityDto = z.infer<typeof ideateIntegritySchema>;

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
    reviewEvidence: reviewEvidenceSchema.nullable().optional(),
    ideateIntegrity: ideateIntegritySchema.nullable().optional(),
    hasPlanLock: z.boolean().default(false),
    reportUrl: z.string().min(1),
    progress: cliRunProgressSchema.nullable(),
    pipeline: cliRunPipelineSchema.nullable().default(null),
    handoff: cliRunHandoffSchema.nullable().default(null),
    businessResult: z.enum(["approved", "needs_attention", "stopped"]).nullable().optional(),
    reasonCode: z.string().min(1).max(80).nullable().optional(),
    sourceRunId: z.string().min(1).max(80).nullable().optional(),
  })
  .strict();
export type CliRunSummaryDto = z.infer<typeof cliRunSummarySchema>;
export type CliRunStatusDto = z.infer<typeof cliRunStatusSchema>;
export type CliRunPipelineDto = z.infer<typeof cliRunPipelineSchema>;

export const cliRunsListResponseSchema = z.object({ runs: z.array(cliRunSummarySchema) }).strict();
export type CliRunsListResponse = z.infer<typeof cliRunsListResponseSchema>;

/** Squad observe copies of brief/plan/reviews/final. Extra keys stripped. */
export const cliRunDocumentSchema = z
  .object({
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(80),
    markdown: z.string(),
    truncated: z.boolean(),
  })
  .strict();
export type CliRunDocumentDto = z.infer<typeof cliRunDocumentSchema>;

export const cliRunDetailResponseSchema = cliRunSummarySchema.extend({
  markdown: z.string(),
  truncated: z.boolean(),
  planMarkdown: z.string().default(""),
  planTruncated: z.boolean().default(false),
  findings: z.array(ledgerFindingSchema).default([]),
  planLock: planLockFileSchema.nullable().default(null),
  landings: z.array(landingRecordSchema).default([]),
  documents: z.array(cliRunDocumentSchema).default([]),
  findingGroups: findingGroupsFileSchema.nullable().optional(),
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

/** A per-run roster. No persisted Agent, executable, credentials or raw argv. */
export const reviewModelSchema = z
  .object({
    driverSelection: driverSelectionSchema,
    modelId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .refine((value) => !value.startsWith("-")),
  })
  .strict();
export type ReviewModel = z.infer<typeof reviewModelSchema>;
export const reviewModelsSchema = z
  .object({
    models: z.array(reviewModelSchema).min(1).max(QUOTAS.maxParticipantsPerScope),
    aggregatorIndex: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.aggregatorIndex >= value.models.length) {
      ctx.addIssue({
        code: "custom",
        path: ["aggregatorIndex"],
        message: "Aggregator must be a selected model",
      });
    }
    const keys = value.models.map((model) =>
      JSON.stringify([
        model.driverSelection.driverId,
        model.driverSelection.options,
        model.modelId,
      ]),
    );
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", path: ["models"], message: "Duplicate review model" });
    }
  });
export type ReviewModels = z.infer<typeof reviewModelsSchema>;

/** Same seat shape as review models, but duplicate configs are allowed (单模型多角色). */
export const ideateModelsSchema = z
  .object({
    models: z.array(reviewModelSchema).min(2).max(QUOTAS.maxParticipantsPerScope),
    aggregatorIndex: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.aggregatorIndex >= value.models.length) {
      ctx.addIssue({
        code: "custom",
        path: ["aggregatorIndex"],
        message: "Reporter must be a selected model",
      });
    }
  });
export type IdeateModels = z.infer<typeof ideateModelsSchema>;

export const cliRunStartIdeateRequestSchema = z
  .object({
    idea: z.string().min(1),
    background: z.string().optional(),
    debateRounds: z.number().int().min(0).max(2).optional(),
    models: ideateModelsSchema.optional(),
  })
  .strict();
export type CliRunStartIdeateRequest = z.infer<typeof cliRunStartIdeateRequestSchema>;

export const cliRunStartReviewRequestSchema = z
  .object({
    pr: z.string().min(1),
    repo: z.string().min(1).optional(),
    against: z
      .string()
      .regex(/^ck-review-[0-9a-fA-F-]+$/, "against must be a ck-review run id")
      .optional(),
    reviewModels: reviewModelsSchema.optional(),
  })
  .strict();
export type CliRunStartReviewRequest = z.infer<typeof cliRunStartReviewRequestSchema>;

export const cliRunStartReviewResponseSchema = z
  .object({
    runId: z.string().min(1),
    started: z.literal(true),
  })
  .strict();
export type CliRunStartReviewResponse = z.infer<typeof cliRunStartReviewResponseSchema>;

export const cliRunStartRepairRequestSchema = z
  .object({
    from: z.string().regex(/^ck-review-[0-9a-fA-F-]+$/, "from must be a ck-review run id"),
    profile: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "profile must be a closed token, not a path"),
  })
  .strict();
export type CliRunStartRepairRequest = z.infer<typeof cliRunStartRepairRequestSchema>;

export const cliRunRepairControlRequestSchema = z.object({}).strict();
export type CliRunRepairControlRequest = z.infer<typeof cliRunRepairControlRequestSchema>;

export const cliRunRepairStopResponseSchema = z
  .object({
    runId: z.string().min(1),
    stopped: z.literal(true),
  })
  .strict();
export type CliRunRepairStopResponse = z.infer<typeof cliRunRepairStopResponseSchema>;

export const cliRunSaveRepairProfileRequestSchema = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "profile must be a closed token, not a path"),
    prUrl: z.string().min(1).max(500),
    repo: z.string().min(1).max(400),
    sourceBranch: z.string().min(1).max(200),
    base: z.string().min(1).max(200),
    capabilities: z.array(z.literal("push-source-branch")).min(1).max(8),
  })
  .strict();
export type CliRunSaveRepairProfileRequest = z.infer<typeof cliRunSaveRepairProfileRequestSchema>;

export const repairProfileSummarySchema = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "profile must be a closed token, not a path"),
    prUrl: z.string().min(1).max(500),
    sourceBranch: z.string().min(1).max(200),
    base: z.string().min(1).max(200),
  })
  .strict();
export type RepairProfileSummaryDto = z.infer<typeof repairProfileSummarySchema>;

export const cliRunListRepairProfilesResponseSchema = z
  .object({
    profiles: z.array(repairProfileSummarySchema).max(64),
    sourceBranchHint: z.string().max(200).nullable(),
    baseHint: z.string().max(200).nullable(),
  })
  .strict();
export type CliRunListRepairProfilesResponse = z.infer<
  typeof cliRunListRepairProfilesResponseSchema
>;
export const cliRunSaveRepairProfileResponseSchema = repairProfileSummarySchema;
export type CliRunSaveRepairProfileResponse = RepairProfileSummaryDto;

const attemptLiveEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      seq: z.number().int().nonnegative(),
      at: z.string().min(1),
      type: z.literal("text.delta"),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      seq: z.number().int().nonnegative(),
      at: z.string().min(1),
      type: z.literal("thinking.delta"),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      seq: z.number().int().nonnegative(),
      at: z.string().min(1),
      type: z.literal("tool.started"),
      name: z.string().min(1),
      summary: z.string().max(240),
    })
    .strict(),
  z
    .object({
      seq: z.number().int().nonnegative(),
      at: z.string().min(1),
      type: z.literal("tool.completed"),
      name: z.string().min(1),
      summary: z.string().max(240),
    })
    .strict(),
  z
    .object({
      seq: z.number().int().nonnegative(),
      at: z.string().min(1),
      type: z.literal("truncated"),
      dropped: z.number().int().nonnegative(),
    })
    .strict(),
]);

export const cliRunAttemptLiveResponseSchema = z
  .object({
    events: z.array(attemptLiveEventSchema),
    nextSeq: z.number().int().nonnegative(),
    done: z.boolean(),
  })
  .strict();
export type CliRunAttemptLiveResponse = z.infer<typeof cliRunAttemptLiveResponseSchema>;

// Re-export for handler convenience.
export { LIMITS, usageSchema };
