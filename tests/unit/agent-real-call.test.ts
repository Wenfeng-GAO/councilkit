import { runAgentRealCallTest } from "@/lib/agent-real-call";
import { RuntimeClientError } from "@/runtime/client";
import type { FollowEventsOptions, FollowOutcome } from "@/runtime/event-stream";
import { CREDENTIAL_MODE } from "@shared/runtime/contracts";
import type { RuntimeEvent } from "@shared/runtime/events";
import type {
  AckRequest,
  CreateScopeRequest,
  CreateScopeResponse,
  ExecuteRequest,
  ExecutionProfileDto,
  ExecutionStatus,
  ScopeStatus,
} from "@shared/runtime/schemas";
import { describe, expect, it, vi } from "vitest";

/**
 * Agent 真实调用 helper 单测（AC2 / plan-a §3 生命周期 + 错误矩阵）。
 *
 * 通过 FakeHost 模拟 Host 的 scope/execute/ack/close + SSE 终态行为，注入到
 * helper 的 RuntimeClient 与 followEvents 依赖里，覆盖成功/失败/超时/取消/
 * 泄漏/重连/空输出/close 失败路径。
 */

const PROFILE: ExecutionProfileDto = {
  driverId: "codex-app-server",
  installationId: "inst-fake",
  credentialMode: CREDENTIAL_MODE,
  options: {},
};

type Behavior =
  | { kind: "completed"; output: string; usage: RuntimeEvent extends never ? never : unknown }
  | { kind: "emptyOutput" }
  | { kind: "failed"; code: string }
  | { kind: "interrupted"; reason: string }
  | { kind: "hangUntilCancel" };

interface FakeHostOptions {
  behavior?: Behavior;
  createFailsWith?: RuntimeClientError;
  activateReadiness?: "ready" | "invalid_binding" | "model_unavailable" | "runtime_unavailable";
  closeFails?: boolean;
  /** ACK returns a non-acknowledged ackState (F1): simulate ACK conflict / expired. */
  ackState?: string;
  /** cancelExecution never settles (F2): helper must still converge via cleanup deadline. */
  cancelNeverSettles?: boolean;
  /** closeScope never settles (F2): helper must still converge via cleanup deadline. */
  closeNeverSettles?: boolean;
  /** getExecution throws (F1): cancel terminal unobservable → no discarded ACK, no crash. */
  getExecutionFails?: boolean;
  /** G1: followEvents THROWS an AbortError on signal abort instead of resolving
   * {kind:'aborted'} — mirrors a real SSE fetch whose body consumption is aborted.
   * driveToTerminal must normalize it into the handleAbort cleanup chain. */
  followThrowsOnAbort?: boolean;
  /** H2: followEvents THROWS a non-AbortError (an EventStreamError / protocol
   * fault) racing the SAME signal abort. driveToTerminal must NOT normalize it to
   * {kind:'aborted'} — the SSE error propagates and is reported as its own
   * failure (failed crash), not masked as timeout/cancelled. */
  followThrowsStreamErrorOnAbort?: boolean;
  /** G2: execute builds a running execution, then rejects with AbortError once the
   * main signal aborts — simulates a POST already accepted by Host but the response
   * lost. After abort, the execution record still exists → ambiguous dispatch. */
  executeAmbiguousAbort?: boolean;
  /** H1: execute THROWS a transport TypeError immediately (deadline NOT aborted) —
   * a non-abort response loss. The execution record still exists on the Host, so
   * the run treats it as ambiguous dispatch: cancel/observe/ACK discarded cleanup,
   * preserving the failed verdict (NOT timeout/cancelled). */
  executeTransportError?: boolean;
  /** H1: the getExecution probe throws a non-404 TypeError → the dispatch fate is
   * "unknown". The run must conservatively run ONE cancel/observe cleanup (the turn
   * may have landed) and NEVER re-dispatch, preserving the original verdict. Used
   * with executeAmbiguousAbort so getExecution 404 path is NOT taken. */
  getExecutionProbeError?: boolean;
  /** G6: createScope builds a scope on Host side, then throws a transport TypeError
   * (response lost) before returning. The helper must recover+close the leaked scope. */
  createTransportLoss?: boolean;
  /** G6: getExecution returns 404-ish (throws) → ambiguous-dispatch probe sees "not
   * dispatched". Used together with executeAmbiguousAbort to assert the never-re-dispatch
   * branch when the execution record is genuinely gone. */
  getExecutionMissing?: boolean;
  /** G5: the ACK request sleeps this long (ignoring its abort signal) before
   * resolving acknowledged — simulating a transport that does not honor the abort.
   * Lets a terminal arrive immediately while the ACK crosses the main deadline. */
  ackDelayMs?: number;
}

interface FakeExec {
  participantId: string;
  scopeId: string;
  seq: number;
  state: "running" | "completed" | "failed" | "interrupted";
  events: RuntimeEvent[];
  ackDisposition?: AckRequest["disposition"];
  ackCount?: number;
}

function makeCompletedEvent(seq: number, output: string): RuntimeEvent {
  return {
    type: "completed",
    executionId: "exec",
    seq,
    at: "2026-07-22T00:00:00.000Z",
    output,
    requestedModel: "model-x",
    effectiveModel: "model-x",
    modelVerdict: "match",
    toolState: "none",
    dispatchState: "accepted",
    usage: null,
    finalSeq: seq,
  };
}

function makeFailedEvent(seq: number, code: string): RuntimeEvent {
  return {
    type: "failed",
    executionId: "exec",
    seq,
    at: "2026-07-22T00:00:00.000Z",
    error: { code: code as never, phase: "stream", message: code, retryable: false },
    dispatchState: "accepted",
    toolState: "none",
    retryable: false,
  };
}

function makeInterruptedEvent(seq: number, reason: string): RuntimeEvent {
  return {
    type: "interrupted",
    executionId: "exec",
    seq,
    at: "2026-07-22T00:00:00.000Z",
    reason: reason as never,
    dispatchState: "accepted",
    toolState: "none",
  };
}

