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

/**
 * CK-002: bufferEvent's post-coalesce drop gate returned BEFORE advancing
 * record.lastSeq, while emit allocates seq = record.lastSeq + 1 BEFORE calling
 * bufferEvent. So a dropped event already consumed a seq, notify() delivered it
 * to live follow() listeners, but lastSeq was unchanged — the next emit
 * recomputed seq = oldLastSeq + 1 = the SAME seq, delivering a duplicate seq to
 * live listeners. Fix: advance record.lastSeq = event.seq on the drop path too.
 *
 * Calibration: a single buffered delta coalesces into a snapshot saving ~0
 * bytes (snapshot type name is 3 bytes longer), so cap=600 + delta(A*50) (~151B,
 * seq1) + delta(B*400) (~501B, seq2) triggers coalesce (652>600) and then
 * post-coalesce drop (154+501=655>600). Delta seq2 is dropped; with the fix
 * lastSeq becomes 2, so the next small delta gets seq=3 (strictly increasing).
 */
describe("ExecutionRegistry post-coalesce drop path seq (CK-002)", () => {
  it("TC4: dropped event's seq is not reused — live listener sees strictly increasing seqs", () => {
    // cap calibrated so coalesce fires AND the post-coalesce drop gate fires.
    (LIMITS as { executionBufferBytes: number }).executionBufferBytes = 600;
    const reg = createExecutionRegistry({ logger: nullLogger });
    const id = "exec-ck002-tc4";
    reg.begin(id, "p-1", "scope-1");

    // seq1: small delta — buffered (lastSeq becomes 1).
    reg.emit(id, driverDelta("A".repeat(50))); // seq1, buffered
    const record0 = reg.get(id);
    expect(record0?.lastSeq).toBe(1);

    // Attach a live listener with afterSeq = current lastSeq (1). follow()
    // replays stored events with seq > 1 (none — only seq1 is stored), then
    // adds the listener to the live set so it captures ONLY subsequent notify()
    // firings (the dropped seq2 and the retained seq3), not pre-stored replay.
    const liveSeqs: number[] = [];
    const unsub = reg.follow(id, 1, (e) => {
      liveSeqs.push(e.seq);
    });
    expect(unsub).not.toBeNull();
    // seq2: large delta — triggers coalesce (seq1 delta -> snapshot seq=1),
    // then post-coalesce drop (coalescedBytes154 + 501 > 600) drops seq2.
    const dropped = reg.emit(id, driverDelta("B".repeat(400)));
    expect(dropped).not.toBeNull();
    expect(dropped?.seq).toBe(2);

    // seq3: small delta — retained (lastSeq+1 = 3 with the fix).
    const kept = reg.emit(id, driverDelta("C".repeat(10))); // seq3, retained
    expect(kept).not.toBeNull();
    expect(kept?.seq).toBe(3);

    unsub?.();

    // The stored record must contain the coalesced output.snapshot (seq=1) and
    // the retained small delta (seq=3), but NOT the dropped seq2.
    const record = reg.get(id);
    expect(record).toBeDefined();
    const events = record?.events ?? [];
    const snapshot = events.find((e) => e.type === "output.snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot?.seq).toBe(1);
    expect(events.some((e) => e.seq === 2)).toBe(false);
    expect(events.some((e) => e.seq === 3)).toBe(true);

    // Core CK-002 assertion: the live listener observed strictly increasing
    // seq with NO duplicates (pre-fix this was [2,2] — duplicate seq).
    expect(liveSeqs.length).toBe(2);
    expect(new Set(liveSeqs).size).toBe(liveSeqs.length);
    expect(liveSeqs[liveSeqs.length - 1]).toBeGreaterThan(liveSeqs[liveSeqs.length - 2]);
    expect(liveSeqs).toEqual([2, 3]);
  });

  it("TC5: lastSeq advances on drop — next emit allocates droppedSeq + 1", () => {
    (LIMITS as { executionBufferBytes: number }).executionBufferBytes = 600;
    const reg = createExecutionRegistry({ logger: nullLogger });
    const id = "exec-ck002-tc5";
    reg.begin(id, "p-1", "scope-1");

    // seq1: small delta — buffered, lastSeq = 1.
    reg.emit(id, driverDelta("A".repeat(50)));
    expect(reg.get(id)?.lastSeq).toBe(1);

    // seq2: large delta — coalesce + post-coalesce drop fires; emit returns
    // the stamped event even though bufferEvent dropped it.
    const dropped = reg.emit(id, driverDelta("B".repeat(400)));
    expect(dropped).not.toBeNull();
    expect(dropped?.seq).toBe(2);

    // The dropped seq2 must NOT be in the stored events.
    const recordAfterDrop = reg.get(id);
    expect(recordAfterDrop?.events.every((e) => e.seq !== 2)).toBe(true);

    // CK-002 core state assertion: lastSeq advanced to the dropped event's seq
    // (pre-fix this was 1 — lastSeq unchanged — the bug).
    expect(recordAfterDrop?.lastSeq).toBe(dropped?.seq);

    // seq3: small retained delta — must be strictly greater than dropped.seq.
    const kept = reg.emit(id, driverDelta("small"));
    expect(kept).not.toBeNull();
    expect(kept?.seq).toBe((dropped?.seq ?? 0) + 1);
    expect(reg.get(id)?.lastSeq).toBe(kept?.seq);
  });

  it("TC6: regression — normal path stays [1..4] and drop/normal are mutually exclusive on lastSeq", () => {
    // Default 32MiB cap: no coalescing, normal append path; lastSeq must equal
    // the count of emitted events and replay must be [1,2,3,4] in order.
    const reg = createExecutionRegistry({ logger: nullLogger });
    const id = "exec-ck002-tc6";
    reg.begin(id, "p-1", "scope-1");

    reg.emit(id, driverDelta("hello")); // seq1
    reg.emit(id, driverActivity("ran-tool")); // seq2
    reg.emit(id, driverDelta("world")); // seq3
    reg.emit(id, driverUsage()); // seq4

    expect(reg.get(id)?.lastSeq).toBe(4);
    expect(collectReplay(reg, id, 0).map((e) => e.seq)).toEqual([1, 2, 3, 4]);

    // Mutually-exclusive guarantee: a drop advances lastSeq exactly once (drop
    // branch returns before the normal-append assignment), so a subsequent
    // retained emit must get a strictly-new seq with no duplicate.
    (LIMITS as { executionBufferBytes: number }).executionBufferBytes = 600;
    const reg2 = createExecutionRegistry({ logger: nullLogger });
    const id2 = "exec-ck002-tc6-mutex";
    reg2.begin(id2, "p-1", "scope-2");

    const a = reg2.emit(id2, driverDelta("A".repeat(50))); // seq1, buffered
    expect(a?.seq).toBe(1);
    const b = reg2.emit(id2, driverDelta("B".repeat(400))); // seq2, coalesce+drop
    expect(b?.seq).toBe(2);
    const c = reg2.emit(id2, driverDelta("C".repeat(10))); // seq3, retained
    expect(c?.seq).toBe(3);

    // No duplicate seq across the three emitted events (drop advanced once,
    // normal path advanced once — mutually exclusive, total +2 over baseline).
    expect(new Set([a?.seq, b?.seq, c?.seq]).size).toBe(3);
    // Final lastSeq equals the last retained event's seq (drop advanced to 2,
    // then normal append advanced to 3).
    expect(reg2.get(id2)?.lastSeq).toBe(c?.seq);
  });
});
