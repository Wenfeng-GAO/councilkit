/**
 * Per-turn execute lifecycle (brief §2d, plan-a §6, D1 §1). Ports the conclusions
 * of `src/lib/agent-real-call.ts`'s four rounds of fix into the CLI's
 * single-threaded, no-React world. The orchestrator (a later slice) owns the
 * Scope lifecycle (create/activate/close); this module drives ONE turn inside an
 * existing scope:
 *
 *   stable executionId → execute → SSE-to-terminal (afterSeq reconnect, never
 *   re-dispatch) → persist terminal output → ACK (committed | discarded).
 *
 * Non-negotiable contract (plan-a §6, risk 高):
 *  - `executionId` is stable; a lost execute response is RECOVERED by probing
 *    `GET execution`, never by re-POSTing execute.
 *  - ambiguous dispatch is three-state: "notDispatched" (definitive 404
 *    EXECUTION_NOT_FOUND → no cleanup), "dispatched" (record exists → cleanup),
 *    "unknown" (cannot prove absence → conservative ONE cancel/observe cleanup).
 *    In ALL cases execute is sent at most once.
 *  - the authoritative `completed.output` is persisted to the transcript BEFORE
 *    the committed ACK is sent — a confirmed output is never ACK'd before it is
 *    durable (persist-before-ACK).
 *  - failed / interrupted / empty output receive a discarded ACK that must reach
 *    `ackState === "acknowledged"`; a definitive non-acknowledged ACK is an
 *    explicit ACK_FAILED, not masked by a later abort.
 *  - cancel → observe → ACK-discard share ONE bounded cleanup budget (no per-
 *    request timeout reset), so the cleanup chain cannot hang.
 *  - a real protocol/parse error that races a deadline is reported as itself,
 *    never masked as timeout/cancelled.
 *
 * `closeScope` is intentionally NOT performed here — the orchestrator owns the
 * scope close in its own finally so a single shared scope serves every turn.
 */
import { type RuntimeClient, RuntimeClientError } from "@/runtime/client";
import {
  type FollowEventsOptions,
  type FollowOutcome,
  followExecutionEvents,
} from "@/runtime/event-stream";
import type { AckDisposition, DispatchState, ToolState } from "@shared/runtime/contracts";
import type {
  CompletedEvent,
  FailedEvent,
  InterruptedEvent,
  ModelVerdict,
  RuntimeEvent,
  Usage,
} from "@shared/runtime/events";
import type { ContextSnapshot, ControllerRequest } from "@shared/runtime/schemas";
import { CliError, EXIT } from "../errors";

/** Minimal Host surface execute-turn needs. The real `HostClient` (client.ts)
 * satisfies this; tests pass a stub returning a mock `RuntimeClient`. */
export interface HostLike {
  rawClient(): Promise<RuntimeClient>;
  /** H3: accepts the turn deadline signal so a SIGINT during the SSE 401
   * cold-rebuild's GET / aborts the auth re-extraction within the shared
   * cleanup budget, instead of waiting out the auth's own 8s timeout and only
   * then starting the 10s cancel/observe/ACK cleanup. */
  refreshAuthForStream(
    signal?: AbortSignal,
  ): Promise<{ cookie: string; csrfToken: string; origin: string }>;
}

// ---------------------------------------------------------------------------
// Public result model
// ---------------------------------------------------------------------------

export type TurnVerdict = "completed" | "failed" | "interrupted" | "timeout" | "cancelled";

export interface TurnError {
  phase: "dispatch" | "stream" | "commit" | "ack" | "cleanup" | "deadline" | "terminal" | "io";
  code: string;
  message: string;
  retryable: boolean;
}

export interface TerminalEvidence {
  output: string;
  requestedModel: string;
  effectiveModel: string | null;
  modelVerdict: ModelVerdict;
  toolState: ToolState;
  usage: Usage | null;
  finalSeq: number;
}

export interface TurnResult {
  verdict: TurnVerdict;
  executionId: string;
  participantId: string;
  dispatchState: DispatchState;
  /** Present only on a clean completion, before ACK. Null for failed/interrupted. */
  terminal: TerminalEvidence | null;
  durationMs: number;
  /** `acknowledged` for a successful ACK; `conflict` for a definitive
   * non-acknowledged ACK (ACK_FAILED); `skipped` when no ACK was attempted
   * (e.g. definitive not-dispatched, no scope */
  ack: "acknowledged" | "conflict" | "skipped";
  error: TurnError | null;
}

