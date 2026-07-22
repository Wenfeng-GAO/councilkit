/**
 * execute-turn unit tests (plan-a §10 AC1, execute bucket). Ports the
 * agent-real-call fix semantics to the CLI per-turn lifecycle, driven through a
 * fake Host/client + an injectable SSE follower. Covers: persist-before-ACK,
 * failed/interrupted discarded ACK, empty output, ambiguous dispatch three-state
 * (dispatched / notDispatched / unknown), execute-at-most-once, SSE afterSeq
 * reconnect, ACK conflict, timeout cleanup, and persist failure.
 */
import { RuntimeClientError } from "@/runtime/client";
import type { FollowEventsOptions, FollowOutcome } from "@/runtime/event-stream";
import type { DispatchState, ToolState } from "@shared/runtime/contracts";
import type { RuntimeError, RuntimeErrorCode } from "@shared/runtime/errors";
import type { RuntimeEvent } from "@shared/runtime/events";
import type { ContextSnapshot, ControllerRequest } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";
import { type HostLike, type TerminalEvidence, executeTurn } from "../src/host/execute-turn";

const CONTROLLER: ControllerRequest = { controllerId: "ctrl", leaseEpoch: 1 };
const EXECUTION_ID = "exec-aaaaaaaa";
const PARTICIPANT_ID = "p-1";

function snapshot(): ContextSnapshot {
  return {
    digestVersion: 1,
    roomContext: { contextRevision: 0, contextDigest: "d", items: [] },
    participant: { participantId: PARTICIPANT_ID, participantSnapshotDigest: "d" },
    instruction: { kind: "message", instructionDigest: "d", text: "reply" },
  } as ContextSnapshot;
}

function completedEvent(seq: number, output: string): RuntimeEvent {
  return {
    type: "completed",
    executionId: EXECUTION_ID,
    seq,
    at: "2026-07-22T00:00:00.000Z",
    output,
    requestedModel: "model-x",
    effectiveModel: "model-x",
    modelVerdict: "match",
    toolState: "none" as ToolState,
    dispatchState: "accepted",
    usage: null,
    finalSeq: seq,
  };
}

function failedEvent(seq: number, code: RuntimeErrorCode): RuntimeEvent {
  return {
    type: "failed",
    executionId: EXECUTION_ID,
    seq,
    at: "2026-07-22T00:00:00.000Z",
    error: { code, phase: "dispatch", message: "boom", retryable: false } satisfies RuntimeError,
    dispatchState: "accepted" as DispatchState,
    toolState: "none",
    retryable: false,
  };
}

interface FakeClientOptions {
  executeThrows?: "transport" | "aborted";
  /** what the ambiguous-dispatch probe (getExecution) returns when execute threw. */
  probe?: "dispatched" | "notDispatched" | "unknown";
  /** terminal event the SSE follower yields on the happy path. */
  terminal?: RuntimeEvent;
  /** if set, the first follow() call returns "closed" then the second yields terminal. */
  reconnectOnce?: boolean;
  /** SSE hangs until the deadline aborts. */
  hangUntilAbort?: boolean;
  /** override ackState returned. */
  ackState?: string;
  /** whether cancel sets the execution to interrupted (observed terminal). */
  cancelInterrupts?: boolean;
  /** getExecution state for the observe-loop / reconnect path. */
  observeState?: "running" | "interrupted" | "completed";
}

interface Counters {
  execute: number;
  ack: number;
  ackDisposition: string[];
  cancel: number;
  persist: number;
  log: string[];
}

