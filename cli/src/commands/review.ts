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
import { type Stats, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { z } from "zod";
import {
  renderReviewReport,
  writeCanonicalReviewReport,
  writeReviewReportCopy,
} from "../auto/aggregate";
import {
  type AttemptSpec,
  DRIVER_PROBE_PROMPT,
  buildProbeSpec,
  buildSpawnSpec,
} from "../auto/driver-commands";
import {
  type AttemptResult,
  type RunAttemptsOutcome,
  type RunnerTimers,
  type SpawnImpl,
  runAttempts,
  spawnOnce,
} from "../auto/runner";
import {
  type ReviewTask,
  buildAggregatePrompt,
  buildAttemptPrompt,
} from "../auto/templates/review";
import {
  type AggregationFinishedRecord,
  type AttemptFinishedRecord,
  type AttemptMeta,
  type DriverProbeRecord,
  type ReviewFinishedRecord,
  type ReviewResumedRecord,
  type ReviewStartedRecord,
  type ReviewTranscriptRecord,
  readReviewTranscript,
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
  /** Inject fake timers (heartbeat tests) — forwarded to the runner. */
  timers?: RunnerTimers;
  /** Override the 30s heartbeat cadence (tests). */
  heartbeatIntervalMs?: number;
}

/** Health-probe timeout (P1-1): a driver that cannot answer a minimal prompt
 * within 10s is treated as unreachable. */
const PROBE_TIMEOUT_MS = 10_000;

/** `--resume` accepts only a real run id — anything else (path separators,
 * `..`, empty) is a usage error, never a path-traversal attempt. */
const RUN_ID_PATTERN = /^ck-review-[0-9a-fA-F-]+$/;

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
        resume: { type: "string" },
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

  // --- resume: load the prior run + validate immutable inputs (P2-2) -------
  const resumeRaw = values.resume as string | undefined;
  let priorRecords: ReviewTranscriptRecord[] = [];
  let priorStartedAt: string | undefined;
  const reusedByAttemptId = new Map<string, AttemptResult>();
  if (resumeRaw !== undefined) {
    const resumeId = resumeRaw.trim();
    if (!RUN_ID_PATTERN.test(resumeId)) {
      throw errors.usage(`--resume must be a ck-review-<uuid> run id, got "${resumeRaw}"`);
    }
    priorRecords = readReviewTranscript(paths.transcript(resumeId));
    const started = priorRecords.find((r) => r.kind === "review.started");
    if (started === undefined) {
      throw errors.usage(`run ${resumeId} has no readable review.started record to resume from`);
    }
    // The transcript must provably belong to THIS run id — an implicit match is
    // not enough (reviewer finding): refuse to resume from another run's
    // history.
    if (started.runId !== resumeId) {
      throw errors.usage(
        `--resume ${resumeId} does not match the transcript's review.started runId`,
      );
    }
    // Consistency is checked on stable IDs (not user-typed names) and on every
    // input that shapes the prompts — a mismatch would silently reuse outputs
    // produced for a different task.
    const priorAgentIds = started.attempts.map((a) => a.agentId);
    const nowAgentIds = attemptAgents.map((a) => a.id);
    if (
      priorAgentIds.length !== nowAgentIds.length ||
      !priorAgentIds.every((id, i) => id === nowAgentIds[i])
    ) {
      throw errors.usage("--agents must match the resumed run (same agent ids, same order)");
    }
    if (started.aggregator.agentId !== aggregatorAgent.id) {
      throw errors.usage("--aggregator must match the resumed run's aggregator");
    }
    if (
      (started.task.pr ?? undefined) !== task.pr ||
      (started.task.task ?? undefined) !== task.task
    ) {
      throw errors.usage("--pr/--task must match the resumed run");
    }
    if ((started.task.focus ?? undefined) !== task.focus) {
      throw errors.usage("--focus must match the resumed run");
    }
    if ((started.task.councilTopic ?? undefined) !== councilTopic) {
      throw errors.usage("council topic must match the resumed run");
    }
    priorStartedAt = started.startedAt;
    // The LAST terminal record per attempt wins (a later resume may have
    // re-failed an attempt an earlier run had succeeded).
    const lastFinished = new Map<string, AttemptFinishedRecord>();
    for (const r of priorRecords) {
      if (r.kind === "attempt.finished") lastFinished.set(r.attemptId, r);
    }
    for (const meta of started.attempts) {
      const rec = lastFinished.get(meta.attemptId);
      if (rec !== undefined && rec.status === "success" && (rec.output ?? "").trim().length > 0) {
        reusedByAttemptId.set(meta.attemptId, {
          attemptId: meta.attemptId,
          agentId: meta.agentId,
          agentName: meta.agentName,
          driverId: meta.driverId,
          modelId: meta.modelId,
          status: "success",
          output: rec.output as string,
          exitCode: rec.exitCode,
          durationMs: rec.durationMs,
          workspace: join(paths.runDir(resumeId), "workspaces", meta.attemptId),
          activity: rec.activity,
          reused: true,
        });
      }
    }
  }

  // --- run scaffold -------------------------------------------------------
  // A resume CONTINUES the same run id: records are appended to the existing
  // transcript and report.md is re-rendered, never a parallel run.
  const runId =
    resumeRaw !== undefined ? (resumeRaw as string).trim() : `ck-review-${randomUUID()}`;
  const runDir = paths.runDir(runId);
  const transcriptPath = paths.transcript(runId);
  const reportPath = paths.report(runId);
  const startedAt = priorStartedAt ?? new Date().toISOString();
  // The run dir must exist before the first transcript flush — but
  // `workspaces/` is created only AFTER probing, for attempts that will
  // actually spawn (a probe must be able to prove no workspace existed yet).
  createWorkspace(runDir);

  const isReused = (attemptId: string): boolean => reusedByAttemptId.has(attemptId);

  // Cost-informed attempt list (printed before any workspace/spawn).
  out.progress(`review ${runId} starting${resumeRaw !== undefined ? " (resumed)" : ""}`);
  out.progress(`  task: ${task.pr ? `PR ${task.pr}` : "<task text>"}`);
  let attemptIndexCounter = 0;
  for (const a of attemptAgents) {
    const attemptId = `attempt-${attemptIndexCounter++}`;
    const role = a.id === aggregatorAgent.id ? " (aggregator)" : "";
    const reused = isReused(attemptId) ? " [reused]" : "";
    out.progress(
      `  attempt: ${a.name} — ${a.driverSelection.driverId}/${a.modelId}${role}${reused}`,
    );
  }

  // Build spawn specs for the attempts that will actually (re)run, up front so
  // usage errors (non-cfuse route, missing executable) fail fast BEFORE any
  // subprocess is spawned. No workspace is created here — probing happens
  // first, and probe-failed attempts never get a workspace.
  const attemptMetas: AttemptMeta[] = [];
  const rerunSpecs: AttemptSpec[] = [];
  const rerunAgents: AgentRecord[] = [];
  let index = 0;
  for (const a of attemptAgents) {
    const attemptId = `attempt-${index}`;
    attemptMetas.push({
      attemptId,
      agentId: a.id,
      agentName: a.name,
      driverId: a.driverSelection.driverId,
      modelId: a.modelId,
    });
    if (!isReused(attemptId)) {
      const workspace = join(runDir, "workspaces", attemptId);
      const prompt = buildAttemptPrompt({
        agentName: a.name,
        personaPrompt: a.personaPrompt,
        task,
      });
      rerunSpecs.push(buildSpawnSpec(a, { attemptId, workspace, prompt }));
      rerunAgents.push(a);
    }
    index++;
  }
  const aggregatorWorkspace = join(runDir, "workspaces", "aggregator");

  // --- SIGINT / SIGTERM ---------------------------------------------------
  // Registered BEFORE the probes so a signal mid-probe still takes the
  // interrupted path.
  const controller = deps.abortController ?? new AbortController();
  let signaled = false;
  const onSignal = () => {
    if (signaled) return;
    signaled = true;
    controller.abort("SIGINT");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // --- driver health probes (P1-1) -----------------------------------------
  // Probe each DISTINCT driver involved in this run exactly once: every driver
  // a rerun attempt needs, plus the Aggregator's driver (aggregation ALWAYS
  // re-runs, even when every attempt was reused). Reused attempts are never
  // probed on their own account.
  const probeAgents = new Map<string, AgentRecord>();
  for (const a of rerunAgents) {
    if (!probeAgents.has(a.driverSelection.driverId))
      probeAgents.set(a.driverSelection.driverId, a);
  }
  probeAgents.set(aggregatorAgent.driverSelection.driverId, aggregatorAgent);

  const probeResults: DriverProbeRecord[] = [];
  for (const [driverId, probeAgent] of probeAgents) {
    const spec = buildProbeSpec(probeAgent, {
      probeId: `probe-${driverId}`,
      cwd: process.cwd(),
      prompt: DRIVER_PROBE_PROMPT,
    });
    const result = await spawnOnce(spec, {
      timeoutMs: PROBE_TIMEOUT_MS,
      signal: controller.signal,
      spawnImpl: deps.spawnImpl,
    });
    probeResults.push({
      driverId,
      modelId: probeAgent.modelId,
      status: result.status,
      durationMs: result.durationMs,
      failure: result.failure ?? null,
    });
    out.progress(
      `  probe ${driverId} (${probeAgent.modelId}) -> ${result.status === "success" ? "ok" : "unreachable"}`,
    );
  }
  const probeByDriver = new Map(probeResults.map((r) => [r.driverId, r]));

  const transcript: ReviewTranscriptRecord[] = [...priorRecords];
  if (resumeRaw === undefined) {
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
      probe: probeResults,
    };
    transcript.push(startedRecord);
  } else {
    // Append — never rewrite — the resume marker with THIS run's probe set.
    const resumedRecord: ReviewResumedRecord = {
      kind: "review.resumed",
      version: 1,
      runId,
      resumedAt: new Date().toISOString(),
      reusedAttemptIds: [...reusedByAttemptId.keys()],
      rerunAttemptIds: rerunSpecs.map((s) => s.attemptId),
      probe: probeResults,
    };
    transcript.push(resumedRecord);
  }
  flushTranscript(transcriptPath, transcript);

  /** Single writer for real AND synthetic attempt results (plan: one helper so
   * transcript / progress / outcome can never drift apart). */
  const recordAttemptFinished = (r: AttemptResult): void => {
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
      activity: r.activity,
    };
    transcript.push(rec);
    flushTranscript(transcriptPath, transcript);
    out.progress(
      `  attempt ${r.agentName} -> ${r.status} (exit ${r.exitCode ?? "n/a"}, ${r.durationMs}ms)`,
    );
    // Surface the failure reason (incl. the driver's stderr tail carried on
    // the EXIT failure message) as a human-mode diagnostic (reviewer finding:
    // stderr was collected but never shown).
    if (r.status === "failure" && r.failure) {
      out.progress(`    failure [${r.failure.code}]: ${r.failure.message}`);
    }
  };

  // Attempts whose driver probe failed become synthetic DRIVER_UNREACHABLE
  // failures: recorded, never spawned, no workspace. Reused results are
  // carried over silently (no new attempt.finished — the history already
  // has one).
  const presolved: AttemptResult[] = [...reusedByAttemptId.values()];
  for (const spec of rerunSpecs) {
    const probe = probeByDriver.get(spec.driverId);
    if (probe === undefined || probe.status === "success") continue;
    const synthetic: AttemptResult = {
      attemptId: spec.attemptId,
      agentId: spec.agentId,
      agentName: spec.agentName,
      driverId: spec.driverId,
      modelId: spec.modelId,
      status: "failure",
      output: "",
      exitCode: null,
      durationMs: probe.durationMs,
      workspace: spec.cwd,
      failure: {
        code: "DRIVER_UNREACHABLE",
        message: `driver ${spec.driverId} health probe failed: ${probe.failure?.message ?? "no output"}`,
      },
    };
    presolved.push(synthetic);
    recordAttemptFinished(synthetic);
  }
  const runnableSpecs = rerunSpecs.filter(
    (s) => probeByDriver.get(s.driverId)?.status === "success",
  );

  let outcome: ReviewOutcome;
  try {
    // Aggregator driver unreachable → the whole run aborts BEFORE any attempt
    // spawn or workspace creation: exit 3, deterministic INCOMPLETE report.
    const aggProbe = probeByDriver.get(aggregatorAgent.driverSelection.driverId);
    if (aggProbe === undefined || aggProbe.status !== "success") {
      // Attempts whose own driver probed OK never run either (the run aborts
      // before the runner): record them as CANCELLED so every attempt has a
      // terminal transcript record and appears in the report.
      for (const spec of runnableSpecs) {
        const cancelled: AttemptResult = {
          attemptId: spec.attemptId,
          agentId: spec.agentId,
          agentName: spec.agentName,
          driverId: spec.driverId,
          modelId: spec.modelId,
          status: "failure",
          output: "",
          exitCode: null,
          durationMs: 0,
          workspace: spec.cwd,
          failure: {
            code: "CANCELLED",
            message: "run aborted before this attempt started (aggregator driver unreachable)",
          },
        };
        presolved.push(cancelled);
        recordAttemptFinished(cancelled);
      }
      const params = buildExecuteParams();
      outcome = await finalize(params, new Date().toISOString(), mergeOrdered(presolved), null, {
        status: "failed",
        exitCode: EXIT.hostUnavailable,
        incomplete: true,
        failure: {
          phase: "probe",
          code: "DRIVER_UNREACHABLE",
          message: `aggregator driver ${aggregatorAgent.driverSelection.driverId} health probe failed: ${aggProbe?.failure?.message ?? "no probe result"}`,
        },
      });
    } else {
      // Workspaces are created only now — after probing — and only for
      // attempts that will actually spawn (plus the Aggregator). A rerun gets a
      // PRISTINE workspace: delete-then-create, never a recursive mkdir over
      // leftovers — a stale checkout would interfere with cloning and a stale
      // `.last-message.md` would let a no-output process pass off the previous
      // round's file as this round's deliverable (reviewer finding). Reused
      // attempts are neither created nor deleted.
      for (const spec of runnableSpecs) recreateWorkspace(spec.cwd, runDir);
      recreateWorkspace(aggregatorWorkspace, runDir);
      const params = buildExecuteParams();
      outcome = await executeReview(params, runnableSpecs);
    }
    // Await stdout flush of the final document BEFORE removing the signal
    // handlers and throwing the exit sentinel — main() process.exit()s on
    // ReviewExit, and a SIGINT landing mid-flush must neither truncate the
    // JSON via Node's default signal kill nor exit 0 after an interruption
    // (reviewer finding: handlers were removed before the final finish).
    await out.finish(outcome, (d) => renderHuman(d as ReviewOutcome));
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  // A signal that arrived only during the final flush (executeReview already
  // completed un-aborted) is still an interruption: report 130 — never a
  // silent 0, and never let an earlier 4/5 mask the signal (POSIX: death by
  // SIGINT is 130). Runs already aborted inside executeReview carry 130.
  const exitCode = signaled ? EXIT.interrupted : outcome.exitCode;
  throw new ReviewExit(exitCode);

  /** Assemble the shared finalize/execute params for this run. */
  function buildExecuteParams(): ExecuteParams {
    return {
      runId,
      runDir,
      transcriptPath,
      reportPath,
      outPath: values.out as string | undefined,
      startedAt,
      presolved,
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
      recordAttemptFinished,
      // Human-mode heartbeat only (plan: JSON mode emits no human heartbeat).
      heartbeat: out.json
        ? undefined
        : { intervalMs: deps.heartbeatIntervalMs, timers: deps.timers },
    };
  }
}

