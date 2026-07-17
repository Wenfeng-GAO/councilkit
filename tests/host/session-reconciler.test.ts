import {
  CONTEXT_WINDOW_THRESHOLD_RATIO,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  SESSION_MAX_EXECUTIONS,
  createSessionReconciler,
} from "@host/scopes/session-reconciler";
import type { ContextSnapshot, SnapshotItem } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

/**
 * Session Reconciler unit tests: pure append-only reuse, divergence
 * detection, the 32-execution and 50%-context-window safety thresholds,
 * driver-epoch cold restarts, and recordApplied bookkeeping. No processes.
 */

const PARTICIPANT = "p-1";

function userItem(id: string, content: string): SnapshotItem {
  return { id, role: "user", content };
}

function participantItem(
  id: string,
  participantId: string,
  content: string,
  sourceExecutionId: string,
): SnapshotItem {
  return { id, role: "participant", participantId, content, sourceExecutionId };
}

function makeSnapshot(options: {
  revision: number;
  items: SnapshotItem[];
  participantDigest?: string;
  digestVersion?: number;
  instructionText?: string;
  topic?: string;
}): ContextSnapshot {
  return {
    // digestVersion is `literal(1)` in the schema; the cast lets a test feed
    // a future version to the reconciler's version gate.
    digestVersion: (options.digestVersion ?? 1) as 1,
    roomContext: {
      contextRevision: options.revision,
      contextDigest: `digest-r${options.revision}`,
      ...(options.topic === undefined ? {} : { topic: options.topic }),
      items: options.items,
    },
    participant: {
      participantId: PARTICIPANT,
      participantSnapshotDigest: options.participantDigest ?? "participant-digest-1",
    },
    instruction: {
      kind: "message",
      instructionDigest: "instr-1",
      text: options.instructionText ?? "Answer the last message.",
    },
  };
}