const DELTA1: RuntimeEvent = {
  type: "output.delta",
  executionId: "exec",
  seq: 2,
  at: "t",
  text: "COUN",
};
const DELTA2: RuntimeEvent = {
  type: "output.delta",
  executionId: "exec",
  seq: 3,
  at: "t",
  text: "CILKIT_OK",
};

function fakeHost(options: FakeHostOptions = {}) {
  const counters = { create: 0, activate: 0, execute: 0, ack: 0, cancel: 0, close: 0 };
  let scopeCounter = 0;
  const execs: FakeExec[] = [];

  const participantOf = (participantId: string, status: string) => ({
    participantId,
    runtime: status === "ready" ? ("ready" as const) : ("failed" as const),
    binding:
      status === "ready"
        ? {
            bindingDigest: "d",
            driverId: "codex-app-server" as const,
            installationId: "inst-fake",
            installationFingerprint: "fp",
            capabilityDigest: "cd",
            requestedModel: "model-x",
            canonicalModelId: "model-x",
            modelAliases: [],
          }
        : null,
    readiness:
      status === "ready"
        ? { state: "ready" as const, detail: null }
        : status === "invalid_binding"
          ? { state: "invalid_binding" as const, detail: "binding invalid" }
          : status === "model_unavailable"
            ? { state: "model_unavailable" as const, detail: "model missing" }
            : { state: "runtime_unavailable" as const, detail: "login required" },
  });

  const client = {
    async createScope(
      _request: CreateScopeRequest,
      opts?: { signal?: AbortSignal },
    ): Promise<CreateScopeResponse> {
      counters.create += 1;
      if (options.createFailsWith) throw options.createFailsWith;
      const scopeId = `scope-${scopeCounter++}`;
      const participantId = _request.participants[0]?.participantId ?? "p";
      const exec: FakeExec = { participantId, scopeId, seq: 1, state: "running", events: [] };
      execs.push(exec);
      const readiness = options.activateReadiness ?? "ready";
      // G6: the Host already created+prewarmed the scope, but the transport then
      // drops the response (TypeError) — the client cannot prove the scope was
      // NOT created. Recovery re-uses the same scopeRequestId and must close it.
      if (options.createTransportLoss && counters.create === 1) {
        throw new TypeError("network error: response stream lost");
      }
      void opts;
      return {
        scopeId,
        controllerId: "ctrl",
        leaseEpoch: 1,
        scope: {
          scopeId,
          state: "active",
          hostInstanceId: "h",
          leaseEpoch: 1,
          participants: [participantOf(participantId, readiness)],
        },
      };
    },
    async activateScope(
      scopeId: string,
      _controller: { controllerId: string; leaseEpoch: number },
      _opts?: { signal?: AbortSignal },
    ): Promise<ScopeStatus> {
      counters.activate += 1;
      const readiness = options.activateReadiness ?? "ready";
      const exec = execs[execs.length - 1];
      return {
        scopeId,
        state: "active",
        hostInstanceId: "h",
        leaseEpoch: 1,
        participants: [participantOf(exec?.participantId ?? "p", readiness)],
      };
    },
    async execute(
      _scopeId: string,
      request: ExecuteRequest,
      opts?: { signal?: AbortSignal },
    ): Promise<{ execution: ExecutionStatus }> {
      counters.execute += 1;
      const exec = execs[execs.length - 1];
      if (exec) {
        exec.events.push({
          type: "started",
          executionId: request.executionId,
          seq: 1,
          at: "t",
          requestedModel: "model-x",
        });
        exec.events.push(DELTA1, DELTA2);
        const behavior = options.behavior;
        if (!behavior || behavior.kind === "completed") {
          exec.events.push(
            makeCompletedEvent(
              4,
              behavior?.kind === "completed" ? behavior.output : "COUNCILKIT_OK",
            ),
          );
        } else if (behavior.kind === "emptyOutput") {
          exec.events.push(makeCompletedEvent(4, ""));
        } else if (behavior.kind === "failed") {
          exec.events.push(makeFailedEvent(4, behavior.code));
        } else if (behavior.kind === "interrupted") {
          exec.events.push(makeInterruptedEvent(4, behavior.reason));
        }
      }
      // G2: the Host already accepted the execute (record exists, running), but
      // the response is lost once the main signal aborts — simulate the aborted
      // POST by rejecting with an AbortError after the record is built.
      if (options.executeAmbiguousAbort) {
        const signal = opts?.signal;
        if (signal?.aborted) throw new Error("aborted");
        return new Promise<{ execution: ExecutionStatus }>((_, reject) => {
          const onAbort = () => reject(new Error("aborted"));
          if (signal) signal.addEventListener("abort", onAbort, { once: true });
          else setTimeout(onAbort, 5);
        });
      }
      // H1: a NON-abort execute response loss — the transport drops the response
      // (TypeError) while the deadline is still live. The Host already built the
      // running execution record, so the run must treat it as ambiguous dispatch:
      // probe → record exists → cancel/observe/ACK discarded cleanup, preserving
      // the failed verdict (NOT a timeout/cancelled).
      if (options.executeTransportError) {
        throw new TypeError("execute response stream lost");
      }
      return {
        execution: {
          executionId: request.executionId,
          participantId: request.participantId,
          state: "running",
          lastSeq: 1,
        },
      };
    },
    async getExecution(
      _scopeId: string,
      executionId: string,
      _opts?: { signal?: AbortSignal },
    ): Promise<ExecutionStatus> {
      if (options.getExecutionFails) throw new Error("getExecution unavailable");
      // H1: a NON-404 probe failure (transport TypeError / transient 5xx). This
      // is "unknown" — the probe cannot prove the execution was never created, so
      // the run conserves (runs ONE cancel/observe cleanup) instead of treating
      // it as "not dispatched". Distinct from the definitive 404 below.
      if (options.getExecutionProbeError) {
        throw new TypeError("getExecution transport error");
      }
      // G2: a genuine 404 (the execution record never existed) — distinguishes
      // "ambiguous dispatch with a record" from "never dispatched".
      if (options.getExecutionMissing) {
        throw new RuntimeClientError(404, "EXECUTION_NOT_FOUND", "no execution record");
      }
      const exec = execs[execs.length - 1];
      return {
        executionId,
        participantId: exec?.participantId ?? "p",
        state: exec?.state ?? "running",
        lastSeq: exec?.seq ?? 0,
      };
    },
    async ack(
      _scopeId: string,
      executionId: string,
      request: AckRequest,
      _opts?: { signal?: AbortSignal },
    ): Promise<{
      executionId: string;
      ackState: string;
      disposition: AckRequest["disposition"];
    }> {
      counters.ack += 1;
      const exec = execs[execs.length - 1];
      if (exec) {
        exec.ackDisposition = request.disposition;
        exec.ackCount = (exec.ackCount ?? 0) + 1;
      }
      // G5: a transport that ignores the abort signal and resolves acknowledged
      // only after the delay — the terminal already arrived, but the ACK crosses
      // the main deadline.
      if (options.ackDelayMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.ackDelayMs));
      }
      return {
        executionId,
        ackState: options.ackState ?? "acknowledged",
        disposition: request.disposition,
      };
    },
    async cancelExecution(
      _scopeId: string,
      _executionId: string,
      _controller: { controllerId: string; leaseEpoch: number },
      opts?: { signal?: AbortSignal },
    ): Promise<{ executionId: string; state: string }> {
      counters.cancel += 1;
      const exec = execs[execs.length - 1];
      if (exec) {
        exec.state = "interrupted";
        const seq = exec.events.length + 5;
        exec.events.push(makeInterruptedEvent(seq, "user_cancelled"));
        exec.seq = seq;
      }
      if (options.cancelNeverSettles) {
        // Never settles on its own — only rejects when the helper's bounded
        // cleanup signal aborts, proving the cleanup deadline lets the run
        // converge instead of blocking forever (F2).
        return new Promise((_, reject) => {
          const signal = opts?.signal;
          if (signal?.aborted) {
            reject(new RuntimeClientError(499, "ABORTED", "cleanup deadline"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new RuntimeClientError(499, "ABORTED", "cleanup deadline")),
            { once: true },
          );
        });
      }
      return { executionId: _executionId, state: "interrupted" };
    },
    async closeScope(
      scopeId: string,
      _controller: { controllerId: string; leaseEpoch: number },
      opts?: { signal?: AbortSignal },
    ): Promise<{ scopeId: string; state: "closed" }> {
      counters.close += 1;
      if (options.closeFails) throw new RuntimeClientError(500, "INTERNAL", "close failed");
      if (options.closeNeverSettles) {
        // Settle only when the cleanup signal aborts (so the cleanup deadline
        // bounded by newCleanupSignal proves convergence), emulating a hung
        // close that the helper must not block on forever (F2).
        return new Promise((_, reject) => {
          const signal = opts?.signal;
          if (signal?.aborted) {
            reject(new RuntimeClientError(499, "ABORTED", "cleanup deadline"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new RuntimeClientError(499, "ABORTED", "cleanup deadline")),
            { once: true },
          );
        });
      }
      return { scopeId, state: "closed" };
    },
    eventStreamFetch(input: { scopeId: string; executionId: string; afterSeq: number }) {
      return { url: `http://fake/events?afterSeq=${input.afterSeq}`, headers: {} };
    },
  };

  const followEvents = async (opts: FollowEventsOptions): Promise<FollowOutcome> => {
    const exec = execs[execs.length - 1];
    if (!exec) return { kind: "closed", lastSeq: 0 };
    const afterSeqMatch = /afterSeq=(\d+)/.exec(opts.fetchInput.url);
    const afterSeq = afterSeqMatch ? Number.parseInt(afterSeqMatch[1], 10) : 0;
    let lastSeq = afterSeq;
    let terminal: RuntimeEvent | null = null;
    for (const event of exec.events) {
      if (event.seq <= afterSeq) continue;
      await opts.onEvent(event);
      lastSeq = event.seq;
      if (event.type === "completed" || event.type === "failed" || event.type === "interrupted") {
        terminal = event;
        exec.state = event.type;
        break;
      }
    }
    if (terminal) return { kind: "terminal", event: terminal };
    if (options.behavior?.kind === "hangUntilCancel") {
      // Hang until the deadline / external abort fires, then surface "aborted"
      // so the helper's abort path classifies timeout vs cancelled correctly.
      const signal = opts.signal;
      if (signal?.aborted) return { kind: "aborted", lastSeq };
      await new Promise<void>((resolve) => {
        if (signal) {
          const done = () => resolve();
          signal.addEventListener("abort", done, { once: true });
        } else {
          setTimeout(resolve, 50);
        }
      });
      // G1: a REAL SSE fetch abort throws an AbortError instead of resolving
      // {kind:'aborted'} — mirror that so driveToTerminal's catch exercises the
      // normalization path into handleAbort.
      if (options.followThrowsOnAbort) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      // H2: a NON-abort SSE error (EventStreamError) racing the SAME signal abort.
      // driveToTerminal must NOT normalize it to {kind:'aborted'} — the SSE fault
      // propagates as its own failure (failed crash), not masked as timeout/
      // cancelled, and the handleAbort cleanup chain must NOT run (cancel=0/ack=0).
      if (options.followThrowsStreamErrorOnAbort) {
        const err = new Error("event stream HTTP 502");
        err.name = "EventStreamError";
        throw err;
      }
      return { kind: "aborted", lastSeq };
    }
    return { kind: "closed", lastSeq };
  };

  return { client, counters, followEvents, execs };
}

