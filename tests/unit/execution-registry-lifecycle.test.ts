/**
 * ExecutionRegistry lifecycle, ACK tombstones, resume, and buffer pressure.
 * Fake timers pin every `at` / `createdAt` so assertions are exact literals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriverEvent } from "../../runtime-host/drivers/types";
import {
  type ExecutionRegistry,
  createExecutionRegistry,
} from "../../runtime-host/executions/execution-registry";
import type { Logger } from "../../runtime-host/logging";
import { LIMITS } from "../../shared/runtime/contracts";

const AT = "2026-10-14T00:00:00.000Z";
const originalLimit = LIMITS.executionBufferBytes;

const nullLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  diagnostic: () => undefined,
  diagnostics: () => [],
  recentProblems: () => [],
} as unknown as Logger;

function registry(): ExecutionRegistry {
  return createExecutionRegistry({ logger: nullLogger });
}

function setCap(bytes: number): void {
  (LIMITS as { executionBufferBytes: number }).executionBufferBytes = bytes;
}

function mustUnsub(value: (() => void) | null): () => void {
  if (value === null) throw new Error("expected an unsubscribe function");
  return value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(AT));
});

afterEach(() => {
  vi.useRealTimers();
  (LIMITS as { executionBufferBytes: number }).executionBufferBytes = originalLimit;
});

describe("ExecutionRegistry begin and get", () => {
  it("begin stores a running record and a second begin returns that same record", () => {
    const reg = registry();
    const first = reg.begin("exec-1", "p-1", "scope-1");
    expect(first).toEqual({
      created: true,
      record: {
        executionId: "exec-1",
        participantId: "p-1",
        scopeId: "scope-1",
        state: "running",
        events: [],
        lastSeq: 0,
        bufferedBytes: 0,
        ackState: "pending",
        disposition: null,
        tombstone: false,
        terminal: null,
        createdAt: AT,
      },
    });
    expect(reg.get("exec-1")).toBe(first.record);
    expect(reg.get("missing")).toBeNull();

    reg.emit("exec-1", { type: "output.delta", text: "hi" });
    const second = reg.begin("exec-1", "p-2", "scope-2");
    expect(second.created).toBe(false);
    expect(second.record).toBe(first.record);
    expect(second.record.participantId).toBe("p-1");
    expect(second.record.scopeId).toBe("scope-1");
    expect(second.record.lastSeq).toBe(1);
    expect(second.record.events).toEqual([
      {
        executionId: "exec-1",
        seq: 1,
        at: AT,
        type: "output.delta",
        text: "hi",
      },
    ]);
  });

  it("keeps an independent seq counter per execution id", () => {
    const reg = registry();
    reg.begin("exec-a", "p-1", "scope-1");
    reg.begin("exec-b", "p-2", "scope-1");
    expect(reg.emit("exec-a", { type: "output.delta", text: "a" })).toEqual({
      executionId: "exec-a",
      seq: 1,
      at: AT,
      type: "output.delta",
      text: "a",
    });
    expect(reg.emit("exec-b", { type: "output.delta", text: "b" })).toEqual({
      executionId: "exec-b",
      seq: 1,
      at: AT,
      type: "output.delta",
      text: "b",
    });
    expect(reg.emit("exec-a", { type: "output.delta", text: "a2" })).toEqual({
      executionId: "exec-a",
      seq: 2,
      at: AT,
      type: "output.delta",
      text: "a2",
    });
  });
});

describe("ExecutionRegistry event stream", () => {
  it("stamps seq, overwrites completed finalSeq, and counts utf-8 buffer bytes", () => {
    const reg = registry();
    reg.begin("exec-1", "p-1", "scope-1");
    const emitted = [
      reg.emit("exec-1", { type: "started", requestedModel: "grok-4" }),
      reg.emit("exec-1", { type: "output.delta", text: "hi" }),
      reg.emit("exec-1", { type: "activity", kind: "command", summary: "ls" }),
      reg.emit("exec-1", {
        type: "usage",
        usage: { inputTokens: 3, outputTokens: 4, costUsd: null },
      }),
      reg.emit("exec-1", { type: "output.snapshot", text: "full" }),
      reg.emit("exec-1", {
        type: "completed",
        output: "hi full",
        requestedModel: "grok-4",
        effectiveModel: "grok-4",
        modelVerdict: "match",
        toolState: "completed",
        dispatchState: "accepted",
        usage: { inputTokens: 3, outputTokens: 4, costUsd: null },
        finalSeq: 99,
      }),
    ];
    expect(emitted).toEqual([
      {
        executionId: "exec-1",
        seq: 1,
        at: AT,
        type: "started",
        requestedModel: "grok-4",
      },
      {
        executionId: "exec-1",
        seq: 2,
        at: AT,
        type: "output.delta",
        text: "hi",
      },
      {
        executionId: "exec-1",
        seq: 3,
        at: AT,
        type: "activity",
        kind: "command",
        summary: "ls",
      },
      {
        executionId: "exec-1",
        seq: 4,
        at: AT,
        type: "usage",
        usage: { inputTokens: 3, outputTokens: 4, costUsd: null },
      },
      {
        executionId: "exec-1",
        seq: 5,
        at: AT,
        type: "output.snapshot",
        text: "full",
      },
      {
        executionId: "exec-1",
        seq: 6,
        at: AT,
        type: "completed",
        output: "hi full",
        requestedModel: "grok-4",
        effectiveModel: "grok-4",
        modelVerdict: "match",
        toolState: "completed",
        dispatchState: "accepted",
        usage: { inputTokens: 3, outputTokens: 4, costUsd: null },
        finalSeq: 6,
      },
    ]);
    expect(reg.get("exec-1")).toEqual({
      executionId: "exec-1",
      participantId: "p-1",
      scopeId: "scope-1",
      state: "completed",
      events: emitted,
      lastSeq: 6,
      bufferedBytes: 858,
      ackState: "pending",
      disposition: null,
      tombstone: false,
      terminal: emitted[5],
      createdAt: AT,
    });
  });

  it("counts a quote and a newline by their escaped utf-8 json size", () => {
    const reg = registry();
    reg.begin("exec-esc", "p-1", "scope-1");
    expect(reg.emit("exec-esc", { type: "output.delta", text: 'a"b\n' })).toEqual({
      executionId: "exec-esc",
      seq: 1,
      at: AT,
      type: "output.delta",
      text: 'a"b\n',
    });
    expect(reg.get("exec-esc")?.bufferedBytes).toBe(104);
    expect(reg.get("exec-esc")?.lastSeq).toBe(1);
  });

  it("counts multibyte text with utf-8 json bytes", () => {
    const reg = registry();
    reg.begin("exec-utf", "p-1", "scope-1");
    expect(reg.emit("exec-utf", { type: "output.delta", text: "你好" })).toEqual({
      executionId: "exec-utf",
      seq: 1,
      at: AT,
      type: "output.delta",
      text: "你好",
    });
    expect(reg.get("exec-utf")?.bufferedBytes).toBe(104);
  });

  it("records failed and interrupted as those states", () => {
    const reg = registry();
    reg.begin("exec-fail", "p-1", "scope-1");
    reg.begin("exec-int", "p-2", "scope-1");
    const failed = reg.emit("exec-fail", {
      type: "failed",
      error: {
        code: "DRIVER_CRASH",
        phase: "stream",
        message: "boom",
        retryable: true,
      },
      dispatchState: "accepted",
      toolState: "active",
      retryable: false,
    });
    const interrupted = reg.emit("exec-int", {
      type: "interrupted",
      reason: "timeout",
      dispatchState: "unknown",
      toolState: "none",
    });
    expect(failed).toEqual({
      executionId: "exec-fail",
      seq: 1,
      at: AT,
      type: "failed",
      error: {
        code: "DRIVER_CRASH",
        phase: "stream",
        message: "boom",
        retryable: true,
      },
      dispatchState: "accepted",
      toolState: "active",
      retryable: false,
    });
    expect(interrupted).toEqual({
      executionId: "exec-int",
      seq: 1,
      at: AT,
      type: "interrupted",
      reason: "timeout",
      dispatchState: "unknown",
      toolState: "none",
    });
    expect(reg.get("exec-fail")?.state).toBe("failed");
    expect(reg.get("exec-fail")?.terminal).toEqual(failed);
    expect(reg.get("exec-fail")?.bufferedBytes).toBe(232);
    expect(reg.get("exec-int")?.state).toBe("interrupted");
    expect(reg.get("exec-int")?.terminal).toEqual(interrupted);
    expect(reg.get("exec-int")?.bufferedBytes).toBe(151);
    expect(reg.runningCount()).toBe(0);
  });

  it("turns an invalid driver event into one protocol-violation failure", () => {
    const reg = registry();
    reg.begin("exec-bad", "p-1", "scope-1");
    const seen: unknown[] = [];
    mustUnsub(
      reg.follow("exec-bad", 0, (event) => {
        seen.push(event);
      }),
    );
    const invalid = { type: "raw.stdout", text: "leak" } as unknown as DriverEvent;
    const fallback = {
      executionId: "exec-bad",
      seq: 1,
      at: AT,
      type: "failed" as const,
      error: {
        code: "PROTOCOL_VIOLATION" as const,
        phase: "stream" as const,
        message: "driver emitted an invalid event",
        retryable: false,
      },
      dispatchState: "unknown" as const,
      toolState: "unknown" as const,
      retryable: false,
    };
    expect(reg.emit("exec-bad", invalid)).toEqual(fallback);
    expect(seen).toEqual([fallback]);
    expect(reg.get("exec-bad")).toEqual({
      executionId: "exec-bad",
      participantId: "p-1",
      scopeId: "scope-1",
      state: "failed",
      events: [fallback],
      lastSeq: 1,
      bufferedBytes: 265,
      ackState: "pending",
      disposition: null,
      tombstone: false,
      terminal: fallback,
      createdAt: AT,
    });
  });

  it("accepts an activity summary of 256 chars and fails 257 as protocol violation", () => {
    const reg = registry();
    reg.begin("exec-bound", "p-1", "scope-1");
    const summary = "s".repeat(256);
    const activity = reg.emit("exec-bound", { type: "activity", kind: "other", summary });
    expect(activity).toEqual({
      executionId: "exec-bound",
      seq: 1,
      at: AT,
      type: "activity",
      kind: "other",
      summary,
    });
    const fallback = reg.emit("exec-bound", {
      type: "activity",
      kind: "other",
      summary: `${summary}x`,
    });
    expect(fallback).toEqual({
      executionId: "exec-bound",
      seq: 2,
      at: AT,
      type: "failed",
      error: {
        code: "PROTOCOL_VIOLATION",
        phase: "stream",
        message: "driver emitted an invalid event",
        retryable: false,
      },
      dispatchState: "unknown",
      toolState: "unknown",
      retryable: false,
    });
    expect(reg.get("exec-bound")?.events).toEqual([activity, fallback]);
    expect(reg.get("exec-bound")?.state).toBe("failed");
    expect(reg.get("exec-bound")?.bufferedBytes).toBe(637);
    expect(reg.get("exec-bound")?.lastSeq).toBe(2);
  });

  it("returns null when emit targets a missing execution", () => {
    const reg = registry();
    expect(reg.emit("missing", { type: "output.delta", text: "x" })).toBeNull();
    expect(reg.runningCount()).toBe(0);
    expect(reg.eventConnectionCount()).toBe(0);
  });
});

describe("ExecutionRegistry follow", () => {
  it("replays seq greater than afterSeq, then live events until unsubscribe", () => {
    const reg = registry();
    reg.begin("exec-resume", "p-1", "scope-1");
    reg.emit("exec-resume", { type: "output.delta", text: "a" });
    reg.emit("exec-resume", { type: "output.delta", text: "b" });
    reg.emit("exec-resume", { type: "output.delta", text: "c" });
    const texts: string[] = [];
    const unsubscribe = mustUnsub(
      reg.follow("exec-resume", 1, (event) => {
        if (event.type === "output.delta") texts.push(event.text);
      }),
    );
    expect(texts).toEqual(["b", "c"]);
    expect(reg.eventConnectionCount()).toBe(1);
    reg.emit("exec-resume", { type: "output.delta", text: "d" });
    expect(texts).toEqual(["b", "c", "d"]);
    unsubscribe();
    expect(reg.eventConnectionCount()).toBe(0);
    reg.emit("exec-resume", { type: "output.delta", text: "e" });
    expect(texts).toEqual(["b", "c", "d"]);
    expect(reg.get("exec-resume")?.events).toEqual([
      { executionId: "exec-resume", seq: 1, at: AT, type: "output.delta", text: "a" },
      { executionId: "exec-resume", seq: 2, at: AT, type: "output.delta", text: "b" },
      { executionId: "exec-resume", seq: 3, at: AT, type: "output.delta", text: "c" },
      { executionId: "exec-resume", seq: 4, at: AT, type: "output.delta", text: "d" },
      { executionId: "exec-resume", seq: 5, at: AT, type: "output.delta", text: "e" },
    ]);
  });

  it("returns null for an unknown execution and does not add a connection", () => {
    const reg = registry();
    expect(reg.follow("missing", 0, () => undefined)).toBeNull();
    expect(reg.eventConnectionCount()).toBe(0);
  });

  it("replays a terminal execution and does not deliver events emitted after follow", () => {
    const reg = registry();
    reg.begin("exec-term-follow", "p-1", "scope-1");
    reg.emit("exec-term-follow", { type: "output.delta", text: "a" });
    reg.emit("exec-term-follow", {
      type: "interrupted",
      reason: "user_cancelled",
      dispatchState: "accepted",
      toolState: "none",
    });
    const seqs: number[] = [];
    const unsubscribe = mustUnsub(
      reg.follow("exec-term-follow", 0, (event) => {
        seqs.push(event.seq);
      }),
    );
    expect(seqs).toEqual([1, 2]);
    expect(reg.eventConnectionCount()).toBe(0);
    unsubscribe();
    expect(reg.eventConnectionCount()).toBe(0);
    expect(reg.emit("exec-term-follow", { type: "output.delta", text: "late" })).toEqual({
      executionId: "exec-term-follow",
      seq: 3,
      at: AT,
      type: "output.delta",
      text: "late",
    });
    expect(seqs).toEqual([1, 2]);
    expect(reg.get("exec-term-follow")?.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(reg.get("exec-term-follow")?.state).toBe("interrupted");
    expect(reg.eventConnectionCount()).toBe(0);
  });

  it("keeps delivering to a listener that subscribed before the terminal event", () => {
    const reg = registry();
    reg.begin("exec-live-term", "p-1", "scope-1");
    const seqs: number[] = [];
    mustUnsub(
      reg.follow("exec-live-term", 0, (event) => {
        seqs.push(event.seq);
      }),
    );
    reg.emit("exec-live-term", { type: "output.delta", text: "a" });
    reg.emit("exec-live-term", {
      type: "completed",
      output: "a",
      requestedModel: "m",
      effectiveModel: null,
      modelVerdict: "unknown",
      toolState: "none",
      dispatchState: "accepted",
      usage: null,
      finalSeq: 1,
    });
    expect(seqs).toEqual([1, 2]);
    expect(reg.eventConnectionCount()).toBe(1);
    expect(reg.get("exec-live-term")?.terminal).toEqual({
      executionId: "exec-live-term",
      seq: 2,
      at: AT,
      type: "completed",
      output: "a",
      requestedModel: "m",
      effectiveModel: null,
      modelVerdict: "unknown",
      toolState: "none",
      dispatchState: "accepted",
      usage: null,
      finalSeq: 2,
    });
  });
});

describe("ExecutionRegistry listeners", () => {
  it("isolates a throwing listener from the execution and from other listeners", () => {
    const reg = registry();
    reg.begin("exec-throw", "p-1", "scope-1");
    const good: number[] = [];
    mustUnsub(
      reg.follow("exec-throw", 0, () => {
        throw new Error("listener-broke");
      }),
    );
    mustUnsub(
      reg.follow("exec-throw", 0, (event) => {
        good.push(event.seq);
      }),
    );
    expect(reg.emit("exec-throw", { type: "output.delta", text: "z" })).toEqual({
      executionId: "exec-throw",
      seq: 1,
      at: AT,
      type: "output.delta",
      text: "z",
    });
    expect(good).toEqual([1]);
    expect(reg.get("exec-throw")?.events).toEqual([
      { executionId: "exec-throw", seq: 1, at: AT, type: "output.delta", text: "z" },
    ]);
    expect(reg.get("exec-throw")?.state).toBe("running");
    expect(reg.eventConnectionCount()).toBe(2);
    expect(reg.emit("exec-throw", { type: "output.delta", text: "y" })).toEqual({
      executionId: "exec-throw",
      seq: 2,
      at: AT,
      type: "output.delta",
      text: "y",
    });
    expect(good).toEqual([1, 2]);
  });

  it("delivers to every listener copied before an unsubscribe inside notify", () => {
    const reg = registry();
    reg.begin("exec-unsub", "p-1", "scope-1");
    const order: string[] = [];
    let unsubB: () => void = () => undefined;
    const unsubA = mustUnsub(
      reg.follow("exec-unsub", 0, () => {
        order.push("a");
        unsubA();
        unsubB();
      }),
    );
    unsubB = mustUnsub(
      reg.follow("exec-unsub", 0, () => {
        order.push("b");
      }),
    );
    reg.emit("exec-unsub", { type: "output.delta", text: "z" });
    expect(order).toEqual(["a", "b"]);
    expect(reg.eventConnectionCount()).toBe(0);
    reg.emit("exec-unsub", { type: "output.delta", text: "later" });
    expect(order).toEqual(["a", "b"]);
    expect(reg.get("exec-unsub")?.lastSeq).toBe(2);
  });

  it("replay isolates listener emits from the in-progress replay", () => {
    const reg = registry();
    reg.begin("exec-reenter", "p-1", "scope-1");
    reg.emit("exec-reenter", { type: "output.delta", text: "first" });
    const seqs: number[] = [];
    reg.follow("exec-reenter", 0, (event) => {
      seqs.push(event.seq);
      if (event.seq === 1) {
        reg.emit("exec-reenter", { type: "output.delta", text: "second" });
      }
    });
    expect(seqs).toEqual([1]);
    expect(reg.get("exec-reenter")?.events.map((event) => event.seq)).toEqual([1, 2]);
  });
});

describe("ExecutionRegistry ack", () => {
  it("returns expired for an unknown execution and does not create one", () => {
    const reg = registry();
    expect(reg.ack("ghost", 1, "committed")).toEqual({
      outcome: "expired",
      disposition: null,
    });
    expect(reg.get("ghost")).toBeNull();
    expect(reg.runningCount()).toBe(0);
  });

  it("conflicts until finalSeq matches, then committed repeats stay acknowledged", () => {
    const reg = registry();
    reg.begin("exec-ack", "p-1", "scope-1");
    reg.emit("exec-ack", { type: "output.delta", text: "hi" });
    expect(reg.ack("exec-ack", 1, "committed")).toEqual({
      outcome: "conflict",
      disposition: null,
      error: {
        code: "EXECUTION_CONFLICT",
        phase: "commit",
        message: "ACK before a terminal event.",
        retryable: false,
        executionId: "exec-ack",
      },
    });
    expect(reg.get("exec-ack")?.ackState).toBe("pending");
    expect(reg.get("exec-ack")?.tombstone).toBe(false);
    expect(reg.get("exec-ack")?.events.map((event) => event.seq)).toEqual([1]);

    const completed = reg.emit("exec-ack", {
      type: "completed",
      output: "hi",
      requestedModel: "grok-4",
      effectiveModel: "grok-4",
      modelVerdict: "match",
      toolState: "none",
      dispatchState: "accepted",
      usage: null,
      finalSeq: 50,
    });
    expect(completed).toEqual({
      executionId: "exec-ack",
      seq: 2,
      at: AT,
      type: "completed",
      output: "hi",
      requestedModel: "grok-4",
      effectiveModel: "grok-4",
      modelVerdict: "match",
      toolState: "none",
      dispatchState: "accepted",
      usage: null,
      finalSeq: 2,
    });
    expect(reg.ack("exec-ack", 1, "committed")).toEqual({
      outcome: "conflict",
      disposition: null,
      error: {
        code: "EXECUTION_CONFLICT",
        phase: "commit",
        message: "ACK finalSeq does not match the terminal event.",
        retryable: false,
        executionId: "exec-ack",
      },
    });
    expect(reg.get("exec-ack")?.tombstone).toBe(false);
    expect(reg.get("exec-ack")?.bufferedBytes).toBe(346);

    const seen: number[] = [];
    mustUnsub(
      reg.follow("exec-ack", 0, (event) => {
        seen.push(event.seq);
      }),
    );
    expect(seen).toEqual([1, 2]);
    expect(reg.eventConnectionCount()).toBe(0);

    expect(reg.ack("exec-ack", 2, "committed")).toEqual({
      outcome: "acknowledged",
      disposition: "committed",
    });
    expect(reg.get("exec-ack")).toEqual({
      executionId: "exec-ack",
      participantId: "p-1",
      scopeId: "scope-1",
      state: "completed",
      events: [],
      lastSeq: 2,
      bufferedBytes: 0,
      ackState: "acknowledged",
      disposition: "committed",
      tombstone: true,
      terminal: completed,
      createdAt: AT,
    });
    expect(reg.ack("exec-ack", 0, "committed")).toEqual({
      outcome: "acknowledged",
      disposition: "committed",
    });
    expect(reg.ack("exec-ack", 2, "discarded")).toEqual({
      outcome: "conflict",
      disposition: "committed",
      error: {
        code: "EXECUTION_CONFLICT",
        phase: "commit",
        message: "ACK disposition differs from the recorded terminal disposition.",
        retryable: false,
        executionId: "exec-ack",
      },
    });
    expect(reg.get("exec-ack")?.disposition).toBe("committed");
    expect(reg.emit("exec-ack", { type: "output.delta", text: "after" })).toBeNull();
    expect(reg.get("exec-ack")?.events).toEqual([]);
    expect(reg.get("exec-ack")?.lastSeq).toBe(2);

    const afterAck: number[] = [];
    const unsub = mustUnsub(
      reg.follow("exec-ack", 0, (event) => {
        afterAck.push(event.seq);
      }),
    );
    expect(afterAck).toEqual([]);
    expect(reg.eventConnectionCount()).toBe(0);
    unsub();
    expect(reg.eventConnectionCount()).toBe(0);
  });

  it("acknowledges a discarded interrupt and conflicts on a later committed ack", () => {
    const reg = registry();
    reg.begin("exec-discard", "p-1", "scope-1");
    const interrupted = reg.emit("exec-discard", {
      type: "interrupted",
      reason: "host_shutdown",
      dispatchState: "not_dispatched",
      toolState: "none",
    });
    expect(interrupted).toEqual({
      executionId: "exec-discard",
      seq: 1,
      at: AT,
      type: "interrupted",
      reason: "host_shutdown",
      dispatchState: "not_dispatched",
      toolState: "none",
    });
    expect(reg.ack("exec-discard", 1, "discarded")).toEqual({
      outcome: "acknowledged",
      disposition: "discarded",
    });
    expect(reg.get("exec-discard")?.events).toEqual([]);
    expect(reg.get("exec-discard")?.bufferedBytes).toBe(0);
    expect(reg.get("exec-discard")?.tombstone).toBe(true);
    expect(reg.get("exec-discard")?.terminal).toEqual(interrupted);
    expect(reg.ack("exec-discard", 1, "discarded")).toEqual({
      outcome: "acknowledged",
      disposition: "discarded",
    });
    expect(reg.ack("exec-discard", 1, "committed")).toEqual({
      outcome: "conflict",
      disposition: "discarded",
      error: {
        code: "EXECUTION_CONFLICT",
        phase: "commit",
        message: "ACK disposition differs from the recorded terminal disposition.",
        retryable: false,
        executionId: "exec-discard",
      },
    });
  });

  it("acknowledges a failed execution at the failed event seq", () => {
    const reg = registry();
    reg.begin("exec-fail-ack", "p-1", "scope-1");
    reg.emit("exec-fail-ack", {
      type: "failed",
      error: {
        code: "EMPTY_OUTPUT",
        phase: "stream",
        message: "empty",
        retryable: false,
      },
      dispatchState: "accepted",
      toolState: "completed",
      retryable: false,
    });
    expect(reg.ack("exec-fail-ack", 4, "committed")).toEqual({
      outcome: "conflict",
      disposition: null,
      error: {
        code: "EXECUTION_CONFLICT",
        phase: "commit",
        message: "ACK finalSeq does not match the terminal event.",
        retryable: false,
        executionId: "exec-fail-ack",
      },
    });
    expect(reg.ack("exec-fail-ack", 1, "committed")).toEqual({
      outcome: "acknowledged",
      disposition: "committed",
    });
    expect(reg.get("exec-fail-ack")?.state).toBe("failed");
    expect(reg.get("exec-fail-ack")?.events).toEqual([]);
    expect(reg.runningCount()).toBe(0);
  });
});

describe("ExecutionRegistry counts, releaseScope, and reset", () => {
  it("counts only running executions and every live listener", () => {
    const reg = registry();
    reg.begin("exec-run", "p-1", "scope-1");
    reg.begin("exec-done", "p-2", "scope-1");
    reg.begin("exec-stop", "p-3", "scope-1");
    expect(reg.runningCount()).toBe(3);
    reg.emit("exec-done", {
      type: "completed",
      output: "ok",
      requestedModel: "m",
      effectiveModel: "m",
      modelVerdict: "match",
      toolState: "none",
      dispatchState: "accepted",
      usage: null,
      finalSeq: 1,
    });
    reg.emit("exec-stop", {
      type: "failed",
      error: {
        code: "CANCELLED",
        phase: "cancel",
        message: "stop",
        retryable: false,
      },
      dispatchState: "unknown",
      toolState: "unknown",
      retryable: false,
    });
    expect(reg.runningCount()).toBe(1);
    const unsubRunA = mustUnsub(reg.follow("exec-run", 0, () => undefined));
    mustUnsub(reg.follow("exec-run", 0, () => undefined));
    const unsubStop = mustUnsub(reg.follow("exec-stop", 0, () => undefined));
    expect(reg.eventConnectionCount()).toBe(2);
    unsubStop();
    expect(reg.eventConnectionCount()).toBe(2);
    unsubRunA();
    expect(reg.eventConnectionCount()).toBe(1);
    expect(reg.runningCount()).toBe(1);
  });

  it("releaseScope drops only that scope's records and listeners", () => {
    const reg = registry();
    reg.begin("exec-s1a", "p-1", "scope-1");
    reg.begin("exec-s1b", "p-2", "scope-1");
    reg.begin("exec-s2", "p-3", "scope-2");
    reg.emit("exec-s2", { type: "output.delta", text: "keep" });
    mustUnsub(reg.follow("exec-s1a", 0, () => undefined));
    mustUnsub(reg.follow("exec-s2", 0, () => undefined));
    expect(reg.runningCount()).toBe(3);
    expect(reg.eventConnectionCount()).toBe(2);

    reg.releaseScope("scope-missing");
    expect(reg.get("exec-s2")?.events).toEqual([
      { executionId: "exec-s2", seq: 1, at: AT, type: "output.delta", text: "keep" },
    ]);

    reg.releaseScope("scope-1");
    expect(reg.get("exec-s1a")).toBeNull();
    expect(reg.get("exec-s1b")).toBeNull();
    expect(reg.get("exec-s2")?.lastSeq).toBe(1);
    expect(reg.runningCount()).toBe(1);
    expect(reg.eventConnectionCount()).toBe(1);
    expect(reg.ack("exec-s1a", 1, "committed")).toEqual({
      outcome: "expired",
      disposition: null,
    });
    expect(reg.follow("exec-s1a", 0, () => undefined)).toBeNull();

    const reborn = reg.begin("exec-s1a", "p-9", "scope-1");
    expect(reborn.created).toBe(true);
    expect(reborn.record.lastSeq).toBe(0);
    expect(reborn.record.participantId).toBe("p-9");
    expect(reborn.record.events).toEqual([]);
    expect(reg.runningCount()).toBe(2);
  });

  it("reset clears records and listeners so a re-begin does not notify old followers", () => {
    const reg = registry();
    reg.begin("exec-reset", "p-1", "scope-1");
    reg.begin("exec-other", "p-2", "scope-2");
    const seen: number[] = [];
    mustUnsub(
      reg.follow("exec-reset", 0, (event) => {
        seen.push(event.seq);
      }),
    );
    reg.emit("exec-reset", { type: "output.delta", text: "before" });
    expect(seen).toEqual([1]);
    reg.reset();
    expect(reg.get("exec-reset")).toBeNull();
    expect(reg.get("exec-other")).toBeNull();
    expect(reg.runningCount()).toBe(0);
    expect(reg.eventConnectionCount()).toBe(0);
    reg.reset();
    reg.begin("exec-reset", "p-1", "scope-1");
    reg.emit("exec-reset", { type: "output.delta", text: "after" });
    expect(seen).toEqual([1]);
    expect(reg.get("exec-reset")?.events).toEqual([
      { executionId: "exec-reset", seq: 1, at: AT, type: "output.delta", text: "after" },
    ]);
    expect(reg.runningCount()).toBe(1);
  });
});

describe("ExecutionRegistry buffer pressure", () => {
  it("keeps an event that lands exactly on the cap", () => {
    setCap(128);
    const reg = registry();
    reg.begin("exec-fit", "p-1", "scope-1");
    const text = "Q".repeat(30);
    expect(reg.emit("exec-fit", { type: "output.delta", text })).toEqual({
      executionId: "exec-fit",
      seq: 1,
      at: AT,
      type: "output.delta",
      text,
    });
    expect(reg.get("exec-fit")?.bufferedBytes).toBe(128);
    expect(reg.get("exec-fit")?.events).toEqual([
      { executionId: "exec-fit", seq: 1, at: AT, type: "output.delta", text },
    ]);
  });

  it("coalesces buffered deltas into one snapshot placed at the first delta", () => {
    // Cap 500: activity + two 40-char deltas fit (390); the third delta
    // (138 bytes, total 528) coalesces the two deltas into a snapshot at seq 2
    // and still fits (433).
    setCap(500);
    const reg = registry();
    reg.begin("exec-mid", "p-1", "scope-1");
    reg.emit("exec-mid", { type: "activity", kind: "tool", summary: "pre" });
    reg.emit("exec-mid", { type: "output.delta", text: "A".repeat(40) });
    reg.emit("exec-mid", { type: "output.delta", text: "B".repeat(40) });
    reg.emit("exec-mid", { type: "output.delta", text: "C".repeat(40) });
    expect(reg.get("exec-mid")?.events).toEqual([
      {
        executionId: "exec-mid",
        seq: 1,
        at: AT,
        type: "activity",
        kind: "tool",
        summary: "pre",
      },
      {
        executionId: "exec-mid",
        seq: 2,
        at: AT,
        type: "output.snapshot",
        text: `${"A".repeat(40)}${"B".repeat(40)}`,
      },
      {
        executionId: "exec-mid",
        seq: 4,
        at: AT,
        type: "output.delta",
        text: "C".repeat(40),
      },
    ]);
    expect(reg.get("exec-mid")?.lastSeq).toBe(4);
    expect(reg.get("exec-mid")?.bufferedBytes).toBe(433);
    const replay: number[] = [];
    reg.follow("exec-mid", 0, (event) => {
      replay.push(event.seq);
    });
    expect(replay).toEqual([1, 2, 4]);
  });

  it("concatenates an existing snapshot with later deltas on a second coalesce", () => {
    // Cap 700. Three 50-char deltas + activity = 576. The next 50-char delta
    // coalesces those deltas (snapshot seq 1) and is kept. A later 50-char
    // delta coalesces that snapshot with the kept delta and is kept too.
    setCap(700);
    const reg = registry();
    const id = "exec-coalesce";
    reg.begin(id, "p-1", "scope-1");
    reg.emit(id, { type: "output.delta", text: "A".repeat(50) });
    reg.emit(id, { type: "output.delta", text: "B".repeat(50) });
    reg.emit(id, { type: "output.delta", text: "D".repeat(50) });
    reg.emit(id, { type: "activity", kind: "tool", summary: "t" });
    reg.emit(id, { type: "output.delta", text: "C".repeat(50) });
    reg.emit(id, { type: "activity", kind: "tool", summary: "end" });
    reg.emit(id, { type: "output.delta", text: "E".repeat(50) });
    expect(reg.get(id)?.events).toEqual([
      {
        executionId: id,
        seq: 1,
        at: AT,
        type: "output.snapshot",
        text: `${"A".repeat(50)}${"B".repeat(50)}${"D".repeat(50)}${"C".repeat(50)}`,
      },
      {
        executionId: id,
        seq: 4,
        at: AT,
        type: "activity",
        kind: "tool",
        summary: "t",
      },
      {
        executionId: id,
        seq: 6,
        at: AT,
        type: "activity",
        kind: "tool",
        summary: "end",
      },
      {
        executionId: id,
        seq: 7,
        at: AT,
        type: "output.delta",
        text: "E".repeat(50),
      },
    ]);
    expect(reg.get(id)?.lastSeq).toBe(7);
    expect(reg.get(id)?.bufferedBytes).toBe(695);
    expect(reg.get(id)?.state).toBe("running");
  });

  it("drops a delta that still does not fit after coalesce and skips its seq in storage", () => {
    // Cap 600. One 50-char delta is 149 bytes. A 400-char delta coalesces it
    // into a 152-byte snapshot and still does not fit (651), so it is dropped.
    // The next 10-char delta is seq 3.
    setCap(600);
    const reg = registry();
    const id = "exec-drop";
    reg.begin(id, "p-1", "scope-1");
    reg.emit(id, { type: "output.delta", text: "A".repeat(50) });
    const live: number[] = [];
    mustUnsub(
      reg.follow(id, 1, (event) => {
        live.push(event.seq);
      }),
    );
    expect(reg.emit(id, { type: "output.delta", text: "B".repeat(400) })).toEqual({
      executionId: id,
      seq: 2,
      at: AT,
      type: "output.delta",
      text: "B".repeat(400),
    });
    expect(reg.emit(id, { type: "output.delta", text: "C".repeat(10) })).toEqual({
      executionId: id,
      seq: 3,
      at: AT,
      type: "output.delta",
      text: "C".repeat(10),
    });
    expect(live).toEqual([2, 3]);
    expect(reg.get(id)?.events).toEqual([
      {
        executionId: id,
        seq: 1,
        at: AT,
        type: "output.snapshot",
        text: "A".repeat(50),
      },
      {
        executionId: id,
        seq: 3,
        at: AT,
        type: "output.delta",
        text: "C".repeat(10),
      },
    ]);
    expect(reg.get(id)?.lastSeq).toBe(3);
    expect(reg.get(id)?.bufferedBytes).toBe(261);
  });

  it("drops a non-delta that does not fit when the buffer holds no preview text", () => {
    // Two activities are 118 bytes each. Cap 200 keeps the first and drops
    // the second without inserting a snapshot.
    setCap(200);
    const reg = registry();
    const id = "exec-nodelta";
    reg.begin(id, "p-1", "scope-1");
    reg.emit(id, { type: "activity", kind: "tool", summary: "one" });
    expect(reg.emit(id, { type: "activity", kind: "tool", summary: "two" })).toEqual({
      executionId: id,
      seq: 2,
      at: AT,
      type: "activity",
      kind: "tool",
      summary: "two",
    });
    expect(reg.get(id)?.events).toEqual([
      {
        executionId: id,
        seq: 1,
        at: AT,
        type: "activity",
        kind: "tool",
        summary: "one",
      },
    ]);
    expect(reg.get(id)?.lastSeq).toBe(2);
    expect(reg.get(id)?.bufferedBytes).toBe(118);
    // No preview was stored, so a later delta cannot shrink the buffer either.
    expect(reg.emit(id, { type: "output.delta", text: "z" })).toEqual({
      executionId: id,
      seq: 3,
      at: AT,
      type: "output.delta",
      text: "z",
    });
    expect(reg.get(id)?.events).toEqual([
      {
        executionId: id,
        seq: 1,
        at: AT,
        type: "activity",
        kind: "tool",
        summary: "one",
      },
    ]);
    expect(reg.get(id)?.lastSeq).toBe(3);
    expect(reg.get(id)?.bufferedBytes).toBe(118);
  });

  it("drops the first event when it alone exceeds the cap and leaves the buffer empty", () => {
    setCap(100);
    const reg = registry();
    const id = "exec-over";
    reg.begin(id, "p-1", "scope-1");
    const seen: string[] = [];
    mustUnsub(
      reg.follow(id, 0, (event) => {
        if (event.type === "output.delta") seen.push(event.text);
      }),
    );
    const text = "Q".repeat(30);
    expect(reg.emit(id, { type: "output.delta", text })).toEqual({
      executionId: id,
      seq: 1,
      at: AT,
      type: "output.delta",
      text,
    });
    expect(seen).toEqual([text]);
    expect(reg.get(id)?.events).toEqual([]);
    expect(reg.get(id)?.bufferedBytes).toBe(0);
    expect(reg.get(id)?.lastSeq).toBe(1);
    expect(reg.emit(id, { type: "output.delta", text: "n" })).toEqual({
      executionId: id,
      seq: 2,
      at: AT,
      type: "output.delta",
      text: "n",
    });
    expect(reg.get(id)?.events).toEqual([
      { executionId: id, seq: 2, at: AT, type: "output.delta", text: "n" },
    ]);
    expect(reg.get(id)?.bufferedBytes).toBe(100);
    expect(reg.get(id)?.lastSeq).toBe(2);
  });

  it("stores a terminal event whole when it exceeds the cap", () => {
    setCap(200);
    const reg = registry();
    const id = "exec-term";
    reg.begin(id, "p-1", "scope-1");
    reg.emit(id, { type: "output.delta", text: "A".repeat(50) });
    const output = "Z".repeat(80);
    const completed = reg.emit(id, {
      type: "completed",
      output,
      requestedModel: "m",
      effectiveModel: null,
      modelVerdict: "unknown",
      toolState: "none",
      dispatchState: "accepted",
      usage: null,
      finalSeq: 99,
    });
    expect(completed).toEqual({
      executionId: id,
      seq: 2,
      at: AT,
      type: "completed",
      output,
      requestedModel: "m",
      effectiveModel: null,
      modelVerdict: "unknown",
      toolState: "none",
      dispatchState: "accepted",
      usage: null,
      finalSeq: 2,
    });
    expect(reg.get(id)?.events).toEqual([
      { executionId: id, seq: 1, at: AT, type: "output.delta", text: "A".repeat(50) },
      completed,
    ]);
    expect(reg.get(id)?.bufferedBytes).toBe(467);
    expect(reg.get(id)?.state).toBe("completed");
    expect(reg.get(id)?.terminal).toBe(completed);
  });
});
