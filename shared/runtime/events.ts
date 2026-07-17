/**
 * Normalized Model Execution event model.
 *
 * Every execution produces an ordered event stream with a strictly increasing
 * `seq` starting at 1. Known events are strictly validated; unknown raw driver
 * notifications never enter this stream — they go to structured diagnostics.
 * Terminal events always carry the full normalized output (completed) or a
 * structured failure (failed/interrupted).
 */
import { z } from "zod";
import { DISPATCH_STATES, TOOL_STATES } from "./contracts";
import { runtimeErrorSchema } from "./errors";

export const usageSchema = z
  .object({
    inputTokens: z.number().nonnegative().nullable().optional(),
    outputTokens: z.number().nonnegative().nullable().optional(),
    costUsd: z.number().nonnegative().nullable().optional(),
  })
  .strict();
export type Usage = z.infer<typeof usageSchema>;

const eventBase = {
  executionId: z.string().min(1),
  seq: z.number().int().positive(),
  at: z.string().min(1),
};

export const startedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("started"),
    requestedModel: z.string().min(1),
  })
  .strict();

export const outputDeltaEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("output.delta"),
    text: z.string(),
  })
  .strict();

/** Coalesced preview once early deltas had to be merged under the cache cap. */
export const outputSnapshotEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("output.snapshot"),
    text: z.string(),
  })
  .strict();

/** Non-text driver activity (tools/commands). Sanitized metadata only — never
 * raw arguments, output, paths or secrets. */
export const activityEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("activity"),
    kind: z.enum(["tool", "command", "other"]),
    summary: z.string().max(256),
  })
  .strict();

export const usageEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("usage"),
    usage: usageSchema,
  })
  .strict();

export const MODEL_VERDICTS = ["match", "mismatch", "unknown"] as const;
export const modelVerdictSchema = z.enum(MODEL_VERDICTS);
export type ModelVerdict = z.infer<typeof modelVerdictSchema>;

/** Terminal success: carries the authoritative normalized full output. */
export const completedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("completed"),
    output: z.string(),
    requestedModel: z.string().min(1),
    effectiveModel: z.string().nullable(),
    modelVerdict: modelVerdictSchema,
    toolState: z.enum(TOOL_STATES),
    dispatchState: z.literal("accepted"),
    usage: usageSchema.nullable(),
    finalSeq: z.number().int().positive(),
  })
  .strict();

export const failedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("failed"),
    error: runtimeErrorSchema,
    dispatchState: z.enum(DISPATCH_STATES),
    toolState: z.enum(TOOL_STATES),
    retryable: z.boolean(),
  })
  .strict();

export const INTERRUPT_REASONS = [
  "user_cancelled",
  "driver_crash",
  "timeout",
  "host_shutdown",
  "supervisor_lost",
  "unknown",
] as const;

export const interruptedEventSchema = z
  .object({
    ...eventBase,
    type: z.literal("interrupted"),
    reason: z.enum(INTERRUPT_REASONS),
    dispatchState: z.enum(DISPATCH_STATES),
    toolState: z.enum(TOOL_STATES),
  })
  .strict();

export const runtimeEventSchema = z.discriminatedUnion("type", [
  startedEventSchema,
  outputDeltaEventSchema,
  outputSnapshotEventSchema,
  activityEventSchema,
  usageEventSchema,
  completedEventSchema,
  failedEventSchema,
  interruptedEventSchema,
]);

export type StartedEvent = z.infer<typeof startedEventSchema>;
export type OutputDeltaEvent = z.infer<typeof outputDeltaEventSchema>;
export type OutputSnapshotEvent = z.infer<typeof outputSnapshotEventSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type UsageEvent = z.infer<typeof usageEventSchema>;
export type CompletedEvent = z.infer<typeof completedEventSchema>;
export type FailedEvent = z.infer<typeof failedEventSchema>;
export type InterruptedEvent = z.infer<typeof interruptedEventSchema>;
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export const TERMINAL_EVENT_TYPES = ["completed", "failed", "interrupted"] as const;

export function isTerminalEvent(event: RuntimeEvent): boolean {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(event.type);
}