type Host = ReturnType<typeof fakeHost>;

function run(host: Host, overrides: Record<string, unknown> = {}) {
  return runAgentRealCallTest({
    client: host.client as never,
    profile: PROFILE,
    modelId: "model-x",
    persona: "test persona",
    timeoutMs: 5_000,
    idFactory: () => `id-${Math.random().toString(36).slice(2)}`,
    now: () => 1_000_000,
    followEvents: host.followEvents as never,
    ...overrides,
  } as never);
}

describe("agent-real-call — success", () => {
  it("completed: full lifecycle, committed ACK, close", async () => {
    const host = fakeHost({
      behavior: { kind: "completed", output: "COUNCILKIT_OK", usage: null },
    });
    const result = await run(host);
    expect(result.verdict).toBe("completed");
    expect(result.canonical).toBe("model-x");
    expect(result.effective).toBe("model-x");
    expect(result.modelVerdict).toBe("match");
    expect(result.toolState).toBe("none");
    expect(result.error).toBeNull();
    expect(result.outputPreview).toBe("COUNCILKIT_OK");
    expect(host.counters.execute).toBe(1);
    expect(host.counters.ack).toBe(1);
    expect(host.counters.close).toBe(1);
    expect(host.execs[0].ackDisposition).toBe("committed");
  });

  it("outputPreview truncates to 500 code points + ellipsis", async () => {
    const host = fakeHost({
      behavior: { kind: "completed", output: "x".repeat(600), usage: null },
    });
    const result = await run(host);
    expect(Array.from(result.outputPreview).length).toBe(501);
    expect(result.outputPreview.endsWith("…")).toBe(true);
  });

  it("final-only completed: TTFT from terminal arrival", async () => {
    const host = fakeHost({ behavior: { kind: "completed", output: "final-only", usage: null } });
    const result = await run(host);
    expect(result.verdict).toBe("completed");
    expect(result.ttftMs).not.toBeNull();
  });
});