/** Merge pre-resolved (reused / synthetic) and freshly-run results back into
 * the user-declared attempt order. */
function mergeOrdered(results: AttemptResult[]): AttemptResult[] {
  return [...results].sort((a, b) => attemptIndex(a.attemptId) - attemptIndex(b.attemptId));
}

interface ExecuteParams {
  runId: string;
  runDir: string;
  transcriptPath: string;
  reportPath: string;
  outPath?: string;
  startedAt: string;
  /** Attempts already decided before the runner: reused (from --resume) and
   * synthetic probe failures (DRIVER_UNREACHABLE), in any order — merged back
   * into declared attempt order by `mergeOrdered`. */
  presolved: AttemptResult[];
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
  /** Single writer for real + synthetic attempt results (transcript, progress,
   * outcome accounting). */
  recordAttemptFinished: (r: AttemptResult) => void;
  /** Human heartbeat config; undefined in JSON mode. */
  heartbeat?: { intervalMs?: number; timers?: RunnerTimers };
}

async function executeReview(p: ExecuteParams, specs: AttemptSpec[]): Promise<ReviewOutcome> {
  // Track results as they finish so a mid-run callback failure can still
  // finalize a report with the Attempts that DID complete (reviewer finding:
  // finalizing with [] wrote a false "no attempts ran" report).
  const completed: AttemptResult[] = [];
  const runnerOpts = {
    timeoutMs: p.timeoutMs,
    concurrency: p.concurrency,
    signal: p.signal,
    spawnImpl: p.spawnImpl,
    heartbeatIntervalMs: p.heartbeat?.intervalMs,
    timers: p.heartbeat?.timers,
    onHeartbeat:
      p.heartbeat === undefined
        ? undefined
        : (_attemptId: string, agentName: string, elapsedMs: number) => {
            p.out.progress(`  attempt ${agentName} 仍在运行 (${formatElapsed(elapsedMs)})`);
          },
    onAttemptFinish: (r: AttemptResult) => {
      completed.push(r);
      p.recordAttemptFinished(r);
    },
  };

  let attemptsOutcome: RunAttemptsOutcome;
  try {
    attemptsOutcome = await runAttempts(specs, runnerOpts);
  } catch (error) {
    // A run-level callback (e.g. the transcript flush in onAttemptFinish)
    // failed mid-run. The runner has already killed every in-flight child;
    // persist a best-effort INCOMPLETE report + review.finished instead of
    // escaping as a bare CliError with no ReviewOutcome (reviewer finding).
    // Aborted runs keep the interrupted/130 semantics.
    const message = error instanceof Error ? error.message : String(error);
    // Restore the original spec order — `completed` is in parallel-completion
    // order, and the report/Outcome must list Attempts deterministically in
    // the user-declared agent order (reviewer finding).
    const ordered = mergeOrdered([...completed, ...p.presolved]);
    if (p.signal.aborted) {
      return finalize(p, new Date().toISOString(), ordered, null, {
        status: "interrupted",
        exitCode: EXIT.interrupted,
        incomplete: true,
        failure: { phase: "review", code: "ABORTED", message: "run aborted by signal" },
      });
    }
    return finalize(p, new Date().toISOString(), ordered, null, {
      status: "failed",
      exitCode: EXIT.io,
      incomplete: true,
      failure: { phase: "transcript", code: "IO_TRANSCRIPT", message },
    });
  }
  const { aborted } = attemptsOutcome;
  const results = mergeOrdered([...attemptsOutcome.results, ...p.presolved]);

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
    activity: aggregation.activity,
  };
  p.transcript.push(aggRec);
  try {
    flushTranscript(p.transcriptPath, p.transcript);
  } catch (error) {
    // Persisting aggregation.finished failed: route through finalize so the run
    // still produces an INCOMPLETE report + ReviewOutcome (exit 5; 130 if the
    // abort already fired) instead of escaping as a bare CliError (reviewer
    // finding).
    const message = error instanceof Error ? error.message : String(error);
    if (p.signal.aborted) {
      return finalize(p, new Date().toISOString(), results, aggregation, {
        status: "interrupted",
        exitCode: EXIT.interrupted,
        incomplete: true,
        failure: { phase: "aggregation", code: "ABORTED", message: "run aborted by signal" },
      });
    }
    return finalize(p, new Date().toISOString(), results, aggregation, {
      status: "failed",
      exitCode: EXIT.io,
      incomplete: true,
      failure: { phase: "transcript", code: "IO_TRANSCRIPT", message },
    });
  }
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
    failurePhase: spec.failure?.phase,
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
  // failures surface via exitCode (5) + `failure` and ALWAYS mark the outcome
  // incomplete (any missing artifact makes the durable record set incomplete);
  // a failed CANONICAL report write additionally flips status to "failed"
  // (nothing durable exists to contradict it). review.finished is persisted
  // with these same fields so the on-disk record and the ReviewOutcome agree.
  const computeOutcome = (io: typeof ioFailure) => {
    // Interrupted (130) outranks artifact-IO (5): an aborted run must keep its
    // signal exit code even when the best-effort finalize also hit an IO error
    // (reviewer finding: artifact IO unconditionally overrode 130 with 5).
    const exitCode =
      spec.exitCode === EXIT.interrupted
        ? EXIT.interrupted
        : io !== undefined
          ? EXIT.io
          : spec.exitCode;
    const status: FinalizeSpec["status"] =
      io !== undefined && io.phase === "report" ? "failed" : spec.status;
    const incomplete = spec.incomplete || io !== undefined;
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
    activity: r.activity,
    reused: r.reused,
  };
}

