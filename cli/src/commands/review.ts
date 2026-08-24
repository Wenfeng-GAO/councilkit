import { randomUUID } from "node:crypto";
import { type Stats, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CLI_RUN_STATUS_FILE,
  type CliRunLiveHeartbeat,
  liveStateFromRecords,
  withLiveHeartbeats,
} from "@shared/runtime/cli-run-progress";
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
 * `--pr <url>` / a positional PR URL and `--task "<text>"` are mutually
 * exclusive; one is required. A positional HTTP(S) URL is the same as `--pr`.
 * With neither `--council` nor `--agents`, the default council is `pr-jury`.
 * Exit codes follow the existing table (0/2/4/5/130).
 */
import { z } from "zod";
import {
  renderReviewReport,
  writeCanonicalReviewReport,
  writeReviewReportCopy,
} from "../auto/aggregate";
import { type RunCommand, defaultRunCommand, inspectPullRequest } from "../auto/checkout-pr";
import {
  type AttemptSpec,
  DRIVER_PROBE_PROMPT,
  buildProbeSpec,
  buildSpawnSpec,
} from "../auto/driver-commands";
import { formatDurationMs } from "../auto/duration";
import { addDetachedWorktree, resolveLocalPrSha } from "../auto/git-worktree";
import {
  type FindingsFile,
  againstDiffRange,
  formatLedgerForPrompt,
  loadAgainstContext,
  persistFindingsFromReport,
} from "../auto/ledger";
import { LiveEventWriter, type RawLiveEvent } from "../auto/live-events";
import { type LocalRepo, resolveLocalRepo } from "../auto/local-repo";
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
import { CliError, EXIT, errors } from "../errors";
import {
  type TrustedRoot,
  assertWithinRoot,
  bindTrustedRoot,
  revalidateTrustedRoot,
} from "../fs-safe";
import { PR_JURY_COUNCIL_NAME } from "../init/defaults";
import type { OutputSink } from "../output";
import { atomicWriteFile } from "../store/atomic-write";
import { resolvePaths } from "../store/paths";
import type { AgentRecord, CouncilRecord } from "../store/schemas";
import { Store } from "../store/store";
import { DEFAULT_CODEX_TIMEOUT_MS, parseFlags, parseJsonFlag, parseTimeoutMs } from "./parse";

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
  runCommand?: RunCommand;
  /** Skip remote fetch; use this git ref in `--repo` (tests use HEAD). */
  worktreeRef?: string;
  /** Called as soon as the run id is known (fresh or resumed). */
  onRunCreated?: (runId: string) => void;
}

/** Health-probe timeout (P-1): a driver that cannot answer a minimal prompt
 * within this window is treated as unreachable. 60s, not 10s: a cold minimal
 * call on a real backend (codex cold start, cfuse route handshake) takes
 * 20-60s; a tighter budget false-negatives healthy drivers (G4' evidence:
 * codex probed "unreachable" at 10s while fully functional). */
const PROBE_TIMEOUT_MS = 60_000;

/** `--resume` accepts only a real run id — anything else (path separators,
 * `..`, empty) is a usage error, never a path-traversal attempt. */
const RUN_ID_PATTERN = /^ck-review-[0-9a-fA-F-]+$/;