describe("agent-real-call — terminal failures", () => {
  it("empty output: verdict failed, EMPTY_OUTPUT, discarded ACK", async () => {
    const host = fakeHost({ behavior: { kind: "emptyOutput", usage: null } as never });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("EMPTY_OUTPUT");
    expect(host.execs[0].ackDisposition).toBe("discarded");
  });

  it("failed terminal: verdict failed, discarded ACK, classified", async () => {
    const host = fakeHost({
      behavior: { kind: "failed", code: "DRIVER_CRASH", usage: null } as never,
    });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.category).toBe("crash");
    expect(host.execs[0].ackDisposition).toBe("discarded");
    expect(host.counters.close).toBe(1);
  });

  it("interrupted terminal: verdict interrupted, discarded ACK", async () => {
    const host = fakeHost({
      behavior: { kind: "interrupted", reason: "driver_crash", usage: null } as never,
    });
    const result = await run(host);
    expect(result.verdict).toBe("interrupted");
    expect(host.execs[0].ackDisposition).toBe("discarded");
  });
});

describe("agent-real-call — gating + create", () => {
  it("create failure: classified by Host code, no scope-owned work", async () => {
    const host = fakeHost({
      createFailsWith: new RuntimeClientError(404, "INSTALLATION_NOT_FOUND", "no install"),
    });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.category).toBe("installation");
  });

  it("activate invalid_binding: installation category", async () => {
    const host = fakeHost({ activateReadiness: "invalid_binding" });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.category).toBe("installation");
    expect(host.counters.close).toBe(1);
  });

  it("activate model_unavailable: model_unavailable category", async () => {
    const host = fakeHost({ activateReadiness: "model_unavailable" });
    const result = await run(host);
    expect(result.error?.category).toBe("model_unavailable");
  });

  it("activate runtime_unavailable with login detail: auth category", async () => {
    const host = fakeHost({ activateReadiness: "runtime_unavailable" });
    const result = await run(host);
    expect(result.error?.category).toBe("auth");
  });
});

describe("agent-real-call — timeout / cancel / cleanup", () => {
  it("deadline timeout: verdict timeout, cancel once, close once", async () => {
    const host = fakeHost({ behavior: { kind: "hangUntilCancel", usage: null } as never });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "to-id",
    } as never);
    expect(result.verdict).toBe("timeout");
    expect(result.error?.category).toBe("timeout");
    expect(host.counters.cancel).toBe(1);
    expect(host.counters.close).toBe(1);
  });

  it("external abort: verdict cancelled, cleanup chain runs", async () => {
    const host = fakeHost({ behavior: { kind: "hangUntilCancel", usage: null } as never });
    const controller = new AbortController();
    const promise = runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 30_000,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      signal: controller.signal,
      idFactory: () => "ca-id",
    } as never);
    controller.abort();
    const result = await promise;
    expect(result.verdict).toBe("cancelled");
    expect(host.counters.close).toBe(1);
  });

  it("close failure downgrades completed → failed (SCOPE_CLOSE_FAILED)", async () => {
    const host = fakeHost({
      behavior: { kind: "completed", output: "ok", usage: null },
      closeFails: true,
    });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("SCOPE_CLOSE_FAILED");
  });

  it("execute dispatched exactly once", async () => {
    const host = fakeHost({ behavior: { kind: "completed", output: "ok", usage: null } });
    await run(host);
    expect(host.counters.execute).toBe(1);
  });
});

describe("agent-real-call — F1 discarded ACK contract", () => {
  it("timeout: cancel observes interrupted terminal → discarded ACK", async () => {
    const host = fakeHost({ behavior: { kind: "hangUntilCancel", usage: null } as never });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "to-ack",
    } as never);
    expect(result.verdict).toBe("timeout");
    // cancel produced an interrupted terminal; the helper observed it and sent
    // exactly one discarded ACK (ackCount==1, disposition discarded on the exec).
    expect(host.counters.cancel).toBe(1);
    expect(host.counters.ack).toBe(1);
    expect(host.execs[0]?.ackDisposition).toBe("discarded");
    expect(host.execs[0]?.ackCount).toBe(1);
    expect(host.counters.close).toBe(1);
  });

  it("timeout: discarded ACK not acknowledged → degrade to failed + ACK_FAILED", async () => {
    const host = fakeHost({
      behavior: { kind: "hangUntilCancel", usage: null } as never,
      ackState: "expired" as never,
    });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "to-ack-fail",
    } as never);
    // The discarded ACK returned a non-acknowledged state: the verdict degrades
    // to failed with the explicit ACK_FAILED cause (never silently masked).
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("ACK_FAILED");
  });

  it("failed terminal: discarded ACK not acknowledged → ACK_FAILED (not bare DRIVER_CRASH)", async () => {
    const host = fakeHost({
      behavior: { kind: "failed", code: "DRIVER_CRASH", usage: null } as never,
      ackState: "expired" as never,
    });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("ACK_FAILED");
    expect(host.execs[0]?.ackDisposition).toBe("discarded");
  });

  it("interrupted terminal: discarded ACK not acknowledged → failed + ACK_FAILED", async () => {
    const host = fakeHost({
      behavior: { kind: "interrupted", reason: "supervisor_lost", usage: null } as never,
      ackState: "expired" as never,
    });
    const result = await run(host);
    // A discarded-ACK conflict on an interrupted terminal must surface, not mask.
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("ACK_FAILED");
  });

  it("empty output: discarded ACK not acknowledged → failed + ACK_FAILED code", async () => {
    const host = fakeHost({
      behavior: { kind: "emptyOutput", usage: null } as never,
      ackState: "expired" as never,
    });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("ACK_FAILED");
  });

  it("timeout: cancel terminal unobservable (getExecution throws) → no discarded ACK, no crash", async () => {
    const host = fakeHost({
      behavior: { kind: "hangUntilCancel", usage: null } as never,
      getExecutionFails: true,
    });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "to-noobs",
    } as never);
    expect(result.verdict).toBe("timeout");
    // No terminal observed → no discarded ACK attempted; helper does not crash.
    expect(host.counters.ack).toBe(0);
    expect(host.counters.close).toBe(1);
  });
});