/** Render an elapsed duration as `Xm Ys` for the human heartbeat line. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function createWorkspace(workspace: string): void {
  try {
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw errors.io(`failed to create workspace dir: ${ioName(cause)}`, { cause: ioName(cause) });
  }
}

/** Delete-then-create so a rerun attempt starts from an EMPTY workspace (no
 * leftover checkout, no stale `.last-message.md`). Refuses (exit 5) when the
 * run dir or an existing workspace is a symlink, or when the workspace's REAL
 * path escapes the run dir's real path — a recursive rm would otherwise follow
 * the link and delete content OUTSIDE the run tree (resume scenario; reviewer
 * finding). */
function recreateWorkspace(workspace: string, runDir: string): void {
  let runStat: Stats;
  try {
    runStat = lstatSync(runDir);
  } catch (cause) {
    throw errors.io(`failed to stat the run dir before clearing a workspace: ${ioName(cause)}`, {
      cause: ioName(cause),
    });
  }
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
    throw errors.io("the run dir is not a real directory (refusing to clear workspaces inside it)");
  }
  let wsStat: Stats | null = null;
  try {
    wsStat = lstatSync(workspace);
  } catch (cause) {
    if (ioCode(cause) !== "ENOENT") {
      throw errors.io(`failed to stat workspace dir: ${ioName(cause)}`, { cause: ioName(cause) });
    }
  }
  if (wsStat !== null) {
    if (!wsStat.isDirectory() || wsStat.isSymbolicLink()) {
      throw errors.io("the workspace path is not a real directory (refusing to remove it)");
    }
    // realpath containment: a symlinked intermediate (e.g. `workspaces/`)
    // would defeat a lexical resolve() check.
    let realRunDir: string;
    let realWorkspace: string;
    try {
      realRunDir = realpathSync(runDir);
      realWorkspace = realpathSync(workspace);
    } catch (cause) {
      throw errors.io(`failed to resolve real workspace paths: ${ioName(cause)}`, {
        cause: ioName(cause),
      });
    }
    if (!realWorkspace.startsWith(realRunDir + sep)) {
      throw errors.io("the workspace resolves outside the run dir (refusing to remove it)");
    }
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch (cause) {
      throw errors.io(`failed to clear workspace dir: ${ioName(cause)}`, { cause: ioName(cause) });
    }
  }
  createWorkspace(workspace);
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
  // Node schedules setTimeout with a 32-bit signed delay; larger values fire
  // after ~1ms (TimeoutOverflowWarning), which would instantly "time out" every
  // full-permission Attempt (reviewer finding). Reject instead of clamping so a
  // typo surfaces.
  if (ms > MAX_TIMEOUT_MS) {
    throw errors.usage(`--timeout must be <= ${MAX_TIMEOUT_MS}ms, got "${raw}"`);
  }
  return ms;
}

/** Node's setTimeout 32-bit signed ceiling (2^31 - 1 ms ≈ 24.8 days). */
const MAX_TIMEOUT_MS = 2_147_483_647;

function parsePositiveInt(raw: string, fieldName: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw errors.usage(`--${fieldName} must be a positive integer, got "${raw}"`);
  }
  return Number(raw);
}

/** Numeric suffix of an attemptId ("attempt-3" → 3); unknown ids sort last. */
function attemptIndex(attemptId: string): number {
  const match = /^attempt-(\d+)$/.exec(attemptId);
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

function ioName(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return "IOFailure";
}

function ioCode(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | undefined)?.code;
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
