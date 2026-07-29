/**
 * `councilkit review` — N fully-autonomous agents independently review the same
 * task in isolated workspaces, then one of them (the Aggregator) synthesizes a
 * single report (DESIGN §0-§4, plan §文件清单/§"ReviewOutcome"). This command
 * deliberately bypasses the Runtime Host and spawns each driver directly by
 * PATH; the trust model is "user invoking this CLI by hand" (DESIGN §2 信任模型).
 *
 * Two forms:
 *  - `--agents '[id,...]' --aggregator <id>` : explicit attempt set + aggregator.
 *  - `--council <ref>` : map council.agentIds → Attempts, reporter → Aggregator.
 * `--pr <url|number>` and `--task "<text>"` are mutually exclusive and one is
 * required. Exit codes follow the existing table (0/2/4/5/130).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  renderReviewReport,
  writeCanonicalReviewReport,
  writeReviewReportCopy,
} from "../auto/aggregate";
import { type AttemptSpec, buildSpawnSpec } from "../auto/driver-commands";
import { type AttemptResult, type SpawnImpl, runAttempts, spawnOnce } from "../auto/runner";
import {
  type ReviewTask,
  buildAggregatePrompt,
  buildAttemptPrompt,
} from "../auto/templates/review";
import {
  type AggregationFinishedRecord,
  type AttemptFinishedRecord,
  type AttemptMeta,
  type ReviewFinishedRecord,
  type ReviewStartedRecord,
  type ReviewTranscriptRecord,
  writeReviewTranscript,
} from "../auto/transcript";
import { EXIT, errors } from "../errors";
import type { OutputSink } from "../output";
import { resolvePaths } from "../store/paths";
import type { AgentRecord, CouncilRecord } from "../store/schemas";
import { Store } from "../store/store";
import { parseFlags, parseJsonFlag } from "./parse";

const agentRefsSchema = z.array(z.string().min(1).max(128)).min(1);

export interface ReviewDeps {
  /** Inject a fake spawn for end-to-end tests (zero real processes). */
  spawnImpl?: SpawnImpl;
  /** Inject the SIGINT controller so tests can drive the abort path without
   * sending a real signal to the process. */
  abortController?: AbortController;
}