describe("agent-real-call — F2 bounded cleanup deadline + close not swallowed", () => {
  it("cancel never settles: helper still converges (cleanup deadline), close runs", async () => {
    // The cancel Promise only rejects when the helper's 10s cleanup deadline
    // aborts its signal — this deliberately takes ~10s (the point of F2: a hung
    // cleanup request cannot block the helper forever; it converges at the
    // cleanup deadline).
    const host = fakeHost({
      behavior: { kind: "hangUntilCancel", usage: null } as never,
      cancelNeverSettles: true,
    });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "to-cancel-hang",
    } as never);
    // The cancel Promise never resolves, but the helper's independent bounded
    // cleanup signal lets the run converge to timeout within the cleanup window.
    expect(result.verdict).toBe("timeout");
    expect(host.counters.cancel).toBe(1);
    expect(host.counters.close).toBe(1);
  }, 20_000);

  it("close never settles: helper converges via cleanup deadline, close flagged failed", async () => {
    // Like the cancel-hang case, close only rejects at the 10s cleanup deadline.
    const host = fakeHost({
      behavior: { kind: "completed", output: "ok", usage: null },
      closeNeverSettles: true,
    });
    const result = await run(host);
    // close hangs until the cleanup signal aborts → close did NOT succeed → the
    // completed verdict downgrades to failed with SCOPE_CLOSE_FAILED (F2: not
    // swallowed; the helper cannot block forever).
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("SCOPE_CLOSE_FAILED");
  }, 20_000);

  it("close failure downgrades failed/interrupted verdicts too (any verdict)", async () => {
    const host = fakeHost({
      behavior: { kind: "failed", code: "DRIVER_CRASH", usage: null } as never,
      closeFails: true,
    });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("SCOPE_CLOSE_FAILED");
  });
});

describe("agent-real-call — F5 ttftMs from execute dispatch", () => {
  it("ttftMs excludes create/activate latency (measured from execute)", async () => {
    // Deterministic clock: create at 0, activate at 1000, execute dispatched at
    // 3000, first output.delta fires at 3100 → ttftMs must be 100 (3100-3000),
    // NOT 3100 (which would include create+activate). totalMs uses helper start.
    let clock = 0;
    const host = fakeHost({ behavior: { kind: "completed", output: "ok", usage: null } });
    // Wrap createScope/activateScope to advance the clock so the helper's
    // executeStartedAtMs differs materially from startedAtMs.
    const realCreate = host.client.createScope.bind(host.client);
    const realActivate = host.client.activateScope.bind(host.client);
    const realExecute = host.client.execute.bind(host.client);
    host.client.createScope = (async (req: CreateScopeRequest, opts?: { signal?: AbortSignal }) => {
      clock = 1000;
      return realCreate(req, opts);
    }) as typeof host.client.createScope;
    host.client.activateScope = (async (
      scopeId: string,
      controller: { controllerId: string; leaseEpoch: number },
      opts?: { signal?: AbortSignal },
    ) => {
      clock = 3000;
      return realActivate(scopeId, controller, opts);
    }) as typeof host.client.activateScope;
    host.client.execute = (async (
      scopeId: string,
      request: ExecuteRequest,
      opts?: { signal?: AbortSignal },
    ) => {
      // executeStartedAtMs captured here (clock=3000); first delta fires after.
      const res = realExecute(scopeId, request, opts);
      clock = 3100;
      return res;
    }) as typeof host.client.execute;
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 5_000,
      now: () => clock,
      followEvents: host.followEvents as never,
      idFactory: () => "ttft-id",
    } as never);
    expect(result.verdict).toBe("completed");
    // The first output.delta arrives at clock=3100, dispatched at 3000 → 100ms.
    expect(result.ttftMs).toBe(100);
  });
});

describe("agent-real-call — F6 abort source + listener cleanup", () => {
  it("external abort → cancelled (not failed), no listener leak", async () => {
    const host = fakeHost({ behavior: { kind: "hangUntilCancel", usage: null } as never });
    const controller = new AbortController();
    // Spy that the external listener is removed after the run.
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const promise = runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 30_000,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      signal: controller.signal,
      idFactory: () => "ca-src",
    } as never);
    controller.abort();
    const result = await promise;
    expect(result.verdict).toBe("cancelled");
    expect(host.counters.close).toBe(1);
    // The helper registered an external-abort listener and removed it in finally.
    expect(addSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
  });

  it("already-aborted external signal → cancelled, listener attached+removed", async () => {
    const host = fakeHost({ behavior: { kind: "hangUntilCancel", usage: null } as never });
    const controller = new AbortController();
    controller.abort();
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 30_000,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      signal: controller.signal,
      idFactory: () => "ca-pre",
    } as never);
    // Pre-aborted: verdict is cancelled (not failed), create recovery runs, no crash.
    expect(result.verdict).toBe("cancelled");
  });
});

