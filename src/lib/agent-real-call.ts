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
import {
  type FollowEventsOptions,
  type FollowOutcome,
  followExecutionEvents,
} from "@/runtime/event-stream";
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

/** Short bounded ceiling for the SHARED cleanup budget (plan-a §3 risk 4 / F2).
 * The cleanup chain (cancel → observe → ACK → close) MUST share ONE remaining
 * budget rather than resetting 10s per request (reviewer G3): otherwise the
 * helper can hang ~30-40s after the 60s main deadline. G3: one controller per
 * run covers the whole chain. */
const CLEANUP_BUDGET_MS = 10_000;

/** A shared, per-run cleanup controller (G3): cancel → observe → ACK(cancel-path)
 * → close all draw from the same bounded budget, so the cleanup chain cannot
 * stretch past CLEANUP_BUDGET_MS in aggregate. The timer is cleared when the
 * holder disposes it via `dispose()` after the chain ends. */
interface SharedCleanup {
  signal: AbortSignal;
  dispose: () => void;
}

function newSharedCleanup(): SharedCleanup {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("cleanup-deadline"), CLEANUP_BUDGET_MS);
  // In Node, unref the timer so it cannot keep the event loop alive on its own
  // (the caller still awaits the cleanup request synchronously). In the browser
  // setTimeout returns a number and there is nothing to unref.
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
  // G3: one SHARED cleanup controller per run covers the whole cleanup chain
  // (cancel → observe terminal → ACK(cancel-path) → close). It is created
  // lazily on first cleanup use (abort/cleanup paths) and disposed at the end
  // of runInternal's finally. The happy-path terminal ACK does NOT consume the
  // cleanup budget — it runs under the main deadline (G5). A holder object is
  // used so closure-assigned mutations are not narrowed to the initial value.
  const cleanupHolder: { current: SharedCleanup | null } = { current: null };
  /** G3/G6/handleAbort: lazily materialize the shared cleanup controller so
   * happy-path runs (no abort, clean close) never start a timer. On the
   * happy path `finally` still closes the scope, but on the happy path the
   * main deadline has budget remaining and is used directly for the close. */
  const cleanupOf = (): AbortSignal => {
    if (!cleanupHolder.current) cleanupHolder.current = newSharedCleanup();
    return cleanupHolder.current.signal;
  };
  /** G5: a terminal ACK on the HAPPY path (completed/interrupted/failed during
   * streaming) runs under the MAIN deadline, with the cleanup signal as a
   * backstop so a stalled ACK still converges once cleanup begins. The shared
   * cleanup signal (not a fresh 10s window) is the backstop.
   *
   * During the abort/cleanup path ACKs, the deadline is long since aborted, so
   * the cleanup signal alone drives the ACK — drawn from the SAME shared
   * budget (G3). */
  const ackSignal = (): AbortSignal => (deadline.aborted ? cleanupOf() : deadline);
  // ACK at most once across the run's terminal path. ALL discarded paths must
  // receive `ackState=acknowledged` (F1): a discarded ACK that is not
  // acknowledged degrades the result to an explicit cleanup/ACK error so a
  // missing-or-conflicting ACK is surfaced rather than masked by closeScope.
  let ackAborted = false;
  const ackOnce = async (
    disposition: "committed" | "discarded",
    finalSeq: number,
  ): Promise<AckOutcome> => {
    if (!owned.scopeId || ackDone) return { ok: false, aborted: deadline.aborted };
    ackDone = true;
    // G5: ACK runs under the main deadline while it has budget. If the deadline
    // (or external abort) fires DURING the ACK, classify via abortSource rather
    // than misreporting ACK_FAILED/completed. The abort path (handleAbort) sends
    // a discarded ACK after deadline abort, where ackSignal() resolves to the
    // shared cleanup signal — drawn from the SAME shared budget (G3).
    const signal = ackSignal();
    try {
      const resp = await client.ack(
        owned.scopeId,
        executionId,
        { ...token(), finalSeq: Math.max(1, finalSeq), disposition },
        { signal },
      );
      // G5: a COMPLETED ACK response — even after the deadline aborted — is a
      // real ACK result. A non-acknowledged state (e.g. expired) is a genuine
      // ACK conflict that MUST surface as ACK_FAILED (F1), NOT be masked as an
      // abort outcome. Only an ACK that was ITSELF aborted (throw, signal
      // aborted → no response reached) is classified as aborted below.
      return { ok: resp.ackState === "acknowledged", aborted: false };
    } catch {
      // G5: an abort during the ACK (deadline/external/cleanup-deadline) is NOT
      // an ACK conflict. Record it so the caller maps the result to
      // timeout/cancelled instead of degrading to ACK_FAILED. Other failures
      // (real ACK rejection / non-acknowledged) surface as ok:false,aborted:false
      // → caller degrades per F1.
      if (deadline.aborted || signal.aborted) {
        ackAborted = true;
        return { ok: false, aborted: true };
      }
      return { ok: false, aborted: false };
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
          signal: cleanupOf(),
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
      } else if (isCreateTransportLoss(error)) {
        // G6: a non-abort transport/response-parse failure CANNOT prove the
        // request never landed on the Host — a scope may already be created and
        // prewarmed. Recover+close idempotently with the SAME scopeRequestId
        // (bounded by the shared cleanup budget) so a leaked scope does not
        // survive until the 30s creating-scope reaper. A definitive HTTP
        // validation rejection (400/401/403/404/409 etc.) is NOT a transport
        // loss — the Host rejected before creating — so it returns directly.
        const recovered = await recoverAndClose({
          client,
          scopeRequestId,
          profile,
          modelId,
          persona,
          participantId,
          signal: cleanupOf(),
        });
        if (!recovered.closed && recovered.attempted) {
          cleanupFailure = {
            category: "crash",
            code: "SCOPE_CLOSE_FAILED",
            message: "recovered scope could not be closed after create transport loss",
            retryable: false,
          };
          result = make("failed", cleanupFailure);
        } else {
          result = make("failed", classifyClientError(error));
        }
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
      // G2: a failed execute response is ambiguous — the Host may have
      // accepted/dispatched the turn before the response was lost. Treat it as
      // ambiguous dispatch: with the STABLE executionId, do a bounded query
      // against the shared cleanup budget. A record (any state) → it was
      // dispatched: cancel/observe terminal/ACK discarded via handleAbort (no
      // re-dispatch). A 404/missing record only → treat as never dispatched and
      // classify as failed/timeout. The deadline-abort verdict is preserved.
      if (deadline.aborted) {
        const dispatchedAsAmbiguous = await checkAmbiguousDispatch({
          client,
          scopeId: created.scopeId,
          executionId,
          signal: cleanupOf(),
        });
        if (dispatchedAsAmbiguous) {
          dispatched = true;
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
            cleanupSignal: cleanupOf(),
          });
        } else {
          result = make(abortVerdict(), abortError(), { canonical });
        }
      } else {
        result = make("failed", classifyClientError(error, { dispatch: true }), { canonical });
      }
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
      // the SHARED bounded cleanup signal (G3) — observe the interrupted
      // terminal and ACK discarded. The cancel request itself is NEVER a
      // re-dispatch. We then validate the discarded ACK reached
      // `acknowledged`; otherwise the result degrades to an explicit ACK/cleanup
      // error.
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
        // G3: pass the shared cleanup signal; if none exists yet handleAbort
        // materializes one. Either way the chain shares one budget.
        cleanupSignal: cleanupHolder.current?.signal,
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
    // G5: if the deadline/external abort fired — whether it aborted the ACK mid-flight
    // (ackAborted) or the ACK simply resolved AFTER the deadline elapsed (the main
    // timer already recorded the abort source) — a `completed`/`interrupted`/
    // `failed` terminal delivered past the budget is NOT a clean completion. Map
    // to the abort verdict so a slow ACK after timeout is never reported completed,
    // and an external abort during ACK is `cancelled` (never ACK_FAILED either).
    if (deadline.aborted || ackAborted) {
      result = make(abortVerdict(), abortError(), {
        canonical: result.canonical,
        effective: result.effective,
        usage: result.usage,
      });
    }
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
    // F2/G3: closeScope runs exactly once. On the happy path (cleanup never
    // materialized) it runs under the main deadline — which still has budget —
    // so a clean close does NOT start a cleanup timer. On an abort/cleanup path
    // the shared cleanup controller already exists (with whatever budget
    // remains) and close draws from the SAME budget as cancel/observe/ACK.
    // recoverAndClose's own recovered scope is closed by it directly (no owned
    // controller), so this finally only closes the owned scope.
    if (owned.scopeId && owned.controllerId && owned.leaseEpoch !== undefined) {
      let closed = false;
      try {
        // G3: closeScope draws from the SHARED cleanup signal so it converges on
        // a bounded budget even when the main deadline timer was already cleared
        // above (clearTimeout(timeoutTimer)). On the happy path this lazily
        // materializes a fresh 10s cleanup controller; on an abort path it
        // reuses the same one cancel/observe/ACK already drew from (one budget).
        await client.closeScope(owned.scopeId, token(), { signal: cleanupOf() });
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
    // G3: dispose the shared cleanup timer so it cannot outlive the run once the
    // whole chain (cancel → observe → ACK → close) has ended.
    cleanupHolder.current?.dispose();
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

/** G5: ACK outcome for terminal handlers. `ok` = acknowledged; `aborted` =
 * the deadline/external (or cleanup-deadline) abort fired during the ACK,
 * which is NOT an ACK conflict and must not be reported as ACK_FAILED. */
interface AckOutcome {
  ok: boolean;
  aborted: boolean;
}

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
  ack: (disposition: "committed" | "discarded", finalSeq: number) => Promise<AckOutcome>;
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
      const ackRes = await ack("discarded", completed.seq);
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
      // G5: an ACK aborted mid-flight is NOT an ACK conflict — return the empty
      // verdict; the run-level ackAborted remap maps it to the abort verdict.
      if (!ackRes.ok && !ackRes.aborted) {
        return make(
          "failed",
          { ...ACK_FAILED_ERROR, message: "EMPTY_OUTPUT + ACK not acknowledged" },
          partial,
        );
      }
      return make("failed", emptyErr, partial);
    }
    const ackOk = await ack("committed", completed.seq);
    // G5: aborted-mid-ACK is not an ACK conflict — fall through to the completed
    // verdict; the run-level ackAborted remap maps a post-deadline ACK to the
    // abort verdict (timeout/cancelled), never reporting completed after abort.
    if (!ackOk.ok && !ackOk.aborted) {
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
    // G5: aborted-mid-ACK is not an ACK conflict — keep the terminal failure
    // verdict; the run-level ackAborted remap handles the abort outcome.
    if (!ackOk.ok && !ackOk.aborted) return make("failed", ACK_FAILED_ERROR, { canonical });
    return make("failed", terminalErr, { canonical });
  }

  // interrupted
  const interrupted = event as InterruptedEvent;
  const interruptErr = classifyInterrupt(interrupted);
  // F1: discarded ACK validated. interrupted normally returns `interrupted`;
  // a discarded ACK that fails validation degrades to failed + the ACK error so
  // the ACK conflict is not masked by closeScope.
  const ackOk = await ack("discarded", interrupted.seq);
  // G5: aborted-mid-ACK is not an ACK conflict — keep the interrupted verdict;
  // the run-level ackAborted remap handles the abort outcome.
  if (!ackOk.ok && !ackOk.aborted) return degradeDiscardedAck(make);
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
  ack: (disposition: "committed" | "discarded", finalSeq: number) => Promise<AckOutcome>;
  make: (
    verdict: AgentRealCallVerdict,
    error: AgentRealCallError | null,
    partial?: Partial<AgentRealCallResult>,
  ) => AgentRealCallResult;
  abortVerdict: () => "timeout" | "cancelled";
  abortError: () => AgentRealCallError;
  canonical: string | null;
  /** G3: the shared cleanup signal covering the whole cleanup chain. If
   * omitted (defensive), a fresh shared controller is created for this chain
   * so the chain still has a bounded aggregate budget. */
  cleanupSignal?: AbortSignal;
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
    cleanupSignal,
  } = input;
  // G3: one shared controller for cancel → observe → ACK(cancel-path). If the
  // caller handed us the run's shared signal, reuse it (single budget); else
  // create a fresh one for this chain (still a single aggregate budget).
  let ownDispose: (() => void) | null = null;
  const chainSignal: AbortSignal = cleanupSignal
    ? cleanupSignal
    : (() => {
        const c = newSharedCleanup();
        ownDispose = c.dispose;
        return c.signal;
      })();
  if (dispatched) {
    // Cancel with the shared cleanup signal (G3): a hung cancel cannot keep the
    // helper pending; execute is NEVER re-sent. The cancel draws from the SAME
    // shared budget as observe/ACK (no per-request 10s reset).
    try {
      await client.cancelExecution(scopeId, executionId, token(), {
        signal: chainSignal,
      });
    } catch {
      // Best-effort: a failed cancel still proceeds to observe the terminal;
      // the cleanup-failure accounting happens below via the ACK validation.
    }
    // Observe the interrupted terminal the cancel produced, bounded by the
    // shared cleanup signal. Only read the record (getExecution) — never
    // re-dispatch.
    let observedSeq: number | null = null;
    for (let attempt = 0; attempt < 5 && !chainSignal.aborted; attempt += 1) {
      try {
        const status = await client.getExecution(scopeId, executionId, {
          signal: chainSignal,
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
      // A discarded ACK that is not acknowledged normally degrades the verdict
      // to failed + the explicit ACK error (never silently mask an ACK gap).
      // G5: but if the ACK was itself aborted (deadline/external/cleanup-deadline
      // firing during the ACK), that is NOT an ACK conflict — fall through to the
      // abort verdict instead of misreporting ACK_FAILED.
      const ackRes = await ack("discarded", Math.max(1, observedSeq));
      if (!ackRes.ok && !ackRes.aborted) {
        return make("failed", ACK_FAILED_ERROR, { canonical });
      }
    }
    // No observable terminal (cancel didn't settle in the cleanup window), or
    // the ACK was aborted mid-way: the verdict is the abort verdict surface;
    // close failure (if any) is still accounted in the unified finally (F2).
  }
  ownDispose?.();
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
    // G1: the real SSE fetcher aborts by THROWING an AbortError (the fetch/body
    // consumption is aborted), not by resolving {kind:'aborted'}. If the
    // deadline signal has aborted, normalize that to {kind:'aborted'} so the
    // run enters the unified handleAbort cleanup chain (cancel/observe/ACK).
    // A non-abort SSE error (HTTP failure, parse error) is propagated as-is.
    let outcome: FollowOutcome;
    try {
      outcome = await follow(options);
    } catch (error) {
      if (deadlineSignal.aborted) return { kind: "aborted" };
      throw error;
    }
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

/** G6: a non-abort create failure where the request MAY have reached the Host
 * and created a scope before the response was lost. These are transport / parse
 * / server (5xx / network) errors — the client cannot prove the scope was NOT
 * created, so idempotent recovery+close with the same scopeRequestId is needed.
 *
 * A definitive HTTP validation rejection (RuntimeClientError with a 4xx status)
 * means the Host rejected the request BEFORE creating anything → NOT a
 * transport loss; the caller returns directly. 404/409/etc. on a mutation
 * mean "rejected, nothing to clean up." */
function isCreateTransportLoss(error: unknown): boolean {
  if (error instanceof RuntimeClientError) {
    // A Host-level rejection: the request reached the Host and was classified
    // (400/401/403/404/409/422 …). The Host did NOT create a scope, so there is
    // nothing to recover. A 5xx from the Host gateway COULD still have created
    // a scope upstream — treat 5xx as transport loss too.
    return error.status >= 500;
  }
  if (error instanceof Error && error.name === "AbortError") {
    // Abort is handled by the deadline branch, not here.
    return false;
  }
  // Network/transport/parse errors (TypeError from fetch, JSON parse errors,
  // connection reset, …): the request's fate is unknown → treat as transport
  // loss and attempt idempotent recovery.
  return true;
}

/** G2: probe whether an execute whose response was lost actually landed on the
 * Host. A record (any state, incl. running) → it WAS dispatched (ambiguous). A
 * thrown getExecution (404/transport) → treat as NOT dispatched. Never
 * re-dispatches execute. Bounded by the shared cleanup signal (G3). */
async function checkAmbiguousDispatch(input: {
  client: RuntimeClient;
  scopeId: string;
  executionId: string;
  signal: AbortSignal;
}): Promise<boolean> {
  const { client, scopeId, executionId, signal } = input;
  try {
    await client.getExecution(scopeId, executionId, { signal });
    // A record exists → the execution WAS accepted by the Host before the
    // response was lost. Treat as dispatched (ambiguous dispatch).
    return true;
  } catch {
    // 404 / Host gone / transport: no provable record → not dispatched.
    return false;
  }
}

async function recoverAndClose(input: {
  client: RuntimeClient;
  scopeRequestId: string;
  profile: ExecutionProfileDto;
  modelId: string;
  persona: string;
  participantId: string;
  /** G3: shared cleanup signal (bounded budget) for the recovery create+close.
   * If omitted, a fresh shared budget is created so the recovery still converges. */
  signal?: AbortSignal;
}): Promise<RecoveryResult> {
  const { client, scopeRequestId, profile, modelId, persona, participantId } = input;
  // F2/G3: a shared bounded cleanup signal so a pre-aborted deadline cannot
  // block recovery and a hung create/close still converges within the cleanup
  // budget. Never rethrow — the caller maps the result onto the verdict.
  let ownDispose: (() => void) | null = null;
  const cleanup: AbortSignal =
    input.signal ??
    (() => {
      const c = newSharedCleanup();
      ownDispose = c.dispose;
      return c.signal;
    })();
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
  } finally {
    ownDispose?.();
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
