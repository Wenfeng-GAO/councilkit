import type { ContextSnapshot, SnapshotItem } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_WINDOW_THRESHOLD_RATIO,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  SESSION_MAX_EXECUTIONS,
  createSessionReconciler,
} from "../../runtime-host/scopes/session-reconciler.ts";

/**
 * Session reconciler: cold vs incremental prompts, every needs_rebase reason
 * in check order, and recordApplied / invalidate / reset bookkeeping.
 */

const PARTICIPANT = "p-1";

function userItem(id: string, content: string): SnapshotItem {
  return { id, role: "user", content };
}

function snapshot(options: {
  revision: number;
  items: SnapshotItem[];
  topic?: string;
  background?: string;
  participantDigest?: string;
  digestVersion?: number;
  text?: string;
  kind?: "message" | "summary";
}): ContextSnapshot {
  return {
    digestVersion: (options.digestVersion ?? 1) as 1,
    roomContext: {
      contextRevision: options.revision,
      contextDigest: `digest-r${options.revision}`,
      ...(options.topic === undefined ? {} : { topic: options.topic }),
      ...(options.background === undefined ? {} : { background: options.background }),
      items: options.items,
    },
    participant: {
      participantId: PARTICIPANT,
      participantSnapshotDigest: options.participantDigest ?? "participant-digest-1",
    },
    instruction: {
      kind: options.kind ?? "message",
      instructionDigest: "instr-1",
      text: options.text ?? "Reply.",
    },
  };
}