function makeFake(
  opts: FakeClientOptions,
  counters: Counters,
): {
  host: HostLike;
  follow: typeof import("@/runtime/event-stream").followExecutionEvents;
  persist: (e: TerminalEvidence) => Promise<void>;
  setPersistFails: (v: boolean) => void;
} {
  let persistFails = false;
  let execState: "running" | "interrupted" | "completed" | "failed" = "running";
  let execSeq = 0;
  let probeCalls = 0;

  const fakeClient = {
    async execute(): Promise<{
      execution: { executionId: string; participantId: string; state: string; lastSeq: number };
    }> {
      counters.execute += 1;
      if (opts.executeThrows === "transport") {
        throw new TypeError("execute transport error");
      }
      if (opts.executeThrows === "aborted") {
        throw new Error("aborted");
      }
      return {
        execution: {
          executionId: EXECUTION_ID,
          participantId: PARTICIPANT_ID,
          state: "running",
          lastSeq: 0,
        },
      };
    },
    async getExecution(): Promise<{
      executionId: string;
      participantId: string;
      state: string;
      lastSeq: number;
    }> {
      // The dispatch probe runs first (checkAmbiguousDispatch); later calls
      // serve the cleanup observe-loop / reconnect path.
      const isProbe = probeCalls === 0;
      probeCalls += 1;
      if (opts.executeThrows && isProbe) {
        if (opts.probe === "notDispatched") {
          throw new RuntimeClientError(404, "EXECUTION_NOT_FOUND", "no record");
        }
        if (opts.probe === "unknown") {
          throw new TypeError("probe transport error");
        }
        return {
          executionId: EXECUTION_ID,
          participantId: PARTICIPANT_ID,
          state: "running",
          lastSeq: 0,
        };
      }
      // Observe / reconnect path.
      return {
        executionId: EXECUTION_ID,
        participantId: PARTICIPANT_ID,
        state: execState,
        lastSeq: execSeq,
      };
    },
    async ack(
      _s: string,
      _e: string,
      req: { disposition: string },
    ): Promise<{ executionId: string; ackState: string; disposition: string | null }> {
      counters.ack += 1;
      counters.ackDisposition.push(req.disposition);
      counters.log.push(`ack:${req.disposition}`);
      return {
        executionId: EXECUTION_ID,
        ackState: opts.ackState ?? "acknowledged",
        disposition: req.disposition,
      };
    },
    async cancelExecution(): Promise<{ executionId: string; state: string }> {
      counters.cancel += 1;
      counters.log.push("cancel");
      if (opts.cancelInterrupts !== false) {
        execState = "interrupted";
        execSeq = 7;
      }
      return { executionId: EXECUTION_ID, state: "interrupted" };
    },
    eventStreamFetch(input: { afterSeq: number }) {
      return { url: `http://fake/events?afterSeq=${input.afterSeq}`, headers: {} };
    },
  };

  const host: HostLike = {
    rawClient: async () => fakeClient as unknown as never,
    refreshAuthForStream: async () => ({
      cookie: "councilkit_session=z",
      csrfToken: "c",
      origin: "http://127.0.0.1:43127",
    }),
  };

  const persist = async (_e: TerminalEvidence) => {
    counters.persist += 1;
    counters.log.push("persist");
    if (persistFails) throw new Error("persist boom");
  };

  let followCalls = 0;
  const follow = async (fopts: FollowEventsOptions): Promise<FollowOutcome> => {
    followCalls += 1;
    if (opts.hangUntilAbort) {
      const signal = fopts.signal;
      if (signal?.aborted) return { kind: "aborted", lastSeq: 0 };
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { kind: "aborted", lastSeq: 0 };
    }
    if (opts.reconnectOnce && followCalls === 1) {
      return { kind: "closed", lastSeq: 0 };
    }
    const terminal = opts.terminal ?? completedEvent(3, "hello");
    return { kind: "terminal", event: terminal };
  };

  return {
    host,
    follow,
    persist,
    setPersistFails: (v) => {
      persistFails = v;
    },
  };
}

function counters(): Counters {
  return { execute: 0, ack: 0, ackDisposition: [], cancel: 0, persist: 0, log: [] };
}

async function run(
  opts: FakeClientOptions,
  c: Counters,
  extra: { timeoutMs?: number; persist?: (e: TerminalEvidence) => Promise<void> } = {},
) {
  const fake = makeFake(opts, c);
  return executeTurn({
    host: fake.host,
    followEvents: fake.follow,
    scopeId: "scope-1",
    controller: CONTROLLER,
    participantId: PARTICIPANT_ID,
    executionId: EXECUTION_ID,
    snapshot: snapshot(),
    role: "message",
    timeoutMs: extra.timeoutMs ?? 5_000,
    persist: extra.persist ?? fake.persist,
  });
}

