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
import {
  type RunCleanup,
  type TerminalEvidence,
  type TurnResult,
  createRunCleanup,
  executeTurn,
} from "../host/execute-turn";
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
  refreshAuthForStream(
    signal?: AbortSignal,
  ): Promise<{ cookie: string; csrfToken: string; origin: string }>;
  listInstallations(): Promise<InstallationsResponse>;
  profileReadiness(profile: ExecutionProfileDto, modelId: string): Promise<ResolveProfileResponse>;
  /** G2: accepts the external-abort / shared-cleanup `signal` so a hanging
   * create cannot block SIGINT cleanup. */
  createScope(
    request: CreateScopeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<CreateScopeResponse>;
  /** G2: accepts the external-abort / shared-cleanup `signal` so a hanging
   * activate cannot block SIGINT cleanup (cancel → close → partial report →
   * exit 130). */
  activateScope(
    scopeId: string,
    controller: ControllerRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ScopeStatus>;
  /** F3: accepts the run-level cleanup `signal` so `getScopeStatus` verification
   * is bounded by the same ≤10s budget as the close. */
  getScopeStatus(scopeId: string, options?: { signal?: AbortSignal }): Promise<ScopeStatus>;
  /** F3: accepts the run-level cleanup `signal` so `closeScope` cannot hang past
   * the shared cleanup budget. */
  closeScope(
    scopeId: string,
    controller: ControllerRequest,
    options?: { signal?: AbortSignal },
  ): Promise<CloseScopeResponse>;
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
  /** F3: shared cleanup budget (ms) for the SIGINT cancel → observe → ACK → close
   * chain. Default 10s. Exposed mainly so bounded-close tests don't wait the full
   * budget on a hanging Host stub. */
  cleanupBudgetMs?: number;
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
  // G4: a LOCAL store/report artifact IO failure (canonical report write, --out
  // copy, final transcript rewrite, INCOMPLETE reconciliation) recorded
  // separately from the primary `failure`. Any artifact IO failure dominates
  // the exit code to 5, even when an earlier turn/Reporter failure is the
  // primary cause (which stays in `failure` as secondary/cause for visibility).
  let artifactIoFailure: RunFailure | null = null;
  let reporterOutput: string | null = null;
  // F2: the canonical success report is written in the Reporter persist-before-
  // ACK callback (before the committed ACK). Its markdown is captured here so
  // the post-close report phase can decide whether to keep it (completed run) or
  // overwrite it with an INCOMPLETE partial report.
  let reporterSuccessMarkdown = "";

  // F3: ONE run-level cleanup budget. The in-flight turn's cancel → observe →
  // discarded-ACK cleanup and the orchestrator's closeScope both draw from this
  // signal, so SIGINT cleanup converges in a single ≤10s window and no pending
  // close can block the partial report + exit 130.
  const runCleanup: RunCleanup = createRunCleanup(deps.cleanupBudgetMs);

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
    // F5: the initial transcript write is a local IO failure → exit 5, not exit 4.
    try {
      rewriteTranscript(path.transcript(runId), transcript);
    } catch (error) {
      status = "failed";
      failure = toFailure("io", "TRANSCRIPT_INIT", error);
      throw new StopRun(status, failure);
    }
    emit({ type: "run.starting", runId, council: input.council.name });

    // --- create + activate scope --------------------------------------------
    scopeRequestId = `ck-run-${runId}-${ids().slice(0, 8)}`;
    // G2: create/activate accept the external-abort signal so a hanging Host
    // call cannot block SIGINT cleanup. raceAbort guarantees convergence even
    // if a Host implementation does not honor the signal on its own — a pending
    // activate + SIGINT must reach catch/finally (close + partial report + 130).
    const scopeSignal = deps.signal;
    try {
      const created = await createScopeIdempotent(
        deps.host,
        scopeRequestId,
        input.agents,
        scopeSignal,
        runCleanup,
      );
      scopeId = created.scopeId;
      controller = { controllerId: created.controllerId, leaseEpoch: created.leaseEpoch };
      await raceAbort(
        deps.host.activateScope(scopeId, controller, { signal: scopeSignal }),
        scopeSignal,
      );
      if (deps.signal?.aborted) throw abortedBySignal();
    } catch (error) {
      if (deps.signal?.aborted) throw abortedBySignal();
      status = "failed";
      failure = toFailure("scope", "SCOPE_CREATE_FAILED", error);
      throw new StopRun(status, failure);
    }

    // --- ordinary turns -----------------------------------------------------
    const driver =
      deps.turnDriver ??
      makeRealTurnDriver(deps.host, scopeId, controller, turnTimeoutMs, runCleanup);
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
          // F5: a duration-patch transcript rewrite failure is a local IO
          // failure → exit 5, and the run must stop (the transcript is the
          // durable record).
          try {
            patchLastTurnDuration(runId, path, transcript, result.durationMs, executionId);
          } catch (error) {
            stopped = true;
            status = "failed";
            failure = toFailure("io", "TRANSCRIPT_DURATION", error);
            break;
          }
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
        persist: makeReporterPersist(
          runId,
          path,
          transcript,
          {
            round: input.rounds,
            turnIndex: input.agents.length,
            agent: reporter,
            executionId,
          },
          {
            startedAt: startedAt.toISOString(),
            council: input.council,
            reporterName: input.reporter.snapshot.name,
            participantNames: input.agents.map((a) => a.snapshot.name),
            onSuccess: (markdown: string) => {
              reporterSuccessMarkdown = markdown;
            },
          },
        ),
      });
      recordSummary(turnSummaries, "report", input.rounds, input.agents.length, reporter, result);
      if (result.verdict === "completed" && result.terminal !== null) {
        // F5: duration-patch transcript rewrite failure → exit 5.
        try {
          patchLastTurnDuration(runId, path, transcript, result.durationMs, executionId);
        } catch (error) {
          status = "failed";
          failure = toFailure("io", "TRANSCRIPT_DURATION", error);
        }
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
    // --- close scope exactly once, bounded by the run-level cleanup budget (F3).
    // arm() is idempotent: if the in-flight turn already armed the shared budget
    // (SIGINT cleanup), close continues on the SAME remaining ≤10s window;
    // otherwise (happy path) a fresh window starts here. A hung close can no
    // longer block the partial report + exit 130.
    let closeFailure: RunFailure | null = null;
    if (scopeId !== null && controller !== null) {
      runCleanup.arm();
      try {
        await closeScopeBounded(deps.host, scopeId, controller, runCleanup.signal);
      } catch (error) {
        // close failure overrides a completed status to non-success, but
        // transcript/report artifacts are preserved. Recorded as a secondary
        // here; H1 below decides whether the external abort outranks it.
        closeFailure = toFailure("cleanup", "CLOSE_FAILED", error);
      }
    }
    // Always release the shared cleanup timer so it cannot outlive the run
    // (the cancel → observe → ACK → close chain has ended).
    runCleanup.dispose();
    // H1: re-check the EXTERNAL abort signal AFTER close + disposal. A SIGINT
    // arriving during the close stage MUST resolve to interrupted / exit 130 —
    // whether close then succeeded (pre-fix it stayed completed/0) or was aborted
    // by the shared cleanup budget (pre-fix the catch flipped it to failed/4).
    // The external-abort verdict outranks a close failure for the exit code
    // (exitCodeForRun checks 130 before any artifact IO): an earlier non-abort
    // failure is kept as the cause, otherwise INTERRUPTED is the honest verdict.
    // A close failure with NO signal abort keeps the completed→failed override
    // (exit 4) below, so a real close rejection is never masked.
    if (deps.signal?.aborted) {
      status = "interrupted";
      failure = failure ?? abortedFailure();
    } else if (closeFailure !== null) {
      if (status === "completed") {
        status = "failed";
        failure = closeFailure;
      } else if (failure === null) {
        failure = closeFailure;
      }
    }
  }

  // --- report (F2/F6) -------------------------------------------------------
  const endedAt = now();
  emit({ type: "report.writing", runId });
  let reportMarkdown = "";
  let reportOk = false;
  // H4: whether the canonical report.md currently on disk holds the success
  // report (written persist-before-ACK by the Reporter) vs. an INCOMPLETE
  // partial report. This tracks KNOWN disk state, not intent: initialize it to
  // whether the Reporter already wrote a success report to disk
  // (reporterSuccessMarkdown is captured only after that write landed). A later
  // OVERWRITE failure (G6 refresh / partial first-write) MUST NOT flip this to
  // false — the disk still holds the prior report, so leaving it true lets the
  // final INCOMPLETE reconcile (below) retry and reconcile report.md with the
  // final status. Only a SUCCESSFUL partial write moves it to false.
  let canonicalIsSuccess = reporterSuccessMarkdown.length > 0;
  try {
    if (status === "completed") {
      // F2: the success report was written in the Reporter persist-before-ACK
      // callback (reporterSuccessMarkdown) BEFORE the committed ACK + Scope
      // close. G6: re-render it here with the FINAL endedAt (post-close) and
      // atomically refresh the canonical report, so the `Ended` header reflects
      // the real run end, not the Reporter persist moment. The body
      // (reporterOutput) is unchanged; only the header's timestamp moves. If the
      // Reporter body was never captured, fall back to the persisted markdown.
      if (reporterSuccessMarkdown.length > 0 && reporterOutput !== null) {
        reportMarkdown = renderSuccessReport({
          runId,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          council: input.council,
          reporterName: input.reporter.snapshot.name,
          participantNames: input.agents.map((a) => a.snapshot.name),
          reporterOutput: reporterOutput ?? "",
        });
        assertNonEmptyMarkdown(reportMarkdown);
        writeCanonicalReport(path.report(runId), reportMarkdown);
        canonicalIsSuccess = true;
      } else if (reporterSuccessMarkdown.length > 0) {
        reportMarkdown = reporterSuccessMarkdown;
        canonicalIsSuccess = true;
      } else {
        reportMarkdown = renderSuccessReport({
          runId,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          council: input.council,
          reporterName: input.reporter.snapshot.name,
          participantNames: input.agents.map((a) => a.snapshot.name),
          reporterOutput: reporterOutput ?? "",
        });
        assertNonEmptyMarkdown(reportMarkdown);
        writeCanonicalReport(path.report(runId), reportMarkdown);
        canonicalIsSuccess = true;
      }
    } else {
      // F2: a non-completed run (close failure / signal / turn failure) gets an
      // INCOMPLETE partial report, overwriting any success report the Reporter
      // persisted before a later failure.
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
      assertNonEmptyMarkdown(reportMarkdown);
      writeCanonicalReport(path.report(runId), reportMarkdown);
      canonicalIsSuccess = false;
    }
    reportOk = true;
  } catch (error) {
    // G4: a canonical report IO/render failure is a local artifact IO failure →
    // exit 5, recorded separately so it dominates even when an earlier turn
    // failure is the primary `failure`. Still finish the transcript + run record.
    const ioFail = toFailure("report", "REPORT_IO", error);
    artifactIoFailure ??= ioFail;
    reportMarkdown = "";
    status = status === "completed" ? "failed" : status;
    // H4: do NOT reset canonicalIsSuccess here. This catch covers an OVERWRITE
    // failure (the G6 post-close refresh, or a partial-report first write) —
    // the disk still holds whatever report was there before (the Reporter's
    // persist-before-ACK success report when one landed). Leaving
    // canonicalIsSuccess at its known-disk value lets the final INCOMPLETE
    // reconcile below retry and bring report.md in line with the now-failed
    // status instead of leaving a stale "complete" report on disk.
    if (failure === null) failure = ioFail;
  }

  // --out copy (failure makes the command non-zero; canonical preserved).
  if (input.outPath && reportOk) {
    try {
      writeReportCopy(input.outPath, reportMarkdown);
    } catch (error) {
      // G4: a --out copy failure is an artifact IO failure → exit 5. Keep the
      // primary `failure` (turn/reporter) as the cause; do not overwrite it.
      const ioFail = toFailure("report", "REPORT_OUT_COPY", error);
      artifactIoFailure ??= ioFail;
      status = "failed";
      if (failure === null) failure = ioFail;
    }
  }

  // --- run.finished + final transcript rewrite -----------------------------
  emit({ type: "run.finishing", status });
  // F6/G5: compute incomplete from the status so far. The final transcript write
  // below is the last status-changing IO; `incomplete` is recomputed after it
  // (and after the canonical INCOMPLETE reconciliation that follows) for the
  // returned outcome.
  let incomplete = status !== "completed";
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
    // G4: the final transcript rewrite is a local artifact IO failure → exit 5,
    // recorded separately so it is never masked by an earlier turn failure.
    const ioFail = toFailure("io", "TRANSCRIPT_FINAL", error);
    artifactIoFailure ??= ioFail;
    if (failure === null) failure = ioFail;
    if (status === "completed") {
      status = "failed";
    }
  }

  // G5: canonical INCOMPLETE reconciliation MOVED to after the last status-
  // changing IO (the final transcript rewrite above). If the run flipped to
  // non-completed AFTER the canonical success report was written (a --out copy
  // failure or a final-transcript-write failure), overwrite the canonical
  // report with an INCOMPLETE partial report so on-disk state matches the final
  // status. A failure to write the INCOMPLETE reconciliation is itself a report
  // IO failure (G4 linkage).
  if (status !== "completed" && canonicalIsSuccess) {
    try {
      const partial = renderPartialReport({
        runId,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        council: input.council,
        reporterName: input.reporter.snapshot.name,
        participantNames: input.agents.map((a) => a.snapshot.name),
        completedTurns,
        failure: failure ?? { phase: "run", code: "UNKNOWN", message: "run did not complete" },
      });
      writeCanonicalReport(path.report(runId), partial);
      reportMarkdown = partial;
    } catch (error) {
      artifactIoFailure ??= toFailure("report", "REPORT_INCOMPLETE_RECONCILE", error);
    }
    canonicalIsSuccess = false;
  }
  // F6: recompute incomplete from the FINAL status (after every status-changing
  // IO: report / --out / final transcript rewrite / INCOMPLETE reconciliation)
  // so the outcome and run record never report incomplete=false alongside a
  // failed status / exit 5.
  incomplete = status !== "completed";

  const exitCode = exitCodeForRun(
    status,
    failure,
    deps.signal?.aborted === true,
    artifactIoFailure,
  );
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
    // G4: any local store/report artifact IO failure that drove the exit code
    // to 5. Present alongside the primary `failure` so both the turn/reporter
    // failure and the artifact IO failure are visible to callers.
    artifactIoFailure,
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
  signal: AbortSignal | undefined,
  cleanup: RunCleanup,
): Promise<CreateScopeResponse> {
  const participants = agents.map((a) => ({
    participantId: a.participantId,
    profile: a.profile,
    modelId: a.snapshot.modelId,
    personaPrompt: a.snapshot.personaPrompt.length > 0 ? a.snapshot.personaPrompt : undefined,
  }));
  const request: CreateScopeRequest = { scopeRequestId, participants };
  try {
    return await raceAbort(host.createScope(request, { signal }), signal);
  } catch (error) {
    // H2: the create RESPONSE may be lost while the Host already created (and
    // prewarmed) a scope keyed by scopeRequestId. Two forms converge here:
    //   - raceAbort rejected first because `signal` aborted on a pending
    //     (delayed-resolve) create — scopeId is still null, so the run-level
    //     finally cannot close it.
    //   - a transport loss (TypeError) where the request's fate is unknown.
    // In both, recover the maybe-created scope idempotently with the SAME
    // scopeRequestId under the SHARED cleanup budget, obtain its fencing token,
    // and close — so it does not occupy a driver seat until the 30s
    // creating-scope reaper. A definitive 4xx RuntimeClientError (Host rejected
    // before creating) needs no recovery and falls through. Mirrors
    // src/lib/agent-real-call.ts recoverAndClose. Never throws — the caller maps
    // the ORIGINAL error onto the verdict.
    if (signal?.aborted) {
      await recoverAndCloseCreate(host, request, cleanup);
      throw error;
    }
    if (isRetryableTransport(error)) {
      // A non-abort transport error: retry once with the same scopeRequestId
      // (the Host keys scopes by it, so a retry never creates a second scope) to
      // try to recover a successful response.
      try {
        return await raceAbort(host.createScope(request, { signal }), signal);
      } catch (retryError) {
        // H2: the retry also failed (or was aborted mid-retry) — the scope may
        // exist on the Host. Recover+close before surfacing the failure.
        await recoverAndCloseCreate(host, request, cleanup);
        throw retryError;
      }
    }
    throw error;
  }
}

