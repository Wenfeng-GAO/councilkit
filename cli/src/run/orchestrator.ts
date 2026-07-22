/**
 * Run orchestrator (plan-a §6, brief §2d). Drives one Council Run end-to-end in
 * a single thread, no React/Dexie. Owns the Scope lifecycle and the turn loop:
 *
 *   resolveInstallations + readiness → createScope → activate →
 *   N rounds × ordered ordinary turns → 1 Reporter turn →
 *   persist-before-ACK (transcript + canonical report) → close (exactly once).
 *
 * Hard contract (D1, plan-a §6 risk 高):
 *  - run-time references fail-fast (agents exist/enabled, reporter ∈ agents,
 *    count ≤ maxParticipantsPerScope). No reporter fallback.
 *  - `executionId`/`scopeRequestId` are stable before the call; a lost
 *    create/execute is recovered by probe, never by re-POSTing.
 *  - the authoritative completed output is persisted to transcript.jsonl BEFORE
 *    the committed ACK (execute-turn's persist callback); the Reporter's persist
 *    also writes the canonical report.md before its ACK.
 *  - any non-completed turn stops the Run, retains the transcript, writes an
 *    INCOMPLETE partial report, exits non-zero (4 run / 130 interrupted).
 *  - SIGINT/SIGTERM: the external signal aborts the in-flight turn (execute-turn
 *    runs a bounded cancel→observe→ACK-discard cleanup), then the orchestrator
 *    writes a partial report + run.finished(interrupted) and exits 130; the
 *    Scope is closed exactly once in finally.
 *  - close failure makes the Run non-success (exit 4) even if all turns
 *    completed; transcript + report artifacts are preserved.
 *  - transcript.jsonl is rewritten atomically (tmp+fsync+rename) after every
 *    persisted turn (Run scale is tiny; half-line corruption is not acceptable).
 *
 * The turn-driving is injected (`turnDriver`) so the sequencing + failure
 * semantics are unit-testable without re-running the SSE/ACK mechanics (those
 * are covered by execute-turn.test). The real driver wires executeTurn with a
 * persist callback that appends to the transcript; fake drivers in tests do the
 * same via the `persist` hook on each TurnRequest.
 */
import { randomUUID } from "node:crypto";
import { CREDENTIAL_MODE, QUOTAS } from "@shared/runtime/contracts";
import type { AckDisposition, DispatchState, ToolState } from "@shared/runtime/contracts";
import type { ModelVerdict, Usage } from "@shared/runtime/events";
import type {
  CloseScopeResponse,
  ControllerRequest,
  CreateScopeRequest,
  CreateScopeResponse,
  ExecutionProfileDto,
  InstallationsResponse,
  ResolveProfileResponse,
  ScopeStatus,
} from "@shared/runtime/schemas";
import { EXIT, type ExitCode, errors, exitCodeForHostCode } from "../errors";
import { type TerminalEvidence, type TurnResult, executeTurn } from "../host/execute-turn";
import { resolveInstallations } from "../host/installations";
import { reporterInstruction } from "../report/instruction";
import {
  assertNonEmptyMarkdown,
  renderPartialReport,
  renderSuccessReport,
  writeCanonicalReport,
  writeReportCopy,
} from "../report/render";
import { atomicWriteFile } from "../store/atomic-write";
import { type StorePaths, ensureRunDir } from "../store/paths";
import {
  type RunFinishedRecord,
  type RunStartedRecord,
  TRANSCRIPT_VERSION,
  type TranscriptRecord,
  type TurnCompletedRecord,
} from "../store/schemas";
import {
  buildContextSnapshot,
  computeParticipantDigest,
  contextItem,
  turnItem,
} from "./context-snapshot";
import { messageInstruction } from "./instructions";
import type {
  CompletedTurn,
  ResolvedAgent,
  RunFailure,
  RunInput,
  RunOutcome,
  RunProgressEvent,
  RunStatus,
  TurnSummary,
} from "./types";