describe("cli execute-turn", () => {
  it("persists the completed output BEFORE the committed ACK", async () => {
    const c = counters();
    const res = await run({ terminal: completedEvent(3, "hello") }, c);
    expect(res.verdict).toBe("completed");
    expect(res.terminal?.output).toBe("hello");
    expect(c.execute).toBe(1);
    expect(c.persist).toBe(1);
    expect(c.ackDisposition).toEqual(["committed"]);
    // Order: persist appears before the committed ACK in the log.
    const persistIdx = c.log.indexOf("persist");
    const ackIdx = c.log.indexOf("ack:committed");
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    expect(ackIdx).toBeGreaterThan(persistIdx);
  });

  it("ACKs discarded on a failed terminal and keeps the failed verdict", async () => {
    const c = counters();
    const res = await run({ terminal: failedEvent(5, "DRIVER_CRASH") }, c);
    expect(res.verdict).toBe("failed");
    expect(c.ackDisposition).toEqual(["discarded"]);
    expect(c.persist).toBe(0);
    expect(res.error?.code).toBe("DRIVER_CRASH");
  });

  it("treats empty completed output as failed with a discarded ACK", async () => {
    const c = counters();
    const res = await run({ terminal: completedEvent(2, "   ") }, c);
    expect(res.verdict).toBe("failed");
    expect(c.ackDisposition).toEqual(["discarded"]);
    expect(res.error?.code).toBe("EMPTY_OUTPUT");
  });

  it("recovers a lost execute with an existing record WITHOUT re-dispatching", async () => {
    const c = counters();
    const res = await run(
      { executeThrows: "transport", probe: "dispatched", cancelInterrupts: true },
      c,
    );
    expect(c.execute).toBe(1); // never re-POSTed
    expect(c.cancel).toBe(1); // conservative cleanup ran
    expect(c.ackDisposition).toEqual(["discarded"]);
    expect(res.verdict).toBe("failed");
  });

  it("skips cleanup on a definitive 404 EXECUTION_NOT_FOUND (never dispatched)", async () => {
    const c = counters();
    const res = await run({ executeThrows: "transport", probe: "notDispatched" }, c);
    expect(c.execute).toBe(1);
    expect(c.cancel).toBe(0); // nothing to clean up
    expect(c.ack).toBe(0);
    expect(res.ack).toBe("skipped");
    expect(res.verdict).toBe("failed");
  });

  it("runs conservative cleanup on an unknown probe WITHOUT re-dispatching", async () => {
    const c = counters();
    const res = await run(
      { executeThrows: "transport", probe: "unknown", cancelInterrupts: true },
      c,
    );
    expect(c.execute).toBe(1);
    expect(c.cancel).toBe(1);
    expect(c.ackDisposition).toEqual(["discarded"]);
    expect(res.dispatchState).toBe("unknown");
    expect(res.verdict).toBe("failed");
  });

  it("reconnects via afterSeq after a non-terminal close and still completes with one execute", async () => {
    const c = counters();
    const res = await run(
      { reconnectOnce: true, terminal: completedEvent(3, "ok"), observeState: "running" },
      c,
    );
    expect(c.execute).toBe(1);
    expect(res.verdict).toBe("completed");
    expect(c.ackDisposition).toEqual(["committed"]);
  });

  it("surfaces a definitive ACK conflict as ACK_FAILED", async () => {
    const c = counters();
    const res = await run({ terminal: completedEvent(3, "hi"), ackState: "expired" }, c);
    expect(res.verdict).toBe("failed");
    expect(res.ack).toBe("conflict");
    expect(res.error?.code).toBe("ACK_FAILED");
  });

  it("cleans up on deadline timeout WITHOUT re-dispatching", async () => {
    const c = counters();
    const res = await run({ hangUntilAbort: true, cancelInterrupts: true }, c, { timeoutMs: 40 });
    expect(c.execute).toBe(1);
    expect(c.cancel).toBe(1);
    expect(res.verdict).toBe("timeout");
    expect(c.ackDisposition).toEqual(["discarded"]);
  });

  it("treats a persist failure as a commit-phase failure with a discarded ACK", async () => {
    const c = counters();
    const fake = makeFake({ terminal: completedEvent(3, "hi") }, c);
    fake.setPersistFails(true);
    const res = await executeTurn({
      host: fake.host,
      followEvents: fake.follow,
      scopeId: "scope-1",
      controller: CONTROLLER,
      participantId: PARTICIPANT_ID,
      executionId: EXECUTION_ID,
      snapshot: snapshot(),
      role: "report",
      timeoutMs: 5_000,
      persist: fake.persist,
    });
    expect(res.verdict).toBe("failed");
    expect(res.error?.phase).toBe("commit");
    expect(c.ackDisposition).toEqual(["discarded"]);
  });
});