describe("session reconciler", () => {
  it("publishes the session safety constants", () => {
    expect(SESSION_MAX_EXECUTIONS).toBe(32);
    expect(CONTEXT_WINDOW_THRESHOLD_RATIO).toBe(0.5);
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(65_536);
  });

  it("starts cold with the full prompt, including a summary item", () => {
    const reconciler = createSessionReconciler();
    const snap = snapshot({
      revision: 1,
      topic: "T",
      background: "B",
      kind: "summary",
      text: "Wrap up.",
      items: [userItem("i-1", "Hello"), { id: "i-2", role: "summary", content: "Sum" }],
    });
    expect(reconciler.reconcile(PARTICIPANT, snap, 0, null)).toEqual({
      kind: "ok",
      basis: "full",
      appliedItemCount: 2,
      prompt: [
        "# Discussion context (revision 1)",
        "Topic: T",
        "Background:",
        "B",
        "",
        "[user]",
        "Hello",
        "",
        "[summary]",
        "Sum",
        "",
        "# Instruction (summary)",
        "Wrap up.",
      ].join("\n"),
    });
    expect(reconciler.record(PARTICIPANT)).toBeNull();
    expect(reconciler.record("missing")).toBeNull();
  });

  it("reuses a strict append and treats a missing topic as an empty header field", () => {
    const reconciler = createSessionReconciler();
    const first = snapshot({ revision: 1, items: [userItem("i-1", "Hello")] });
    reconciler.recordApplied(PARTICIPANT, first, "exec-1", 0, { inputTokens: 10 });

    const appended = snapshot({
      revision: 2,
      items: [
        userItem("i-1", "Hello"),
        {
          id: "i-2",
          role: "participant",
          participantId: "p-2",
          content: "Other",
          sourceExecutionId: "exec-0",
        },
      ],
    });
    expect(reconciler.reconcile(PARTICIPANT, appended, 0, 8_000)).toEqual({
      kind: "ok",
      basis: "incremental",
      appliedItemCount: 2,
      prompt: "[participant p-2]\nOther\n\n# Instruction (message)\nReply.",
    });

    const sameLength = snapshot({ revision: 2, items: [userItem("i-1", "Hello")] });
    expect(reconciler.reconcile(PARTICIPANT, sameLength, 0, 8_000)).toEqual({
      kind: "ok",
      basis: "incremental",
      appliedItemCount: 1,
      prompt: "# Instruction (message)\nReply.",
    });
  });

  it("accepts an omitted topic when the stored topic is empty", () => {
    const reconciler = createSessionReconciler();
    const applied = snapshot({
      revision: 1,
      topic: "",
      background: "",
      items: [userItem("i-1", "Hello")],
    });
    reconciler.recordApplied(PARTICIPANT, applied, "exec-1", 0, null);
    const next = snapshot({
      revision: 2,
      items: [userItem("i-1", "Hello"), userItem("i-2", "Next")],
    });
    expect(reconciler.reconcile(PARTICIPANT, next, 0, null)).toEqual({
      kind: "ok",
      basis: "incremental",
      appliedItemCount: 2,
      prompt: "[user]\nNext\n\n# Instruction (message)\nReply.",
    });
  });

  it("restarts cold when the driver session epoch changes", () => {
    const reconciler = createSessionReconciler();
    const snap = snapshot({ revision: 4, topic: "T", items: [userItem("i-1", "Hello")] });
    reconciler.recordApplied(PARTICIPANT, snap, "exec-1", 0, { inputTokens: 99 });
    expect(reconciler.reconcile(PARTICIPANT, snap, 1, null)).toEqual({
      kind: "ok",
      basis: "full",
      appliedItemCount: 1,
      prompt:
        "# Discussion context (revision 4)\nTopic: T\n\n[user]\nHello\n\n# Instruction (message)\nReply.",
    });
  });

  it("reports session_execution_limit before later drift checks", () => {
    const reconciler = createSessionReconciler();
    const snap = snapshot({ revision: 1, items: [userItem("i-1", "Hello")] });
    for (let index = 0; index < SESSION_MAX_EXECUTIONS; index += 1) {
      reconciler.recordApplied(PARTICIPANT, snap, `exec-${index}`, 0, null);
    }
    const drifted = snapshot({
      revision: 0,
      digestVersion: 2,
      participantDigest: "other",
      items: [],
    });
    expect(reconciler.reconcile(PARTICIPANT, drifted, 0, null)).toEqual({
      kind: "needs_rebase",
      reason: "session_execution_limit",
    });
    expect(reconciler.record(PARTICIPANT)?.executionCount).toBe(32);
  });

  it("reports context_window_threshold before revision and digest drift", () => {
    const reconciler = createSessionReconciler();
    reconciler.recordApplied(
      PARTICIPANT,
      snapshot({ revision: 2, items: [userItem("i-1", "Hello")] }),
      "exec-1",
      0,
      { inputTokens: 500 },
    );
    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 1,
          digestVersion: 2,
          items: [userItem("i-1", "Hello"), userItem("i-2", "Next")],
        }),
        0,
        1_000,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "context_window_threshold" });
  });

  it("allows cumulative input one token under the window and rejects the exact boundary", () => {
    const under = createSessionReconciler();
    under.recordApplied(
      PARTICIPANT,
      snapshot({ revision: 1, items: [userItem("i-1", "Hello")] }),
      "exec-1",
      0,
      { inputTokens: 499 },
    );
    expect(
      under.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 2,
          items: [userItem("i-1", "Hello"), userItem("i-2", "Next")],
        }),
        0,
        1_000,
      ),
    ).toEqual({
      kind: "ok",
      basis: "incremental",
      appliedItemCount: 2,
      prompt: "[user]\nNext\n\n# Instruction (message)\nReply.",
    });

    const at = createSessionReconciler();
    at.recordApplied(
      PARTICIPANT,
      snapshot({ revision: 1, items: [userItem("i-1", "Hello")] }),
      "exec-1",
      0,
      { inputTokens: 500 },
    );
    expect(
      at.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 2,
          items: [userItem("i-1", "Hello"), userItem("i-2", "Next")],
        }),
        0,
        1_000,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "context_window_threshold" });
  });

  it("uses the 65536-token default window when the driver reports none", () => {
    const reconciler = createSessionReconciler();
    reconciler.recordApplied(
      PARTICIPANT,
      snapshot({ revision: 1, items: [userItem("i-1", "Hello")] }),
      "exec-1",
      0,
      { inputTokens: 32_768 },
    );
    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 2,
          items: [userItem("i-1", "Hello"), userItem("i-2", "Next")],
        }),
        0,
        null,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "context_window_threshold" });

    const below = createSessionReconciler();
    below.recordApplied(
      PARTICIPANT,
      snapshot({ revision: 1, items: [userItem("i-1", "Hello")] }),
      "exec-1",
      0,
      { inputTokens: 32_767 },
    );
    expect(
      below.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 2,
          items: [userItem("i-1", "Hello"), userItem("i-2", "Next")],
        }),
        0,
        null,
      ),
    ).toEqual({
      kind: "ok",
      basis: "incremental",
      appliedItemCount: 2,
      prompt: "[user]\nNext\n\n# Instruction (message)\nReply.",
    });
  });

  it("reports digest_version_changed, revision_regressed, and participant_changed in that order", () => {
    const reconciler = createSessionReconciler();
    const applied = snapshot({ revision: 5, items: [userItem("i-1", "Hello")] });
    reconciler.recordApplied(PARTICIPANT, applied, "exec-1", 0, { inputTokens: 1 });

    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({ revision: 4, digestVersion: 2, items: [userItem("i-1", "Hello")] }),
        0,
        8_000,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "digest_version_changed" });

    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({ revision: 4, items: [userItem("i-1", "Hello")] }),
        0,
        8_000,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "revision_regressed" });

    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 5,
          participantDigest: "participant-digest-2",
          items: [userItem("i-1", "Hello")],
        }),
        0,
        8_000,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "participant_changed" });

    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({ revision: 5, items: [userItem("i-1", "Hello")] }),
        0,
        8_000,
      ),
    ).toEqual({
      kind: "ok",
      basis: "incremental",
      appliedItemCount: 1,
      prompt: "# Instruction (message)\nReply.",
    });
  });

  it("reports history_replaced for a shorter list, a changed prefix, or a later-item edit", () => {
    const reconciler = createSessionReconciler();
    const applied = snapshot({
      revision: 2,
      topic: "T",
      background: "B",
      items: [userItem("i-1", "Hello"), userItem("i-2", "Second")],
    });
    reconciler.recordApplied(PARTICIPANT, applied, "exec-1", 0, null);

    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 3,
          topic: "CHANGED",
          items: [userItem("i-1", "Hello")],
        }),
        0,
        null,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "history_replaced" });

    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 3,
          items: [userItem("i-1", "EDITED"), userItem("i-2", "Second")],
        }),
        0,
        null,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "history_replaced" });

    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 3,
          items: [
            userItem("i-1", "Hello"),
            { id: "i-2", role: "user", content: "Second", sourceExecutionId: "exec-x" },
            userItem("i-3", "Third"),
          ],
        }),
        0,
        null,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "history_replaced" });

    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 3,
          items: [userItem("i-9", "Hello"), userItem("i-2", "Second")],
        }),
        0,
        null,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "history_replaced" });

    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 3,
          items: [
            { id: "i-1", role: "participant", participantId: "p-9", content: "Hello" },
            userItem("i-2", "Second"),
          ],
        }),
        0,
        null,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "history_replaced" });
  });

  it("reports shared_context_changed when only the topic or only the background changes", () => {
    const reconciler = createSessionReconciler();
    reconciler.recordApplied(
      PARTICIPANT,
      snapshot({
        revision: 1,
        topic: "T",
        background: "B",
        items: [userItem("i-1", "Hello")],
      }),
      "exec-1",
      0,
      null,
    );
    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 2,
          topic: "U",
          background: "B",
          items: [userItem("i-1", "Hello"), userItem("i-2", "Next")],
        }),
        0,
        null,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "shared_context_changed" });
    expect(
      reconciler.reconcile(
        PARTICIPANT,
        snapshot({
          revision: 2,
          topic: "T",
          background: "C",
          items: [userItem("i-1", "Hello"), userItem("i-2", "Next")],
        }),
        0,
        null,
      ),
    ).toEqual({ kind: "needs_rebase", reason: "shared_context_changed" });
  });

  it("recordApplied stores digests, sums usage, and resets on a new epoch", () => {
    const reconciler = createSessionReconciler();
    const first = snapshot({
      revision: 1,
      topic: "T",
      background: "B",
      items: [userItem("i-1", "Hello")],
    });
    reconciler.recordApplied(PARTICIPANT, first, "exec-1", 0, { inputTokens: 10 });
    reconciler.recordApplied(PARTICIPANT, first, "exec-2", 0, { inputTokens: null });
    reconciler.recordApplied(PARTICIPANT, first, "exec-3", 0, {});
    reconciler.recordApplied(
      PARTICIPANT,
      snapshot({
        revision: 4,
        topic: "T",
        background: "B",
        items: [userItem("i-1", "Hello"), userItem("i-2", "Next")],
      }),
      "exec-4",
      0,
      { inputTokens: undefined },
    );

    expect(reconciler.record(PARTICIPANT)).toEqual({
      sessionEpoch: 0,
      digestVersion: 1,
      contextRevision: 4,
      contextDigest: "digest-r4",
      participantSnapshotDigest: "participant-digest-1",
      appliedItemCount: 2,
      itemDigests: [
        "8e3dd51bda936d0bb250d2d7b5f963af56a4828880d505ca01a40bca6f294e8c",
        "71f0c4f8a77ac58fd60f3c218f508425990bceefc289ec77cb625265bbe1dff6",
      ],
      topic: "T",
      background: "B",
      executionCount: 4,
      cumulativeInputTokens: 10,
      executionIds: ["exec-1", "exec-2", "exec-3", "exec-4"],
    });

    const resetSnap = snapshot({ revision: 9, items: [userItem("i-9", "Fresh")] });
    reconciler.recordApplied(PARTICIPANT, resetSnap, "exec-9", 3, null);
    expect(reconciler.record(PARTICIPANT)).toEqual({
      sessionEpoch: 3,
      digestVersion: 1,
      contextRevision: 9,
      contextDigest: "digest-r9",
      participantSnapshotDigest: "participant-digest-1",
      appliedItemCount: 1,
      itemDigests: ["21a0476ec41897de34e33a2924b99d87b5139e2073098d1e374be8145eaff6c0"],
      topic: "",
      background: "",
      executionCount: 1,
      cumulativeInputTokens: 0,
      executionIds: ["exec-9"],
    });
  });

  it("invalidate and reset drop stored sessions", () => {
    const reconciler = createSessionReconciler();
    const snap = snapshot({ revision: 1, items: [userItem("i-1", "Hello")] });
    reconciler.recordApplied(PARTICIPANT, snap, "exec-1", 0, { inputTokens: 4 });
    reconciler.recordApplied("p-2", snap, "exec-2", 0, { inputTokens: 1 });
    reconciler.invalidate(PARTICIPANT);
    reconciler.invalidate("nobody");
    expect(reconciler.record(PARTICIPANT)).toBeNull();
    expect(reconciler.record("p-2")?.executionIds).toEqual(["exec-2"]);
    reconciler.reset();
    expect(reconciler.record("p-2")).toBeNull();
    expect(reconciler.reconcile(PARTICIPANT, snap, 0, null)).toEqual({
      kind: "ok",
      basis: "full",
      appliedItemCount: 1,
      prompt:
        "# Discussion context (revision 1)\n\n[user]\nHello\n\n# Instruction (message)\nReply.",
    });
  });
});
