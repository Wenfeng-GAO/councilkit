/**
 * execute-turn branches the existing suite does not hit: interrupt reasons,
 * auth-refresh reconnect, cleanup observe states, ack conflicts, and the
 * default SSE follower.
 */
import { type Server, createServer } from "node:http";
import { type RuntimeClient, RuntimeClientError } from "@/runtime/client";
import type { FollowEventsOptions, FollowOutcome } from "@/runtime/event-stream";
import type { RuntimeEvent } from "@shared/runtime/events";
import type { ControllerRequest } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";
import { CliError, EXIT } from "../src/errors";
import {
  type HostLike,
  type TerminalEvidence,
  type TurnResult,
  createRunCleanup,
  executeTurn,
} from "../src/host/execute-turn";

const CONTROLLER: ControllerRequest = { controllerId: "ctrl", leaseEpoch: 1 };
const EXECUTION_ID = "exec-aaaaaaaa";
const PARTICIPANT_ID = "p-1";
const SNAPSHOT = {
  digestVersion: 1 as const,
  roomContext: { contextRevision: 0, contextDigest: "d", items: [] },
  participant: { participantId: PARTICIPANT_ID, participantSnapshotDigest: "d" },
  instruction: { kind: "message" as const, instructionDigest: "d", text: "reply" },
};

interface AckBody {
  controllerId: string;
  leaseEpoch: number;
  finalSeq: number;
  disposition: string;
}

interface Trace {
  executeCalls: number;
  executeSignalAborted: boolean[];
  executeRequests: unknown[];
  cancelCalls: number;
  cancelBodies: ControllerRequest[];
  ackBodies: AckBody[];
  followAfter: number[];
  refreshCalls: number;
  refreshAborted: boolean[];
  persistCalls: number;
  getCalls: number;
  events: string[];
  persisted: TerminalEvidence[];
}

type FollowStep =
  | { kind: "terminal"; event: RuntimeEvent }
  | { kind: "closed"; lastSeq: number }
  | { kind: "aborted" }
  | { kind: "throw"; error: unknown }
  | { kind: "wait-abort"; resume: "aborted" | "throw-abort" | "throw-auth" };

type GetStep =
  | { kind: "status"; state: "running" | "interrupted" | "failed" | "completed"; lastSeq?: number }
  | { kind: "error"; error: unknown }
  | { kind: "null" }
  | { kind: "wait-abort"; state: "running"; lastSeq: number };

type ExecuteMode =
  | "ok"
  | "type-error"
  | "abort"
  | "abort-empty"
  | "string"
  | "rate-limit"
  | "empty-code"
  | "if-aborted";

interface Script {
  execute?: ExecuteMode;
  follows?: FollowStep[];
  gets?: GetStep[];
  ack?: "ok" | "expired" | "throw" | "hang" | "abort-error";
  cancel?: "ok" | "throw";
  refresh?: "ok" | "reject-on-abort" | "resolve-after-abort" | "throw";
  persist?: (evidence: TerminalEvidence) => Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
  sharedCleanup?: ReturnType<typeof createRunCleanup>;
  role?: "message" | "report";
  now?: () => number;
  useDateNow?: boolean;
  omitFollow?: boolean;
  streamUrl?: string;
}

function abortError(message = "aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function eventStreamError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.name = "EventStreamError";
  error.status = status;
  return error;
}

function completedEvent(
  seq: number,
  output: string,
  extra: Partial<Extract<RuntimeEvent, { type: "completed" }>> = {},
): RuntimeEvent {
  return {
    type: "completed",
    executionId: EXECUTION_ID,
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
    ...extra,
  };
}

function failedEvent(opts: {
  code: string;
  message: string;
  retryable: boolean;
  dispatchState?: "not_dispatched" | "accepted" | "unknown";
}): RuntimeEvent {
  return {
    type: "failed",
    executionId: EXECUTION_ID,
    seq: 5,
    at: "2026-07-22T00:00:00.000Z",
    error: {
      code: opts.code as "DRIVER_CRASH",
      phase: "dispatch",
      message: opts.message,
      retryable: opts.retryable,
    },
    dispatchState: opts.dispatchState ?? "accepted",
    toolState: "none",
    retryable: opts.retryable,
  };
}

function interruptedEvent(reason: string): RuntimeEvent {
  return {
    type: "interrupted",
    executionId: EXECUTION_ID,
    seq: 4,
    at: "2026-07-22T00:00:00.000Z",
    reason: reason as "timeout",
    dispatchState: "unknown",
    toolState: "none",
  };
}

function waitAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return Promise.reject(new Error("expected an abort signal"));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function emptyTrace(): Trace {
  return {
    executeCalls: 0,
    executeSignalAborted: [],
    executeRequests: [],
    cancelCalls: 0,
    cancelBodies: [],
    ackBodies: [],
    followAfter: [],
    refreshCalls: 0,
    refreshAborted: [],
    persistCalls: 0,
    getCalls: 0,
    events: [],
    persisted: [],
  };
}