// ---------------------------------------------------------------------------
// Host surface the orchestrator needs (HostClient satisfies it; tests fake it)
// ---------------------------------------------------------------------------

export interface OrchestratorHost {
  rawClient(): Promise<unknown>;
  refreshAuthForStream(): Promise<{ cookie: string; csrfToken: string; origin: string }>;
  listInstallations(): Promise<InstallationsResponse>;
  profileReadiness(profile: ExecutionProfileDto, modelId: string): Promise<ResolveProfileResponse>;
  createScope(request: CreateScopeRequest): Promise<CreateScopeResponse>;
  activateScope(scopeId: string, controller: ControllerRequest): Promise<ScopeStatus>;
  getScopeStatus(scopeId: string): Promise<ScopeStatus>;
  closeScope(scopeId: string, controller: ControllerRequest): Promise<CloseScopeResponse>;
}

// ---------------------------------------------------------------------------
// Turn driving (injectable for tests)
// ---------------------------------------------------------------------------

export interface TurnRequest {
  agent: ResolvedAgent;
  participantId: string;
  role: "message" | "report";
  round: number;
  turnIndex: number;
  executionId: string;
  /** The wire snapshot for this execution. */
  snapshot: ReturnType<typeof buildContextSnapshot>;
  /** External abort (SIGINT). */
  signal?: AbortSignal;
  /** Persist the authoritative completed output BEFORE the committed ACK.
   * Called only on a completed terminal. The record carries the run's
   * transcript shape so the driver need not know it. */
  persist: (evidence: TerminalEvidence) => Promise<void>;
}

export type TurnDriver = (request: TurnRequest) => Promise<TurnResult>;

export interface OrchestratorDeps {
  host: OrchestratorHost;
  paths: StorePaths;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  idFactory?: () => string;
  /** External abort signal (SIGINT/SIGTERM). */
  signal?: AbortSignal;
  /** Progress sink (stderr in --json, stdout in human). */
  onProgress?: (event: RunProgressEvent) => void;
  /** Per-turn deadline covering execute + SSE + terminal ACK. */
  turnTimeoutMs?: number;
  /** Injectable turn driver (tests). Defaults to the real executeTurn wiring. */
  turnDriver?: TurnDriver;
}