export async function runReview(
  argv: string[],
  out: OutputSink,
  deps: ReviewDeps = {},
): Promise<void> {
  const { values } = parseFlags(
    {
      flags: {
        json: { type: "boolean" },
        agents: { type: "string" },
        aggregator: { type: "string" },
        council: { type: "string" },
        pr: { type: "string" },
        task: { type: "string" },
        focus: { type: "string" },
        timeout: { type: "string" },
        concurrency: { type: "string" },
        out: { type: "string" },
      },
      allowPositionals: 0,
    },
    argv,
  );

  // --- task (mutually exclusive, one required, non-blank) -----------------
  const hasPr = values.pr !== undefined;
  const hasTask = values.task !== undefined;
  if (hasPr && hasTask) {
    throw errors.usage("--pr and --task are mutually exclusive");
  }
  if (!hasPr && !hasTask) {
    throw errors.usage("one of --pr or --task is required");
  }
  if (hasPr && (values.pr as string).trim().length === 0) {
    throw errors.usage("--pr must not be empty or whitespace");
  }
  if (hasTask && (values.task as string).trim().length === 0) {
    throw errors.usage("--task must not be empty or whitespace");
  }
  const task: ReviewTask = {
    pr: hasPr ? (values.pr as string).trim() : undefined,
    task: hasTask ? (values.task as string).trim() : undefined,
    focus: values.focus !== undefined ? (values.focus as string) : undefined,
    councilTopic: undefined,
  };

  // --- agents / aggregator resolution -------------------------------------
  const store = new Store();
  const paths = resolvePaths();
  let attemptAgents: AgentRecord[];
  let aggregatorAgent: AgentRecord;
  let councilTopic: string | undefined;

  if (values.council !== undefined) {
    if (values.agents !== undefined || values.aggregator !== undefined) {
      throw errors.usage("--council is mutually exclusive with --agents/--aggregator");
    }
    const council = store.getCouncil(values.council as string);
    councilTopic = council.topic.trim().length > 0 ? council.topic : undefined;
    task.councilTopic = councilTopic;
    attemptAgents = council.agentIds.map((id) => store.getAgent(id));
    aggregatorAgent = store.getAgent(council.reporterAgentId);
    if (!attemptAgents.some((a) => a.id === aggregatorAgent.id)) {
      throw errors.usage("council reporter (aggregator) is not among council agents");
    }
  } else {
    if (values.aggregator === undefined) {
      throw errors.usage("--aggregator is required (or use --council)");
    }
    const refs = parseJsonFlag(values.agents as string | undefined, agentRefsSchema, "agents");
    attemptAgents = refs.map((ref) => store.getAgent(ref));
    aggregatorAgent = store.getAgent(values.aggregator as string);
    if (!attemptAgents.some((a) => a.id === aggregatorAgent.id)) {
      throw errors.usage("--aggregator must be among --agents");
    }
  }

  // De-dupe attempt agents (an agent listed twice is a usage error).
  const seenIds = new Set<string>();
  for (const a of attemptAgents) {
    if (seenIds.has(a.id)) throw errors.usage(`agent "${a.name}" is listed more than once`);
    seenIds.add(a.id);
  }

  // Reject disabled agents before any cost is incurred (mirrors the run path:
  // a disabled agent cannot participate). Checked after resolution but before
  // workspace creation / spawning.
  for (const a of attemptAgents) {
    if (!a.enabled) {
      throw errors.usage(`agent "${a.name}" is disabled; cannot participate in a review`);
    }
  }

  // --- options ------------------------------------------------------------
  const timeoutMs = parseTimeout(values.timeout as string | undefined);
  const concurrencyRaw = values.concurrency as string | undefined;
  const concurrency =
    concurrencyRaw !== undefined ? parsePositiveInt(concurrencyRaw, "concurrency") : undefined;

  // --- run scaffold -------------------------------------------------------
  const runId = `ck-review-${randomUUID()}`;
  const runDir = paths.runDir(runId);
  const transcriptPath = paths.transcript(runId);
  const reportPath = paths.report(runId);
  const startedAt = new Date().toISOString();

  // Cost-informed attempt list (printed before any spawn).
  out.progress(`review ${runId} starting`);
  out.progress(`  task: ${task.pr ? `PR ${task.pr}` : "<task text>"}`);
  for (const a of attemptAgents) {
    const role = a.id === aggregatorAgent.id ? " (aggregator)" : "";
    out.progress(`  attempt: ${a.name} — ${a.driverSelection.driverId}/${a.modelId}${role}`);
  }

  // Build all spawn specs up front so usage errors (non-cfuse route, missing
  // executable) fail fast BEFORE any subprocess is spawned.
  const attemptMetas: AttemptMeta[] = [];
  const specs: AttemptSpec[] = [];
  let index = 0;
  for (const a of attemptAgents) {
    const attemptId = `attempt-${index}`;
    const workspace = join(runDir, "workspaces", attemptId);
    createWorkspace(workspace);
    const prompt = buildAttemptPrompt({ agentName: a.name, personaPrompt: a.personaPrompt, task });
    const spec = buildSpawnSpec(a, { attemptId, workspace, prompt });
    specs.push(spec);
    attemptMetas.push({
      attemptId,
      agentId: a.id,
      agentName: a.name,
      driverId: spec.driverId,
      modelId: spec.modelId,
    });
    index++;
  }
  const aggregatorWorkspace = join(runDir, "workspaces", "aggregator");
  createWorkspace(aggregatorWorkspace);

  // --- SIGINT / SIGTERM ---------------------------------------------------
  const controller = deps.abortController ?? new AbortController();
  let signaled = false;
  const onSignal = () => {
    if (signaled) return;
    signaled = true;
    controller.abort("SIGINT");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const transcript: ReviewTranscriptRecord[] = [];
  const startedRecord: ReviewStartedRecord = {
    kind: "review.started",
    version: 1,
    runId,
    startedAt,
    task: {
      pr: task.pr,
      task: task.task,
      focus: task.focus,
      councilTopic,
    },
    attempts: attemptMetas,
    aggregator: {
      attemptId: "aggregator",
      agentId: aggregatorAgent.id,
      agentName: aggregatorAgent.name,
      driverId: aggregatorAgent.driverSelection.driverId,
      modelId: aggregatorAgent.modelId,
    },
  };
  transcript.push(startedRecord);
  flushTranscript(transcriptPath, transcript);

  let outcome: ReviewOutcome;
  try {
    outcome = await executeReview({
      runId,
      runDir,
      transcriptPath,
      reportPath,
      outPath: values.out as string | undefined,
      startedAt,
      specs,
      aggregatorAgent,
      aggregatorWorkspace,
      task,
      councilTopic,
      timeoutMs,
      concurrency,
      signal: controller.signal,
      spawnImpl: deps.spawnImpl,
      out,
      transcript,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  // Await stdout flush of the final document before throwing the exit sentinel
  // — main() process.exit()s on ReviewExit, which would truncate a large
  // ReviewOutcome still buffered in stdout under backpressure (reviewer finding).
  // The run command keeps its existing fire-and-forget finish (unchanged).
  await out.finish(outcome, (d) => renderHuman(d as ReviewOutcome));
  throw new ReviewExit(outcome.exitCode);
}

interface ExecuteParams {
  runId: string;
  runDir: string;
  transcriptPath: string;
  reportPath: string;
  outPath?: string;
  startedAt: string;
  specs: AttemptSpec[];
  aggregatorAgent: AgentRecord;
  aggregatorWorkspace: string;
  task: ReviewTask;
  councilTopic?: string;
  timeoutMs: number;
  concurrency?: number;
  signal: AbortSignal;
  spawnImpl?: SpawnImpl;
  out: OutputSink;
  transcript: ReviewTranscriptRecord[];
}

async function executeReview(p: ExecuteParams): Promise<ReviewOutcome> {
  const runnerOpts = {
    timeoutMs: p.timeoutMs,
    concurrency: p.concurrency,
    signal: p.signal,
    spawnImpl: p.spawnImpl,
    onAttemptFinish: (r: AttemptResult) => {
      const rec: AttemptFinishedRecord = {
        kind: "attempt.finished",
        version: 1,
        attemptId: r.attemptId,
        agentName: r.agentName,
        driverId: r.driverId,
        status: r.status,
        output: r.status === "success" ? r.output : null,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        failure: r.failure ?? null,
      };
      p.transcript.push(rec);
      flushTranscript(p.transcriptPath, p.transcript);
      p.out.progress(
        `  attempt ${r.agentName} -> ${r.status} (exit ${r.exitCode ?? "n/a"}, ${r.durationMs}ms)`,
      );
      // Surface the failure reason (incl. the driver's stderr tail carried on
      // the EXIT failure message) as a human-mode diagnostic (reviewer finding:
      // stderr was collected but never shown).
      if (r.status === "failure" && r.failure) {
        p.out.progress(`    failure [${r.failure.code}]: ${r.failure.message}`);
      }
    },
  };

  const { results, aborted } = await runAttempts(p.specs, runnerOpts);

  if (aborted || p.signal.aborted) {
    return finalize(p, new Date().toISOString(), results, null, {
      status: "interrupted",
      exitCode: EXIT.interrupted,
      incomplete: true,
      failure: { phase: "review", code: "ABORTED", message: "run aborted by signal" },
    });
  }

  const successes = results.filter((r) => r.status === "success");

  // All attempts failed → no aggregation; deterministic failed report; exit 4.
  if (successes.length === 0) {
    return finalize(p, new Date().toISOString(), results, null, {
      status: "failed",
      exitCode: EXIT.runFailed,
      incomplete: true,
      failure: { phase: "attempts", code: "ALL_FAILED", message: "every attempt failed" },
    });
  }

  // --- aggregation --------------------------------------------------------
  const aggregatePrompt = buildAggregatePrompt({
    aggregatorName: p.aggregatorAgent.name,
    aggregatorPersona: p.aggregatorAgent.personaPrompt,
    task: p.task,
    attempts: results.map((r) => ({
      attemptId: r.attemptId,
      name: r.agentName,
      status: r.status,
      output: r.output,
    })),
  });
  const aggregatorSpec = buildSpawnSpec(p.aggregatorAgent, {
    attemptId: "aggregator",
    workspace: p.aggregatorWorkspace,
    prompt: aggregatePrompt,
  });

  p.out.progress(`  aggregator ${p.aggregatorAgent.name} synthesizing`);
  const aggregation = await spawnOnce(aggregatorSpec, {
    timeoutMs: p.timeoutMs,
    signal: p.signal,
    spawnImpl: p.spawnImpl,
  });

  const aggRec: AggregationFinishedRecord = {
    kind: "aggregation.finished",
    version: 1,
    attemptId: aggregation.attemptId,
    agentName: aggregation.agentName,
    driverId: aggregation.driverId,
    status: aggregation.status,
    output: aggregation.status === "success" ? aggregation.output : null,
    exitCode: aggregation.exitCode,
    durationMs: aggregation.durationMs,
    failure: aggregation.failure ?? null,
  };
  p.transcript.push(aggRec);
  flushTranscript(p.transcriptPath, p.transcript);
  p.out.progress(
    `  aggregator -> ${aggregation.status} (exit ${aggregation.exitCode ?? "n/a"}, ${aggregation.durationMs}ms)`,
  );

  // Abort during (or immediately after) aggregation is an interrupted run — NOT
  // "aggregation failed/exit 4" and NOT "completed/0" even if the Aggregator
  // happened to finish. Persist best-effort transcript/report, exit 130.
  if (p.signal.aborted) {
    return finalize(p, new Date().toISOString(), results, aggregation, {
      status: "interrupted",
      exitCode: EXIT.interrupted,
      incomplete: true,
      failure: { phase: "aggregation", code: "ABORTED", message: "run aborted by signal" },
    });
  }

  if (aggregation.status !== "success") {
    return finalize(p, new Date().toISOString(), results, null, {
      status: "failed",
      exitCode: EXIT.runFailed,
      incomplete: true,
      failure: {
        phase: "aggregation",
        code: aggregation.failure?.code ?? "AGGREGATION_FAILED",
        message: aggregation.failure?.message ?? "aggregator produced no output",
      },
    });
  }

  const incomplete = successes.length < results.length;
  return finalize(p, new Date().toISOString(), results, aggregation, {
    status: "completed",
    exitCode: EXIT.ok,
    incomplete,
    failure: undefined,
  });
}

interface FinalizeSpec {
  status: "completed" | "failed" | "interrupted";
  exitCode: number;
  incomplete: boolean;
  failure?: { phase: string; code: string; message: string };
}

async function finalize(
  p: ExecuteParams,
  endedAt: string,
  results: AttemptResult[],
  aggregation: AttemptResult | null,
  spec: FinalizeSpec,
): Promise<ReviewOutcome> {
  // Surface the failure reason (interrupt cause / failure cause) in the report
  // header so an interrupted or failed run is labelled — not just "incomplete".
  const reason = spec.failure?.message;

  const markdown = renderReviewReport({
    runId: p.runId,
    startedAt: p.startedAt,
    endedAt,
    task: p.task,
    attempts: results,
    aggregator: {
      attemptId: "aggregator",
      agentId: p.aggregatorAgent.id,
      agentName: p.aggregatorAgent.name,
      driverId: p.aggregatorAgent.driverSelection.driverId,
      modelId: p.aggregatorAgent.modelId,
    },
    aggregation,
    status: spec.status,
    incomplete: spec.incomplete,
    reason,
  });

  // Collect EVERY artifact-IO outcome first (canonical report, --out copy, then
  // the final transcript rewrite), THEN compute status/incomplete/exitCode in
  // one place. Previously these were derived from only the report/--out results
  // before the transcript rewrite was attempted, so a --out or transcript IO
  // failure returned status="completed"/exit 5/incomplete=false and the
  // persisted review.finished record disagreed with the ReviewOutcome (reviewer
  // finding: artifact-IO status computed before the final transcript write,
  // incomplete never recomputed).
  let ioFailure: { phase: string; code: string; message: string } | undefined;
  try {
    writeCanonicalReviewReport(p.reportPath, markdown);
  } catch (error) {
    ioFailure = {
      phase: "report",
      code: "IO_WRITE",
      message: error instanceof Error ? error.message : "canonical report write failed",
    };
  }
  if (p.outPath !== undefined && ioFailure === undefined) {
    try {
      writeReviewReportCopy(p.outPath, markdown);
    } catch (error) {
      ioFailure = {
        phase: "out",
        code: "IO_COPY",
        message: error instanceof Error ? error.message : "--out copy write failed",
      };
    }
  }

  // The canonical report was rendered with the run's logical status/incomplete
  // (spec.*), so the ReviewOutcome declares the SAME run status — artifact-IO
  // failures surface via exitCode (5) + `failure`, not by mutating the run
  // status — keeping the canonical report and ReviewOutcome consistent. A
  // failure of a CANONICAL artifact (report/transcript) marks the durable
  // record incomplete; the non-canonical --out copy does not (the canonical
  // report is intact, matching the report's own incomplete banner).
  const computeOutcome = (io: typeof ioFailure) => {
    const exitCode = io !== undefined ? EXIT.io : spec.exitCode;
    const status: FinalizeSpec["status"] = spec.status;
    const incomplete = spec.incomplete || (io !== undefined && io.phase !== "out");
    const failure = io ?? spec.failure;
    return { exitCode, status, incomplete, failure };
  };

  let outcomeFields = computeOutcome(ioFailure);

  // The review.finished record is persisted with these fields. If the flush
  // below then fails, that record is NOT on disk (the atomic rewrite failed),
  // so the on-disk record always matches a successful flush; the returned
  // ReviewOutcome is recomputed below to include the transcript failure.
  const finished: ReviewFinishedRecord = {
    kind: "review.finished",
    version: 1,
    status: outcomeFields.status,
    endedAt,
    incomplete: outcomeFields.incomplete,
    reportPath: p.reportPath,
    failure: outcomeFields.failure,
  };
  p.transcript.push(finished);
  try {
    flushTranscript(p.transcriptPath, p.transcript);
  } catch (error) {
    // The final transcript rewrite is itself an artifact-IO failure: map it to
    // exit 5 and surface it in the outcome (the canonical report, if written,
    // remains the durable artifact). Recompute the outcome so the transcript
    // failure is reflected in incomplete/exitCode/failure.
    if (ioFailure === undefined) {
      ioFailure = {
        phase: "transcript",
        code: "IO_TRANSCRIPT",
        message: error instanceof Error ? error.message : "transcript write failed",
      };
      outcomeFields = computeOutcome(ioFailure);
    }
  }

  return {
    status: outcomeFields.status,
    exitCode: outcomeFields.exitCode,
    runId: p.runId,
    reportPath: p.reportPath,
    transcriptPath: p.transcriptPath,
    attempts: results.map(summarizeAttempt),
    attemptFailures: results
      .filter((r) => r.status === "failure")
      .map((r) => ({
        agentId: r.agentId,
        agentName: r.agentName,
        code: r.failure?.code ?? "unknown",
        message: r.failure?.message ?? "no output",
      })),
    incomplete: outcomeFields.incomplete,
    failure: outcomeFields.failure,
  };
}

function summarizeAttempt(r: AttemptResult): AttemptResult {
  return {
    attemptId: r.attemptId,
    agentId: r.agentId,
    agentName: r.agentName,
    driverId: r.driverId,
    modelId: r.modelId,
    status: r.status,
    output: r.output,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    workspace: r.workspace,
    failure: r.failure,
  };
}

function createWorkspace(workspace: string): void {
  try {
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw errors.io(`failed to create workspace dir: ${ioName(cause)}`, { cause: ioName(cause) });
  }
}

function flushTranscript(path: string, records: ReviewTranscriptRecord[]): void {
  writeReviewTranscript(path, records);
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return 30 * 60 * 1000;
  const match = /^(\d+)(ms|s|m|h)$/.exec(raw);
  if (match === null) {
    throw errors.usage(`--timeout must look like 30m|600s|1h|5000ms, got "${raw}"`);
  }
  const n = Number(match[1]);
  const unit = match[2];
  const ms = n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw errors.usage(`--timeout must be a positive duration, got "${raw}"`);
  }
  return ms;
}

function parsePositiveInt(raw: string, fieldName: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw errors.usage(`--${fieldName} must be a positive integer, got "${raw}"`);
  }
  return Number(raw);
}

function ioName(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return "IOFailure";
}

function renderHuman(o: ReviewOutcome): string {
  const lines: string[] = [];
  lines.push(`Review ${o.runId}: ${o.status} (exit ${o.exitCode})`);
  lines.push(`  report: ${o.reportPath}`);
  lines.push(`  transcript: ${o.transcriptPath}`);
  lines.push(`  attempts: ${o.attempts.length} (${o.attemptFailures.length} failed)`);
  if (o.incomplete) lines.push("  (INCOMPLETE — see report.md)");
  if (o.failure)
    lines.push(`  failure: [${o.failure.phase}] ${o.failure.code} — ${o.failure.message}`);
  return lines.join("\n");
}

/** Sentinel carrying the review exit code up to main(). Mirrors RunExit. */
export class ReviewExit {
  constructor(readonly exitCode: number) {}
}

export interface ReviewOutcome {
  status: "completed" | "failed" | "interrupted";
  exitCode: number;
  runId: string;
  reportPath: string;
  transcriptPath: string;
  attempts: AttemptResult[];
  attemptFailures: Array<{ agentId: string; agentName: string; code: string; message: string }>;
  incomplete: boolean;
  failure?: { phase: string; code: string; message: string };
}

// Re-exported for the CLI router.
export type { CouncilRecord };
