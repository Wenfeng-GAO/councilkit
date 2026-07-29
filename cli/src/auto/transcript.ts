/**
 * review transcript records (plan §文件清单). Independent `kind` union — the
 * existing `run.*` transcript schema in `store/schemas.ts` is left untouched.
 * Style mirrors the store schemas (strict objects, `kind` discriminator). The
 * whole JSONL is rewritten atomically after each appended record (single-writer,
 * appends are append-only in practice but always durable via tmp+fsync+rename).
 */
import { z } from "zod";
import { errors } from "../errors";
import { atomicWriteFile } from "../store/atomic-write";

export const REVIEW_TRANSCRIPT_VERSION = 1 as const;

export interface AttemptMeta {
  attemptId: string;
  agentId: string;
  agentName: string;
  driverId: string;
  modelId: string;
}

export interface ReviewTaskRecord {
  pr?: string;
  task?: string;
  focus?: string;
  councilTopic?: string;
}

export const reviewStartedRecordSchema = z
  .object({
    kind: z.literal("review.started"),
    version: z.literal(REVIEW_TRANSCRIPT_VERSION),
    runId: z.string().min(1),
    startedAt: z.string().min(1),
    task: z
      .object({
        pr: z.string().optional(),
        task: z.string().optional(),
        focus: z.string().optional(),
        councilTopic: z.string().optional(),
      })
      .strict(),
    attempts: z.array(
      z
        .object({
          attemptId: z.string().min(1),
          agentId: z.string().min(1),
          agentName: z.string().min(1),
          driverId: z.string().min(1),
          modelId: z.string().min(1),
        })
        .strict(),
    ),
    aggregator: z
      .object({
        attemptId: z.string().min(1),
        agentId: z.string().min(1),
        agentName: z.string().min(1),
        driverId: z.string().min(1),
        modelId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type ReviewStartedRecord = z.infer<typeof reviewStartedRecordSchema>;

export const attemptFinishedRecordSchema = z
  .object({
    kind: z.literal("attempt.finished"),
    version: z.literal(REVIEW_TRANSCRIPT_VERSION),
    attemptId: z.string().min(1),
    agentName: z.string().min(1),
    driverId: z.string().min(1),
    status: z.enum(["success", "failure"]),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    failure: z
      .object({ code: z.string().min(1), message: z.string() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type AttemptFinishedRecord = z.infer<typeof attemptFinishedRecordSchema>;

export const aggregationFinishedRecordSchema = z
  .object({
    kind: z.literal("aggregation.finished"),
    version: z.literal(REVIEW_TRANSCRIPT_VERSION),
    attemptId: z.string().min(1),
    agentName: z.string().min(1),
    driverId: z.string().min(1),
    status: z.enum(["success", "failure"]),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    failure: z
      .object({ code: z.string().min(1), message: z.string() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type AggregationFinishedRecord = z.infer<typeof aggregationFinishedRecordSchema>;

export const reviewFinishedRecordSchema = z
  .object({
    kind: z.literal("review.finished"),
    version: z.literal(REVIEW_TRANSCRIPT_VERSION),
    status: z.enum(["completed", "failed", "interrupted"]),
    endedAt: z.string().min(1),
    incomplete: z.boolean().optional(),
    reportPath: z.string().optional(),
    failure: z
      .object({ phase: z.string().min(1), code: z.string().min(1), message: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export type ReviewFinishedRecord = z.infer<typeof reviewFinishedRecordSchema>;

export const reviewTranscriptRecordSchema = z.discriminatedUnion("kind", [
  reviewStartedRecordSchema,
  attemptFinishedRecordSchema,
  aggregationFinishedRecordSchema,
  reviewFinishedRecordSchema,
]);
export type ReviewTranscriptRecord = z.infer<typeof reviewTranscriptRecordSchema>;

/** Rewrite the entire transcript JSONL atomically. */
export function writeReviewTranscript(path: string, records: ReviewTranscriptRecord[]): void {
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  try {
    atomicWriteFile(path, `${lines}\n`);
  } catch (cause) {
    throw errors.io(`failed to write review transcript: ${ioName(cause)}`, {
      cause: ioName(cause),
    });
  }
}

function ioName(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return "IOFailure";
}