describe("session reconciler", () => {
  it("starts cold with a full render, then reuses the session on a strict append", () => {
    const reconciler = createSessionReconciler();
    const snap1 = makeSnapshot({ revision: 1, items: [userItem("i-1", "First user message.")] });

    const cold = reconciler.reconcile(PARTICIPANT, snap1, 0, null);
    expect(cold.kind).toBe("ok");
    if (cold.kind !== "ok") throw new Error("unreachable");
    expect(cold.basis).toBe("full");
    expect(cold.appliedItemCount).toBe(1);
    expect(cold.prompt).toContain("# Discussion context (revision 1)");
    expect(cold.prompt).toContain("First user message.");
    expect(cold.prompt).toContain("# Instruction (message)");

    reconciler.recordApplied(PARTICIPANT, snap1, "exec-1", 0, { inputTokens: 120 });

    const snap2 = makeSnapshot({
      revision: 2,
      items: [
        userItem("i-1", "First user message."),
        participantItem("i-2", "p-2", "Other participant reply.", "exec-0"),
      ],
    });
    const appended = reconciler.reconcile(PARTICIPANT, snap2, 0, null);
    expect(appended.kind).toBe("ok");
    if (appended.kind !== "ok") throw new Error("unreachable");
    expect(appended.basis).toBe("incremental");
    expect(appended.appliedItemCount).toBe(2);
    // Incremental prompt: only the new tail plus the instruction, no header.
    expect(appended.prompt).toContain("Other participant reply.");
    expect(appended.prompt).not.toContain("First user message.");
    expect(appended.prompt).not.toContain("# Discussion context");
    expect(appended.prompt).toContain("# Instruction (message)");
  });

  it("needs_rebase when applied history diverges or is truncated", () => {
    const reconciler = createSessionReconciler();
    const applied = makeSnapshot({
      revision: 2,
      items: [userItem("i-1", "Original."), userItem("i-2", "Second.")],
    });
    reconciler.reconcile(PARTICIPANT, applied, 0, null);
    reconciler.recordApplied(PARTICIPANT, applied, "exec-1", 0, null);

    // Content of an already-applied item changed under the same id.
    const edited = makeSnapshot({
      revision: 3,
      items: [userItem("i-1", "Original."), userItem("i-2", "EDITED.")],
    });
    expect(reconciler.reconcile(PARTICIPANT, edited, 0, null)).toEqual({
      kind: "needs_rebase",
      reason: "history_replaced",
    });

    // Fewer items than were applied.
    const truncated = makeSnapshot({ revision: 3, items: [userItem("i-1", "Original.")] });
    expect(reconciler.reconcile(PARTICIPANT, truncated, 0, null)).toEqual({
      kind: "needs_rebase",
      reason: "history_replaced",
    });
  });

  it("needs_rebase with the exact reason for version, revision, and participant drift", () => {
    const reconciler = createSessionReconciler();
    const applied = makeSnapshot({ revision: 5, items: [userItem("i-1", "base")] });
    reconciler.reconcile(PARTICIPANT, applied, 0, null);
    reconciler.recordApplied(PARTICIPANT, applied, "exec-1", 0, null);

    const regressed = makeSnapshot({ revision: 4, items: [userItem("i-1", "base")] });
    expect(reconciler.reconcile(PARTICIPANT, regressed, 0, null)).toEqual({
      kind: "needs_rebase",
      reason: "revision_regressed",
    });

    const otherParticipant = makeSnapshot({
      revision: 6,
      items: [userItem("i-1", "base")],
      participantDigest: "participant-digest-2",
    });
    expect(reconciler.reconcile(PARTICIPANT, otherParticipant, 0, null)).toEqual({
      kind: "needs_rebase",
      reason: "participant_changed",
    });

    const futureVersion = makeSnapshot({
      revision: 6,
      items: [userItem("i-1", "base")],
      digestVersion: 2,
    });
    expect(reconciler.reconcile(PARTICIPANT, futureVersion, 0, null)).toEqual({
      kind: "needs_rebase",
      reason: "digest_version_changed",
    });
  });

  it("needs_rebase once the 32-execution safety limit is reached", () => {
    const reconciler = createSessionReconciler();
    const items: SnapshotItem[] = [];
    for (let index = 0; index < SESSION_MAX_EXECUTIONS; index += 1) {
      items.push(userItem(`i-${index}`, `message ${index}`));
      const snap = makeSnapshot({ revision: index + 1, items: [...items] });
      const outcome = reconciler.reconcile(PARTICIPANT, snap, 0, null);
      expect(outcome.kind, `reconcile before execution ${index + 1}`).toBe("ok");
      reconciler.recordApplied(PARTICIPANT, snap, `exec-${index}`, 0, null);
    }
    expect(reconciler.record(PARTICIPANT)?.executionCount).toBe(32);

    items.push(userItem("i-32", "one more"));
    const snap = makeSnapshot({ revision: 33, items: [...items] });
    expect(reconciler.reconcile(PARTICIPANT, snap, 0, null)).toEqual({
      kind: "needs_rebase",
      reason: "session_execution_limit",
    });
  });

  it("needs_rebase at exactly 50% of the reported context window", () => {
    const reconciler = createSessionReconciler();
    const window = 1000;
    const threshold = window * CONTEXT_WINDOW_THRESHOLD_RATIO;
    const items: SnapshotItem[] = [];

    items.push(userItem("i-0", "first"));
    reconciler.recordApplied(
      PARTICIPANT,
      makeSnapshot({ revision: 1, items: [...items] }),
      "exec-0",
      0,
      { inputTokens: threshold - 100 },
    );
    const below = makeSnapshot({
      revision: 2,
      items: [...items, userItem("i-1", "next")],
    });
    expect(reconciler.reconcile(PARTICIPANT, below, 0, window).kind).toBe("ok");

    // Cumulative input reaches exactly the 50% boundary: >= trips the gate.
    items.push(userItem("i-1", "next"));
    reconciler.recordApplied(
      PARTICIPANT,
      makeSnapshot({ revision: 2, items: [...items] }),
      "exec-1",
      0,
      { inputTokens: 100 },
    );
    const atThreshold = makeSnapshot({
      revision: 3,
      items: [...items, userItem("i-2", "overflow")],
    });
    expect(reconciler.reconcile(PARTICIPANT, atThreshold, 0, window)).toEqual({
      kind: "needs_rebase",
      reason: "context_window_threshold",
    });
  });

  it("falls back to the 64k default window when the runtime reports none", () => {
    const reconciler = createSessionReconciler();
    const items = [userItem("i-1", "big turn")];
    reconciler.recordApplied(
      PARTICIPANT,
      makeSnapshot({ revision: 1, items: [...items] }),
      "exec-1",
      0,
      { inputTokens: DEFAULT_CONTEXT_WINDOW_TOKENS * CONTEXT_WINDOW_THRESHOLD_RATIO },
    );
    items.push(userItem("i-2", "more"));
    const snap = makeSnapshot({ revision: 2, items: [...items] });
    expect(reconciler.reconcile(PARTICIPANT, snap, 0, null)).toEqual({
      kind: "needs_rebase",
      reason: "context_window_threshold",
    });
  });

  it("restarts cold on a driver session epoch change instead of rebasing", () => {
    const reconciler = createSessionReconciler();
    const snap = makeSnapshot({ revision: 5, items: [userItem("i-1", "kept")] });
    reconciler.reconcile(PARTICIPANT, snap, 0, null);
    reconciler.recordApplied(PARTICIPANT, snap, "exec-1", 0, { inputTokens: 999 });

    // Same snapshot, new driver epoch: never a rebase, always a cold full render.
    const restarted = reconciler.reconcile(PARTICIPANT, snap, 1, null);
    expect(restarted.kind).toBe("ok");
    if (restarted.kind !== "ok") throw new Error("unreachable");
    expect(restarted.basis).toBe("full");
    expect(restarted.prompt).toContain("# Discussion context (revision 5)");

    // recordApplied on the new epoch resets the bookkeeping, it does not add up.
    reconciler.recordApplied(PARTICIPANT, snap, "exec-2", 1, null);
    const record = reconciler.record(PARTICIPANT);
    expect(record?.sessionEpoch).toBe(1);
    expect(record?.executionCount).toBe(1);
    expect(record?.cumulativeInputTokens).toBe(0);
    expect(record?.executionIds).toEqual(["exec-2"]);
  });

  it("recordApplied accumulates counts, usage, ids, and item digests", () => {
    const reconciler = createSessionReconciler();
    const snap1 = makeSnapshot({ revision: 1, items: [userItem("i-1", "one")] });
    reconciler.recordApplied(PARTICIPANT, snap1, "exec-1", 0, { inputTokens: 100 });
    const snap2 = makeSnapshot({
      revision: 2,
      items: [userItem("i-1", "one"), userItem("i-2", "two")],
    });
    reconciler.recordApplied(PARTICIPANT, snap2, "exec-2", 0, { inputTokens: 50 });
    const snap3 = makeSnapshot({
      revision: 3,
      items: [userItem("i-1", "one"), userItem("i-2", "two"), userItem("i-3", "three")],
    });
    // Missing usage counts as zero.
    reconciler.recordApplied(PARTICIPANT, snap3, "exec-3", 0, null);

    const record = reconciler.record(PARTICIPANT);
    expect(record?.executionCount).toBe(3);
    expect(record?.cumulativeInputTokens).toBe(150);
    expect(record?.executionIds).toEqual(["exec-1", "exec-2", "exec-3"]);
    expect(record?.appliedItemCount).toBe(3);
    expect(record?.itemDigests).toHaveLength(3);
    expect(record?.contextRevision).toBe(3);
    expect(record?.contextDigest).toBe("digest-r3");
    expect(record?.digestVersion).toBe(1);
    expect(reconciler.record("someone-else")).toBeNull();
  });

  it("invalidate drops the session; the next reconcile starts cold", () => {
    const reconciler = createSessionReconciler();
    const snap = makeSnapshot({ revision: 1, items: [userItem("i-1", "x")] });
    reconciler.reconcile(PARTICIPANT, snap, 0, null);
    reconciler.recordApplied(PARTICIPANT, snap, "exec-1", 0, null);

    reconciler.invalidate(PARTICIPANT);
    expect(reconciler.record(PARTICIPANT)).toBeNull();

    const cold = reconciler.reconcile(PARTICIPANT, snap, 0, null);
    expect(cold.kind).toBe("ok");
    if (cold.kind !== "ok") throw new Error("unreachable");
    expect(cold.basis).toBe("full");
  });
});