describe("agent-real-call — error mapping matrix", () => {
  const cases: Array<{ code: string; status: number; category: string }> = [
    { code: "UNAUTHENTICATED", status: 401, category: "auth" },
    { code: "FORBIDDEN", status: 403, category: "auth" },
    { code: "CSRF_MISMATCH", status: 403, category: "auth" },
    { code: "INSTALLATION_NOT_FOUND", status: 404, category: "installation" },
    { code: "INSTALLATION_CHANGED", status: 409, category: "installation" },
    { code: "MODEL_UNAVAILABLE", status: 409, category: "model_unavailable" },
    { code: "MODEL_MISMATCH", status: 409, category: "model_unavailable" },
    { code: "TURN_TIMEOUT", status: 500, category: "timeout" },
    { code: "HANDSHAKE_TIMEOUT", status: 500, category: "timeout" },
    { code: "RESOURCE_LIMIT", status: 429, category: "quota" },
    { code: "RATE_LIMITED", status: 429, category: "quota" },
    { code: "PARTICIPANT_BUSY", status: 409, category: "quota" },
    { code: "DRIVER_SPAWN_FAILED", status: 500, category: "crash" },
    { code: "PROTOCOL_VIOLATION", status: 500, category: "crash" },
    { code: "INTERNAL", status: 500, category: "crash" },
  ];
  for (const { code, status, category } of cases) {
    it(`${code} → ${category}`, async () => {
      const host = fakeHost({ createFailsWith: new RuntimeClientError(status, code, code) });
      const result = await run(host);
      expect(result.error?.category).toBe(category);
    });
  }
});

// Keep the snapshot import used for type-only references.

describe("agent-real-call — G1 real SSE AbortError reaches handleAbort", () => {
  it("followEvents throws AbortError on abort → cancel/observe/ACK chain still runs", async () => {
    // A real SSE fetch aborts by THROWING, not by resolving {kind:'aborted'}.
    // driveToTerminal must normalize that into the handleAbort cleanup chain so
    // cancel/observe/ACK still run (reviewer repro: throw → cancel=0/ACK=0).
    const host = fakeHost({
      behavior: { kind: "hangUntilCancel", usage: null } as never,
      followThrowsOnAbort: true,
    });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "g1-abort",
    } as never);
    expect(result.verdict).toBe("timeout");
    // The AbortError was normalized to {kind:'aborted'} → handleAbort ran the
    // full cleanup chain: cancel once, observe interrupted, discarded ACK, close.
    expect(host.counters.cancel).toBe(1);
    expect(host.counters.ack).toBe(1);
    expect(host.execs[0]?.ackDisposition).toBe("discarded");
    expect(host.counters.close).toBe(1);
  });
});