/** H2: best-effort idempotent recovery of a scope whose create response was
 * lost. Re-POST create with the SAME scopeRequestId (idempotent: returns the
 * existing scope if one was already created), then close it under the shared
 * cleanup budget. Arms the shared cleanup timer so a hung recovery create/close
 * converges within the ≤10s budget instead of blocking the partial report +
 * exit 130. Never throws; the caller owns the original verdict. */
async function recoverAndCloseCreate(
  host: OrchestratorHost,
  request: CreateScopeRequest,
  cleanup: RunCleanup,
): Promise<void> {
  cleanup.arm();
  try {
    const recovered = await host.createScope(request, { signal: cleanup.signal });
    try {
      await host.closeScope(
        recovered.scopeId,
        { controllerId: recovered.controllerId, leaseEpoch: recovered.leaseEpoch },
        { signal: cleanup.signal },
      );
    } catch {
      // close failed — Host reaper is the last resort; do not mask the original
      // create error. The run-level finally will not double-close (scopeId never
      // left the createScopeIdempotent failure path).
    }
  } catch {
    // create never landed / Host gone — nothing to close.
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
  runCleanup: RunCleanup,
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
      // F3: share the run-level cleanup budget so this turn's cancel → observe →
      // ACK cleanup and the orchestrator's close converge in one ≤10s window.
      sharedCleanup: runCleanup,
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

/** Reporter persist = append transcript record (role report) AND write the
 * canonical success report BEFORE the committed ACK (F2). Both artifacts must be
 * durable before the ACK releases the terminal payload to the Host; if either
 * write fails the persist callback throws (→ executeTurn commit failure → the
 * run stops non-zero) so a crash after the ACK never leaves a run dir with a
 * transcript but no report. */
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
  reportCtx: {
    startedAt: string;
    council: RunInput["council"];
    reporterName: string;
    participantNames: ReadonlyArray<string>;
    onSuccess: (markdown: string) => void;
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
    // F5: transcript write failure throws a CliError(io) → persist fails →
    // executeTurn commit phase → exit 5 at the run boundary.
    rewriteTranscript(path.transcript(runId), transcript);
    // F2: write the canonical success report BEFORE the committed ACK so a crash
    // after the ACK never leaves a transcript-only run dir.
    const endedAtIso = new Date().toISOString();
    const markdown = renderSuccessReport({
      runId,
      startedAt: reportCtx.startedAt,
      endedAt: endedAtIso,
      council: reportCtx.council,
      reporterName: reportCtx.reporterName,
      participantNames: reportCtx.participantNames,
      reporterOutput: evidence.output,
    });
    assertNonEmptyMarkdown(markdown);
    writeCanonicalReport(path.report(runId), markdown);
    reportCtx.onSuccess(markdown);
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
  try {
    atomicWriteFile(transcriptPath, `${lines}\n`);
  } catch (cause) {
    // F5: a transcript write failure is a local IO failure → exit 5. The caller
    // (initial write / persist / duration patch / final rewrite) maps this to a
    // phase=io failure so the run boundary reports exit 5, not exit 4.
    throw errors.io(`failed to write transcript: ${ioName(cause)}`, { cause: ioName(cause) });
  }
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
  signal: AbortSignal,
): Promise<void> {
  // Single bounded attempt under the run-level cleanup signal (F3); the Host's
  // close is the durable signal. A failure here makes the Run non-success
  // (override at the boundary). The signal bounds a hanging close so it cannot
  // block the partial report + exit 130.
  await host.closeScope(scopeId, controller, { signal });
  // Verify the scope actually reached a closed state (bounded by the same signal).
  let status: ScopeStatus;
  try {
    status = await host.getScopeStatus(scopeId, { signal });
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

/** G2: reject `p` with an AbortError the moment `signal` aborts, even if the
 * underlying Host call never settles on its own. Guarantees a hanging create
 * or activate cannot block SIGINT cleanup — the pending Host call is left to
 * settle best-effort; the run has already moved to catch/finally. No-op when
 * no signal is given. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortedBySignal());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedBySignal());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function exitCodeForRun(
  status: RunStatus,
  failure: RunFailure | null,
  aborted: boolean,
  artifactIoFailure?: RunFailure | null,
): ExitCode {
  if (aborted && status === "interrupted") return EXIT.interrupted;
  // G4: any local store/report artifact IO failure dominates the exit code to
  // 5, even when an earlier turn/Reporter failure (kept in `failure` as cause)
  // would otherwise map to exit 4. SIGINT (130) stays highest-priority above.
  if (artifactIoFailure) return EXIT.io;
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

/** A short diagnostic name for an IO failure cause (used in wrapped messages). */
function ioName(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  return "IOFailure";
}

// Re-exports used by the command layer.
export { QUOTAS };
export type { AckDisposition, DispatchState, ToolState, ModelVerdict, Usage };