export async function runReview(
  argv: string[],
  out: OutputSink,
  deps: ReviewDeps = {},
): Promise<void> {
  const { values, positionals } = parseFlags(
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
        "codex-timeout": { type: "string" },
        concurrency: { type: "string" },
        out: { type: "string" },
        resume: { type: "string" },
        "run-id": { type: "string" },
        repo: { type: "string" },
        against: { type: "string" },
      },
      allowPositionals: 1,
    },
    argv,
  );

  // --- task (mutually exclusive, one required, non-blank) -----------------
  const positionalPr = positionals[0];
  if (positionalPr !== undefined) {
    if (!isHttpUrl(positionalPr)) {
      throw errors.usage(`positional argument must be a PR URL (got "${positionalPr}")`);
    }
    if (values.pr !== undefined) {
      throw errors.usage("pass the PR URL as a positional or --pr, not both");
    }
  }
  const prRaw = positionalPr ?? (values.pr as string | undefined);
  const hasPr = prRaw !== undefined;
  const hasTask = values.task !== undefined;
  if (hasPr && hasTask) {
    throw errors.usage("--pr and --task are mutually exclusive");
  }
  if (!hasPr && !hasTask) {
    throw errors.usage("one of a PR URL, --pr, or --task is required");
  }
  if (hasPr && prRaw.trim().length === 0) {
    throw errors.usage("--pr must not be empty or whitespace");
  }
  if (hasTask && (values.task as string).trim().length === 0) {
    throw errors.usage("--task must not be empty or whitespace");
  }
  const task: ReviewTask = {
    pr: hasPr ? prRaw.trim() : undefined,
    task: hasTask ? (values.task as string).trim() : undefined,
    focus: values.focus !== undefined ? (values.focus as string) : undefined,
    councilTopic: undefined,
  };

  const assignedRunIdRaw = values["run-id"] as string | undefined;
  const resumeRaw = values.resume as string | undefined;
  if (assignedRunIdRaw !== undefined && resumeRaw !== undefined) {
    throw errors.usage("--run-id and --resume are mutually exclusive");
  }
  if (assignedRunIdRaw !== undefined) {
    const assigned = assignedRunIdRaw.trim();
    if (!RUN_ID_PATTERN.test(assigned)) {
      throw errors.usage(`--run-id must be a ck-review-<uuid> run id, got "${assignedRunIdRaw}"`);
    }
  }

  // --- agents / aggregator resolution -------------------------------------
  const store = new Store();
  const paths = resolvePaths();
  let attemptAgents: AgentRecord[];
  let aggregatorAgent: AgentRecord;
  let councilTopic: string | undefined;

  const defaultedCouncil =
    values.council === undefined && values.agents === undefined && values.aggregator === undefined;
  const councilRef = defaultedCouncil
    ? PR_JURY_COUNCIL_NAME
    : (values.council as string | undefined);

  if (councilRef !== undefined) {
    if (values.agents !== undefined || values.aggregator !== undefined) {
      throw errors.usage("--council is mutually exclusive with --agents/--aggregator");
    }
    let council: CouncilRecord;
    try {
      council = store.getCouncil(councilRef);
    } catch (error) {
      if (defaultedCouncil) {
        throw errors.usage(
          "no --council/--agents given and default pr-jury is missing; run `councilkit init` or pass --council/--agents",
        );
      }
      throw error;
    }
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

  const againstRaw = values.against as string | undefined;
  let againstFindings: FindingsFile | null = null;
  if (againstRaw !== undefined) {
    const againstId = againstRaw.trim();
    if (!RUN_ID_PATTERN.test(againstId)) {
      throw errors.usage(`--against must be a ck-review-<uuid> run id, got "${againstRaw}"`);
    }
    if (!existsSync(paths.report(againstId)) && !existsSync(paths.findings(againstId))) {
      throw errors.usage(`--against ${againstId} has no report.md or findings.json`);
    }
    task.against = againstId;
    const againstCtx = loadAgainstContext(paths.runDir(againstId), againstId);
    againstFindings = againstCtx.findings;
    task.againstRange = againstCtx.range ?? undefined;
    task.againstLedger = formatLedgerForPrompt(againstCtx.findings, againstCtx.range);
  }

  // --- options ------------------------------------------------------------
  const timeoutMs = parseTimeoutMs(values.timeout as string | undefined);
  const codexTimeoutMs = parseTimeoutMs(
    values["codex-timeout"] as string | undefined,
    DEFAULT_CODEX_TIMEOUT_MS,
    "codex-timeout",
  );
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const env = process.env;
  let localRepo: LocalRepo | null = null;
  if (task.pr) {
    localRepo = await resolveLocalRepo({
      pr: task.pr,
      repoFlag: values.repo as string | undefined,
      runCommand,
      env,
    });
    out.progress(`  local repo: ${localRepo.path} (${localRepo.source})`);
  }
  const concurrencyRaw = values.concurrency as string | undefined;
  const concurrency =
    concurrencyRaw !== undefined ? parsePositiveInt(concurrencyRaw, "concurrency") : undefined;

  // --- resume: load the prior run + validate immutable inputs (P2-2) -------
  let priorRecords: ReviewTranscriptRecord[] = [];
  let priorStartedAt: string | undefined;
  const reusedByAttemptId = new Map<string, AttemptResult>();
  const resumedAfterFailureIds = new Set<string>();
  // The runs root is bound ONCE at the resume entry and the SAME binding is
  // carried through every later resume write/rebuild path (transcript flush,
  // report render, workspace recreation), revalidated at each use — never
  // rebound from the current runsRoot, which could have been swapped in
  // between (reviewer finding).
  let resumeRoot: TrustedRoot | null = null;
  // The trusted runs root bound for THIS run (fresh or carried from a resume).
  // Hoisted to function scope so `buildExecuteParams` can thread it to
  // `executeReview`, which wires the retry-time workspace rebuild. Assigned in
  // the spawn branch below; stays null on the aggregator-unreachable path where
  // `executeReview` is never called.
  let trustedRoot: TrustedRoot | null = null;
  if (resumeRaw !== undefined) {
    const resumeId = resumeRaw.trim();
    if (!RUN_ID_PATTERN.test(resumeId)) {
      throw errors.usage(`--resume must be a ck-review-<uuid> run id, got "${resumeRaw}"`);
    }
    // Fail-closed path validation BEFORE any resume read or write (transcript
    // load, probes, the review.resumed append): a run dir swapped for a
    // symlink must be refused here, not after its transcript was atomically
    // rewritten (reviewer finding). A missing runs root / run dir falls
    // through to the transcript read, which reports "nothing to resume from".
    resumeRoot = bindTrustedRoot(paths.runsRoot);
    if (resumeRoot !== null) {
      const resumeRunDir = paths.runDir(resumeId);
      let runStat: Stats | null = null;
      try {
        runStat = lstatSync(resumeRunDir);
      } catch (cause) {
        if (ioCode(cause) !== "ENOENT") {
          throw errors.io(`failed to stat the run dir before resuming: ${ioName(cause)}`, {
            cause: ioName(cause),
          });
        }
      }
      if (runStat !== null && (!runStat.isDirectory() || runStat.isSymbolicLink())) {
        throw errors.io("the run dir is not a real directory (refusing to resume)");
      }
      assertWithinRoot(resumeRoot, resumeRunDir);
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
    if ((started.task.against ?? undefined) !== task.against) {
      throw errors.usage("--against must match the resumed run");
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
          // Preserve the retry chain on re-render so the appendix keeps the
          // 「第 1 次尝试（失败，已重试）」 mark across a resume (plan §"瞬态重试").
          attemptNumber: rec.attemptNumber,
          retryOf: rec.retryOf,
          resumedAfterFailure:
            (rec as { resumedAfterFailure?: boolean }).resumedAfterFailure === true
              ? true
              : undefined,
        });
      }
    }
    // Attempts that FAILED in the prior run and are being rerun now: mark the
    // fresh result so the appendix can say 「上一轮失败,resume 重跑」 instead
    // of silently presenting it as a first-try success (reviewer finding).
    for (const meta of started.attempts) {
      if (reusedByAttemptId.has(meta.attemptId)) continue;
      if (lastFinished.has(meta.attemptId)) resumedAfterFailureIds.add(meta.attemptId);
    }
  }

  // --- run scaffold -------------------------------------------------------
  // A resume CONTINUES the same run id: records are appended to the existing
  // transcript and report.md is re-rendered, never a parallel run.
  const assignedRunId = assignedRunIdRaw !== undefined ? assignedRunIdRaw.trim() : undefined;
  const runId =
    assignedRunId !== undefined
      ? assignedRunId
      : resumeRaw !== undefined
        ? resumeRaw.trim()
        : `ck-review-${randomUUID()}`;
  if (assignedRunId !== undefined && existsSync(paths.transcript(runId))) {
    throw errors.usage(`--run-id ${runId} already exists`);
  }
  deps.onRunCreated?.(runId);
  const runDir = paths.runDir(runId);
  const transcriptPath = paths.transcript(runId);
  const reportPath = paths.report(runId);
  const startedAt = priorStartedAt ?? new Date().toISOString();
  let reviewedSha: string | null = null;
  // The run dir must exist before the first transcript flush — but
  // `workspaces/` is created only AFTER probing, for attempts that will
  // actually spawn (a probe must be able to prove no workspace existed yet).
  createWorkspace(runDir);

  const isReused = (attemptId: string): boolean => reusedByAttemptId.has(attemptId);

  // Cost-informed attempt list (printed before any workspace/spawn).
  out.progress(`review ${runId} starting${resumeRaw !== undefined ? " (resumed)" : ""}`);
  out.progress(`  task: ${task.pr ? `PR ${task.pr}` : "<task text>"}`);
  if (task.against) {
    out.progress(`  against: ${task.against}${task.againstRange ? ` ${task.againstRange}` : ""}`);
  }
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
        workspaceMode: localRepo !== null ? "worktree" : "empty",
      });
      const spec = buildSpawnSpec(a, { attemptId, workspace, prompt });
      spec.timeoutMs = timeoutForDriver(spec.driverId, timeoutMs, codexTimeoutMs);
      rerunSpecs.push(spec);
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
  const probeCwd = join(runDir, "probe");
  mkdirSync(probeCwd, { recursive: true, mode: 0o700 });
  for (const [driverId, probeAgent] of probeAgents) {
    const spec = buildProbeSpec(probeAgent, {
      probeId: `probe-${driverId}`,
      cwd: probeCwd,
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
        against: task.against,
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
  const liveBeats = new Map<string, CliRunLiveHeartbeat>();
  flushTranscript(transcriptPath, transcript, resumeRoot, liveBeats);

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
      // Transient-retry chain (plan §"瞬态重试"): every physical execution is
      // recorded; the retried second try carries retryOf=1. Older records and
      // synthetic results simply omit both.
      attemptNumber: r.attemptNumber,
      retryOf: r.retryOf,
      resumedAfterFailure: r.resumedAfterFailure === true ? true : undefined,
    };
    transcript.push(rec);
    liveBeats.delete(r.attemptId);
    flushTranscript(transcriptPath, transcript, resumeRoot, liveBeats);
    out.progress(
      `  attempt ${r.agentName} -> ${r.status} (exit ${r.exitCode ?? "n/a"}, ${formatDurationMs(r.durationMs)})`,
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
      // Bind the trusted runs root ONCE (lstat + realpath): every workspace
      // recreation — delete AND create — must stay under THIS pinned root,
      // never under a run dir realpath that a swapped symlink could redirect
      // outside the runs tree (reviewer findings). A RESUME reuses the root
      // bound at the entry (revalidated here: a root swapped since entry —
      // dev/ino changed — is fail-closed exit 5); it NEVER rebinds the
      // current runsRoot, which would silently bless the swap.
      let trustedRootBound: TrustedRoot | null;
      if (resumeRoot !== null) {
        revalidateTrustedRoot(resumeRoot);
        trustedRootBound = resumeRoot;
      } else {
        trustedRootBound = bindTrustedRoot(paths.runsRoot);
      }
      if (trustedRootBound === null) {
        throw errors.io("the runs dir is missing (refusing to recreate workspaces)");
      }
      trustedRoot = trustedRootBound;
      if (localRepo !== null && task.pr) {
        let branch = "HEAD";
        if (deps.worktreeRef === undefined) {
          const meta = await inspectPullRequest(task.pr, runCommand, env);
          branch = meta.branch;
          out.progress(`  worktree branch: ${branch}`);
        }
        const sha = await resolveLocalPrSha({
          repo: localRepo.path,
          branch,
          pinnedRef: deps.worktreeRef,
          runCommand,
          env,
        });
        reviewedSha = sha;
        out.progress(`  worktree ${sha.slice(0, 12)}`);
        if (againstFindings?.sha) {
          const widened = againstDiffRange({
            findingsSha: againstFindings.sha,
            currentSha: sha,
            fallback: task.againstRange ?? null,
          });
          if (widened && widened !== task.againstRange) {
            task.againstRange = widened;
            task.againstLedger = formatLedgerForPrompt(againstFindings, widened);
            for (let i = 0; i < rerunSpecs.length; i++) {
              const agent = rerunAgents[i];
              const spec = rerunSpecs[i];
              if (!agent || !spec) continue;
              spec.prompt = buildAttemptPrompt({
                agentName: agent.name,
                personaPrompt: agent.personaPrompt,
                task,
                workspaceMode: "worktree",
              });
            }
            out.progress(`  against range: ${widened}`);
          }
        }
        createWorkspace(join(runDir, "workspaces"));
        for (const spec of runnableSpecs) {
          spec.sourceRepo = localRepo.path;
          spec.sourceSha = sha;
          await addDetachedWorktree({
            repo: localRepo.path,
            dest: spec.cwd,
            sha,
            runDir,
            root: trustedRoot,
            runCommand,
            env,
          });
        }
      } else {
        for (const spec of runnableSpecs) recreateWorkspace(spec.cwd, runDir, trustedRoot);
      }
      recreateWorkspace(aggregatorWorkspace, runDir, trustedRoot);
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
      codexTimeoutMs,
      concurrency,
      signal: controller.signal,
      spawnImpl: deps.spawnImpl,
      out,
      transcript,
      recordAttemptFinished,
      resumeRoot,
      trustedRoot,
      resumedAfterFailureIds,
      liveBeats,
      runCommand,
      reviewedSha,
      // Heartbeat always writes status.json (including --json). Human mode
      // also prints a 仍在运行 line; JSON mode stays silent on stderr.
      heartbeat: { intervalMs: deps.heartbeatIntervalMs, timers: deps.timers },
      humanHeartbeat: !out.json,
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
  codexTimeoutMs: number;
  concurrency?: number;
  signal: AbortSignal;
  spawnImpl?: SpawnImpl;
  out: OutputSink;
  transcript: ReviewTranscriptRecord[];
  /** Single writer for real + synthetic attempt results (transcript, progress,
   * outcome accounting). */
  recordAttemptFinished: (r: AttemptResult) => void;
  /** The runs-root binding from the resume entry (null for a fresh run):
   * revalidated before every resume-related write below, never rebound. */
  resumeRoot: TrustedRoot | null;
  /** Attempt ids whose prior-run terminal record was a failure (resume only):
   * their fresh results get `resumedAfterFailure` for the appendix mark. */
  resumedAfterFailureIds?: Set<string>;
  /** The trusted runs root bound for THIS run (fresh or carried from a resume).
   * Non-null whenever `executeReview` runs — it is null only on the
   * aggregator-unreachable path that finalizes without spawning. Used to rebuild
   * a pristine workspace before the transient-retry spawn (reviewer finding). */
  trustedRoot: TrustedRoot | null;
  /** Heartbeat timers (always set so status.json updates mid-attempt). */
  heartbeat?: { intervalMs?: number; timers?: RunnerTimers };
  /** Print human 仍在运行 lines (false in --json). */
  humanHeartbeat?: boolean;
  liveBeats: Map<string, CliRunLiveHeartbeat>;
  runCommand: RunCommand;
  reviewedSha: string | null;
}

async function executeReview(p: ExecuteParams, specs: AttemptSpec[]): Promise<ReviewOutcome> {
  // Track results as they finish so a mid-run callback failure can still
  // finalize a report with the Attempts that DID complete (reviewer finding:
  // finalizing with [] wrote a false "no attempts ran" report).
  const completed: AttemptResult[] = [];
  const liveWriter = new LiveEventWriter(p.runDir);
  const onLiveEvent = (attemptId: string, events: readonly RawLiveEvent[]): void => {
    liveWriter.append(attemptId, events);
  };
  const runnerOpts = {
    timeoutMs: p.timeoutMs,
    concurrency: p.concurrency,
    signal: p.signal,
    spawnImpl: p.spawnImpl,
    heartbeatIntervalMs: p.heartbeat?.intervalMs,
    timers: p.heartbeat?.timers,
    onAttemptStart: (attemptId: string) => {
      noteLiveBeat(p, attemptId, 0, null, true);
    },
    onHeartbeat: (
      attemptId: string,
      agentName: string,
      elapsedMs: number,
      snapshot?: { lastActivity: string | null },
    ) => {
      noteLiveBeat(p, attemptId, elapsedMs, snapshot?.lastActivity ?? null, true);
      if (p.humanHeartbeat === true) {
        p.out.progress(`  attempt ${agentName} 仍在运行 (${formatDurationMs(elapsedMs)})`);
      }
    },
    onActivity: (attemptId: string, lastActivity: string) => {
      noteLiveBeat(p, attemptId, undefined, lastActivity, true);
    },
    onLiveEvent,
    onAttemptFinish: (r: AttemptResult) => {
      liveWriter.flush(r.attemptId);
      // Mark resume-rerun results BEFORE persistence — assigning after
      // runAttempts returns would leave attempt.finished without the flag, and
      // the next resume would silently lose the history (reviewer finding).
      if (p.resumedAfterFailureIds?.has(r.attemptId)) r.resumedAfterFailure = true;
      // A retried Attempt fires this callback twice (attemptNumber 1 then 2);
      // keep only the LAST result per logical attemptId so a mid-run callback
      // failure never double-counts the same Attempt in the error-path report
      // (plan §risks: completed 按 attemptId 去重).
      const idx = completed.findIndex((x) => x.attemptId === r.attemptId);
      if (idx === -1) completed.push(r);
      else completed[idx] = r;
      p.recordAttemptFinished(r);
    },
    // Rebuild a pristine workspace (fs-safe delete-then-recreate under the
    // bound runs root) before the retry spawn, so the failed first try's
    // leftover cwd — notably a codex `.last-message.md` — cannot pass a
    // no-output second try off as a real deliverable (reviewer finding).
    // Workspace/fs-safe errors thrown here are tagged `detail.phase = "workspace"`
    // so the run-level catch below can map them to phase=workspace instead of
    // the default transcript phase (reviewer finding: a retry rebuild failure
    // was uniformly reported as phase=transcript/code=IO_TRANSCRIPT).
    rebuildWorkspaceBeforeRetry:
      p.trustedRoot === null
        ? undefined
        : async (s: AttemptSpec) => {
            try {
              if (s.sourceRepo && s.sourceSha) {
                await addDetachedWorktree({
                  repo: s.sourceRepo,
                  dest: s.cwd,
                  sha: s.sourceSha,
                  runDir: p.runDir,
                  root: p.trustedRoot as TrustedRoot,
                  runCommand: p.runCommand,
                  env: process.env,
                });
              } else {
                recreateWorkspace(s.cwd, p.runDir, p.trustedRoot as TrustedRoot);
              }
            } catch (error) {
              if (error instanceof CliError) {
                throw new CliError({
                  code: error.exitCode,
                  message: error.message,
                  detail: { ...(error.detail ?? {}), phase: "workspace" },
                  cause: error,
                });
              }
              throw error;
            }
          },
  };

  let attemptsOutcome: RunAttemptsOutcome;
  try {
    attemptsOutcome = await runAttempts(specs, runnerOpts);
  } catch (error) {
    // A run-level callback failed mid-run — either the transcript flush in
    // onAttemptFinish (an artifact-IO fault) OR the retry workspace rebuild
    // (a fs-safe/workspace fault). The runner has already killed every
    // in-flight child; persist a best-effort INCOMPLETE report + review.finished
    // instead of escaping as a bare CliError with no ReviewOutcome (reviewer
    // finding). Aborted runs keep the interrupted/130 semantics. The two fault
    // sources are distinguished so the outcome's failure phase is reported
    // faithfully (reviewer finding: both were mapped to phase=transcript).
    const message = error instanceof Error ? error.message : String(error);
    const isWorkspaceFault = error instanceof CliError && error.detail?.phase === "workspace";
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
      failure: isWorkspaceFault
        ? { phase: "workspace", code: "IO_WORKSPACE", message }
        : { phase: "transcript", code: "IO_TRANSCRIPT", message },
    });
  }
  const { aborted } = attemptsOutcome;
  for (const r of attemptsOutcome.results) {
    if (p.resumedAfterFailureIds?.has(r.attemptId)) r.resumedAfterFailure = true;
  }
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
  noteLiveBeat(p, "aggregator", 0, null, true);
  const aggregation = await spawnOnce(aggregatorSpec, {
    timeoutMs: timeoutForDriver(
      p.aggregatorAgent.driverSelection.driverId,
      p.timeoutMs,
      p.codexTimeoutMs,
    ),
    signal: p.signal,
    spawnImpl: p.spawnImpl,
    heartbeatIntervalMs: p.heartbeat?.intervalMs,
    timers: p.heartbeat?.timers,
    onHeartbeat: (
      attemptId: string,
      agentName: string,
      elapsedMs: number,
      snapshot?: { lastActivity: string | null },
    ) => {
      noteLiveBeat(p, attemptId, elapsedMs, snapshot?.lastActivity ?? null, true);
      if (p.humanHeartbeat === true) {
        p.out.progress(`  aggregator ${agentName} 仍在运行 (${formatDurationMs(elapsedMs)})`);
      }
    },
    onActivity: (attemptId, lastActivity) => {
      noteLiveBeat(p, attemptId, undefined, lastActivity, true);
    },
    onLiveEvent,
  });
  liveWriter.flush(aggregation.attemptId);

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
    p.liveBeats.delete(aggregation.attemptId);
    flushTranscript(p.transcriptPath, p.transcript, p.resumeRoot, p.liveBeats);
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
    `  aggregator -> ${aggregation.status} (exit ${aggregation.exitCode ?? "n/a"}, ${formatDurationMs(aggregation.durationMs)})`,
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
  // A resume writes the report + final transcript under the SAME root bound at
  // the entry — revalidated here (fail-closed exit 5 if swapped), never
  // rebound from the current runsRoot.
  if (p.resumeRoot !== null) revalidateTrustedRoot(p.resumeRoot);
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
  if (ioFailure === undefined) {
    try {
      persistFindingsFromReport({
        runDir: p.runDir,
        runId: p.runId,
        markdown,
        sha: p.reviewedSha,
        againstRunId: p.task.against ?? null,
        againstRange: p.task.againstRange ?? null,
        prior: p.task.against
          ? loadAgainstContext(join(dirname(p.runDir), p.task.against), p.task.against).findings
          : null,
      });
    } catch {
      // Ledger is derived from report.md; a sidecar write must not fail the review.
    }
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
    p.liveBeats.clear();
    flushTranscript(p.transcriptPath, p.transcript, p.resumeRoot, p.liveBeats);
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
    resumeCommand:
      outcomeFields.incomplete && results.some((r) => r.status === "failure")
        ? buildResumeCommand(p.runId, p.task)
        : null,
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
    attemptNumber: r.attemptNumber,
    retryOf: r.retryOf,
  };
}