export interface ExecuteTurnInput {
  host: HostLike;
  scopeId: string;
  controller: ControllerRequest;
  participantId: string;
  /** Stable execution id, generated before the call. */
  executionId: string;
  snapshot: ContextSnapshot;
  /** Distinguishes ordinary turns from the Reporter turn (for metadata). */
  role: "message" | "report";
  /** Per-turn deadline covering execute + SSE + terminal ACK. */
  timeoutMs: number;
  /** External abort (e.g. SIGINT / run-level cancel). */
  signal?: AbortSignal;
  /** Persist the authoritative completed output BEFORE the committed ACK. If it
   * throws, the turn fails with a commit-phase error and the ACK is discarded. */
  persist: (evidence: TerminalEvidence) => Promise<void>;
  idFactory?: () => string;
  now?: () => number;
  /** Injected SSE follower (tests substitute a mock). */
  followEvents?: typeof followExecutionEvents;
  /** Optional run-level shared cleanup budget (F3). When provided, the turn's
   * cancel → observe → discarded-ACK cleanup draws from this controller's
   * `signal` (and `arm()`s its ≤10s timer on first use) instead of allocating a
   * private one, so the orchestrator's later `closeScope` continues on the SAME
   * remaining budget. The orchestrator owns `dispose()`; executeTurn never
   * disposes a shared cleanup. */
  sharedCleanup?: RunCleanup;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Shared bounded cleanup budget for cancel → observe → ACK-discard. */
const CLEANUP_BUDGET_MS = 10_000;

const ACK_FAILED_ERROR: TurnError = {
  phase: "ack",
  code: "ACK_FAILED",
  message: "ACK did not reach the acknowledged state",
  retryable: true,
};

// ---------------------------------------------------------------------------
// Internal shared-cleanup controller
// ---------------------------------------------------------------------------

interface SharedCleanup {
  signal: AbortSignal;
  dispose: () => void;
}

function newSharedCleanup(): SharedCleanup {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("cleanup-deadline"), CLEANUP_BUDGET_MS);
  if (typeof timer === "object" && typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort("cleanup-disposed");
    },
  };
}

/**
 * Run-level shared cleanup budget (F3). The orchestrator owns ONE of these per
 * run; a turn's cancel → observe → discarded-ACK cleanup AND the orchestrator's
 * `closeScope` both draw from the same `signal`, so the whole SIGINT cleanup
 * chain converges within a single ≤10s window (no per-request 10s reset, no
 * unbounded `closeScope`).
 *
 * `arm()` starts the 10s timer the first time it is called (idempotent) — so a
 * happy-path run that never needs cleanup never starts a timer, and a happy-path
 * `closeScope` gets a fresh 10s window when the finally arms it. The owner calls
 * `dispose()` once the chain (turn cleanup + close) has ended. */
export interface RunCleanup {
  signal: AbortSignal;
  arm(): void;
  dispose(): void;
}

