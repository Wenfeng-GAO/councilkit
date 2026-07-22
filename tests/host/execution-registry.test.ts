import type { DriverEvent } from "@host/drivers/types";
import { createExecutionRegistry } from "@host/executions/execution-registry";
import type { Logger } from "@host/logging";
import { LIMITS } from "@shared/runtime/contracts";
import type { RuntimeEvent } from "@shared/runtime/events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * CK-001: ExecutionRegistry.bufferEvent coalesces buffered output.delta /
 * output.snapshot into one consolidated output.snapshot (seq = firstDeltaSeq)
 * when the buffer cap is exceeded. The consolidated snapshot must be spliced
 * at the first replaced delta's position (preserving seq order in storage),
 * so follow(id, afterSeq) replays events in monotonically increasing seq.
 *
 * These tests call createExecutionRegistry({ logger }).emit/follow directly —
 * no scope-manager / HTTP / FakeDriver — and temporarily lower
 * LIMITS.executionBufferBytes to deterministically trigger coalescing.
 *
 * Calibration note: coalescing one delta into a snapshot saves ~0 bytes
 * (snapshot type name is 3 bytes longer), so a single buffered delta cannot
 * make room for the incoming delta — the drop gate (L114) rejects it. To
 * deterministically trigger coalesce AND have the new delta survive, we buffer
 * two+ deltas before the triggering emit so coalescing saves ~one event
 * envelope (~100 bytes), opening a window for the new delta to fit.
 */

const nullLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  diagnostic: () => undefined,
} as unknown as Logger;

const driverDelta = (text: string): DriverEvent => ({ type: "output.delta", text });
const driverActivity = (summary: string): DriverEvent => ({
  type: "activity",
  kind: "tool",
  summary,
});
const driverUsage = (): DriverEvent => ({
  type: "usage",
  usage: { inputTokens: 1, outputTokens: 2, costUsd: null },
});

const collectReplay = (
  reg: ReturnType<typeof createExecutionRegistry>,
  id: string,
  afterSeq: number,
): RuntimeEvent[] => {
  const seen: RuntimeEvent[] = [];
  reg.follow(id, afterSeq, (e) => seen.push(e));
  return seen;
};

let originalLimit: number;

beforeEach(() => {
  originalLimit = LIMITS.executionBufferBytes;
});

afterEach(() => {
  (LIMITS as { executionBufferBytes: number }).executionBufferBytes = originalLimit;
});

describe("ExecutionRegistry coalescing seq order (CK-001)", () => {
  it("TC1: coalescing keeps replay in non-decreasing seq order", () => {
    // Lower the cap so the 5th emit (delta) triggers coalescing after
    // two deltas + one activity are buffered. Calibrated so coalesce
    // saves enough room for the triggering delta to survive the drop gate.
    (LIMITS as { executionBufferBytes: number }).executionBufferBytes = 700;
    const reg = createExecutionRegistry({ logger: nullLogger });
    const id = "exec-coalesce-tc1";
    reg.begin(id, "p-1", "scope-1");

    // seq1: delta — buffered
    // seq2: delta — buffered
    // seq3: delta — buffered
    // seq4: activity — buffered (non-delta, kept through coalesce)
    // seq5: delta — triggers coalesce; consolidated snapshot seq=1; delta survives
    // seq6: activity — normal append after coalesce
    reg.emit(id, driverDelta("A".repeat(50))); // seq1
    reg.emit(id, driverDelta("B".repeat(50))); // seq2
    reg.emit(id, driverDelta("D".repeat(50))); // seq3
    reg.emit(id, driverActivity("t")); // seq4
    reg.emit(id, driverDelta("C".repeat(50))); // seq5 -> coalesce, snapshot seq=1
    reg.emit(id, driverActivity("end")); // seq6

    const record = reg.get(id);
    expect(record).toBeDefined();
    const events = record?.events ?? [];

    // The consolidated output.snapshot (seq=1) must exist.
    const snapshot = events.find((e) => e.type === "output.snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot?.seq).toBe(1);

    // follow(id, 0) must replay in non-decreasing seq order.
    const seen = collectReplay(reg, id, 0);
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].seq).toBeGreaterThanOrEqual(seen[i - 1].seq);
    }

    // Consolidated snapshot must precede every event with seq > 1.
    const snapshotIdx = seen.findIndex((e) => e.type === "output.snapshot");
    expect(snapshotIdx).toBeGreaterThanOrEqual(0);
    for (let i = snapshotIdx + 1; i < seen.length; i++) {
      expect(seen[i].seq).toBeGreaterThan(1);
    }
  });

  it("TC2: afterSeq replays only strictly-greater seqs", () => {
    (LIMITS as { executionBufferBytes: number }).executionBufferBytes = 700;
    const reg = createExecutionRegistry({ logger: nullLogger });
    const id = "exec-coalesce-tc2";
    reg.begin(id, "p-1", "scope-1");

    reg.emit(id, driverDelta("A".repeat(50))); // seq1
    reg.emit(id, driverDelta("B".repeat(50))); // seq2
    reg.emit(id, driverDelta("D".repeat(50))); // seq3
    reg.emit(id, driverActivity("t")); // seq4
    reg.emit(id, driverDelta("C".repeat(50))); // seq5 -> coalesce, snapshot seq=1

    // follow(id, 1) replays only events with seq > 1, in increasing order.
    const seen = collectReplay(reg, id, 1);
    expect(seen.length).toBeGreaterThan(0);
    for (const e of seen) {
      expect(e.seq).toBeGreaterThan(1);
      expect(e.type).not.toBe("output.snapshot");
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].seq).toBeGreaterThan(seen[i - 1].seq);
    }
  });

  it("TC3: regression — common path without coalescing replays seqs [1..4]", () => {
    // No cap override (default 32MiB); all events tiny -> no coalescing.
    const reg = createExecutionRegistry({ logger: nullLogger });
    const id = "exec-coalesce-tc3";
    reg.begin(id, "p-1", "scope-1");

    reg.emit(id, driverDelta("hello")); // seq1
    reg.emit(id, driverActivity("ran-tool")); // seq2
    reg.emit(id, driverDelta("world")); // seq3
    reg.emit(id, driverUsage()); // seq4

    const seen = collectReplay(reg, id, 0);
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(seen.some((e) => e.type === "output.snapshot")).toBe(false);
  });
});
