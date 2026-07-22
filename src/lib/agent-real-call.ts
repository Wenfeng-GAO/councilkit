import { digestOf } from "@/models/discussion/factories";
/**
 * Agent 真实模型调用测试 helper（V1.1 §2 / plan-a §3）。
 *
 * 框架无关、不依赖 React/Dexie/Host 新端点：输入 RuntimeClient + Profile DTO +
 * modelId + persona，驱动 createScope → activateScope → execute → SSE 终态 →
 * ack（committed/discarded）→ closeScope 的完整生命周期，返回终态证据与错误
 * 分类。60s 总超时覆盖全阶段；任何路径不泄漏 scope/进程；结果不落 Dexie。
 *
 * 复用既有 scope/execute/SSE/ack 口径，但完全不读 Dexie/不创建
 * Room/Participant/ModelExecution 行——一次性单 participant scope。
 */
import { type RuntimeClient, RuntimeClientError } from "@/runtime/client";
import { type FollowEventsOptions, followExecutionEvents } from "@/runtime/event-stream";
import type { ToolState } from "@shared/runtime/contracts";
import type {
  CompletedEvent,
  FailedEvent,
  InterruptedEvent,
  ModelVerdict,
  RuntimeEvent,
  Usage,
} from "@shared/runtime/events";
import type { ContextSnapshot, ExecutionProfileDto, SnapshotItem } from "@shared/runtime/schemas";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AgentRealCallVerdict = "completed" | "failed" | "interrupted" | "timeout" | "cancelled";

export type AgentRealCallErrorCategory =
  | "auth"
  | "installation"
  | "model_unavailable"
  | "timeout"
  | "quota"
  | "crash";

export interface AgentRealCallError {
  category: AgentRealCallErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
}

export interface AgentRealCallResult {
  verdict: AgentRealCallVerdict;
  canonical: string | null;
  effective: string | null;
  modelVerdict: ModelVerdict | null;
  toolState: ToolState | null;
  ttftMs: number | null;
  totalMs: number;
  outputPreview: string;
  usage: Usage | null;
  error: AgentRealCallError | null;
}

export interface AgentRealCallInput {
  client: RuntimeClient;
  profile: ExecutionProfileDto;
  modelId: string;
  persona: string;
  signal?: AbortSignal;
  /** 默认 60_000。 */
  timeoutMs?: number;
  idFactory?: () => string;
  now?: () => number;
  /** 注入式 SSE 跟随器，便于单测替换。 */
  followEvents?: typeof followExecutionEvents;
}

/** outputPreview 按 Unicode code point 截断的最大长度。 */
export const AGENT_REAL_CALL_PREVIEW_MAX = 500;

/** 探针指令逐字（plan-a §3 / Q16）。 */
const PROBE_INSTRUCTION = "Reply with exactly: COUNCILKIT_OK";

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function runAgentRealCallTest(input: AgentRealCallInput): Promise<AgentRealCallResult> {
  const now = input.now ?? Date.now;
  const ids = input.idFactory ?? (() => crypto.randomUUID());
  const timeoutMs = input.timeoutMs ?? 60_000;

  return runInternal({
    client: input.client,
    profile: input.profile,
    modelId: input.modelId,
    persona: input.persona,
    externalSignal: input.signal,
    timeoutMs,
    ids,
    now,
    follow: input.followEvents ?? followExecutionEvents,
  });
}

// ---------------------------------------------------------------------------
// Internal driver
// ---------------------------------------------------------------------------

interface RunParams {
  client: RuntimeClient;
  profile: ExecutionProfileDto;
  modelId: string;
  persona: string;
  externalSignal?: AbortSignal;
  timeoutMs: number;
  ids: () => string;
  now: () => number;
  follow: typeof followExecutionEvents;
}

/** Short bounded deadline for the cleanup chain (cancel/recover/close): the
 * helper MUST converge after the main 60s deadline, so cleanup never reuses an
 * already-aborted signal and has its own 10s ceiling (plan-a §3 risk 4 / F2). */
const CLEANUP_DEADLINE_MS = 10_000;

/** A one-shot bounded cleanup controller: aborts after CLEANUP_DEADLINE_MS so a
 * hung cancel/close request cannot keep the helper pending forever. */