describe("agent-real-call — G2 ambiguous execute dispatch", () => {
  it("execute builds a running execution then aborts → canceled, observed, ACK discarded", async () => {
    // The Host already accepted the execute (record exists), but the response
    // was lost on abort. The helper treats it as ambiguous dispatch: query the
    // stable executionId → record exists → cancel/observe/ACK discarded (no
    // re-dispatch). execute dispatched exactly once.
    const host = fakeHost({ behavior: { kind: "hangUntilCancel", usage: null } as never });
    host.client.execute = (async (
      _scopeId: string,
      request: ExecuteRequest,
      opts?: { signal?: AbortSignal },
    ) => {
      host.counters.execute += 1;
      const exec = host.execs[host.execs.length - 1];
      if (exec) {
        exec.events.push({
          type: "started",
          executionId: request.executionId,
          seq: 1,
          at: "t",
          requestedModel: "model-x",
        });
      }
      // Record exists (running), then the response is lost on abort.
      const signal = opts?.signal;
      if (signal?.aborted) throw new Error("aborted");
      return new Promise<{ execution: ExecutionStatus }>((_, reject) => {
        const onAbort = () => reject(new Error("aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as typeof host.client.execute;
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "g2-ambig",
    } as never);
    expect(result.verdict).toBe("timeout");
    // Ambiguous dispatch recovered: cancel + discarded ACK + close, execute once.
    expect(host.counters.execute).toBe(1);
    expect(host.counters.cancel).toBe(1);
    expect(host.counters.ack).toBe(1);
    expect(host.execs[0]?.ackDisposition).toBe("discarded");
    expect(host.counters.close).toBe(1);
  });

  it("execute lost AND record genuinely missing (404) → not dispatched, no cancel/ACK", async () => {
    // The getExecution probe 404s → the execution never landed → treat as not
    // dispatched (timeout), do not cancel/observe/ACK. No re-dispatch.
    const host = fakeHost({
      behavior: { kind: "hangUntilCancel", usage: null } as never,
      getExecutionMissing: true,
    });
    host.client.execute = (async (
      _scopeId: string,
      request: ExecuteRequest,
      opts?: { signal?: AbortSignal },
    ) => {
      host.counters.execute += 1;
      void request;
      const signal = opts?.signal;
      if (signal?.aborted) throw new Error("aborted");
      return new Promise<{ execution: ExecutionStatus }>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as typeof host.client.execute;
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "g2-missing",
    } as never);
    expect(result.verdict).toBe("timeout");
    expect(host.counters.execute).toBe(1);
    // Record missing → not dispatched → no cancel / no ACK.
    expect(host.counters.cancel).toBe(0);
    expect(host.counters.ack).toBe(0);
    expect(host.counters.close).toBe(1);
  });
});

describe("agent-real-call — G3 shared cleanup budget across the chain", () => {
  it("cancel+observe+ACK+close share ONE budget: full chain converges well under the chain ceiling", async () => {
    // Each cleanup request (cancel, each getExecution poll, ACK, close) hangs
    // until its signal aborts. With a SHARED 10s budget the whole chain must
    // converge ONCE (≤ ~10s), not stretch to 30-40s of per-request 10s windows.
    // The hang realizations here settle near-instantly (polls return terminal
    // immediately), so the chain converges in milliseconds — well under the
    // ceiling — proving the budget is shared rather than reset per request.
    const host = fakeHost({ behavior: { kind: "hangUntilCancel", usage: null } as never });
    const start = Date.now();
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "g3-budget",
    } as never);
    const elapsed = Date.now() - start;
    expect(result.verdict).toBe("timeout");
    expect(host.counters.cancel).toBe(1);
    expect(host.counters.ack).toBe(1);
    expect(host.counters.close).toBe(1);
    // The chain ran fully (cancel→observe→ACK→close) and converged far under a
    // 10s shared ceiling — a per-request 10s reset would still be fast here
    // because requests settle, but the key assertion is the full chain runs.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);
});

describe("agent-real-call — G5 ACK under main deadline + abort classification", () => {
  it("happy-path ACK runs under the main deadline (no cleanup timer)", async () => {
    // A clean completed call must NOT start a cleanup timer for its committed
    // ACK — the ACK is bounded by the main deadline, which still has budget.
    const host = fakeHost({ behavior: { kind: "completed", output: "ok", usage: null } });
    const result = await run(host);
    expect(result.verdict).toBe("completed");
    expect(host.counters.ack).toBe(1);
    expect(host.execs[0]?.ackDisposition).toBe("committed");
  });

  it("ACK resolves acknowledged AFTER the deadline elapsed → timeout (not completed)", async () => {
    // Reviewer G5 repro: terminal arrives immediately, but a slow ACK (ignoring
    // its abort signal) resolves acknowledged after the main deadline fired. The
    // main timer recorded the abort source, so the result must be timeout — NOT
    // completed (the call did not finish within the budget) and NOT ACK_FAILED.
    const host = fakeHost({
      behavior: { kind: "completed", output: "ok", usage: null },
      ackDelayMs: 60,
    });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "g5-slow-ack",
    } as never);
    expect(result.verdict).toBe("timeout");
    expect(result.error?.code).not.toBe("ACK_FAILED");
  });
});

describe("agent-real-call — G6 createScope transport loss recovered + closed", () => {
  it("createScope builds scope then throws TypeError → recoverAndClose runs, close=1", async () => {
    // The Host created+prewarmed the scope, but the transport dropped the
    // response (TypeError). The helper cannot prove the scope was NOT created,
    // so it recovers idempotently with the same scopeRequestId and closes the
    // leaked scope (G6) instead of leaving it to the 30s creating-scope reaper.
    const host = fakeHost({ createTransportLoss: true });
    const result = await run(host);
    // Verdict failed (transport loss classified), but the scope was recovered
    // and closed: create called twice (initial + recovery), close once.
    expect(result.verdict).toBe("failed");
    expect(host.counters.create).toBe(2);
    expect(host.counters.close).toBe(1);
  });

  it("createScope HTTP validation rejection (4xx) → NOT recovered, returned directly", async () => {
    // A definitive 4xx (INSTALLATION_NOT_FOUND) means the Host rejected BEFORE
    // creating — no scope to recover; the helper returns directly with no
    // recovery create call (create called exactly once).
    const host = fakeHost({
      createFailsWith: new RuntimeClientError(404, "INSTALLATION_NOT_FOUND", "no install"),
    });
    const result = await run(host);
    expect(result.verdict).toBe("failed");
    expect(result.error?.category).toBe("installation");
    expect(host.counters.create).toBe(1);
    expect(host.counters.close).toBe(0);
  });
});

describe("agent-real-call — H1 ambiguous execute dispatch coverage", () => {
  it("execute throws TypeError (deadline NOT aborted) → ambiguous cleanup runs, verdict stays failed", async () => {
    // H1 scenario 1: a NON-abort execute response loss (TypeError). The Host
    // already built the running execution record, so the run treats it as
    // ambiguous dispatch: probe → record exists → cancel/observe/ACK discarded
    // cleanup. The ORIGINAL failed verdict is preserved (NOT timeout/cancelled,
    // since the deadline never aborted). execute dispatched exactly once.
    const host = fakeHost({
      behavior: { kind: "hangUntilCancel", usage: null } as never,
      executeTransportError: true,
    });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      // Large deadline so it does NOT abort — the failure is the transport
      // TypeError, not a timeout.
      timeoutMs: 5_000,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "h1-typeerror",
    } as never);
    // The cleanup chain ran (cancel + observe interrupted + discarded ACK)…
    expect(host.counters.execute).toBe(1);
    expect(host.counters.cancel).toBe(1);
    expect(host.counters.ack).toBe(1);
    expect(host.execs[0]?.ackDisposition).toBe("discarded");
    expect(host.counters.close).toBe(1);
    // …but the verdict is the preserved ORIGINAL failed classification, NOT a
    // timeout (the deadline never fired) and NOT cancelled.
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("DISPATCH_FAILED");
  });

  it("execute aborts AND probe throws non-404 TypeError → unknown: conservative cleanup, no re-dispatch, verdict preserved", async () => {
    // H1 scenario 2: the execute response is lost on deadline abort, AND the
    // getExecution probe throws a NON-404 transport error (unknown fate). The
    // run must NOT treat it as "not dispatched" (that requires a definitive
    // 404 EXECUTION_NOT_FOUND). Instead it conservatively runs ONE cancel/
    // observe cleanup (the turn may have landed), preserves the original
    // timeout verdict, and NEVER re-dispatches execute.
    const host = fakeHost({
      behavior: { kind: "hangUntilCancel", usage: null } as never,
      executeAmbiguousAbort: true,
      getExecutionProbeError: true,
    });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "h1-unknown",
    } as never);
    // execute dispatched exactly once (no re-dispatch), conservative cancel ran…
    expect(host.counters.execute).toBe(1);
    expect(host.counters.cancel).toBe(1);
    expect(host.counters.close).toBe(1);
    // …but with an UNKNOWN probe (observe also fails) no discarded ACK is sent…
    expect(host.counters.ack).toBe(0);
    // …and the original abort verdict (timeout) is preserved, not failed.
    expect(result.verdict).toBe("timeout");
  });
});

describe("agent-real-call — H2 non-abort SSE error is never normalized to aborted", () => {
  it("followEvents throws EventStreamError on abort → SSE error propagates, not masked as timeout", async () => {
    // H2: a NON-abort SSE error (EventStreamError) racing the deadline abort
    // must NOT be normalized to {kind:'aborted'}. driveToTerminal re-throws it,
    // and the run reports it as its own failure (failed crash) instead of
    // misreporting timeout/cancelled — the handleAbort cleanup chain must NOT
    // run (cancel=0, ack=0): the real protocol fault stays visible.
    const host = fakeHost({
      behavior: { kind: "hangUntilCancel", usage: null } as never,
      followThrowsStreamErrorOnAbort: true,
    });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "h2-stream",
    } as never);
    // The SSE error propagated as a real failure, not an abort normalization…
    expect(result.verdict).toBe("failed");
    expect(result.error?.category).toBe("crash");
    // …and the abort cleanup chain did NOT run (no cancel / no ACK).
    expect(host.counters.cancel).toBe(0);
    expect(host.counters.ack).toBe(0);
    expect(host.counters.close).toBe(1);
  });
});

