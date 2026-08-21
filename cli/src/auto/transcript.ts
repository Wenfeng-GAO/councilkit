/**
 * review transcript records (plan §文件清单). Independent `kind` union — the
 * existing `run.*` transcript schema in `store/schemas.ts` is left untouched.
 * Style mirrors the store schemas (strict objects, `kind` discriminator). The
 * whole JSONL is rewritten atomically after each appended record (single-writer,
 * appends are append-only in practice but always durable via tmp+fsync+rename).
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { errors } from "../errors";
import { atomicWriteFile } from "../store/atomic-write";

export const REVIEW_TRANSCRIPT_VERSION = 1 as const;

/** Normalized exit code: a real signal/timeout kill is recorded as `"killed"`
 * (not the raw numeric the kernel returned for SIGTERM), so a child dying on
 * SIGTERM is never displayed as `exit 0`. Old numeric/null records stay valid. */
export const attemptExitCodeSchema = z.union([z.number().int(), z.literal("killed"), z.null()]);
export type AttemptExitCode = z.infer<typeof attemptExitCodeSchema>;

/** Per-Attempt process summary parsed incrementally from stream-json stdout.
 * Optional everywhere: absent means "no process data" (older runs / parse
 * failure), never an error. */
export const attemptActivitySchema = z
  .object({
    toolCalls: z.number().int().nonnegative(),
    commands: z.array(z.string()),
    /** Proxy-prefix-stripped flag (collection time). Optional for back-compat. */
    strippedProxy: z.boolean().optional(),
  })
  .strict();
export type AttemptActivity = z.infer<typeof attemptActivitySchema>;

/** One driver health-probe result (P1-1). The Aggregator driver is always
 * probed (aggregation always re-runs); a normal driver probe is shared across
 * every rerun Attempt that uses it. */
export const driverProbeRecordSchema = z
  .object({
    driverId: z.string().min(1),
    modelId: z.string().min(1),
    status: z.enum(["success", "failure"]),
    durationMs: z.number().int().nonnegative(),
    failure: z
      .object({ code: z.string().min(1), message: z.string() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type DriverProbeRecord = z.infer<typeof driverProbeRecordSchema>;

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
  against?: string;
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
        against: z.string().optional(),
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
    /** Driver health-probe results (P1-1). Present on every fresh run; `.optional()`
     * keeps older transcripts (written before probes existed) readable. A resume
     * run records its own probe set in `review.resumed`, never rewriting history. */
    probe: z.array(driverProbeRecordSchema).optional(),
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
    /** Final delivered text on success; null on failure (design: each Attempt's
     * final text is part of the durable transcript). */
    output: z.string().nullable(),
    exitCode: attemptExitCodeSchema,
    durationMs: z.number().int().nonnegative(),
    failure: z
      .object({ code: z.string().min(1), message: z.string() })
      .strict()
      .nullable()
      .optional(),
    /** Incremental process summary (P2-1). Optional for back-compat with runs
     * written before process capture, and absent when parsing yielded nothing. */
    activity: attemptActivitySchema.optional(),
    /** 1-based physical execution index for this Attempt (plan §"瞬态重试"):
     * `1` for the first try, `2` for the retried second try. Absent on older
     * transcripts and on synthetic/cancelled records. */
    attemptNumber: z.number().int().positive().optional(),
    /** Present (and `1`) on the retried second try, naming the failed first
     * try's `attemptNumber`. Absent on a non-retried Attempt. */
    retryOf: z.number().int().positive().optional(),
    /** Present on a fresh success that followed a FAILED attempt in the run
     * being resumed — persisted so the appendix mark survives further resumes
     * (reviewer finding). */
    resumedAfterFailure: z.boolean().optional(),
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
    /** The Aggregator's synthesized delivery on success; null on failure. */
    output: z.string().nullable(),
    exitCode: attemptExitCodeSchema,
    durationMs: z.number().int().nonnegative(),
    failure: z
      .object({ code: z.string().min(1), message: z.string() })
      .strict()
      .nullable()
      .optional(),
    activity: attemptActivitySchema.optional(),
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

/** Resume marker (P2-2). Appended (never rewriting history) on a `--resume` run:
 * which Attempts were reused verbatim, which were re-run, and this run's own
 * driver-probe results. Aggregation is always re-run, so `probe` includes the
 * Aggregator driver even when every non-aggregator Attempt was reused. */
export const reviewResumedRecordSchema = z
  .object({
    kind: z.literal("review.resumed"),
    version: z.literal(REVIEW_TRANSCRIPT_VERSION),
    runId: z.string().min(1),
    resumedAt: z.string().min(1),
    reusedAttemptIds: z.array(z.string().min(1)),
    rerunAttemptIds: z.array(z.string().min(1)),
    probe: z.array(driverProbeRecordSchema),
  })
  .strict();
export type ReviewResumedRecord = z.infer<typeof reviewResumedRecordSchema>;

export const reviewTranscriptRecordSchema = z.discriminatedUnion("kind", [
  reviewStartedRecordSchema,
  reviewResumedRecordSchema,
  attemptFinishedRecordSchema,
  aggregationFinishedRecordSchema,
  reviewFinishedRecordSchema,
]);
export type ReviewTranscriptRecord = z.infer<typeof reviewTranscriptRecordSchema>;

/** Read a review transcript JSONL into validated records (P2-2). Each line is
 * JSON.parsed then `safeParse`d against the union. ANY malformed line aborts
 * the read with a diagnostic CliError(io) carrying the (1-indexed) line number
 * and a short schema summary — the offending line's content is NEVER echoed
 * (it could carry secret-shaped model output). Silently skipping a bad line
 * would let an old success record become "the last terminal state" and the
 * next rewrite would drop history, so a corrupt transcript refuses the resume
 * and leaves repair to the user (reviewer finding). Only a MISSING file
 * (ENOENT) returns []; any other read failure (EACCES/EISDIR/ELOOP/EIO/…) is
 * an exit-5 io error — treating it as "no transcript" would silently discard
 * history on the next rewrite (reviewer finding). The OS error text is never
 * echoed verbatim. */
export function readReviewTranscript(path: string): ReviewTranscriptRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    throw errors.io(`failed to read review transcript: ${ioName(cause)}`, {
      cause: ioName(cause),
    });
  }
  const records: ReviewTranscriptRecord[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const lineNo = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Never echo the line (could carry model output / secrets).
      throw errors.io(`review transcript is corrupt: line ${lineNo} is not valid JSON`, {
        line: lineNo,
      });
    }
    const result = reviewTranscriptRecordSchema.safeParse(parsed);
    if (result.success) {
      records.push(result.data);
      continue;
    }
    // Report the failure WITHOUT echoing the offending record's content.
    const firstIssue = result.error.issues[0];
    const summary =
      firstIssue === undefined
        ? "schema mismatch"
        : `${firstIssue.code}${firstIssue.path.length > 0 ? ` @${firstIssue.path.join(".")}` : ""}`;
    throw errors.io(`review transcript is corrupt: line ${lineNo}: ${summary}`, {
      line: lineNo,
    });
  }
  return records;
}

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