function newCleanupSignal(): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("cleanup-deadline"), CLEANUP_DEADLINE_MS);
  // In Node, unref the timer so it cannot keep the event loop alive on its own
  // (the caller still awaits the cleanup request synchronously). In the browser
  // setTimeout returns a number and there is nothing to unref.
  if (typeof timer === "object" && typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

async function runInternal(params: RunParams): Promise<AgentRealCallResult> {
  const { client, profile, modelId, persona, externalSignal, timeoutMs, ids, now, follow } = params;
  const startedAtMs = now();

  // Stable idents up-front: a lost create response is recovered idempotently by
  // re-using the same scopeRequestId.
  const scopeRequestId = ids();
  const participantId = ids();
  const executionId = ids();

  // --- Combined deadline (F6): track abortSource explicitly, never guess from
  // the reason string. The internal timer fires `deadline`; an external signal
  // flips `external`. The merged controller records which one fired so every
  // stage catch can map timeout vs cancelled uniformly.
  const timeoutController = new AbortController();
  let abortSource: "deadline" | "external" | null = null;
  const onExternalAbort = () => {
    if (abortSource === null) abortSource = "external";
    timeoutController.abort(externalSignal?.reason ?? "external");
  };
  if (externalSignal?.aborted) {
    abortSource = "external";
    timeoutController.abort("external");
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timeoutTimer = setTimeout(() => {
    if (abortSource === null) abortSource = "deadline";
    timeoutController.abort("timeout");
  }, timeoutMs);
  const deadline = timeoutController.signal;
  /** Map the active abort source to a verdict. `timeout` only ever comes from
   * the internal deadline; an external abort is `cancelled`. */
  const abortVerdict = (): "timeout" | "cancelled" =>
    abortSource === "deadline" ? "timeout" : "cancelled";
  const abortError = (): AgentRealCallError =>
    abortSource === "deadline"
      ? makeTimeoutError()
      : {
          category: "crash",
          code: "CANCELLED",
          message: "cancelled by caller",
          retryable: false,
        };

  let ttftMs: number | null = null;
  // F5: executeStartedAtMs is captured just before client.execute so ttftMs
  // excludes create/activate/prewarm latency; totalMs keeps using startedAtMs.
  let executeStartedAtMs: number | null = null;
  let dispatched = false;
  let ackDone = false;
  const owned: { scopeId?: string; controllerId?: string; leaseEpoch?: number } = {};
  const token = () => ({
    controllerId: owned.controllerId as string,
    leaseEpoch: owned.leaseEpoch as number,
  });
  const snapshot = buildProbeSnapshot({ participantId, persona });
  // ACK at most once across the run's terminal path. ALL discarded paths must
  // receive `ackState=acknowledged` (F1): a discarded ACK that is not
  // acknowledged degrades the result to an explicit cleanup/ACK error so a
  // missing-or-conflicting ACK is surfaced rather than masked by closeScope.
  const ackOnce = async (
    disposition: "committed" | "discarded",
    finalSeq: number,
  ): Promise<boolean> => {
    if (!owned.scopeId || ackDone) return false;
    ackDone = true;
    try {
      const resp = await client.ack(
        owned.scopeId,
        executionId,
        { ...token(), finalSeq: Math.max(1, finalSeq), disposition },
        { signal: newCleanupSignal() },
      );
      return resp.ackState === "acknowledged";
    } catch {
      return false;
    }
  };

  let result: AgentRealCallResult | undefined;
  let cleanupFailure: AgentRealCallError | null = null;

  const make = (
    verdict: AgentRealCallVerdict,
    error: AgentRealCallError | null,
    partial: Partial<AgentRealCallResult> = {},
  ): AgentRealCallResult => ({
    verdict,
    canonical: partial.canonical ?? null,
    effective: partial.effective ?? null,
    modelVerdict: partial.modelVerdict ?? null,
    toolState: partial.toolState ?? null,
    ttftMs: partial.ttftMs ?? ttftMs,
    totalMs: now() - startedAtMs,
    outputPreview: partial.outputPreview ?? "",
    usage: partial.usage ?? null,
    error,
  });

  try {
    // --- create -----------------------------------------------------------
    let created: Awaited<ReturnType<RuntimeClient["createScope"]>>;
    try {
      created = await client.createScope(
        {
          scopeRequestId,
          participants: [{ participantId, profile, modelId, personaPrompt: persona || undefined }],
        },
        { signal: deadline },
      );
    } catch (error) {
      if (deadline.aborted) {
        // create lost/timed out: idempotent recovery, close, then classify.
        // recoverAndClose returns whether its own close succeeded so the verdict
        // can surface a cleanup failure (F2) instead of swallowing it.
        const recovered = await recoverAndClose({
          client,
          scopeRequestId,
          profile,
          modelId,
          persona,
          participantId,
        });
        if (!recovered.closed && recovered.attempted) {
          cleanupFailure = {
            category: "crash",
            code: "SCOPE_CLOSE_FAILED",
            message: "recovered scope could not be closed after create abort",
            retryable: false,
          };
        }
        result = make(abortVerdict(), cleanupFailure ?? abortError());
      } else {
        result = make("failed", classifyClientError(error));
      }
      return result;
    }
    owned.scopeId = created.scopeId;
    owned.controllerId = created.controllerId;
    owned.leaseEpoch = created.leaseEpoch;
    const canonical =
      created.scope.participants.find((p) => p.participantId === participantId)?.binding
        ?.canonicalModelId ?? null;

    if (deadline.aborted) {
      result = make(abortVerdict(), abortError(), { canonical });
      return result;
    }

    // --- activate ---------------------------------------------------------
    let activated: Awaited<ReturnType<RuntimeClient["activateScope"]>>;
    try {
      activated = await client.activateScope(created.scopeId, token(), { signal: deadline });
    } catch (error) {
      // F6: a deadline abort during activate is a timeout, not a generic
      // failure; an external abort is cancelled (mapped uniformly here).
      result = make(
        deadline.aborted ? abortVerdict() : "failed",
        deadline.aborted ? abortError() : classifyClientError(error),
        { canonical },
      );
      return result;
    }
    const ap = activated.participants.find((p) => p.participantId === participantId);
    const gate = gateParticipant(ap);
    if (gate) {
      result = make(gate.verdict, gate.error, { canonical });
      return result;
    }
    if (deadline.aborted) {
      result = make(abortVerdict(), abortError(), { canonical });
      return result;
    }

    // --- execute (F5: capture executeStartedAtMs just before dispatch) -----
    executeStartedAtMs = now();
    try {
      await client.execute(
        created.scopeId,
        { ...token(), executionId, participantId, snapshot },
        { signal: deadline },
      );
      dispatched = true;
    } catch (error) {
      result = make(
        deadline.aborted ? abortVerdict() : "failed",
        deadline.aborted ? abortError() : classifyClientError(error, { dispatch: true }),
        { canonical },
      );
      return result;
    }

    // --- follow SSE -------------------------------------------------------
    const terminal = await driveToTerminal({
      client,
      scopeId: created.scopeId,
      executionId,
      follow,
      deadlineSignal: deadline,
      onEvent: (event) => {
        if (ttftMs === null && isOutputEvent(event)) {
          // F5: TTFT is measured from execute dispatch, not helper start.
          ttftMs = executeStartedAtMs !== null ? now() - executeStartedAtMs : now() - startedAtMs;
        }
      },
    });

    if (terminal.kind === "aborted") {
      // Abort during streaming (F1): cancel an in-flight execution, then — with
      // an independent bounded cleanup signal — observe the interrupted terminal
      // and ACK discarded. The cancel request itself is NEVER a re-dispatch. We
      // then validate the discarded ACK reached `acknowledged`; otherwise the
      // result degrades to an explicit ACK/cleanup error.
      result = await handleAbort({
        client,
        scopeId: created.scopeId,
        executionId,
        dispatched,
        token,
        ack: ackOnce,
        make,
        abortVerdict,
        abortError,
        canonical,
      });
      return result;
    }

    if (terminal.kind === "closed") {
      result = await handleStreamReconnect({ canonical, make });
      return result;
    }

    result = await handleTerminalEvent({
      event: terminal.event,
      canonical,
      ack: ackOnce,
      make,
      now,
      startedAtMs,
      executeStartedAtMs,
      getTtft: () => ttftMs,
    });
    return result;
  } catch (error) {
    // Defensive catch-all: classify and let finally close. A deadline abort here
    // is a timeout; anything else is a crash.
    result = make(
      deadline.aborted ? abortVerdict() : "failed",
      deadline.aborted ? abortError() : classifyClientError(error),
    );
    return result;
  } finally {
    clearTimeout(timeoutTimer);
    // F6: always remove the external listener so a reused long-lived signal
    // cannot accumulate listeners across repeated calls.
    externalSignal?.removeEventListener("abort", onExternalAbort);
    // F2: closeScope runs exactly once with an independent bounded cleanup
    // signal, so an already-aborted deadline cannot block it and a hung close
    // still converges. recoverAndClose's own recovered scope is closed by it
    // directly (no owned controller), so this finally only closes the_owned scope.
    if (owned.scopeId && owned.controllerId && owned.leaseEpoch !== undefined) {
      let closed = false;
      try {
        await client.closeScope(owned.scopeId, token(), { signal: newCleanupSignal() });
        closed = true;
      } catch {
        closed = false;
      }
      if (!closed) {
        // F2: close failure is never swallowed. Any verdict downgrades to a
        // crash so the UI can flag diagnostics; Host reaper is the last resort.
        cleanupFailure = {
          category: "crash",
          code: "SCOPE_CLOSE_FAILED",
          message: "scope could not be closed after the call",
          retryable: false,
        };
      }
    }
    if (cleanupFailure && result) {
      result.verdict = "failed";
      result.error = cleanupFailure;
    }
  }
}

// ---------------------------------------------------------------------------
// Terminal handling
// ---------------------------------------------------------------------------

/** F1: a discarded ACK that does not reach `acknowledged` is an explicit
 * cleanup/ACK error — the result degrades rather than masking an ACK conflict
 * behind the original terminal verdict. */
const ACK_FAILED_ERROR: AgentRealCallError = {
  category: "crash",
  code: "ACK_FAILED",
  message: "ACK did not reach the acknowledged state",
  retryable: true,
};

/** When a discarded ACK fails validation, surface the explicit ACK conflict
 * (ACK_FAILED) — never the bare terminal error — so a broken cleanup/ACK path
 * is identifiable (reviewer F1 repro: ack=expired must read ACK_FAILED, not the
 * original DRIVER_CRASH / SUPERVISOR_LOST). The verdict degrades to failed. */
function degradeDiscardedAck(
  make: (verdict: AgentRealCallVerdict, error: AgentRealCallError | null) => AgentRealCallResult,
): AgentRealCallResult {
  return make("failed", ACK_FAILED_ERROR);
}

async function handleTerminalEvent(input: {
  event: RuntimeEvent;
  canonical: string | null;
  ack: (disposition: "committed" | "discarded", finalSeq: number) => Promise<boolean>;
  make: (
    verdict: AgentRealCallVerdict,
    error: AgentRealCallError | null,
    partial?: Partial<AgentRealCallResult>,
  ) => AgentRealCallResult;
  now: () => number;
  startedAtMs: number;
  executeStartedAtMs: number | null;
  getTtft: () => number | null;
}): Promise<AgentRealCallResult> {
  const { event, canonical, ack, make, now, startedAtMs, executeStartedAtMs, getTtft } = input;
  // F5: final-only/completed TTFT falls back to the gap from execute dispatch
  // (not helper start), so create/activate latency never inflates first-frame.
  const ttftFallback = () =>
    (executeStartedAtMs ?? startedAtMs) !== null
      ? now() - (executeStartedAtMs ?? startedAtMs)
      : null;

  if (event.type === "completed") {
    const completed = event as CompletedEvent;
    const output = completed.output ?? "";
    if (output.trim().length === 0) {
      // F1: discarded ACK must validate ackState. EmptyOutput is already failed;
      // if the discarded ACK is not acknowledged, surface the explicit ACK
      // error (code ACK_FAILED) so the ACK conflict is not masked.
      const ackOk = await ack("discarded", completed.seq);
      const emptyErr: AgentRealCallError = {
        category: "crash",
        code: "EMPTY_OUTPUT",
        message: "model returned an empty output",
        retryable: false,
      };
      const partial = {
        canonical: canonical ?? completed.requestedModel,
        effective: completed.effectiveModel,
        modelVerdict: completed.modelVerdict,
        toolState: completed.toolState,
        ttftMs: getTtft() ?? ttftFallback(),
        usage: completed.usage,
      };
      if (!ackOk) {
        return make(
          "failed",
          { ...ACK_FAILED_ERROR, message: "EMPTY_OUTPUT + ACK not acknowledged" },
          partial,
        );
      }
      return make("failed", emptyErr, partial);
    }
    const ackOk = await ack("committed", completed.seq);
    if (!ackOk) {
      return make("failed", ACK_FAILED_ERROR, {
        canonical: canonical ?? completed.requestedModel,
        effective: completed.effectiveModel,
        modelVerdict: completed.modelVerdict,
        toolState: completed.toolState,
        usage: completed.usage,
        outputPreview: truncatePreview(output),
      });
    }
    return make("completed", null, {
      canonical: canonical ?? completed.requestedModel,
      effective: completed.effectiveModel,
      modelVerdict: completed.modelVerdict,
      toolState: completed.toolState,
      usage: completed.usage,
      outputPreview: truncatePreview(output),
    });
  }

  if (event.type === "failed") {
    const failed = event as FailedEvent;
    const terminalErr = classifyTerminalError(failed.error);
    // F1: validate the discarded ACK. A failed terminal whose discarded ACK is
    // not acknowledged surfaces the ACK conflict (ACK_FAILED) instead of the
    // bare driver crash — the verdict stays failed either way, but the cause
    // identifies the broken cleanup/ACK path (reviewer repro: ack=expired).
    const ackOk = await ack("discarded", failed.seq);
    if (!ackOk) return make("failed", ACK_FAILED_ERROR, { canonical });
    return make("failed", terminalErr, { canonical });
  }

  // interrupted
  const interrupted = event as InterruptedEvent;
  const interruptErr = classifyInterrupt(interrupted);
  // F1: discarded ACK validated. interrupted normally returns `interrupted`;
  // a discarded ACK that fails validation degrades to failed + the ACK error so
  // the ACK conflict is not masked by closeScope.
  const ackOk = await ack("discarded", interrupted.seq);
  if (!ackOk) return degradeDiscardedAck(make);
  return make("interrupted", interruptErr, { canonical });
}

/**
 * F1: handle a deadline/external abort during streaming. Cancel an in-flight
 * execution (no re-dispatch), then — using an independent bounded cleanup
 * signal — observe whether cancel produced an interrupted terminal. If it did,
 * send a discarded ACK and VALIDATE ackState; if the discarded ACK is not
 * acknowledged, the result degrades to an explicit ACK/cleanup error. The
 * observer never re-dispatches execute; it only reads the execution record.
 */
async function handleAbort(input: {
  client: RuntimeClient;
  scopeId: string;
  executionId: string;
  dispatched: boolean;
  token: () => { controllerId: string; leaseEpoch: number };
  ack: (disposition: "committed" | "discarded", finalSeq: number) => Promise<boolean>;
  make: (
    verdict: AgentRealCallVerdict,
    error: AgentRealCallError | null,
    partial?: Partial<AgentRealCallResult>,
  ) => AgentRealCallResult;
  abortVerdict: () => "timeout" | "cancelled";
  abortError: () => AgentRealCallError;
  canonical: string | null;
}): Promise<AgentRealCallResult> {
  const {
    client,
    scopeId,
    executionId,
    dispatched,
    token,
    ack,
    make,
    abortVerdict,
    abortError,
    canonical,
  } = input;
  if (dispatched) {
    // Cancel with an independent bounded cleanup signal (F2): a hung cancel
    // cannot keep the helper pending; execute is NEVER re-sent.
    try {
      await client.cancelExecution(scopeId, executionId, token(), {
        signal: newCleanupSignal(),
      });
    } catch {
      // Best-effort: a failed cancel still proceeds to observe the terminal;
      // the cleanup-failure accounting happens below via the ACK validation.
    }
    // Observe the interrupted terminal the cancel produced, bounded by the
    // cleanup signal. Only read the record (getExecution) — never re-dispatch.
    let observedSeq: number | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const status = await client.getExecution(scopeId, executionId, {
          signal: newCleanupSignal(),
        });
        if (
          status.state === "interrupted" ||
          status.state === "failed" ||
          status.state === "completed"
        ) {
          observedSeq = status.lastSeq ?? 0;
          break;
        }
      } catch {
        break; // Host unreachable / gone — cannot observe; fall through.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    if (observedSeq !== null) {
      // F1: observed a terminal → send discarded ACK and validate ackState.
      // A discarded ACK that is not acknowledged degrades the verdict to
      // failed with the explicit ACK error (never silently mask an ACK gap).
      const ackOk = await ack("discarded", Math.max(1, observedSeq));
      if (!ackOk) {
        return make("failed", ACK_FAILED_ERROR, { canonical });
      }
    }
    // No observable terminal (cancel didn't settle in the cleanup window):
    // the verdict is the abort verdict surface; close failure (if any) is
    // still accounted in the unified finally (F2).
  }
  return make(abortVerdict(), abortError(), { canonical });
}

// ---------------------------------------------------------------------------
// SSE driving + reconnect (mirrors orchestrator driveToTerminal semantics)
// ---------------------------------------------------------------------------

type TerminalOutcome =
  | { kind: "terminal"; event: RuntimeEvent }
  | { kind: "closed"; afterSeq: number }
  | { kind: "aborted" };

async function driveToTerminal(input: {
  client: RuntimeClient;
  scopeId: string;
  executionId: string;
  follow: typeof followExecutionEvents;
  deadlineSignal: AbortSignal;
  onEvent: (event: RuntimeEvent) => void;
}): Promise<TerminalOutcome> {
  const { client, scopeId, executionId, follow, deadlineSignal, onEvent } = input;
  let resumeAt = 0;
  for (;;) {
    const fetchInput = client.eventStreamFetch({ scopeId, executionId, afterSeq: resumeAt });
    const options: FollowEventsOptions = {
      fetchInput,
      onEvent,
      signal: deadlineSignal,
    };
    const outcome = await follow(options);
    if (outcome.kind === "terminal") return { kind: "terminal", event: outcome.event };
    if (outcome.kind === "aborted") return { kind: "aborted" };
    // closed without terminal: re-read the Host record to decide resume vs terminal.
    resumeAt = outcome.lastSeq;
    let state: Awaited<ReturnType<RuntimeClient["getExecution"]>> | null = null;
    try {
      state = await client.getExecution(scopeId, executionId, { signal: deadlineSignal });
    } catch {
      state = null;
    }
    if (deadlineSignal.aborted) return { kind: "aborted" };
    if (!state) return { kind: "closed", afterSeq: resumeAt };
    // Both "still running" and "Host terminal not yet replayed" cases re-follow
    // from afterSeq on the next iteration (execute is NEVER re-dispatched —
    // reconnect only) until a terminal arrives.
  }
}

async function handleStreamReconnect(input: {
  canonical: string | null;
  make: (
    verdict: AgentRealCallVerdict,
    error: AgentRealCallError | null,
    partial?: Partial<AgentRealCallResult>,
  ) => AgentRealCallResult;
}): Promise<AgentRealCallResult> {
  const { canonical, make } = input;
  // Stream closed and getExecution returned nothing usable: treat as crash — no
  // re-dispatch is allowed (execute at most once).
  return make(
    "failed",
    {
      category: "crash",
      code: "STREAM_CLOSED",
      message: "event stream closed before a terminal arrived and the execution was lost",
      retryable: false,
    },
    { canonical },
  );
}

// ---------------------------------------------------------------------------
// Idempotent create recovery
// ---------------------------------------------------------------------------

/** F2 result: whether recovery attempted to close a scope and whether the close
 * succeeded, so the create-abort path can surface a cleanup failure instead of
 * swallowing it. */
interface RecoveryResult {
  attempted: boolean;
  closed: boolean;
}

async function recoverAndClose(input: {
  client: RuntimeClient;
  scopeRequestId: string;
  profile: ExecutionProfileDto;
  modelId: string;
  persona: string;
  participantId: string;
}): Promise<RecoveryResult> {
  const { client, scopeRequestId, profile, modelId, persona, participantId } = input;
  // F2: independent bounded cleanup signal so a pre-aborted deadline cannot
  // block recovery and a hung create/close still converges within the cleanup
  // window. Never rethrow — the caller maps the result onto the verdict.
  const cleanup = newCleanupSignal();
  try {
    const recovered = await client.createScope(
      {
        scopeRequestId,
        participants: [{ participantId, profile, modelId, personaPrompt: persona || undefined }],
      },
      { signal: cleanup },
    );
    try {
      await client.closeScope(
        recovered.scopeId,
        { controllerId: recovered.controllerId, leaseEpoch: recovered.leaseEpoch },
        { signal: cleanup },
      );
      return { attempted: true, closed: true };
    } catch {
      // F2: close failure NOT swallowed — return closed:false so the caller
      // surfaces SCOPE_CLOSE_FAILED rather than masking it.
      return { attempted: true, closed: false };
    }
  } catch {
    // If the first create never landed, the recovery create may have thrown
    // (e.g. Host gone). Nothing to close; not a cleanup failure.
    return { attempted: false, closed: false };
  }
}

// ---------------------------------------------------------------------------
// Participant readiness gating (activate-time)
// ---------------------------------------------------------------------------

function gateParticipant(
  status:
    | {
        runtime?: string;
        binding?: { canonicalModelId?: string } | null;
        readiness?: { state?: string | null; detail?: string | null } | null;
      }
    | undefined,
): { verdict: AgentRealCallVerdict; error: AgentRealCallError } | null {
  if (!status) return null;
  const readiness = status.readiness?.state;
  if (readiness === "ready") return null;
  if (readiness === "invalid_binding") {
    return {
      verdict: "failed",
      error: {
        category: "installation",
        code: "INVALID_BINDING",
        message: status.readiness?.detail ?? "installation/binding invalid",
        retryable: false,
      },
    };
  }
  if (readiness === "model_unavailable") {
    return {
      verdict: "failed",
      error: {
        category: "model_unavailable",
        code: "MODEL_UNAVAILABLE",
        message: status.readiness?.detail ?? "selected modelId not in the driver catalog",
        retryable: false,
      },
    };
  }
  if (readiness === "runtime_unavailable") {
    const detail = (status.readiness?.detail ?? "").toLowerCase();
    const authKeywords = ["auth", "login", "unauthenticated", "forbidden"];
    if (authKeywords.some((keyword) => detail.includes(keyword))) {
      return {
        verdict: "failed",
        error: {
          category: "auth",
          code: "AUTH_REQUIRED",
          message: status.readiness?.detail ?? "local CLI not authenticated",
          retryable: false,
        },
      };
    }
    return {
      verdict: "failed",
      error: {
        category: "crash",
        code: "RUNTIME_UNAVAILABLE",
        message: status.readiness?.detail ?? "runtime unavailable",
        retryable: false,
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyClientError(
  error: unknown,
  opts: { dispatch?: boolean } = {},
): AgentRealCallError {
  if (error instanceof RuntimeClientError) {
    return classifyCode(error.code, error.status, error.message);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return {
      category: "timeout",
      code: "ABORT",
      message: error.message || "request aborted",
      retryable: true,
    };
  }
  return {
    category: "crash",
    code: opts.dispatch ? "DISPATCH_FAILED" : "RUNTIME_UNAVAILABLE",
    message: errorMessageOf(error),
    retryable: false,
  };
}

function classifyTerminalError(error: {
  code: string;
  message: string;
  retryable: boolean;
}): AgentRealCallError {
  return classifyCode(error.code, 0, error.message, error.retryable);
}

function classifyInterrupt(event: InterruptedEvent): AgentRealCallError {
  switch (event.reason) {
    case "timeout":
      return {
        category: "timeout",
        code: "TURN_TIMEOUT",
        message: "turn timed out",
        retryable: true,
      };
    case "host_shutdown":
      return {
        category: "crash",
        code: "HOST_SHUTDOWN",
        message: "host shutdown",
        retryable: false,
      };
    case "supervisor_lost":
      return {
        category: "crash",
        code: "SUPERVISOR_LOST",
        message: "supervisor lost",
        retryable: false,
      };
    case "driver_crash":
      return {
        category: "crash",
        code: "DRIVER_CRASH",
        message: "driver crashed",
        retryable: false,
      };
    case "user_cancelled":
      return {
        category: "crash",
        code: "USER_CANCELLED",
        message: "cancelled by user",
        retryable: false,
      };
    default:
      return { category: "crash", code: "INTERRUPTED", message: "interrupted", retryable: false };
  }
}

function classifyCode(
  code: string,
  status: number,
  message: string,
  retryable = false,
): AgentRealCallError {
  const c = code;
  if (
    c === "UNAUTHENTICATED" ||
    c === "FORBIDDEN" ||
    c === "CSRF_MISMATCH" ||
    c === "AUTH_REQUIRED" ||
    c === "STALE_CONTROLLER"
  ) {
    return { category: "auth", code: c, message, retryable: false };
  }
  if (
    c === "INSTALLATION_NOT_FOUND" ||
    c === "INSTALLATION_INVALID" ||
    c === "INSTALLATION_CHANGED" ||
    c === "INSTALLATION_UNTRUSTED" ||
    c === "PROFILE_INVALID" ||
    c === "INCOMPATIBLE_DRIVER"
  ) {
    return { category: "installation", code: c, message, retryable: false };
  }
  if (c === "MODEL_UNAVAILABLE" || c === "MODEL_MISMATCH") {
    return { category: "model_unavailable", code: c, message, retryable: false };
  }
  if (
    c === "HANDSHAKE_TIMEOUT" ||
    c === "DISPATCH_TIMEOUT" ||
    c === "STREAM_IDLE_TIMEOUT" ||
    c === "STREAM_DRAIN_TIMEOUT" ||
    c === "TURN_TIMEOUT"
  ) {
    return { category: "timeout", code: c, message, retryable: retryable || true };
  }
  if (
    c === "RESOURCE_LIMIT" ||
    c === "RATE_LIMITED" ||
    c === "PARTICIPANT_BUSY" ||
    status === 429
  ) {
    return { category: "quota", code: c, message, retryable: retryable || true };
  }
  // Crash bucket (default fallback): driver spawn/protocol/internal/unknown.
  return { category: "crash", code: c || "CRASH", message, retryable };
}

function makeTimeoutError(): AgentRealCallError {
  return {
    category: "timeout",
    code: "DEADLINE_TIMEOUT",
    message: "60s deadline exceeded",
    retryable: true,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isOutputEvent(event: RuntimeEvent): boolean {
  return (
    event.type === "output.delta" || event.type === "output.snapshot" || event.type === "completed"
  );
}

/** Truncate to AGENT_REAL_CALL_PREVIEW_MAX Unicode code points, append ellipsis. */
function truncatePreview(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= AGENT_REAL_CALL_PREVIEW_MAX) return text;
  return `${chars.slice(0, AGENT_REAL_CALL_PREVIEW_MAX).join("")}…`;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function buildProbeSnapshot(input: { participantId: string; persona: string }): ContextSnapshot {
  const instruction = { kind: "message" as const, text: PROBE_INSTRUCTION };
  const instructionDigest = digestOf({
    digestVersion: 1,
    kind: instruction.kind,
    text: instruction.text,
  });
  const items: SnapshotItem[] = [];
  const participantSnapshotDigest = digestOf({
    digestVersion: 1,
    personaPrompt: input.persona || undefined,
  });
  return {
    digestVersion: 1,
    roomContext: {
      contextRevision: 0,
      contextDigest: digestOf({ digestVersion: 1, topic: "", background: "", items }),
      items,
    },
    participant: {
      participantId: input.participantId,
      participantSnapshotDigest,
      ...(input.persona ? { personaPrompt: input.persona } : {}),
    },
    instruction: {
      kind: instruction.kind,
      instructionDigest,
      text: instruction.text,
    },
  };
}

// Silent type re-exports to keep imports used under isolatedModules.
export type { CompletedEvent, FailedEvent, InterruptedEvent, ModelVerdict, Usage };
