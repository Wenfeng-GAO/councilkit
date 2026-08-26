import { QUOTAS } from "@shared/runtime/contracts";
import type { SnapshotItem } from "@shared/runtime/schemas";
import {
  claudeStreamJsonOptionsSchema,
  codexAppServerOptionsSchema,
  cursorStreamJsonOptionsSchema,
  type executionProfileSchema,
  grokStreamJsonOptionsSchema,
  kimiStreamJsonOptionsSchema,
} from "@shared/runtime/schemas";
/**
 * CLI store schemas (brief §2b, plan-a §3). Reuses the shared per-driver option
 * schemas so a CLI Driver Selection can never drift from the Host's wire
 * contract, but drops `installationId`/`credentialMode` — the CLI resolves the
 * installation dynamically each run and never persists it.
 *
 * All file-level and record-level objects are `.strict()`: unknown fields
 * (including executable/argv/shell/env/token injection) fail validation. Every
 * file carries `format` + `version` for forward migration.
 */
import { z } from "zod";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// ---------------------------------------------------------------------------
// Driver Selection (agent binding basis; replaces executionProfileId)
// ---------------------------------------------------------------------------

/** Reuses the shared per-driver options schemas — same closed vocabulary the
 * Host validates on the wire. `installationId`/`credentialMode` are NOT here:
 * the CLI resolves a trusted installation per run and never persists it. */
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

// ---------------------------------------------------------------------------
// agents.json
// ---------------------------------------------------------------------------

export const AGENTS_FORMAT = "councilkit-agents" as const;
export const AGENTS_VERSION = 1 as const;

export const agentRecordSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    personaPrompt: z
      .string()
      .min(1)
      .max(64 * 1024),
    modelId: z.string().min(1).max(256),
    color: z.string().regex(HEX_COLOR),
    enabled: z.boolean(),
    driverSelection: driverSelectionSchema,
  })
  .strict();
export type AgentRecord = z.infer<typeof agentRecordSchema>;

export const agentsFileSchema = z
  .object({
    format: z.literal(AGENTS_FORMAT),
    version: z.literal(AGENTS_VERSION),
    agents: z.array(agentRecordSchema),
  })
  .strict();
export type AgentsFile = z.infer<typeof agentsFileSchema>;

// ---------------------------------------------------------------------------
// councils.json
// ---------------------------------------------------------------------------

export const COUNCILS_FORMAT = "councilkit-councils" as const;
export const COUNCILS_VERSION = 1 as const;

export const councilRecordSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    topic: z
      .string()
      .min(1)
      .max(64 * 1024),
    background: z
      .string()
      .max(64 * 1024)
      .default(""),
    targetOutput: z
      .string()
      .max(64 * 1024)
      .default(""),
    agentIds: z.array(z.string().min(1).max(128)).min(1).max(QUOTAS.maxParticipantsPerScope),
    rounds: z.number().int().positive().max(16),
    reporterAgentId: z.string().min(1).max(128),
  })
  .strict();
export type CouncilRecord = z.infer<typeof councilRecordSchema>;

export const councilsFileSchema = z
  .object({
    format: z.literal(COUNCILS_FORMAT),
    version: z.literal(COUNCILS_VERSION),
    councils: z.array(councilRecordSchema),
  })
  .strict();
export type CouncilsFile = z.infer<typeof councilsFileSchema>;

// ---------------------------------------------------------------------------
// transcript.jsonl (one JSON document per line; tagged union by `kind`)
// ---------------------------------------------------------------------------

export const TRANSCRIPT_VERSION = 1 as const;

/** Snapshot of an agent captured at run start (so the transcript is self-
 * describing even if the agent is later edited). */
export const agentSnapshotSchema = agentRecordSchema;
export type AgentSnapshot = z.infer<typeof agentSnapshotSchema>;

/** The shared ExecutionProfileDto the CLI constructs per agent from its Driver
 * Selection + the dynamically resolved installationId. Persisted in the
 * transcript (it carries no secret — it is the same shape the Host consumes). */
export type ResolvedProfile = z.infer<typeof executionProfileSchema>;

export const runStartedRecordSchema = z
  .object({
    kind: z.literal("run.started"),
    version: z.literal(TRANSCRIPT_VERSION),
    runId: z.string().min(1),
    startedAt: z.string().min(1),
    council: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        topic: z.string(),
        background: z.string(),
        targetOutput: z.string(),
        rounds: z.number().int().positive(),
        reporterAgentId: z.string().min(1),
        agentIds: z.array(z.string().min(1)),
      })
      .strict(),
    agents: z.array(agentSnapshotSchema),
    /** Representative (primary) installationId for the run — the first
     * participant's. Kept for back-compat with the singular brief §2d field. */
    installationId: z.string().min(1),
    /** Slice-2 additive: per-agent resolved installationId (agentId →
     * installationId), so a multi-driver run (e.g. cfuse + kimi) is fully
     * self-describing in the transcript. installationId is still never persisted
     * in agents.json/councils.json — only here, per run. */
    installations: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();
export type RunStartedRecord = z.infer<typeof runStartedRecordSchema>;

export const turnCompletedRecordSchema = z
  .object({
    kind: z.literal("turn.completed"),
    seq: z.number().int().nonnegative(),
    completedAt: z.string().min(1),
    round: z.number().int().positive(),
    turnIndex: z.number().int().nonnegative(),
    /** "message" for ordinary turns, "report" for the Reporter turn. */
    role: z.enum(["message", "report"]),
    agentId: z.string().min(1),
    agentName: z.string().min(1),
    participantId: z.string().min(1),
    executionId: z.string().min(1),
    output: z.string(),
    requestedModel: z.string().min(1),
    effectiveModel: z.string().nullable(),
    modelVerdict: z.enum(["match", "mismatch", "unknown"]),
    toolState: z.enum(["none", "active", "completed", "unknown"]),
    durationMs: z.number().int().nonnegative(),
    usage: z
      .object({
        inputTokens: z.number().nullable().optional(),
        outputTokens: z.number().nullable().optional(),
        costUsd: z.number().nullable().optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type TurnCompletedRecord = z.infer<typeof turnCompletedRecordSchema>;

export const runFinishedRecordSchema = z
  .object({
    kind: z.literal("run.finished"),
    status: z.enum(["completed", "failed", "interrupted"]),
    endedAt: z.string().min(1),
    /** Structured failure phase/cause for failed/interrupted; absent on success. */
    failure: z
      .object({
        phase: z.string().min(1),
        code: z.string().min(1),
        message: z.string(),
      })
      .strict()
      .optional(),
    reportPath: z.string().optional(),
    incomplete: z.boolean().optional(),
  })
  .strict();
export type RunFinishedRecord = z.infer<typeof runFinishedRecordSchema>;

export const transcriptRecordSchema = z.discriminatedUnion("kind", [
  runStartedRecordSchema,
  turnCompletedRecordSchema,
  runFinishedRecordSchema,
]);
export type TranscriptRecord = z.infer<typeof transcriptRecordSchema>;

// Re-export shared types used by turn records / orchestrator.
export type { SnapshotItem };