function createWorkspace(workspace: string): void {
  try {
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw errors.io(`failed to create workspace dir: ${ioName(cause)}`, { cause: ioName(cause) });
  }
}

/** Delete-then-create so a rerun attempt starts from an EMPTY workspace (no
 * leftover checkout, no stale `.last-message.md`). Fail-closed (exit 5, nothing
 * deleted or created) unless EVERY step validates against the root bound at
 * run start: the run dir must be a real directory, every existing component on
 * the workspace path (run dir, `workspaces/`, the workspace itself) must be a
 * real directory — never a symlink — and the nearest existing ancestor's REAL
 * path must stay under the bound runs root. This runs on the CREATE path too:
 * a symlinked `workspaces/` would otherwise make a recursive rm delete — or a
 * recursive mkdir create and spawn cwd — OUTSIDE the runs tree (resume
 * scenario; reviewer findings). */
function recreateWorkspace(workspace: string, runDir: string, root: TrustedRoot): void {
  // Revalidate the bound root against the CURRENT filesystem BEFORE any delete
  // or create: a same-path REPLACEMENT of runsRoot (delete + fresh real
  // directory) keeps the realpath string but changes dev/ino, so the
  // assertWithinRoot realpath check alone cannot detect it — the retry path
  // holds the root bound at run start (possibly minutes earlier), and without
  // this revalidate it would rmSync inside the swapped tree (reviewer finding:
  // recreateWorkspace reused the long-held TrustedRoot without revalidating).
  revalidateTrustedRoot(root);
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
  // Bound-root validation — runs whether or not the workspace already exists:
  // lstat every existing component (a symlinked intermediate is refused) and
  // realpath the nearest existing ancestor against the BOUND runs root (a
  // lexical check is blind to an intermediate symlink pointing outside).
  assertWithinRoot(root, workspace);
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
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch (cause) {
      throw errors.io(`failed to clear workspace dir: ${ioName(cause)}`, { cause: ioName(cause) });
    }
  }
  createWorkspace(workspace);
}