async function runScript(script: Script): Promise<{ result: TurnResult; trace: Trace }> {
  const trace = emptyTrace();
  const follows = script.follows ?? [
    { kind: "terminal" as const, event: completedEvent(3, "hello") },
  ];
  let followIndex = 0;
  let getIndex = 0;
  const streamUrl = script.streamUrl ?? "http://127.0.0.1/events";

  const fake = {
    async execute(
      _scopeId: string,
      request: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<void> {
      trace.executeCalls += 1;
      trace.executeSignalAborted.push(options?.signal?.aborted === true);
      trace.executeRequests.push(request);
      const mode = script.execute ?? "ok";
      if (mode === "if-aborted" && options?.signal?.aborted) throw abortError();
      if (mode === "type-error") throw new TypeError("execute transport error");
      if (mode === "abort") throw abortError();
      if (mode === "abort-empty") throw abortError("");
      if (mode === "string") throw "raw-failure";
      if (mode === "rate-limit") throw new RuntimeClientError(429, "RATE_LIMITED", "slow");
      if (mode === "empty-code") throw new RuntimeClientError(503, "", "down");
    },
    async getExecution(
      _scopeId: string,
      _executionId: string,
      options?: { signal?: AbortSignal },
    ): Promise<{
      executionId: string;
      participantId: string;
      state: string;
      lastSeq: number | undefined;
    } | null> {
      trace.getCalls += 1;
      const step = script.gets?.[getIndex];
      if (script.gets && step === undefined) {
        throw new Error(`getExecution queue exhausted at ${getIndex}`);
      }
      getIndex += 1;
      if (!step || step.kind === "status") {
        return {
          executionId: EXECUTION_ID,
          participantId: PARTICIPANT_ID,
          state: step?.state ?? "running",
          lastSeq: step?.lastSeq,
        };
      }
      if (step.kind === "error") throw step.error;
      if (step.kind === "null") return null;
      await waitAbort(options?.signal);
      return {
        executionId: EXECUTION_ID,
        participantId: PARTICIPANT_ID,
        state: step.state,
        lastSeq: step.lastSeq,
      };
    },
    async ack(
      _scopeId: string,
      _executionId: string,
      request: AckBody,
      options?: { signal?: AbortSignal },
    ): Promise<{ executionId: string; ackState: string; disposition: string }> {
      trace.ackBodies.push(request);
      trace.events.push(`ack:${request.disposition}`);
      const mode = script.ack ?? "ok";
      if (mode === "hang") {
        await waitAbort(options?.signal);
        throw abortError();
      }
      if (mode === "abort-error") throw abortError();
      if (mode === "throw") throw new TypeError("ack exploded");
      return {
        executionId: EXECUTION_ID,
        ackState: mode === "expired" ? "expired" : "acknowledged",
        disposition: request.disposition,
      };
    },
    async cancelExecution(
      _scopeId: string,
      _executionId: string,
      body: ControllerRequest,
    ): Promise<void> {
      trace.cancelCalls += 1;
      trace.cancelBodies.push(body);
      trace.events.push("cancel");
      if (script.cancel === "throw") throw new Error("cancel failed");
    },
    eventStreamFetch(input: { afterSeq: number }) {
      trace.followAfter.push(input.afterSeq);
      return {
        url: `${streamUrl}?afterSeq=${input.afterSeq}`,
        headers: { Cookie: "councilkit_session=z", Accept: "text/event-stream" },
      };
    },
  };

  const host: HostLike = {
    rawClient: async () => fake as unknown as RuntimeClient,
    refreshAuthForStream: async (signal?: AbortSignal) => {
      trace.refreshCalls += 1;
      trace.refreshAborted.push(signal?.aborted === true);
      trace.events.push("refresh");
      const mode = script.refresh ?? "ok";
      if (mode === "throw") throw new Error("document GET failed");
      if (mode === "reject-on-abort" || mode === "resolve-after-abort") {
        await waitAbort(signal);
        if (mode === "reject-on-abort") throw abortError();
      }
      return { cookie: "councilkit_session=z", csrfToken: "c", origin: "http://127.0.0.1:43127" };
    },
  };

  const follow = async (options: FollowEventsOptions): Promise<FollowOutcome> => {
    const step = follows[followIndex];
    followIndex += 1;
    if (!step) throw new Error(`follow queue exhausted at ${followIndex}`);
    if (step.kind === "terminal") {
      await options.onEvent(step.event);
      return { kind: "terminal", event: step.event };
    }
    if (step.kind === "closed") return { kind: "closed", lastSeq: step.lastSeq };
    if (step.kind === "aborted") return { kind: "aborted", lastSeq: 0 };
    if (step.kind === "throw") throw step.error;
    await waitAbort(options.signal);
    if (step.resume === "aborted") return { kind: "aborted", lastSeq: 0 };
    if (step.resume === "throw-abort") throw abortError();
    throw eventStreamError(401, "event stream HTTP 401");
  };

  const persist = async (evidence: TerminalEvidence) => {
    trace.persistCalls += 1;
    trace.events.push("persist");
    trace.persisted.push(evidence);
    if (script.persist) await script.persist(evidence);
  };

  const result = await executeTurn({
    host,
    ...(script.omitFollow ? {} : { followEvents: follow }),
    scopeId: "scope-1",
    controller: CONTROLLER,
    participantId: PARTICIPANT_ID,
    executionId: EXECUTION_ID,
    snapshot: SNAPSHOT,
    role: script.role ?? "message",
    timeoutMs: script.timeoutMs ?? 5_000,
    signal: script.signal,
    sharedCleanup: script.sharedCleanup,
    persist,
    ...(script.useDateNow ? {} : { now: script.now ?? (() => 5000) }),
  });
  return { result, trace };
}

const ACK_FAILED = {
  phase: "ack" as const,
  code: "ACK_FAILED",
  message: "ACK did not reach the acknowledged state",
  retryable: true,
};

const TURN_TIMEOUT = {
  phase: "deadline" as const,
  code: "TURN_TIMEOUT",
  message: "turn deadline exceeded",
  retryable: true,
};

const CANCELLED = {
  phase: "cleanup" as const,
  code: "CANCELLED",
  message: "cancelled by caller",
  retryable: false,
};

function ack(disposition: string, finalSeq: number): AckBody {
  return { controllerId: "ctrl", leaseEpoch: 1, finalSeq, disposition };
}

describe("createRunCleanup", () => {
  it("does not abort until arm, and a second arm leaves the same deadline", () => {
    const shared = createRunCleanup(5_000);
    expect(shared.signal.aborted).toBe(false);
    shared.arm();
    shared.arm();
    expect(shared.signal.aborted).toBe(false);
    shared.dispose();
    expect(shared.signal.aborted).toBe(true);
    expect(shared.signal.reason).toBe("cleanup-disposed");
    shared.dispose();
    expect(shared.signal.reason).toBe("cleanup-disposed");
  });

  it("dispose before arm aborts with cleanup-disposed", () => {
    const shared = createRunCleanup(5_000);
    shared.dispose();
    expect(shared.signal.aborted).toBe(true);
    expect(shared.signal.reason).toBe("cleanup-disposed");
  });

  it("arm aborts with cleanup-deadline and dispose does not replace the reason", async () => {
    const shared = createRunCleanup(30);
    shared.arm();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(shared.signal.aborted).toBe(true);
    expect(shared.signal.reason).toBe("cleanup-deadline");
    shared.dispose();
    expect(shared.signal.reason).toBe("cleanup-deadline");
  });
});

describe("executeTurn completed and commit paths", () => {
  it("persists before the committed ACK and reports the terminal fields", async () => {
    let tick = 0;
    const ticks = [1000, 1040, 1090];
    const { result, trace } = await runScript({
      now: () => ticks[Math.min(tick++, ticks.length - 1)] ?? 1090,
      follows: [
        {
          kind: "terminal",
          event: completedEvent(4, "rich", {
            requestedModel: "asked",
            effectiveModel: null,
            modelVerdict: "unknown",
            toolState: "active",
            usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
            finalSeq: 9,
          }),
        },
      ],
    });
    expect(result).toEqual({
      verdict: "completed",
      executionId: EXECUTION_ID,
      participantId: PARTICIPANT_ID,
      dispatchState: "accepted",
      terminal: {
        output: "rich",
        requestedModel: "asked",
        effectiveModel: null,
        modelVerdict: "unknown",
        toolState: "active",
        usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
        finalSeq: 4,
      },
      durationMs: 40,
      ack: "acknowledged",
      error: null,
    });
    expect(trace.events).toEqual(["persist", "ack:committed"]);
    expect(trace.executeCalls).toBe(1);
    expect(trace.cancelCalls).toBe(0);
    expect(trace.ackBodies).toEqual([ack("committed", 4)]);
    expect(trace.executeRequests).toEqual([
      {
        controllerId: "ctrl",
        leaseEpoch: 1,
        executionId: EXECUTION_ID,
        participantId: PARTICIPANT_ID,
        snapshot: SNAPSHOT,
      },
    ]);
    expect(trace.persisted).toEqual([result.terminal]);
  });

  it("treats a missing completed output as empty and discards the ACK", async () => {
    const event = completedEvent(2, "placeholder");
    (event as { output?: string }).output = undefined;
    const { result, trace } = await runScript({ follows: [{ kind: "terminal", event }] });
    expect(result.verdict).toBe("failed");
    expect(result.ack).toBe("acknowledged");
    expect(result.durationMs).toBe(0);
    expect(result.terminal?.output).toBe("");
    expect(result.error).toEqual({
      phase: "terminal",
      code: "EMPTY_OUTPUT",
      message: "model returned an empty output",
      retryable: false,
    });
    expect(trace.events).toEqual(["ack:discarded"]);
    expect(trace.ackBodies).toEqual([ack("discarded", 2)]);
  });

  it("keeps whitespace output and forces ack finalSeq to at least 1", async () => {
    const { result, trace } = await runScript({
      follows: [{ kind: "terminal", event: completedEvent(0, " \n") }],
    });
    expect(result.verdict).toBe("failed");
    expect(result.error?.code).toBe("EMPTY_OUTPUT");
    expect(result.terminal?.output).toBe(" \n");
    expect(result.terminal?.finalSeq).toBe(0);
    expect(trace.ackBodies).toEqual([ack("discarded", 1)]);
  });

  it("reports ACK_FAILED when an empty output is not acknowledged", async () => {
    const { result, trace } = await runScript({
      ack: "expired",
      follows: [{ kind: "terminal", event: completedEvent(2, "   ") }],
    });
    expect(result.verdict).toBe("failed");
    expect(result.ack).toBe("conflict");
    expect(result.durationMs).toBe(0);
    expect(result.terminal?.output).toBe("   ");
    expect(result.error).toEqual({
      ...ACK_FAILED,
      message: "EMPTY_OUTPUT + ACK not acknowledged",
    });
    expect(trace.ackBodies).toEqual([ack("discarded", 2)]);
  });

  it("classifies a string persist failure as PERSIST_FAILED after a discarded ACK", async () => {
    const { result, trace } = await runScript({
      persist: async () => {
        throw "disk";
      },
    });
    expect(result.verdict).toBe("failed");
    expect(result.ack).toBe("acknowledged");
    expect(result.terminal?.output).toBe("hello");
    expect(result.error).toEqual({
      phase: "commit",
      code: "PERSIST_FAILED",
      message: "persist failed",
      retryable: false,
    });
    expect(trace.events).toEqual(["persist", "ack:discarded"]);
  });

  it("keeps a non-io CliError on the commit phase", async () => {
    const { result } = await runScript({
      role: "report",
      persist: async () => {
        throw new CliError({ code: EXIT.usage, message: "bad usage" });
      },
    });
    expect(result.error).toEqual({
      phase: "commit",
      code: "PERSIST_FAILED",
      message: "bad usage",
      retryable: false,
    });
    expect(result.ack).toBe("acknowledged");
  });

  it("classifies a transcript IO failure as phase io", async () => {
    const { result, trace } = await runScript({
      role: "report",
      persist: async () => {
        throw new CliError({ code: EXIT.io, message: "transcript ENOSPC" });
      },
    });
    expect(result.verdict).toBe("failed");
    expect(result.error).toEqual({
      phase: "io",
      code: "TRANSCRIPT_IO",
      message: "transcript ENOSPC",
      retryable: false,
    });
    expect(trace.ackBodies).toEqual([ack("discarded", 3)]);
  });

  it("reports ACK_FAILED when persist fails and the discarded ACK is not acknowledged", async () => {
    const { result } = await runScript({
      ack: "expired",
      persist: async () => {
        throw new Error("persist boom");
      },
    });
    expect(result.verdict).toBe("failed");
    expect(result.ack).toBe("conflict");
    expect(result.terminal?.output).toBe("hello");
    expect(result.error).toEqual({
      ...ACK_FAILED,
      message: "commit failed + ACK not acknowledged: persist boom",
    });
  });

  it("reports ACK_FAILED rather than TRANSCRIPT_IO when the io ACK is not acknowledged", async () => {
    const { result } = await runScript({
      ack: "expired",
      persist: async () => {
        throw new CliError({ code: EXIT.io, message: "transcript ENOSPC" });
      },
    });
    expect(result.error).toEqual({
      ...ACK_FAILED,
      message: "commit failed + ACK not acknowledged: transcript ENOSPC",
    });
  });

  it("reports ACK_FAILED when a committed ACK throws a non-abort error", async () => {
    const { result, trace } = await runScript({ ack: "throw" });
    expect(result.verdict).toBe("failed");
    expect(result.ack).toBe("conflict");
    expect(result.terminal?.output).toBe("hello");
    expect(result.error).toEqual(ACK_FAILED);
    expect(trace.persistCalls).toBe(1);
  });

  it("downgrades a spontaneous ACK AbortError to cancelled", async () => {
    const { result, trace } = await runScript({ ack: "abort-error" });
    expect(result.verdict).toBe("cancelled");
    expect(result.ack).toBe("skipped");
    expect(result.error).toEqual(CANCELLED);
    expect(result.terminal?.output).toBe("hello");
    expect(trace.events).toEqual(["persist", "ack:committed"]);
  });

  it("downgrades a deadline abort during the committed ACK to timeout", async () => {
    const { result, trace } = await runScript({
      ack: "hang",
      timeoutMs: 40,
    });
    expect(result.verdict).toBe("timeout");
    expect(result.ack).toBe("skipped");
    expect(result.error).toEqual(TURN_TIMEOUT);
    expect(result.terminal?.output).toBe("hello");
    expect(trace.persistCalls).toBe(1);
    expect(trace.ackBodies).toEqual([ack("committed", 3)]);
  });
});

describe("executeTurn terminal failures", () => {
  it("keeps a retryable failed-event error after a discarded ACK", async () => {
    const { result, trace } = await runScript({
      follows: [
        {
          kind: "terminal",
          event: failedEvent({
            code: "RATE_LIMITED",
            message: "slow down",
            retryable: true,
            dispatchState: "not_dispatched",
          }),
        },
      ],
    });
    expect(result.verdict).toBe("failed");
    expect(result.dispatchState).toBe("not_dispatched");
    expect(result.terminal).toBeNull();
    expect(result.ack).toBe("acknowledged");
    expect(result.durationMs).toBe(0);
    expect(result.error).toEqual({
      phase: "terminal",
      code: "RATE_LIMITED",
      message: "slow down",
      retryable: true,
    });
    expect(trace.ackBodies).toEqual([ack("discarded", 5)]);
    expect(trace.persistCalls).toBe(0);
  });

  it("maps an empty failed-event code to CRASH", async () => {
    const { result } = await runScript({
      follows: [
        {
          kind: "terminal",
          event: failedEvent({ code: "", message: "blank", retryable: false }),
        },
      ],
    });
    expect(result.error).toEqual({
      phase: "terminal",
      code: "CRASH",
      message: "blank",
      retryable: false,
    });
  });

  it("replaces a failed terminal with ACK_FAILED when the discarded ACK conflicts", async () => {
    const { result } = await runScript({
      ack: "expired",
      follows: [
        {
          kind: "terminal",
          event: failedEvent({ code: "DRIVER_CRASH", message: "boom", retryable: false }),
        },
      ],
    });
    expect(result.verdict).toBe("failed");
    expect(result.ack).toBe("conflict");
    expect(result.terminal).toBeNull();
    expect(result.error).toEqual(ACK_FAILED);
  });

  it.each([
    ["timeout", "deadline", "TURN_TIMEOUT", "turn timed out", true],
    ["host_shutdown", "terminal", "HOST_SHUTDOWN", "host shutdown", false],
    ["supervisor_lost", "terminal", "SUPERVISOR_LOST", "supervisor lost", false],
    ["driver_crash", "terminal", "DRIVER_CRASH", "driver crashed", false],
    ["user_cancelled", "terminal", "USER_CANCELLED", "cancelled by user", false],
    ["unknown", "terminal", "INTERRUPTED", "interrupted", false],
  ] as const)("interrupted reason %s", async (reason, phase, code, message, retryable) => {
    const { result, trace } = await runScript({
      follows: [{ kind: "terminal", event: interruptedEvent(reason) }],
    });
    expect(result.verdict).toBe("interrupted");
    expect(result.dispatchState).toBe("unknown");
    expect(result.ack).toBe("acknowledged");
    expect(result.terminal).toBeNull();
    expect(result.durationMs).toBe(0);
    expect(result.error).toEqual({ phase, code, message, retryable });
    expect(trace.ackBodies).toEqual([ack("discarded", 4)]);
  });

  it("replaces an interrupt with ACK_FAILED when the discarded ACK conflicts", async () => {
    const { result } = await runScript({
      ack: "expired",
      follows: [{ kind: "terminal", event: interruptedEvent("driver_crash") }],
    });
    expect(result.verdict).toBe("failed");
    expect(result.ack).toBe("conflict");
    expect(result.error).toEqual(ACK_FAILED);
  });
});

describe("executeTurn ambiguous dispatch", () => {
  it("skips cleanup on a definitive 404 EXECUTION_NOT_FOUND", async () => {
    const { result, trace } = await runScript({
      useDateNow: true,
      execute: "type-error",
      gets: [
        { kind: "error", error: new RuntimeClientError(404, "EXECUTION_NOT_FOUND", "no record") },
      ],
    });
    expect(result.verdict).toBe("failed");
    expect(result.dispatchState).toBe("not_dispatched");
    expect(result.ack).toBe("skipped");
    expect(result.terminal).toBeNull();
    expect(result.error).toEqual({
      phase: "dispatch",
      code: "DISPATCH_FAILED",
      message: "execute transport error",
      retryable: false,
    });
    expect(trace.executeCalls).toBe(1);
    expect(trace.cancelCalls).toBe(0);
    expect(trace.ackBodies).toEqual([]);
    expect(trace.getCalls).toBe(1);
  });

  it("treats 404 with a different code as unknown and still cleans up", async () => {
    const { result, trace } = await runScript({
      execute: "type-error",
      gets: [
        { kind: "error", error: new RuntimeClientError(404, "SCOPE_NOT_FOUND", "nope") },
        { kind: "status", state: "failed", lastSeq: 8 },
      ],
    });
    expect(result.verdict).toBe("failed");
    expect(result.dispatchState).toBe("unknown");
    expect(result.error?.code).toBe("DISPATCH_FAILED");
    expect(trace.cancelCalls).toBe(1);
    expect(trace.cancelBodies).toEqual([CONTROLLER]);
    expect(trace.ackBodies).toEqual([ack("discarded", 8)]);
  });

  it("treats EXECUTION_NOT_FOUND on a non-404 status as unknown", async () => {
    const { result, trace } = await runScript({
      execute: "string",
      gets: [
        { kind: "error", error: new RuntimeClientError(500, "EXECUTION_NOT_FOUND", "nope") },
        { kind: "status", state: "interrupted", lastSeq: 0 },
      ],
    });
    expect(result.dispatchState).toBe("unknown");
    expect(result.error).toEqual({
      phase: "dispatch",
      code: "DISPATCH_FAILED",
      message: "raw-failure",
      retryable: false,
    });
    expect(trace.ackBodies).toEqual([ack("discarded", 1)]);
  });

  it("cleans up a dispatched record without re-executing", async () => {
    const { result, trace } = await runScript({
      execute: "rate-limit",
      gets: [
        { kind: "status", state: "running", lastSeq: 0 },
        { kind: "status", state: "completed", lastSeq: 6 },
      ],
    });
    expect(trace.executeCalls).toBe(1);
    expect(result.dispatchState).toBe("accepted");
    expect(result.verdict).toBe("failed");
    expect(result.error).toEqual({
      phase: "dispatch",
      code: "RATE_LIMITED",
      message: "slow",
      retryable: false,
    });
    expect(trace.ackBodies).toEqual([ack("discarded", 6)]);
  });

  it("maps an empty runtime code to CRASH and an AbortError execute to ABORT", async () => {
    const crashed = await runScript({
      execute: "empty-code",
      gets: [
        { kind: "error", error: new RuntimeClientError(404, "EXECUTION_NOT_FOUND", "missing") },
      ],
    });
    expect(crashed.result.error).toEqual({
      phase: "dispatch",
      code: "CRASH",
      message: "down",
      retryable: false,
    });
    expect(crashed.result.verdict).toBe("failed");

    const aborted = await runScript({
      execute: "abort",
      gets: [
        { kind: "error", error: new RuntimeClientError(404, "EXECUTION_NOT_FOUND", "missing") },
      ],
    });
    expect(aborted.result.verdict).toBe("failed");
    expect(aborted.result.error).toEqual({
      phase: "deadline",
      code: "ABORT",
      message: "aborted",
      retryable: true,
    });
    expect(aborted.trace.cancelCalls).toBe(0);

    const emptyAbort = await runScript({
      execute: "abort-empty",
      gets: [
        { kind: "error", error: new RuntimeClientError(404, "EXECUTION_NOT_FOUND", "missing") },
      ],
    });
    expect(emptyAbort.result.error).toEqual({
      phase: "deadline",
      code: "ABORT",
      message: "request aborted",
      retryable: true,
    });
  });

  it("reports the caller cancel when execute is rejected by an already-aborted signal", async () => {
    const external = new AbortController();
    external.abort("SIGINT");
    const skipped = await runScript({
      signal: external.signal,
      execute: "if-aborted",
      gets: [
        { kind: "error", error: new RuntimeClientError(404, "EXECUTION_NOT_FOUND", "missing") },
      ],
    });
    expect(skipped.trace.executeSignalAborted).toEqual([true]);
    expect(skipped.trace.cancelCalls).toBe(0);
    expect(skipped.result.verdict).toBe("cancelled");
    expect(skipped.result.dispatchState).toBe("not_dispatched");
    expect(skipped.result.error).toEqual(CANCELLED);

    const cleaned = await runScript({
      signal: external.signal,
      execute: "if-aborted",
      gets: [
        { kind: "status", state: "running", lastSeq: 0 },
        { kind: "status", state: "interrupted" },
      ],
    });
    expect(cleaned.result.verdict).toBe("cancelled");
    expect(cleaned.result.dispatchState).toBe("accepted");
    expect(cleaned.trace.cancelCalls).toBe(1);
    expect(cleaned.trace.ackBodies).toEqual([ack("discarded", 1)]);
  });

  it("drives the discarded ACK from the shared cleanup budget", async () => {
    const shared = createRunCleanup(50);
    const started = Date.now();
    const { result, trace } = await runScript({
      execute: "type-error",
      ack: "hang",
      timeoutMs: 600_000,
      sharedCleanup: shared,
      gets: [
        { kind: "status", state: "running", lastSeq: 0 },
        { kind: "status", state: "interrupted", lastSeq: 7 },
      ],
    });
    const elapsed = Date.now() - started;
    shared.dispose();
    expect(trace.executeCalls).toBe(1);
    expect(trace.cancelCalls).toBe(1);
    expect(trace.ackBodies).toEqual([ack("discarded", 7)]);
    expect(result.verdict).toBe("failed");
    expect(result.dispatchState).toBe("accepted");
    expect(result.error?.code).toBe("DISPATCH_FAILED");
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("executeTurn stream, reconnect, and cleanup", () => {
  it("reconnects from lastSeq when the execution is still present", async () => {
    const { result, trace } = await runScript({
      follows: [
        { kind: "closed", lastSeq: 2 },
        { kind: "terminal", event: completedEvent(3, "ok") },
      ],
      gets: [{ kind: "status", state: "completed", lastSeq: 2 }],
    });
    expect(trace.followAfter).toEqual([0, 2]);
    expect(trace.executeCalls).toBe(1);
    expect(result.verdict).toBe("completed");
    expect(result.terminal?.output).toBe("ok");
    expect(trace.ackBodies).toEqual([ack("committed", 3)]);
  });

  it("fails with STREAM_CLOSED when a later reconnect cannot read the execution", async () => {
    const { result, trace } = await runScript({
      follows: [
        { kind: "closed", lastSeq: 1 },
        { kind: "closed", lastSeq: 4 },
      ],
      gets: [
        { kind: "status", state: "completed", lastSeq: 1 },
        { kind: "error", error: new Error("lost") },
      ],
    });
    expect(trace.followAfter).toEqual([0, 1]);
    expect(trace.cancelCalls).toBe(0);
    expect(result.verdict).toBe("failed");
    expect(result.ack).toBe("skipped");
    expect(result.error).toEqual({
      phase: "stream",
      code: "STREAM_CLOSED",
      message: "event stream closed before a terminal arrived and the execution was lost",
      retryable: false,
    });
  });

  it("fails with STREAM_CLOSED when getExecution returns no record", async () => {
    const { result, trace } = await runScript({
      follows: [{ kind: "closed", lastSeq: 6 }],
      gets: [{ kind: "null" }],
    });
    expect(trace.getCalls).toBe(1);
    expect(result.error?.code).toBe("STREAM_CLOSED");
    expect(result.verdict).toBe("failed");
  });

  it("cleans up when the deadline aborts while probing a closed stream", async () => {
    const { result, trace } = await runScript({
      timeoutMs: 30,
      follows: [{ kind: "closed", lastSeq: 0 }],
      gets: [
        { kind: "wait-abort", state: "running", lastSeq: 0 },
        { kind: "status", state: "interrupted", lastSeq: 9 },
      ],
    });
    expect(result.verdict).toBe("timeout");
    expect(result.error).toEqual(TURN_TIMEOUT);
    expect(trace.cancelCalls).toBe(1);
    expect(trace.ackBodies).toEqual([ack("discarded", 9)]);
  });

  it("refreshes auth once on SSE 403 and completes without a second execute", async () => {
    const { result, trace } = await runScript({
      follows: [
        { kind: "throw", error: eventStreamError(403, "event stream HTTP 403") },
        { kind: "terminal", event: completedEvent(3, "after-auth") },
      ],
    });
    expect(trace.refreshCalls).toBe(1);
    expect(trace.refreshAborted).toEqual([false]);
    expect(trace.followAfter).toEqual([0, 0]);
    expect(trace.executeCalls).toBe(1);
    expect(result.verdict).toBe("completed");
    expect(result.terminal?.output).toBe("after-auth");
  });

  it("surfaces the second follow error after a successful auth refresh", async () => {
    const { result, trace } = await runScript({
      follows: [
        { kind: "throw", error: eventStreamError(401, "event stream HTTP 401") },
        { kind: "throw", error: new Error("second-fail") },
      ],
    });
    expect(trace.refreshCalls).toBe(1);
    expect(trace.cancelCalls).toBe(0);
    expect(result.verdict).toBe("failed");
    expect(result.error).toEqual({
      phase: "stream",
      code: "RUNTIME_UNAVAILABLE",
      message: "second-fail",
      retryable: false,
    });
  });

  it("does not refresh a non-auth stream error, including a 401-shaped generic Error", async () => {
    const generic = new Error("not-really-auth") as Error & { status: number };
    generic.status = 401;
    const plain = await runScript({
      follows: [{ kind: "throw", error: generic }],
    });
    expect(plain.trace.refreshCalls).toBe(0);
    expect(plain.result.error).toEqual({
      phase: "stream",
      code: "RUNTIME_UNAVAILABLE",
      message: "not-really-auth",
      retryable: false,
    });

    const http = await runScript({
      follows: [{ kind: "throw", error: eventStreamError(500, "event stream HTTP 500") }],
    });
    expect(http.trace.refreshCalls).toBe(0);
    expect(http.result.error?.message).toBe("event stream HTTP 500");
    expect(http.result.error?.code).toBe("RUNTIME_UNAVAILABLE");

    const raw = await runScript({
      follows: [{ kind: "throw", error: "stream-down" }],
    });
    expect(raw.result.error).toEqual({
      phase: "stream",
      code: "RUNTIME_UNAVAILABLE",
      message: "stream-down",
      retryable: false,
    });

    const runtime = await runScript({
      follows: [{ kind: "throw", error: new RuntimeClientError(502, "DRIVER_CRASH", "gone") }],
    });
    expect(runtime.result.error).toEqual({
      phase: "stream",
      code: "DRIVER_CRASH",
      message: "gone",
      retryable: false,
    });
  });

  it("classifies an AbortError from follow as ABORT when the deadline is still open", async () => {
    const { result, trace } = await runScript({
      follows: [{ kind: "throw", error: abortError("") }],
    });
    expect(trace.cancelCalls).toBe(0);
    expect(result.verdict).toBe("failed");
    expect(result.ack).toBe("skipped");
    expect(result.error).toEqual({
      phase: "deadline",
      code: "ABORT",
      message: "request aborted",
      retryable: true,
    });
  });

  it("reports a 401 that arrives after the deadline as the stream error itself", async () => {
    const { result, trace } = await runScript({
      timeoutMs: 30,
      follows: [{ kind: "wait-abort", resume: "throw-auth" }],
    });
    expect(trace.refreshCalls).toBe(0);
    expect(trace.cancelCalls).toBe(0);
    expect(result.verdict).toBe("failed");
    expect(result.error).toEqual({
      phase: "stream",
      code: "RUNTIME_UNAVAILABLE",
      message: "event stream HTTP 401",
      retryable: false,
    });
  });

  it("cleans up when the refreshed follow aborts with the deadline", async () => {
    const { result, trace } = await runScript({
      timeoutMs: 40,
      gets: [{ kind: "status", state: "interrupted", lastSeq: 2 }],
      follows: [
        { kind: "throw", error: eventStreamError(401, "event stream HTTP 401") },
        { kind: "wait-abort", resume: "throw-abort" },
      ],
    });
    expect(trace.refreshCalls).toBe(1);
    expect(trace.cancelCalls).toBe(1);
    expect(trace.ackBodies).toEqual([ack("discarded", 2)]);
    expect(result.verdict).toBe("timeout");
    expect(result.error).toEqual(TURN_TIMEOUT);
  });

  it("returns aborted from a refresh that resolves after the caller signal fires", async () => {
    const external = new AbortController();
    const timer = setTimeout(() => external.abort(null), 20);
    try {
      const { result, trace } = await runScript({
        signal: external.signal,
        timeoutMs: 5_000,
        refresh: "resolve-after-abort",
        gets: [{ kind: "status", state: "interrupted", lastSeq: 4 }],
        follows: [{ kind: "throw", error: eventStreamError(401, "event stream HTTP 401") }],
      });
      expect(trace.refreshCalls).toBe(1);
      expect(trace.cancelCalls).toBe(1);
      expect(trace.ackBodies).toEqual([ack("discarded", 4)]);
      expect(result.verdict).toBe("cancelled");
      expect(result.error).toEqual(CANCELLED);
    } finally {
      clearTimeout(timer);
    }
  });

  it("reports a non-abort auth refresh failure without cancelling", async () => {
    const { result, trace } = await runScript({
      refresh: "throw",
      follows: [{ kind: "throw", error: eventStreamError(401, "event stream HTTP 401") }],
    });
    expect(trace.executeCalls).toBe(1);
    expect(trace.refreshCalls).toBe(1);
    expect(trace.cancelCalls).toBe(0);
    expect(trace.ackBodies).toEqual([]);
    expect(result.verdict).toBe("failed");
    expect(result.error).toEqual({
      phase: "stream",
      code: "RUNTIME_UNAVAILABLE",
      message: "document GET failed",
      retryable: false,
    });
  });

  it("cancels an accepted execution when the SSE 401 cold-rebuild aborts", async () => {
    const external = new AbortController();
    const timer = setTimeout(() => external.abort("SIGINT"), 20);
    try {
      const { result, trace } = await runScript({
        signal: external.signal,
        timeoutMs: 5_000,
        refresh: "reject-on-abort",
        gets: [{ kind: "status", state: "interrupted", lastSeq: 4 }],
        follows: [{ kind: "throw", error: eventStreamError(401, "event stream HTTP 401") }],
      });
      expect(trace.executeCalls).toBe(1);
      expect(trace.refreshCalls).toBe(1);
      expect(trace.cancelCalls).toBe(1);
      expect(trace.ackBodies).toEqual([ack("discarded", 4)]);
      expect(result.verdict).toBe("cancelled");
      expect(result.error).toEqual(CANCELLED);
    } finally {
      clearTimeout(timer);
    }
  });

  it("times out a hung follow, still ACKs after a thrown cancel, and stops when observe throws", async () => {
    const observed = await runScript({
      timeoutMs: 30,
      cancel: "throw",
      follows: [{ kind: "wait-abort", resume: "aborted" }],
      gets: [{ kind: "status", state: "interrupted", lastSeq: 3 }],
    });
    expect(observed.trace.cancelCalls).toBe(1);
    expect(observed.trace.events[0]).toBe("cancel");
    expect(observed.trace.ackBodies).toEqual([ack("discarded", 3)]);
    expect(observed.result.verdict).toBe("timeout");
    expect(observed.result.error).toEqual(TURN_TIMEOUT);

    const lost = await runScript({
      timeoutMs: 30,
      follows: [{ kind: "wait-abort", resume: "aborted" }],
      gets: [{ kind: "error", error: new Error("observe down") }],
    });
    expect(lost.trace.cancelCalls).toBe(1);
    expect(lost.trace.ackBodies).toEqual([]);
    expect(lost.result.verdict).toBe("timeout");
    expect(lost.result.ack).toBe("skipped");
  });

  it("polls a still-running execution and then discards the observed seq", async () => {
    const { result, trace } = await runScript({
      timeoutMs: 40,
      follows: [{ kind: "wait-abort", resume: "throw-abort" }],
      gets: [
        { kind: "status", state: "running", lastSeq: 1 },
        { kind: "status", state: "interrupted", lastSeq: 8 },
      ],
    });
    expect(trace.getCalls).toBe(2);
    expect(trace.ackBodies).toEqual([ack("discarded", 8)]);
    expect(result.verdict).toBe("timeout");
  });

  it("stops after five running observations without an ACK", async () => {
    const { result, trace } = await runScript({
      timeoutMs: 30,
      follows: [{ kind: "wait-abort", resume: "aborted" }],
      gets: [
        { kind: "status", state: "running", lastSeq: 1 },
        { kind: "status", state: "running", lastSeq: 1 },
        { kind: "status", state: "running", lastSeq: 1 },
        { kind: "status", state: "running", lastSeq: 1 },
        { kind: "status", state: "running", lastSeq: 1 },
      ],
    });
    expect(trace.getCalls).toBe(5);
    expect(trace.ackBodies).toEqual([]);
    expect(result.verdict).toBe("timeout");
    expect(result.ack).toBe("skipped");
  });

  it("reports ACK_FAILED when the cleanup ACK is not acknowledged", async () => {
    const { result, trace } = await runScript({
      timeoutMs: 30,
      ack: "expired",
      follows: [{ kind: "wait-abort", resume: "aborted" }],
      gets: [{ kind: "status", state: "interrupted", lastSeq: 3 }],
    });
    expect(trace.ackBodies).toEqual([ack("discarded", 3)]);
    expect(result.verdict).toBe("failed");
    expect(result.ack).toBe("conflict");
    expect(result.error).toEqual(ACK_FAILED);
  });

  it("cancels when the caller aborts during the follow", async () => {
    const external = new AbortController();
    const timer = setTimeout(() => external.abort("SIGINT"), 20);
    try {
      const { result, trace } = await runScript({
        signal: external.signal,
        follows: [{ kind: "wait-abort", resume: "aborted" }],
        gets: [{ kind: "status", state: "interrupted", lastSeq: 2 }],
      });
      expect(trace.cancelCalls).toBe(1);
      expect(result.verdict).toBe("cancelled");
      expect(result.error).toEqual(CANCELLED);
      expect(trace.ackBodies).toEqual([ack("discarded", 2)]);
    } finally {
      clearTimeout(timer);
    }
  });

  it("uses the shared cleanup signal for the committed ACK after the caller aborts during persist", async () => {
    const external = new AbortController();
    const shared = createRunCleanup(50);
    const started = Date.now();
    const { result, trace } = await runScript({
      signal: external.signal,
      sharedCleanup: shared,
      timeoutMs: 600_000,
      ack: "hang",
      persist: async () => {
        external.abort("SIGINT");
      },
    });
    const elapsed = Date.now() - started;
    shared.dispose();
    expect(trace.events).toEqual(["persist", "ack:committed"]);
    expect(result.verdict).toBe("cancelled");
    expect(result.ack).toBe("skipped");
    expect(result.error).toEqual(CANCELLED);
    expect(result.terminal?.output).toBe("hello");
    expect(elapsed).toBeLessThan(2_000);
  });

  it("does not arm a shared cleanup on the happy path", async () => {
    const shared = createRunCleanup(30);
    const { result } = await runScript({ sharedCleanup: shared });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(shared.signal.aborted).toBe(false);
    expect(result.verdict).toBe("completed");
    expect(result.terminal?.output).toBe("hello");
    shared.dispose();
    expect(shared.signal.reason).toBe("cleanup-disposed");
  });

  it("follows the real SSE reader when followEvents is omitted", async () => {
    const event = completedEvent(3, "from-sse");
    const server: Server = createServer((req, res) => {
      if (req.url?.startsWith("/events")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`event: runtime\ndata: ${JSON.stringify(event)}\n\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const { result, trace } = await runScript({
        omitFollow: true,
        streamUrl: `http://127.0.0.1:${port}/events`,
      });
      expect(result.verdict).toBe("completed");
      expect(result.durationMs).toBe(0);
      expect(result.terminal).toEqual({
        output: "from-sse",
        requestedModel: "model-x",
        effectiveModel: "model-x",
        modelVerdict: "match",
        toolState: "none",
        usage: null,
        finalSeq: 3,
      });
      expect(trace.followAfter).toEqual([0]);
      expect(trace.ackBodies).toEqual([ack("committed", 3)]);
      expect(trace.events).toEqual(["persist", "ack:committed"]);
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    }
  });
});