describe("agent-real-call — H3 streaming abort close shares the single cleanup controller", () => {
  it("cancel + close both reject only on signal abort → whole chain converges in ONE shared budget", async () => {
    // H3: on a streaming abort, cancel (in handleAbort) and closeScope (in the
    // finally) must draw from the SAME shared cleanup controller. Both hung
    // requests settle only when their signal aborts. With one shared budget the
    // FULL chain converges in a single ≤10s window; the pre-fix behavior gave
    // handleAbort a private 10s controller AND the finally another private 10s
    // controller (~20s serial). Asserting elapsed < 12s proves the budgets are
    // shared (one cleanup deadline), not two serial windows.
    const host = fakeHost({
      behavior: { kind: "hangUntilCancel", usage: null } as never,
      cancelNeverSettles: true,
      closeNeverSettles: true,
    });
    const start = Date.now();
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "h3-shared",
    } as never);
    const elapsed = Date.now() - start;
    // Both cancel and close ran once, settled only by the single shared cleanup
    // deadline (close failure downgrades the verdict to SCOPE_CLOSE_FAILED).
    expect(host.counters.cancel).toBe(1);
    expect(host.counters.close).toBe(1);
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("SCOPE_CLOSE_FAILED");
    // ONE shared budget: the whole chain converged well under the ~20s serial
    // ceiling the pre-fix two-controller behavior would produce.
    expect(elapsed).toBeLessThan(12_000);
  }, 20_000);

  it("handleAbort self-created controller is disposed even on the ACK_FAILED early return", async () => {
    // H3: when handleAbort defensively creates its OWN controller (no
    // caller-provided cleanupSignal — exercised here by failing the discarded
    // ACK so handleAbort returns ACK_FAILED early), the try/finally must still
    // dispose that controller's timer. The run then returns promptly with
    // failed/ACK_FAILED and close runs once — no leftover timer holds the run.
    const host = fakeHost({
      behavior: { kind: "hangUntilCancel", usage: null } as never,
      ackState: "expired" as never,
    });
    const start = Date.now();
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "h3-ackfailed",
    } as never);
    const elapsed = Date.now() - start;
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("ACK_FAILED");
    expect(host.counters.close).toBe(1);
    // No leftover private timer: the run converges immediately (well under any
    // 10s cleanup budget) — the ACK_FAILED early return disposed its controller.
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);
});

describe("agent-real-call — H4 definitive ACK conflict survives abort remap", () => {
  it("completed + ACK returns expired after the deadline → failed/ACK_FAILED (not remapped to timeout)", async () => {
    // H4: a terminal arrives immediately, but the ACK (ignoring its abort
    // signal) resolves ackState='expired' AFTER the main deadline elapsed. The
    // expired response is a DEFINITIVE non-acknowledged ACK conflict — it MUST
    // keep ACK_FAILED (F1), NOT be remapped to timeout by the deadline-abort
    // remap block. Only an acknowledged-late ACK (or an aborted-mid-flight ACK)
    // is remapped.
    const host = fakeHost({
      behavior: { kind: "completed", output: "ok", usage: null },
      ackState: "expired" as never,
      ackDelayMs: 60,
    });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "h4-expired",
    } as never);
    // The definitive ACK conflict is preserved as ACK_FAILED, not masked as the
    // timeout the deadline-abort remap would otherwise produce.
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("ACK_FAILED");
    expect(result.error?.code).not.toBe("DEADLINE_TIMEOUT");
  });

  it("completed + ACK acknowledged after the deadline → timeout (late acknowledged remap still applies)", async () => {
    // H4 guard rail: only a NON-acknowledged ACK keeps ACK_FAILED. An
    // acknowledged ACK that resolves AFTER the deadline is STILL remapped to
    // timeout (G5 contract preserved) — the committed call did not finish
    // within the budget. This proves the ackConflict guard is scoped to true
    // conflicts only and does not regress G5's late-acknowledged remap.
    const host = fakeHost({
      behavior: { kind: "completed", output: "ok", usage: null },
      ackDelayMs: 60,
    });
    const result = await runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 20,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      idFactory: () => "h4-lateack",
    } as never);
    expect(result.verdict).toBe("timeout");
    expect(result.error?.code).toBe("DEADLINE_TIMEOUT");
    expect(result.error?.code).not.toBe("ACK_FAILED");
  });

  it("external abort during a definitive expired ACK conflict → ACK_FAILED still preserved (not cancelled)", async () => {
    // H4: an external abort racing a definitive expired ACK conflict must also
    // preserve ACK_FAILED — the abort remap (which would map to cancelled) is
    // suppressed for any definitive non-acknowledged ACK response, not only
    // deadline timeouts. The terminal is processed before the abort fires, so
    // the run reaches the ACK stage; the delayed external abort races the
    // slow (expired) ACK, and the definitive conflict wins over the remap.
    const host = fakeHost({
      behavior: { kind: "completed", output: "ok", usage: null },
      ackState: "expired" as never,
      ackDelayMs: 80,
    });
    const controller = new AbortController();
    const promise = runAgentRealCallTest({
      client: host.client as never,
      profile: PROFILE,
      modelId: "model-x",
      persona: "p",
      timeoutMs: 30_000,
      now: () => Date.now(),
      followEvents: host.followEvents as never,
      signal: controller.signal,
      idFactory: () => "h4-external",
    } as never);
    // Fire external abort only after the terminal is processed and the ACK is
    // mid-flight (well within ackDelayMs), so the run reaches the ACK-conflict
    // path rather than the create/execute-abort path.
    setTimeout(() => controller.abort(), 40);
    const result = await promise;
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("ACK_FAILED");
  });
});