const DEFAULT_TURN_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runCouncil(input: RunInput, deps: OrchestratorDeps): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const ids = deps.idFactory ?? randomUUID;
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const startedAt = now();
  const path = deps.paths;
  const runId = input.runId;

  // Reference fail-fast (no reporter fallback, D1).
  assertRunReferences(input);

  const transcript: TranscriptRecord[] = [];
  const completedTurns: CompletedTurn[] = [];
  const turnSummaries: TurnSummary[] = [];
  const installations: Record<string, string> = {};
  for (const a of input.agents) installations[a.snapshot.id] = a.installationId;

  let scopeId: string | null = null;
  let controller: ControllerRequest | null = null;
  let scopeRequestId: string | null = null;
  let status: RunStatus = "completed";
  let failure: RunFailure | null = null;
  let reporterOutput: string | null = null;
  let closeOk = true;

  const emit = (ev: RunProgressEvent) => deps.onProgress?.(ev);

  try {
    // --- create run dir + write run.started ----------------------------------
    ensureRunDir(runId, deps.env);
    const startedRec: RunStartedRecord = {
      kind: "run.started",
      version: TRANSCRIPT_VERSION,
      runId,
      startedAt: startedAt.toISOString(),
      council: {
        id: input.council.id,
        name: input.council.name,
        topic: input.council.topic,
        background: input.council.background,
        targetOutput: input.council.targetOutput,
        rounds: input.rounds,
        reporterAgentId: input.council.reporterAgentId,
        agentIds: input.council.agentIds,
      },
      agents: input.agents.map((a) => a.snapshot),
      installationId: input.agents[0].installationId,
      installations,
    };
    transcript.push(startedRec);
    rewriteTranscript(path.transcript(runId), transcript);
    emit({ type: "run.starting", runId, council: input.council.name });

    // --- create + activate scope --------------------------------------------
    scopeRequestId = `ck-run-${runId}-${ids().slice(0, 8)}`;
    try {
      const created = await createScopeIdempotent(deps.host, scopeRequestId, input.agents);
      scopeId = created.scopeId;
      controller = { controllerId: created.controllerId, leaseEpoch: created.leaseEpoch };
      await deps.host.activateScope(scopeId, controller);
      if (deps.signal?.aborted) throw abortedBySignal();
    } catch (error) {
      if (deps.signal?.aborted) throw abortedBySignal();
      status = "failed";
      failure = toFailure("scope", "SCOPE_CREATE_FAILED", error);
      throw new StopRun(status, failure);
    }

    // --- ordinary turns -----------------------------------------------------
    const driver =
      deps.turnDriver ?? makeRealTurnDriver(deps.host, scopeId, controller, turnTimeoutMs);
    let seq = 0;
    let stopped = false;
    for (let round = 1; round <= input.rounds && !stopped; round += 1) {
      emit({ type: "round.start", round, totalRounds: input.rounds });
      for (let turnIndex = 0; turnIndex < input.agents.length && !stopped; turnIndex += 1) {
        if (deps.signal?.aborted) {
          stopped = true;
          status = "interrupted";
          failure = abortedFailure();
          break;
        }
        const agent = input.agents[turnIndex] as ResolvedAgent;
        emit({
          type: "turn.start",
          round,
          turnIndex,
          agent: agent.snapshot.name,
          role: "message",
        });
        const executionId = `ck-exec-${ids()}`;
        const items = sharedItems(runId, input.council, input.agents, completedTurns);
        const snapshot = buildContextSnapshot({
          runId,
          topic: input.council.topic,
          background: input.council.background,
          items,
          participantId: agent.participantId,
          participantSnapshotDigest: agent.participantSnapshotDigest,
          personaPrompt: agent.snapshot.personaPrompt,
          instruction: {
            kind: "message",
            text: messageInstruction({
              agentName: agent.snapshot.name,
              personaPrompt: agent.snapshot.personaPrompt,
              round,
              totalRounds: input.rounds,
              council: { topic: input.council.topic },
            }),
          },
        });
        const result = await driveTurn(driver, {
          agent,
          participantId: agent.participantId,
          role: "message",
          round,
          turnIndex,
          executionId,
          snapshot,
          signal: deps.signal,
          persist: makePersist(runId, path, transcript, completedTurns, {
            round,
            turnIndex,
            agent,
            role: "message",
            executionId,
          }),
        });
        recordSummary(turnSummaries, "message", round, turnIndex, agent, result);
        if (result.verdict === "completed" && result.terminal !== null) {
          patchLastTurnDuration(runId, path, transcript, result.durationMs, executionId);
        }
        emit({
          type: "turn.done",
          round,
          turnIndex,
          agent: agent.snapshot.name,
          verdict: result.verdict,
          durationMs: result.durationMs,
        });
        if (result.verdict !== "completed" || result.terminal === null) {
          stopped = true;
          status =
            result.verdict === "interrupted" ||
            result.verdict === "cancelled" ||
            deps.signal?.aborted
              ? "interrupted"
              : "failed";
          failure = result.error
            ? { phase: result.error.phase, code: result.error.code, message: result.error.message }
            : {
                phase: "turn",
                code: "TURN_NOT_COMPLETED",
                message: `turn verdict ${result.verdict}`,
              };
          if (deps.signal?.aborted) {
            status = "interrupted";
            failure = abortedFailure();
          }
          break;
        }
        seq += 1;
      }
    }

    // --- Reporter turn ------------------------------------------------------
    if (status === "completed" && !deps.signal?.aborted) {
      const reporter = input.reporter;
      emit({
        type: "turn.start",
        round: input.rounds,
        turnIndex: input.agents.length,
        agent: reporter.snapshot.name,
        role: "report",
      });
      const executionId = `ck-exec-${ids()}`;
      const items = sharedItems(runId, input.council, input.agents, completedTurns);
      const snapshot = buildContextSnapshot({
        runId,
        topic: input.council.topic,
        background: input.council.background,
        items,
        participantId: reporter.participantId,
        participantSnapshotDigest: reporter.participantSnapshotDigest,
        personaPrompt: reporter.snapshot.personaPrompt,
        instruction: {
          kind: "summary",
          text: reporterInstruction({
            council: {
              topic: input.council.topic,
              background: input.council.background,
              targetOutput: input.council.targetOutput,
            },
            agentNames: input.agents.map((a) => a.snapshot.name),
            reporterName: reporter.snapshot.name,
          }),
        },
      });
      const result = await driveTurn(driver, {
        agent: reporter,
        participantId: reporter.participantId,
        role: "report",
        round: input.rounds,
        turnIndex: input.agents.length,
        executionId,
        snapshot,
        signal: deps.signal,
        persist: makeReporterPersist(runId, path, transcript, {
          round: input.rounds,
          turnIndex: input.agents.length,
          agent: reporter,
          executionId,
        }),
      });
      recordSummary(turnSummaries, "report", input.rounds, input.agents.length, reporter, result);
      if (result.verdict === "completed" && result.terminal !== null) {
        patchLastTurnDuration(runId, path, transcript, result.durationMs, executionId);
      }
      emit({
        type: "turn.done",
        round: input.rounds,
        turnIndex: input.agents.length,
        agent: reporter.snapshot.name,
        verdict: result.verdict,
        durationMs: result.durationMs,
      });
      if (result.verdict !== "completed" || result.terminal === null) {
        status = deps.signal?.aborted ? "interrupted" : "failed";
        failure = result.error
          ? { phase: result.error.phase, code: result.error.code, message: result.error.message }
          : {
              phase: "reporter",
              code: "REPORTER_NOT_COMPLETED",
              message: `reporter verdict ${result.verdict}`,
            };
        if (deps.signal?.aborted) {
          status = "interrupted";
          failure = abortedFailure();
        }
      } else {
        reporterOutput = result.terminal.output;
      }
    } else if (status === "completed" && deps.signal?.aborted) {
      status = "interrupted";
      failure = abortedFailure();
    }
  } catch (error) {
    if (error instanceof StopRun) {
      status = error.status;
      failure = error.failure;
    } else if (deps.signal?.aborted) {
      status = "interrupted";
      failure = abortedFailure();
    } else {
      status = "failed";
      failure = toFailure("run", "RUN_ERROR", error);
    }
  } finally {
    // --- close scope exactly once ------------------------------------------
    if (scopeId !== null && controller !== null) {
      try {
        await closeScopeBounded(deps.host, scopeId, controller);
      } catch (error) {
        closeOk = false;
        // close failure overrides a completed status to non-success, but
        // transcript/report artifacts are preserved.
        if (status === "completed") {
          status = "failed";
          failure = toFailure("cleanup", "CLOSE_FAILED", error);
        } else if (failure === null) {
          failure = toFailure("cleanup", "CLOSE_FAILED", error);
        }
      }
    } else if (!closeOk) {
      // no-op
    }
  }

  // --- report ---------------------------------------------------------------
  const endedAt = now();
  const incomplete = status !== "completed";
  emit({ type: "report.writing", runId });
  let reportMarkdown = "";
  let reportOk = false;
  try {
    if (status === "completed" && reporterOutput !== null) {
      reportMarkdown = renderSuccessReport({
        runId,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        council: input.council,
        reporterName: input.reporter.snapshot.name,
        participantNames: input.agents.map((a) => a.snapshot.name),
        reporterOutput,
      });
    } else {
      reportMarkdown = renderPartialReport({
        runId,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        council: input.council,
        reporterName: input.reporter.snapshot.name,
        participantNames: input.agents.map((a) => a.snapshot.name),
        completedTurns,
        failure: failure ?? { phase: "run", code: "UNKNOWN", message: "run did not complete" },
      });
    }
    assertNonEmptyMarkdown(reportMarkdown);
    writeCanonicalReport(path.report(runId), reportMarkdown);
    reportOk = true;
  } catch (error) {
    // report IO/render failure → exit 5, but still finish the transcript + run record.
    reportMarkdown = "";
    status = status === "completed" ? "failed" : status;
    if (failure === null) failure = toFailure("report", "REPORT_IO", error);
  }

  // --out copy (failure makes the command non-zero; canonical preserved).
  if (input.outPath && reportOk) {
    try {
      writeReportCopy(input.outPath, reportMarkdown);
    } catch (error) {
      status = "failed";
      failure = toFailure("report", "REPORT_OUT_COPY", error);
    }
  }

  // --- run.finished + final transcript rewrite -----------------------------
  emit({ type: "run.finishing", status });
  const finishedRec: RunFinishedRecord = {
    kind: "run.finished",
    status,
    endedAt: endedAt.toISOString(),
    ...(failure
      ? { failure: { phase: failure.phase, code: failure.code, message: failure.message } }
      : {}),
    reportPath: path.report(runId),
    incomplete,
  };
  transcript.push(finishedRec);
  try {
    rewriteTranscript(path.transcript(runId), transcript);
  } catch (error) {
    if (failure === null) failure = toFailure("io", "TRANSCRIPT_FINAL", error);
    if (status === "completed") {
      status = "failed";
    }
  }

  const exitCode = exitCodeForRun(status, failure, deps.signal?.aborted === true);
  return {
    status,
    exitCode,
    runId,
    reportPath: path.report(runId),
    transcriptPath: path.transcript(runId),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    turns: turnSummaries,
    installations,
    failure,
    incomplete,
  };
}