export function createRunCleanup(budgetMs: number = CLEANUP_BUDGET_MS): RunCleanup {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    signal: controller.signal,
    arm() {
      if (timer !== null) return;
      timer = setTimeout(() => controller.abort("cleanup-deadline"), budgetMs);
      if (
        typeof timer === "object" &&
        typeof (timer as { unref?: () => void }).unref === "function"
      ) {
        (timer as { unref: () => void }).unref();
      }
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (!controller.signal.aborted) controller.abort("cleanup-disposed");
    },
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function executeTurn(input: ExecuteTurnInput): Promise<TurnResult> {
  const now = input.now ?? Date.now;
  const follow = input.followEvents ?? followExecutionEvents;
  return runInternal({ ...input, now, follow });
}

interface RunParams extends ExecuteTurnInput {
  now: () => number;
  follow: typeof followExecutionEvents;
}

async function runInternal(params: RunParams): Promise<TurnResult> {
  const {
    host,
    scopeId,
    controller,
    participantId,
    executionId,
    snapshot,
    timeoutMs,
    signal,
    follow,
  } = params;
  const startedAtMs = params.now();

  // --- Combined deadline (F6): track abortSource explicitly, never guess.
  const timeoutController = new AbortController();
  let abortSource: "deadline" | "external" | null = null;
  const onExternalAbort = () => {
    if (abortSource === null) abortSource = "external";
    timeoutController.abort(signal?.reason ?? "external");
  };
  if (signal?.aborted) {
    abortSource = "external";
    timeoutController.abort("external");
  } else {
    signal?.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timeoutTimer = setTimeout(() => {
    if (abortSource === null) abortSource = "deadline";
    timeoutController.abort("timeout");
  }, timeoutMs);
  const deadline = timeoutController.signal;
  const abortVerdict = (): "timeout" | "cancelled" =>
    abortSource === "deadline" ? "timeout" : "cancelled";
  const abortError = (): TurnError =>
    abortSource === "deadline"
      ? {
          phase: "deadline",
          code: "TURN_TIMEOUT",
          message: "turn deadline exceeded",
          retryable: true,
        }
      : { phase: "cleanup", code: "CANCELLED", message: "cancelled by caller", retryable: false };

  const cleanupHolder: { current: SharedCleanup | null } = { current: null };
  const cleanupOf = (): AbortSignal => {
    // F3: when the run shares a cleanup budget, draw from it (arming the ≤10s
    // timer on first use) instead of a private controller, so cancel → observe →
    // ACK-discard and the orchestrator's close share ONE remaining budget.
    if (params.sharedCleanup) {
      params.sharedCleanup.arm();
      return params.sharedCleanup.signal;
    }
    if (!cleanupHolder.current) cleanupHolder.current = newSharedCleanup();
    return cleanupHolder.current.signal;
  };

  let dispatchState: DispatchState = "not_dispatched";
  let ackResult: TurnResult["ack"] = "skipped";
  let ackDefinitiveConflict = false;
  // F1: a committed/discard ACK that is itself aborted mid-flight (the deadline
  // or external/cleanup signal fired while the ACK was pending) is NOT a clean
  // completion and NOT a definitive ACK conflict. Recorded so the run-level
  // remap downgrades the verdict to timeout/cancelled instead of leaving a stale
  // `completed` (the persist-before-ACK already landed on disk) or masking an
  // ACK conflict.
  let ackAborted = false;

  const ackOnce = async (
    client: RuntimeClient,
    disposition: AckDisposition,
    finalSeq: number,
    overrideSignal?: AbortSignal,
  ): Promise<{ ok: boolean; aborted: boolean }> => {
    // G1: a discarded ACK on a cleanup path (ambiguous dispatch / aborted turn)
    // runs under the shared cleanup signal the caller passes in explicitly —
    // ackOnce NEVER re-selects the signal on the cleanup path, so an ambiguous-
    // dispatch ACK cannot fall back to the (possibly far-future) turn deadline
    // and wait past the shared ≤10s budget. A happy terminal ACK (no override)
    // runs under the main deadline while it has budget, falling back to the
    // shared cleanup signal once the deadline already aborted.
    const ackSignal: AbortSignal = overrideSignal ?? (deadline.aborted ? cleanupOf() : deadline);
    try {
      const resp = await client.ack(
        scopeId,
        executionId,
        { ...controller, finalSeq: Math.max(1, finalSeq), disposition },
        { signal: ackSignal },
      );
      const acknowledged = resp.ackState === "acknowledged";
      if (!acknowledged) ackDefinitiveConflict = true;
      ackResult = acknowledged ? "acknowledged" : "conflict";
      return { ok: acknowledged, aborted: false };
    } catch (error) {
      // An abort during the ACK — the deadline, the external signal, or the
      // cleanup-deadline firing on the signal that drove the ACK — is NOT an ACK
      // conflict. Record it so the run-level remap maps the result to
      // timeout/cancelled. Any OTHER throw is a definitive non-acknowledged ACK
      // (expired / conflicting state) → keep ACK_FAILED (F1).
      if (deadline.aborted || ackSignal.aborted || isAbortError(error)) {
        ackAborted = true;
        return { ok: false, aborted: true };
      }
      ackDefinitiveConflict = true;
      ackResult = "conflict";
      return { ok: false, aborted: false };
    }
  };

  const make = (
    verdict: TurnVerdict,
    error: TurnError | null,
    partial: { terminal?: TerminalEvidence | null } = {},
  ): TurnResult => ({
    verdict,
    executionId,
    participantId,
    dispatchState,
    terminal: partial.terminal ?? null,
    durationMs: params.now() - startedAtMs,
    ack: ackResult,
    error,
  });

  /** F1: apply the post-ACK abort downgrade to a terminal-ACK result. Only an
   * `acknowledged` ACK that completed before any abort permits a
   * `completed`/`interrupted`/`failed` terminal verdict. If the deadline or the
   * ACK itself was aborted by a signal (ackAborted), downgrade to
   * timeout/cancelled — even when persist-before-ACK already landed on disk. A
   * definitive ACK conflict (expired / non-acknowledged response, not an abort
   * artifact) keeps ACK_FAILED. This MUST be applied at the `return` site so the
   * returned value reflects the downgrade; a `finally`-block reassignment would
   * not affect an already-captured return value. */
  const remapIfAborted = (r: TurnResult): TurnResult => {
    if (!ackDefinitiveConflict && (deadline.aborted || ackAborted)) {
      return make(abortVerdict(), abortError(), { terminal: r.terminal });
    }
    return r;
  };

  let result: TurnResult | undefined;
  const client = await host.rawClient();

  try {
    // --- execute -----------------------------------------------------------
    try {
      await client.execute(
        scopeId,
        { ...controller, executionId, participantId, snapshot },
        { signal: deadline },
      );
      dispatchState = "accepted";
    } catch (error) {
      // Ambiguous dispatch: the lost/errored execute may have landed. Probe once,
      // never re-dispatch. Preserve the original verdict through cleanup.
      const baseVerdict = (): TurnVerdict => (deadline.aborted ? abortVerdict() : "failed");
      const baseError = (): TurnError =>
        deadline.aborted ? abortError() : classifyClientError(error, "dispatch");

      const probe = await checkAmbiguousDispatch(client, scopeId, executionId, cleanupOf());

      if (probe === "notDispatched") {
        // Definitively never dispatched: nothing to clean up. Persist none, ACK none.
        result = make(baseVerdict(), baseError());
        return result;
      }
      // "dispatched" | "unknown": the turn MAY be running. ONE bounded cleanup
      // (cancel → observe → discarded ACK), execute never re-sent.
      dispatchState = probe === "dispatched" ? "accepted" : "unknown";
      result = await handleAbort({
        client,
        scopeId,
        executionId,
        controller,
        ack: (disposition, finalSeq, ackSignal) =>
          ackOnce(client, disposition, finalSeq, ackSignal),
        make,
        verdict: baseVerdict,
        verdictError: baseError,
        cleanupSignal: cleanupOf(),
      });
      return result;
    }

    // --- follow SSE -------------------------------------------------------
    const terminal = await driveToTerminal({
      client,
      host,
      scopeId,
      executionId,
      controller,
      participantId,
      follow,
      deadlineSignal: deadline,
      onEvent: () => {},
    });

    if (terminal.kind === "aborted") {
      result = await handleAbort({
        client,
        scopeId,
        executionId,
        controller,
        ack: (disposition, finalSeq, ackSignal) =>
          ackOnce(client, disposition, finalSeq, ackSignal),
        make,
        verdict: abortVerdict,
        verdictError: abortError,
        cleanupSignal: cleanupOf(),
      });
      return result;
    }
    if (terminal.kind === "closed") {
      result = make("failed", {
        phase: "stream",
        code: "STREAM_CLOSED",
        message: "event stream closed before a terminal arrived and the execution was lost",
        retryable: false,
      });
      return result;
    }

    const event = terminal.event;
    if (event.type === "completed") {
      const completed = event as CompletedEvent;
      const output = completed.output ?? "";
      const evidence: TerminalEvidence = {
        output,
        requestedModel: completed.requestedModel,
        effectiveModel: completed.effectiveModel,
        modelVerdict: completed.modelVerdict,
        toolState: completed.toolState,
        usage: completed.usage,
        finalSeq: completed.seq,
      };
      if (output.trim().length === 0) {
        // Empty output = failed. Discarded ACK must still be validated.
        const ackRes = await ackOnce(client, "discarded", completed.seq);
        if (!ackRes.ok && !ackRes.aborted) {
          result = make(
            "failed",
            { ...ACK_FAILED_ERROR, message: "EMPTY_OUTPUT + ACK not acknowledged" },
            { terminal: evidence },
          );
          return remapIfAborted(result);
        }
        result = make(
          "failed",
          {
            phase: "terminal",
            code: "EMPTY_OUTPUT",
            message: "model returned an empty output",
            retryable: false,
          },
          { terminal: evidence },
        );
        return remapIfAborted(result);
      }
      // persist BEFORE committed ACK.
      try {
        await params.persist(evidence);
      } catch (persistError) {
        // persisted failed → commit-phase failure. ACK discarded (output not durable),
        // surface a commit error. F5: a local-transcript IO failure (CliError io)
        // is classified phase=io so the run boundary maps it to exit 5, not exit 4.
        const ackRes = await ackOnce(client, "discarded", completed.seq);
        const message = persistError instanceof Error ? persistError.message : "persist failed";
        const isIo = persistError instanceof CliError && persistError.exitCode === EXIT.io;
        if (!ackRes.ok && !ackRes.aborted) {
          result = make(
            "failed",
            { ...ACK_FAILED_ERROR, message: `commit failed + ACK not acknowledged: ${message}` },
            { terminal: evidence },
          );
          return remapIfAborted(result);
        }
        result = make(
          "failed",
          {
            phase: isIo ? "io" : "commit",
            code: isIo ? "TRANSCRIPT_IO" : "PERSIST_FAILED",
            message,
            retryable: false,
          },
          { terminal: evidence },
        );
        return remapIfAborted(result);
      }
      const ackRes = await ackOnce(client, "committed", completed.seq);
      if (!ackRes.ok && !ackRes.aborted) {
        result = make("failed", ACK_FAILED_ERROR, { terminal: evidence });
        return remapIfAborted(result);
      }
      result = make("completed", null, { terminal: evidence });
      return remapIfAborted(result);
    }

    if (event.type === "failed") {
      const failed = event as FailedEvent;
      dispatchState = failed.dispatchState;
      const ackRes = await ackOnce(client, "discarded", failed.seq);
      const terminalErr = classifyTerminalError(failed.error);
      if (!ackRes.ok && !ackRes.aborted) {
        result = make("failed", ACK_FAILED_ERROR);
        return remapIfAborted(result);
      }
      result = make("failed", terminalErr);
      return remapIfAborted(result);
    }

    // interrupted
    const interrupted = event as InterruptedEvent;
    dispatchState = interrupted.dispatchState;
    const ackRes = await ackOnce(client, "discarded", interrupted.seq);
    const interruptErr = classifyInterrupt(interrupted);
    if (!ackRes.ok && !ackRes.aborted) {
      result = make("failed", ACK_FAILED_ERROR);
      return remapIfAborted(result);
    }
    result = make("interrupted", interruptErr);
    return remapIfAborted(result);
  } catch (error) {
    // Defensive catch-all (H2): a genuine non-abort failure is reported as
    // itself, not masked by a racing deadline abort.
    if (isAbortError(error) && (deadline.aborted || signal?.aborted === true)) {
      result = make(abortVerdict(), abortError());
    } else {
      result = make("failed", classifyClientError(error, "stream"));
    }
    return result;
  } finally {
    clearTimeout(timeoutTimer);
    signal?.removeEventListener("abort", onExternalAbort);
    // F1: the abort downgrade (ackDone/ackAborted) is applied at each terminal
    // `return` site via remapIfAborted — NOT here, because a `finally`-block
    // reassignment of `result` would not affect an already-captured return
    // value. This block only tears down timers / the shared cleanup controller.
    cleanupHolder.current?.dispose();
  }
}

// ---------------------------------------------------------------------------
// SSE driving + reconnect (mirrors agent-real-call driveToTerminal)
// ---------------------------------------------------------------------------

type TerminalOutcome =
  | { kind: "terminal"; event: RuntimeEvent }
  | { kind: "closed"; afterSeq: number }
  | { kind: "aborted" };

async function driveToTerminal(input: {
  client: RuntimeClient;
  host: HostLike;
  scopeId: string;
  executionId: string;
  controller: ControllerRequest;
  participantId: string;
  follow: typeof followExecutionEvents;
  deadlineSignal: AbortSignal;
  onEvent: (event: RuntimeEvent) => void;
}): Promise<TerminalOutcome> {
  const { client, host, scopeId, executionId, follow, deadlineSignal, onEvent } = input;
  let resumeAt = 0;
  for (;;) {
    let fetchInput = client.eventStreamFetch({ scopeId, executionId, afterSeq: resumeAt });
    const options: FollowEventsOptions = {
      fetchInput,
      onEvent,
      signal: deadlineSignal,
    };
    let outcome: FollowOutcome;
    try {
      outcome = await follow(options);
    } catch (error) {
      // SSE reported a definitive 401/403 → re-extract auth once, rebuild the
      // fetch input, and reconnect WITHOUT re-dispatching execute. The refreshed
      // outcome then falls through to the normal post-follow handling below.
      if (isEventStreamAuthError(error) && !deadlineSignal.aborted) {
        // H3: thread the turn deadline signal into the cold-rebuild so a SIGINT
        // during the auth GET / aborts it within the shared cleanup budget (the
        // AuthClient combines this signal with its own 8s timeout — G3), instead
        // of letting the auth wait out 8s and only then entering the 10s
        // cancel/observe/ACK cleanup (an ~18s convergence that breaks the shared
        // ≤10s window). Then re-check the abort BEFORE reconnecting so a signal
        // that fired during/right after the refresh converges immediately.
        await host.refreshAuthForStream(deadlineSignal);
        if (deadlineSignal.aborted) return { kind: "aborted" };
        const refreshed = await host.rawClient();
        fetchInput = refreshed.eventStreamFetch({ scopeId, executionId, afterSeq: resumeAt });
        try {
          outcome = await follow({ fetchInput, onEvent, signal: deadlineSignal });
        } catch (error2) {
          if (deadlineSignal.aborted && isAbortError(error2)) return { kind: "aborted" };
          throw error2;
        }
      } else if (deadlineSignal.aborted && isAbortError(error)) {
        return { kind: "aborted" };
      } else {
        throw error;
      }
    }
    if (outcome.kind === "terminal") return { kind: "terminal", event: outcome.event };
    if (outcome.kind === "aborted") return { kind: "aborted" };
    resumeAt = outcome.lastSeq;
    const after = await afterStreamClosed(client, scopeId, executionId, deadlineSignal, resumeAt);
    if (after !== null) return after;
    // else still running / terminal not yet replayed → re-follow from resumeAt.
  }
}

async function afterStreamClosed(
  client: RuntimeClient,
  scopeId: string,
  executionId: string,
  deadlineSignal: AbortSignal,
  resumeAt: number,
): Promise<TerminalOutcome | null> {
  let state: Awaited<ReturnType<RuntimeClient["getExecution"]>> | null = null;
  try {
    state = await client.getExecution(scopeId, executionId, { signal: deadlineSignal });
  } catch {
    state = null;
  }
  if (deadlineSignal.aborted) return { kind: "aborted" };
  if (!state) return { kind: "closed", afterSeq: resumeAt };
  // Still running or terminal not yet replayed → caller re-follows. Returning null
  // signals "continue the reconnect loop from resumeAt".
  return null;
}

// ---------------------------------------------------------------------------
// Ambiguous dispatch probe (three-state)
// ---------------------------------------------------------------------------

type DispatchProbe = "dispatched" | "notDispatched" | "unknown";

async function checkAmbiguousDispatch(
  client: RuntimeClient,
  scopeId: string,
  executionId: string,
  signal: AbortSignal,
): Promise<DispatchProbe> {
  try {
    await client.getExecution(scopeId, executionId, { signal });
    return "dispatched";
  } catch (error) {
    if (
      error instanceof RuntimeClientError &&
      error.status === 404 &&
      error.code === "EXECUTION_NOT_FOUND"
    ) {
      return "notDispatched";
    }
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Cleanup chain: cancel → observe terminal → discarded ACK (shared budget)
// ---------------------------------------------------------------------------

async function handleAbort(input: {
  client: RuntimeClient;
  scopeId: string;
  executionId: string;
  controller: ControllerRequest;
  ack: (
    disposition: AckDisposition,
    finalSeq: number,
    ackSignal?: AbortSignal,
  ) => Promise<{ ok: boolean; aborted: boolean }>;
  make: (
    verdict: TurnVerdict,
    error: TurnError | null,
    partial?: { terminal?: TerminalEvidence | null },
  ) => TurnResult;
  verdict: () => TurnVerdict;
  verdictError: () => TurnError;
  cleanupSignal: AbortSignal;
}): Promise<TurnResult> {
  const { client, scopeId, executionId, controller, ack, make, verdict, verdictError } = input;
  const chainSignal = input.cleanupSignal;
  // Cancel the in-flight execution (never a re-dispatch).
  try {
    await client.cancelExecution(scopeId, executionId, controller, { signal: chainSignal });
  } catch {
    // best-effort; observe still proceeds
  }
  // Observe the terminal the cancel produced (read-only; never re-dispatch).
  let observedSeq: number | null = null;
  for (let attempt = 0; attempt < 5 && !chainSignal.aborted; attempt += 1) {
    try {
      const status = await client.getExecution(scopeId, executionId, { signal: chainSignal });
      if (
        status.state === "interrupted" ||
        status.state === "failed" ||
        status.state === "completed"
      ) {
        observedSeq = status.lastSeq ?? 0;
        break;
      }
    } catch {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  if (observedSeq !== null) {
    // G1: the discarded ACK on this cleanup path runs under the shared cleanup
    // signal (≤10s budget), NOT the turn deadline — handleAbort passes the
    // chainSignal explicitly so ackOnce cannot fall back to the main deadline.
    const ackRes = await ack("discarded", observedSeq, chainSignal);
    if (!ackRes.ok && !ackRes.aborted) {
      return make("failed", ACK_FAILED_ERROR);
    }
  }
  return make(verdict(), verdictError());
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyClientError(error: unknown, phase: TurnError["phase"]): TurnError {
  if (error instanceof RuntimeClientError) {
    return hostErrorToTurn(error.code, error.message, phase);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return {
      phase: "deadline",
      code: "ABORT",
      message: error.message || "request aborted",
      retryable: true,
    };
  }
  return {
    phase,
    code: phase === "dispatch" ? "DISPATCH_FAILED" : "RUNTIME_UNAVAILABLE",
    message: errorMessageOf(error),
    retryable: false,
  };
}

function classifyTerminalError(error: {
  code: string;
  message: string;
  retryable: boolean;
}): TurnError {
  return hostErrorToTurn(error.code, error.message, "terminal", error.retryable);
}

function classifyInterrupt(event: InterruptedEvent): TurnError {
  switch (event.reason) {
    case "timeout":
      return {
        phase: "deadline",
        code: "TURN_TIMEOUT",
        message: "turn timed out",
        retryable: true,
      };
    case "host_shutdown":
      return {
        phase: "terminal",
        code: "HOST_SHUTDOWN",
        message: "host shutdown",
        retryable: false,
      };
    case "supervisor_lost":
      return {
        phase: "terminal",
        code: "SUPERVISOR_LOST",
        message: "supervisor lost",
        retryable: false,
      };
    case "driver_crash":
      return {
        phase: "terminal",
        code: "DRIVER_CRASH",
        message: "driver crashed",
        retryable: false,
      };
    case "user_cancelled":
      return {
        phase: "terminal",
        code: "USER_CANCELLED",
        message: "cancelled by user",
        retryable: false,
      };
    default:
      return { phase: "terminal", code: "INTERRUPTED", message: "interrupted", retryable: false };
  }
}

function hostErrorToTurn(
  code: string,
  message: string,
  phase: TurnError["phase"],
  retryable = false,
): TurnError {
  return { phase, code: code || "CRASH", message, retryable };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isEventStreamAuthError(error: unknown): boolean {
  // The event-stream reader throws an Error with name "EventStreamError" and a
  // status property on a non-ok response (see src/runtime/event-stream.ts). A
  // 401/403 means the session capability was rejected mid-stream.
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: number }).status;
  return error.name === "EventStreamError" && (status === 401 || status === 403);
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