function flushTranscript(
  path: string,
  records: ReviewTranscriptRecord[],
  root?: TrustedRoot | null,
  beats?: Map<string, CliRunLiveHeartbeat>,
): void {
  // A resume carries the runs-root binding from its entry; revalidate it
  // before EVERY transcript write (fail-closed exit 5 when the root was
  // swapped after entry) instead of rebinding the current root.
  if (root != null) revalidateTrustedRoot(root);
  writeReviewTranscript(path, records);
  persistLiveStatus(dirname(path), records, beats);
}

function persistLiveStatus(
  runDir: string,
  records: ReviewTranscriptRecord[],
  beats?: Map<string, CliRunLiveHeartbeat>,
): void {
  const live = liveStateFromRecords(records, new Date().toISOString());
  if (live === null) return;
  const next =
    beats === undefined || beats.size === 0 ? live : withLiveHeartbeats(live, beats.values());
  next.progress.updatedAt = new Date().toISOString();
  atomicWriteFile(join(runDir, CLI_RUN_STATUS_FILE), `${JSON.stringify(next)}\n`);
}

function timeoutForDriver(driverId: string, timeoutMs: number, codexTimeoutMs: number): number {
  return driverId === "codex-app-server" ? codexTimeoutMs : timeoutMs;
}

function buildResumeCommand(runId: string, task: ReviewTask): string {
  if (task.pr && task.pr.trim().length > 0) {
    return `councilkit review ${task.pr.trim()} --resume ${runId}`;
  }
  if (task.task && task.task.trim().length > 0) {
    return `councilkit review --resume ${runId} --task ${JSON.stringify(task.task.trim())}`;
  }
  return `councilkit review --resume ${runId}`;
}

function noteLiveBeat(
  p: Pick<ExecuteParams, "runDir" | "transcript" | "liveBeats">,
  attemptId: string,
  elapsedMs: number | undefined,
  lastActivity: string | null,
  started = false,
): void {
  const prev = p.liveBeats.get(attemptId);
  p.liveBeats.set(attemptId, {
    attemptId,
    elapsedMs: elapsedMs ?? prev?.elapsedMs,
    lastActivity: lastActivity ?? prev?.lastActivity ?? null,
    started: started || prev?.started === true,
  });
  try {
    persistLiveStatus(p.runDir, p.transcript, p.liveBeats);
  } catch {
    // Live status is a sidecar; never fail the review because of it.
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

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
  if (o.resumeCommand) {
    lines.push("  rerun failed seats (reuses successes):");
    lines.push(`    ${o.resumeCommand}`);
  }
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
  /** Set when some Attempts failed; `--resume` reuses successful seats. */
  resumeCommand?: string | null;
}

// Re-exported for the CLI router.
export type { CouncilRecord };