// ---------------------------------------------------------------------------
// Reference validation
// ---------------------------------------------------------------------------

function assertRunReferences(input: RunInput): void {
  if (input.agents.length === 0) {
    throw errors.usage("run has no agents");
  }
  if (input.agents.length > QUOTAS.maxParticipantsPerScope) {
    throw errors.usage(
      `run has ${input.agents.length} agents; max is ${QUOTAS.maxParticipantsPerScope} (incl. reporter)`,
    );
  }
  const reporterId = input.reporter.snapshot.id;
  if (!input.agents.some((a) => a.snapshot.id === reporterId)) {
    throw errors.usage("reporter must be among the participating agents");
  }
  if (input.rounds < 1) {
    throw errors.usage("rounds must be a positive integer");
  }
  const ids = new Set(input.agents.map((a) => a.snapshot.id));
  if (ids.size !== input.agents.length) {
    throw errors.usage("run agents contains duplicates");
  }
  for (const a of input.agents) {
    if (!a.snapshot.enabled) {
      throw errors.usage(`agent "${a.snapshot.name}" is disabled; cannot participate in a run`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scope create (idempotent on scopeRequestId)
// ---------------------------------------------------------------------------

async function createScopeIdempotent(
  host: OrchestratorHost,
  scopeRequestId: string,
  agents: ReadonlyArray<ResolvedAgent>,
): Promise<CreateScopeResponse> {
  const participants = agents.map((a) => ({
    participantId: a.participantId,
    profile: a.profile,
    modelId: a.snapshot.modelId,
    personaPrompt: a.snapshot.personaPrompt.length > 0 ? a.snapshot.personaPrompt : undefined,
  }));
  const request: CreateScopeRequest = { scopeRequestId, participants };
  try {
    return await host.createScope(request);
  } catch (error) {
    // A transport/5xx may have landed. Retry once with the SAME scopeRequestId:
    // the Host keys Scopes by it, so a retry never creates a second Scope.
    if (isRetryableTransport(error)) {
      return await host.createScope(request);
    }
    throw error;
  }
}

function isRetryableTransport(error: unknown): boolean {
  // Retry only on likely-non-landing transport errors (TypeError = fetch threw
  // before a response). A RuntimeClientError (HTTP status) is NOT retried — it
  // may have landed (ambiguous), and a 4xx is a definitive rejection.
  return error instanceof TypeError;
}

// ---------------------------------------------------------------------------
// Turn driving
// ---------------------------------------------------------------------------

async function driveTurn(driver: TurnDriver, request: TurnRequest): Promise<TurnResult> {
  return driver(request);
}

/** Build the real turn driver: wires executeTurn with a persist callback. */
function makeRealTurnDriver(
  host: OrchestratorHost,
  scopeId: string,
  controller: ControllerRequest,
  timeoutMs: number,
): TurnDriver {
  return async (request) => {
    return executeTurn({
      host: host as unknown as Parameters<typeof executeTurn>[0]["host"],
      scopeId,
      controller,
      participantId: request.participantId,
      executionId: request.executionId,
      snapshot: request.snapshot,
      role: request.role,
      timeoutMs,
      signal: request.signal,
      persist: request.persist,
    });
  };
}

// ---------------------------------------------------------------------------
// Transcript persistence (persist-before-ACK)
// ---------------------------------------------------------------------------

function makePersist(
  runId: string,
  path: StorePaths,
  transcript: TranscriptRecord[],
  completedTurns: CompletedTurn[],
  meta: {
    round: number;
    turnIndex: number;
    agent: ResolvedAgent;
    role: "message" | "report";
    executionId: string;
  },
): (evidence: TerminalEvidence) => Promise<void> {
  return async (evidence) => {
    const record: TurnCompletedRecord = {
      kind: "turn.completed",
      seq: completedTurns.length,
      completedAt: new Date().toISOString(),
      round: meta.round,
      turnIndex: meta.turnIndex,
      role: meta.role,
      agentId: meta.agent.snapshot.id,
      agentName: meta.agent.snapshot.name,
      participantId: meta.agent.participantId,
      executionId: meta.executionId,
      output: evidence.output,
      requestedModel: evidence.requestedModel,
      effectiveModel: evidence.effectiveModel,
      modelVerdict: evidence.modelVerdict,
      toolState: evidence.toolState,
      durationMs: 0,
      usage: evidence.usage,
    };
    transcript.push(record);
    if (meta.role === "message") {
      completedTurns.push({
        agentId: meta.agent.snapshot.id,
        agentName: meta.agent.snapshot.name,
        participantId: meta.agent.participantId,
        executionId: meta.executionId,
        output: record.output,
        round: meta.round,
        turnIndex: meta.turnIndex,
      });
    }
    rewriteTranscript(path.transcript(runId), transcript);
  };
}

/** Reporter persist = append transcript record (role report) BEFORE the
 * committed ACK. The canonical report.md (with the deterministic header) is
 * rendered after the Reporter ACKs, from this persisted output. */
function makeReporterPersist(
  runId: string,
  path: StorePaths,
  transcript: TranscriptRecord[],
  meta: {
    round: number;
    turnIndex: number;
    agent: ResolvedAgent;
    executionId: string;
  },
): (evidence: TerminalEvidence) => Promise<void> {
  return async (evidence) => {
    const ordinaryCount = completedMessageCount(transcript);
    const record: TurnCompletedRecord = {
      kind: "turn.completed",
      seq: ordinaryCount,
      completedAt: new Date().toISOString(),
      round: meta.round,
      turnIndex: meta.turnIndex,
      role: "report",
      agentId: meta.agent.snapshot.id,
      agentName: meta.agent.snapshot.name,
      participantId: meta.agent.participantId,
      executionId: meta.executionId,
      output: evidence.output,
      requestedModel: evidence.requestedModel,
      effectiveModel: evidence.effectiveModel,
      modelVerdict: evidence.modelVerdict,
      toolState: evidence.toolState,
      durationMs: 0,
      usage: evidence.usage,
    };
    transcript.push(record);
    rewriteTranscript(path.transcript(runId), transcript);
  };
}

function completedMessageCount(transcript: TranscriptRecord[]): number {
  return transcript.filter((r) => r.kind === "turn.completed" && r.role === "message").length;
}

/** Patch the just-persisted turn record's final durationMs (unknown at
 * persist-before-ACK time) and rewrite the transcript. */
function patchLastTurnDuration(
  runId: string,
  path: StorePaths,
  transcript: TranscriptRecord[],
  durationMs: number,
  executionId: string,
): void {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const rec = transcript[i];
    if (rec.kind === "turn.completed" && rec.executionId === executionId) {
      rec.durationMs = durationMs;
      rewriteTranscript(path.transcript(runId), transcript);
      return;
    }
  }
}

function rewriteTranscript(transcriptPath: string, records: TranscriptRecord[]): void {
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  atomicWriteFile(transcriptPath, `${lines}\n`);
}

// ---------------------------------------------------------------------------
// Snapshot item assembly
// ---------------------------------------------------------------------------

function sharedItems(
  runId: string,
  council: RunInput["council"],
  agents: ReadonlyArray<ResolvedAgent>,
  completedTurns: ReadonlyArray<CompletedTurn>,
) {
  const items = [
    contextItem(
      runId,
      { topic: council.topic, background: council.background, targetOutput: council.targetOutput },
      agents.map((a) => ({ name: a.snapshot.name, participantId: a.participantId })),
    ),
    ...completedTurns.map((t, i) =>
      turnItem(runId, i + 1, {
        participantId: t.participantId,
        output: t.output,
        executionId: t.executionId,
      }),
    ),
  ];
  return items;
}

// ---------------------------------------------------------------------------
// Scope close (bounded)
// ---------------------------------------------------------------------------

async function closeScopeBounded(
  host: OrchestratorHost,
  scopeId: string,
  controller: ControllerRequest,
): Promise<void> {
  // Single bounded attempt; the Host's close is the durable signal. A failure
  // here makes the Run non-success (override at the boundary).
  await host.closeScope(scopeId, controller);
  // Verify the scope actually reached a closed state.
  let status: ScopeStatus;
  try {
    status = await host.getScopeStatus(scopeId);
  } catch {
    return; // best-effort verification; the close call itself succeeded.
  }
  if (status.state !== "closed") {
    throw new Error(`scope did not reach closed (state=${status.state})`);
  }
}

// ---------------------------------------------------------------------------
// Error / exit mapping
// ---------------------------------------------------------------------------

class StopRun extends Error {
  constructor(
    readonly status: RunStatus,
    readonly failure: RunFailure,
  ) {
    super(failure.message);
    this.name = "StopRun";
  }
}

function toFailure(phase: string, code: string, error: unknown): RunFailure {
  const message =
    error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512);
  // Map a Host-structured code to a CLI-ish code when possible.
  const hostCode = (error as { code?: string })?.code;
  return { phase, code: hostCode ?? code, message };
}

function abortedFailure(): RunFailure {
  return {
    phase: "signal",
    code: "INTERRUPTED",
    message: "interrupted by signal (SIGINT/SIGTERM)",
  };
}

function abortedBySignal(): Error {
  const err = new Error("interrupted by signal");
  err.name = "AbortError";
  return err;
}

function exitCodeForRun(status: RunStatus, failure: RunFailure | null, aborted: boolean): ExitCode {
  if (aborted && status === "interrupted") return EXIT.interrupted;
  if (status === "completed") return EXIT.ok;
  if (failure) {
    if (failure.phase === "io" || failure.phase === "report") return EXIT.io;
    if (failure.phase === "cleanup") return EXIT.runFailed;
    // Host-code mapping for quota rejections.
    if (failure.code === "RESOURCE_LIMIT" || failure.code === "RATE_LIMITED") {
      return EXIT.quota;
    }
  }
  // Pre-run-style faults (scope/readyness) arrived in-run → exit 4 by default;
  // host-unavailable codes that clearly predate dispatch stay 3 via the mapper.
  if (failure) {
    const mapped = exitCodeForHostCode(failure.code, "run");
    if (mapped === EXIT.quota) return EXIT.quota;
  }
  return EXIT.runFailed;
}

// ---------------------------------------------------------------------------
// Summary bookkeeping
// ---------------------------------------------------------------------------

function recordSummary(
  summaries: TurnSummary[],
  role: "message" | "report",
  round: number,
  turnIndex: number,
  agent: ResolvedAgent,
  result: TurnResult,
): void {
  summaries.push({
    role,
    round,
    turnIndex,
    agentId: agent.snapshot.id,
    agentName: agent.snapshot.name,
    verdict: result.verdict,
    effectiveModel: result.terminal?.effectiveModel ?? null,
    durationMs: result.durationMs,
  });
}

// ---------------------------------------------------------------------------
// Resolution helper: build ResolvedAgent[] from a Council + Store agents
// ---------------------------------------------------------------------------

/** Resolve a Council's agents into Run-ready ResolvedAgents: dynamic
 * installationId per driver + ExecutionProfileDto + readiness probe. Throws a
 * structured CliError (exit 3) on no-trusted-installation / not-ready. */
export async function resolveRunAgents(input: {
  council: {
    agentIds: ReadonlyArray<string>;
    reporterAgentId: string;
  };
  agents: ReadonlyArray<{
    snapshot: import("../store/schemas").AgentRecord;
  }>;
  installations: InstallationsResponse;
  host: Pick<OrchestratorHost, "profileReadiness">;
  idFactory?: () => string;
}): Promise<ResolvedAgent[]> {
  const ids = input.idFactory ?? randomUUID;
  const byId = new Map(input.agents.map((a) => [a.snapshot.id, a.snapshot]));
  const out: ResolvedAgent[] = [];
  for (const agentId of input.council.agentIds) {
    const snapshot = byId.get(agentId);
    if (!snapshot) {
      throw errors.usage(`run references unknown agent id "${agentId}"`);
    }
    const resolved = resolveInstallations(input.installations, snapshot.driverSelection.driverId);
    const profile = buildProfile(snapshot.driverSelection, resolved.installationId);
    let readiness: ResolveProfileResponse;
    try {
      readiness = await input.host.profileReadiness(profile, snapshot.modelId);
    } catch (error) {
      throw errors.hostUnavailable(
        `profile readiness failed for agent "${snapshot.name}": ${messageOf(error)}`,
        { code: "READINESS_FAILED", agentId },
      );
    }
    if (readiness.readiness.state !== "ready") {
      throw errors.hostUnavailable(
        `agent "${snapshot.name}" is not ready (state=${readiness.readiness.state}: ${readiness.readiness.detail ?? "no detail"})`,
        { code: "PROFILE_NOT_READY", agentId, readiness: readiness.readiness.state },
      );
    }
    out.push({
      snapshot,
      profile,
      installationId: resolved.installationId,
      participantId: `ck-p-${ids().slice(0, 12)}`,
      participantSnapshotDigest: computeParticipantDigest(snapshot.personaPrompt),
    });
  }
  return out;
}

export function buildProfile(
  selection: import("../store/schemas").DriverSelection,
  installationId: string,
): ExecutionProfileDto {
  return {
    driverId: selection.driverId,
    installationId,
    credentialMode: CREDENTIAL_MODE,
    options: selection.options,
  } as ExecutionProfileDto;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Re-exports used by the command layer.
export { QUOTAS };
export type { AckDisposition, DispatchState, ToolState, ModelVerdict, Usage };
