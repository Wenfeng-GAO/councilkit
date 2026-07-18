import { PAUSE_REASON_COPY, pauseReasonCopy } from "@/components/room/pause-reasons";
import {
  USER_SPEAKER,
  failureRecordDisplay,
  isFailedExecution,
  isNeedsRebasePause,
  isSkippedFailure,
  pausedPanelBranch,
  resolveSpeaker,
  retryCountForPause,
  roomRunStateLabel,
  rotationDisplayFor,
  roundPhaseLabel,
} from "@/components/room/round-timeline";
import type { DiscussionAgent, DiscussionRound, Participant } from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";
import type { RuntimeBinding } from "@/models/discussion/runtime-binding";
import { describe, expect, it } from "vitest";

/**
 * Pure display helpers for the Room timeline (U6): pause-reason mapping
 * covers every code with actionable copy; speaker resolution falls back
 * safely; failure records expose structured codes, never body text.
 */

function participant(over: Partial<Participant> = {}): Participant {
  return {
    id: "p-1",
    roomId: "room-1",
    agentId: "agent-1",
    personaPrompt: "persona",
    executionProfileId: "profile-1",
    profileRevision: 1,
    profileDigest: "digest",
    modelId: "model-x",
    participantSnapshotDigest: "snap",
    state: "active",
    createdAt: "2026-07-17T00:00:00.000Z",
    endedAt: null,
    ...over,
  };
}

function agent(over: Partial<DiscussionAgent> = {}): DiscussionAgent {
  return {
    id: "agent-1",
    name: "安全审查员",
    personaPrompt: "persona",
    executionProfileId: "profile-1",
    modelId: "model-x",
    color: "#22c55e",
    revision: 1,
    enabled: true,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

function execution(over: Partial<ModelExecution> = {}): ModelExecution {
  return {
    executionId: "e-1",
    roomId: "room-1",
    roundId: "round-1",
    participantId: "p-1",
    resultKind: "message",
    state: "discarded",
    hostInstanceId: null,
    executionScopeId: null,
    requestedModel: "model-x",
    effectiveModel: null,
    dispatchState: "accepted",
    toolState: "none",
    contextRevision: 1,
    expectedRoomDigest: "d",
    participantSnapshotDigest: "s",
    instructionDigest: "i",
    contentDigest: null,
    committedEntityType: null,
    committedEntityId: null,
    runtimeOutcome: null,
    usage: null,
    error: null,
    finalEventSeq: null,
    ackState: null,
    retryOfExecutionId: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

describe("pauseReasonCopy", () => {
  it("covers every pause code with title, description and typed repair entries", () => {
    const codes = [
      "prewarm_failed",
      "facilitator_unavailable",
      "model_mismatch",
      "tool_state_unknown",
      "stale_context",
      "empty_output",
      "needs_rebase",
      "execution_failed",
      "user_cancelled",
    ] as const;
    for (const code of codes) {
      const copy = pauseReasonCopy(code);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.description.length).toBeGreaterThan(0);
      for (const entry of copy.repair) {
        expect(["/settings", "/rooms/new"]).toContain(entry.href);
        expect(entry.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("maps user_cancelled to a manual-stop explanation without repair links", () => {
    const copy = pauseReasonCopy("user_cancelled");
    expect(copy.title).toContain("停止");
    expect(copy.description).toContain("保留");
    expect(copy.repair).toHaveLength(0);
  });

  it("points model/profile problems at settings", () => {
    expect(pauseReasonCopy("model_mismatch").repair[0]?.href).toBe("/settings");
    expect(pauseReasonCopy("prewarm_failed").repair[0]?.href).toBe("/settings");
    expect(pauseReasonCopy("needs_rebase").repair[0]?.href).toBe("/rooms/new");
  });
});

describe("resolveSpeaker", () => {
  const participants = new Map([["p-1", participant()]]);
  const agents = new Map([["agent-1", agent()]]);

  it("resolves participant → agent name and color", () => {
    expect(resolveSpeaker("p-1", participants, agents)).toEqual({
      name: "安全审查员",
      color: "#22c55e",
    });
  });

  it("falls back for missing participant or missing agent", () => {
    expect(resolveSpeaker("nope", participants, agents).name).toBe("未知参与者");
    expect(resolveSpeaker(null, participants, agents).name).toBe("未知参与者");
    expect(resolveSpeaker("p-1", participants, new Map()).name).toBe("model-x");
  });

  it("has a stable user speaker", () => {
    expect(USER_SPEAKER.name).toBe("你");
  });
});

describe("failure records", () => {
  it("only discarded/failed/interrupted executions become failure records", () => {
    expect(isFailedExecution(execution({ state: "discarded" }))).toBe(true);
    expect(isFailedExecution(execution({ state: "failed" }))).toBe(true);
    expect(isFailedExecution(execution({ state: "interrupted" }))).toBe(true);
    expect(isFailedExecution(execution({ state: "committed" }))).toBe(false);
    expect(isFailedExecution(execution({ state: "running" }))).toBe(false);
  });

  it("discarded records show the mapped outcome title, never body text", () => {
    const display = failureRecordDisplay(
      execution({
        state: "discarded",
        runtimeOutcome: "model_mismatch",
        error: {
          code: "MODEL_MISMATCH",
          phase: "stream",
          message: "mismatch detail",
          retryable: false,
        },
      }),
    );
    expect(display.codeLabel).toBe(PAUSE_REASON_COPY.model_mismatch.title);
    expect(display.stateLabel).toBe("已丢弃");
    expect(display.detail).toBe("mismatch detail");
  });

  it("failed records fall back to the structured error code", () => {
    const display = failureRecordDisplay(
      execution({
        state: "failed",
        error: { code: "DISPATCH_FAILED", phase: "dispatch", message: "boom", retryable: false },
      }),
    );
    expect(display.codeLabel).toBe("DISPATCH_FAILED");
    expect(display.stateLabel).toBe("执行失败");
    expect(display.tone).toBe("error");
  });
});

describe("state labels", () => {
  it("labels every round phase and room run state in Chinese", () => {
    expect(roundPhaseLabel("running")).toBe("进行中");
    expect(roundPhaseLabel("completed")).toBe("已完成");
    expect(roundPhaseLabel("aborted")).toBe("已终止");
    expect(roomRunStateLabel("idle")).toBe("空闲");
    expect(roomRunStateLabel("running")).toBe("运行中");
    expect(roomRunStateLabel("paused")).toBe("已暂停");
  });
});

// ---------------------------------------------------------------------------
// S3 recovery display: pure derivation helpers
// ---------------------------------------------------------------------------

function roundFixture(over: Partial<DiscussionRound> & { id: string }): DiscussionRound {
  return {
    roomId: "room-1",
    roundNumber: 1,
    participantOrder: ["p-1", "p-2"],
    phase: "completed",
    pausedFrom: null,
    pauseReason: null,
    nextParticipantIndex: 2,
    activeExecutionId: null,
    focusMessageId: "f-1",
    createdAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:00:10.000Z",
    ...over,
  };
}

function bindingFixture(over: Partial<RuntimeBinding> & { id: string }): RuntimeBinding {
  return {
    roomId: "room-1",
    scopeRequestId: over.scopeRequestId ?? `req-${over.id}`,
    state: "active",
    hostInstanceId: "host-1",
    executionScopeId: "scope-1",
    controllerId: "ctrl-1",
    leaseEpoch: 1,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

describe("pausedPanelBranch (S3)", () => {
  it("needs_rebase code / execution_failed with reconciliation detail → rotate", () => {
    expect(pausedPanelBranch({ code: "needs_rebase" }, "fac")).toBe("rotate");
    expect(
      pausedPanelBranch({ code: "execution_failed", detail: "session reconciliation: x" }, "fac"),
    ).toBe("rotate");
  });
  it("five recoverable codes × non-facilitator → recoverable; × facilitator → facilitator", () => {
    const recoverable = [
      "model_mismatch",
      "tool_state_unknown",
      "stale_context",
      "empty_output",
      "execution_failed",
    ] as const;
    for (const code of recoverable) {
      expect(pausedPanelBranch({ code, participantId: "p-2" }, "fac")).toBe("recoverable");
      expect(pausedPanelBranch({ code, participantId: "fac" }, "fac")).toBe("facilitator");
    }
  });
  it("prewarm_failed / user_cancelled / facilitator_unavailable → default", () => {
    expect(pausedPanelBranch({ code: "prewarm_failed" }, "fac")).toBe("default");
    expect(pausedPanelBranch({ code: "user_cancelled" }, "fac")).toBe("default");
    expect(pausedPanelBranch({ code: "facilitator_unavailable" }, "fac")).toBe("default");
  });
  it("missing participantId on a recoverable code reads as non-facilitator (recoverable)", () => {
    expect(pausedPanelBranch({ code: "execution_failed" }, "fac")).toBe("recoverable");
  });
  it("isNeedsRebasePause recognizes both the code and the detail prefix", () => {
    expect(isNeedsRebasePause({ code: "needs_rebase" })).toBe(true);
    expect(
      isNeedsRebasePause({ code: "execution_failed", detail: "session reconciliation: y" }),
    ).toBe(true);
    expect(isNeedsRebasePause({ code: "execution_failed", detail: "some other detail" })).toBe(
      false,
    );
  });
});

describe("retryCountForPause (S3)", () => {
  it("returns 0 when the reason carries no executionId", () => {
    expect(retryCountForPause([], { code: "execution_failed" })).toBe(0);
  });
  it("counts the chain length minus one (executions with retryOfExecutionId set on the same slot)", () => {
    const executions: ModelExecution[] = [
      execution({
        executionId: "e-1",
        roundId: "r-1",
        participantId: "p-1",
        resultKind: "message",
        retryOfExecutionId: null,
      }),
      execution({
        executionId: "e-2",
        roundId: "r-1",
        participantId: "p-1",
        resultKind: "message",
        retryOfExecutionId: "e-1",
      }),
      execution({
        executionId: "e-3",
        roundId: "r-1",
        participantId: "p-1",
        resultKind: "message",
        retryOfExecutionId: "e-2",
      }),
    ];
    expect(retryCountForPause(executions, { code: "execution_failed", executionId: "e-1" })).toBe(
      2,
    );
  });
  it("isolates by round / participant / resultKind", () => {
    const executions: ModelExecution[] = [
      execution({
        executionId: "e-1",
        roundId: "r-1",
        participantId: "p-1",
        resultKind: "message",
        retryOfExecutionId: null,
      }),
      execution({
        executionId: "e-2",
        roundId: "r-1",
        participantId: "p-1",
        resultKind: "summary",
        retryOfExecutionId: "e-1",
      }),
      execution({
        executionId: "e-3",
        roundId: "r-2",
        participantId: "p-1",
        resultKind: "message",
        retryOfExecutionId: "e-1",
      }),
    ];
    expect(retryCountForPause(executions, { code: "execution_failed", executionId: "e-1" })).toBe(
      0,
    );
  });
});

describe("rotationDisplayFor (S3)", () => {
  const bindings = [
    bindingFixture({ id: "b-1", createdAt: "2026-07-17T00:00:00.000Z" }),
    bindingFixture({ id: "b-2", createdAt: "2026-07-17T00:00:20.000Z" }),
  ];
  it("null for a non-NEEDS_REBASE failure", () => {
    expect(
      rotationDisplayFor(
        execution({
          executionId: "e-1",
          error: { code: "MODEL_UNAVAILABLE", phase: "stream", message: "x", retryable: false },
        }),
        [execution()],
        bindings,
      ),
    ).toBeNull();
  });
  it("1-based ordinal among the room's NEEDS_REBASE failures (sorted by createdAt)", () => {
    const e1 = execution({
      executionId: "e-1",
      createdAt: "2026-07-17T00:00:05.000Z",
      error: { code: "NEEDS_REBASE", phase: "stream", message: "a", retryable: false },
    });
    const e2 = execution({
      executionId: "e-2",
      createdAt: "2026-07-17T00:00:15.000Z",
      error: { code: "NEEDS_REBASE", phase: "stream", message: "b", retryable: false },
    });
    expect(rotationDisplayFor(e1, [e1, e2], bindings)?.n).toBe(1);
    expect(rotationDisplayFor(e2, [e1, e2], bindings)?.n).toBe(2);
  });
  it("rebuilt true when a binding is newer than the failure, false otherwise", () => {
    const failAtMid = execution({
      executionId: "e-1",
      createdAt: "2026-07-17T00:00:10.000Z",
      error: { code: "NEEDS_REBASE", phase: "stream", message: "a", retryable: false },
    });
    expect(rotationDisplayFor(failAtMid, [failAtMid], bindings)?.rebuilt).toBe(true);
    const oldFail = execution({
      executionId: "e-old",
      createdAt: "2026-07-18T00:00:00.000Z",
      error: { code: "NEEDS_REBASE", phase: "stream", message: "a", retryable: false },
    });
    expect(rotationDisplayFor(oldFail, [oldFail], bindings)?.rebuilt).toBe(false);
  });
  it("R2: rebuilt requires the newer binding to have a non-null executionScopeId — a creating-only binding (Host create failed) reads false", () => {
    const fail = execution({
      executionId: "e-1",
      createdAt: "2026-07-17T00:00:10.000Z",
      error: { code: "NEEDS_REBASE", phase: "stream", message: "a", retryable: false },
    });
    // A newer binding stuck in `creating` (no executionScopeId) proves no rebuild.
    const creatingBinding = bindingFixture({
      id: "b-creating",
      state: "creating",
      executionScopeId: null,
      createdAt: "2026-07-17T00:00:20.000Z",
    });
    expect(rotationDisplayFor(fail, [fail], [creatingBinding])?.rebuilt).toBe(false);
    // The same newer binding, once it obtains a scopeId, proves the rebuild.
    const activatedBinding = bindingFixture({
      id: "b-creating",
      state: "active",
      executionScopeId: "scope-rebuilt",
      createdAt: "2026-07-17T00:00:20.000Z",
    });
    expect(rotationDisplayFor(fail, [fail], [activatedBinding])?.rebuilt).toBe(true);
    // A mix: an older activated binding + a newer creating one. The newer
    // creating binding must not count; rebuilt is false.
    const olderActive = bindingFixture({
      id: "b-old-active",
      createdAt: "2026-07-17T00:00:05.000Z",
    });
    expect(rotationDisplayFor(fail, [fail], [olderActive, creatingBinding])?.rebuilt).toBe(false);
  });
});

describe("isSkippedFailure (S3)", () => {
  it("true: cursor passed the slot + no committed message execution", () => {
    const r = roundFixture({ id: "r-1", nextParticipantIndex: 2 });
    const exec = execution({
      executionId: "e-1",
      roundId: "r-1",
      participantId: "p-2",
      state: "failed",
      resultKind: "message",
    });
    expect(isSkippedFailure(exec, [r], [exec])).toBe(true);
  });
  it("true also for discarded/interrupted terminals", () => {
    const r = roundFixture({ id: "r-1", nextParticipantIndex: 2 });
    const exec = execution({
      executionId: "e-1",
      roundId: "r-1",
      participantId: "p-2",
      state: "discarded",
      resultKind: "message",
    });
    expect(isSkippedFailure(exec, [r], [exec])).toBe(true);
  });
  it("false when the slot has a committed message (retry succeeded)", () => {
    const r = roundFixture({ id: "r-1", nextParticipantIndex: 2 });
    const failed = execution({
      executionId: "e-1",
      roundId: "r-1",
      participantId: "p-2",
      state: "failed",
      resultKind: "message",
    });
    const committed = execution({
      executionId: "e-2",
      roundId: "r-1",
      participantId: "p-2",
      state: "committed",
      resultKind: "message",
    });
    expect(isSkippedFailure(failed, [r], [failed, committed])).toBe(false);
  });
  it("false when the cursor is still on the slot (paused, not yet skipped)", () => {
    const r = roundFixture({ id: "r-1", nextParticipantIndex: 1 }); // paused at p-2 (index 1)
    const exec = execution({
      executionId: "e-1",
      roundId: "r-1",
      participantId: "p-2",
      state: "failed",
      resultKind: "message",
    });
    expect(isSkippedFailure(exec, [r], [exec])).toBe(false);
  });
  it("aborted Round 的已跳过标记仍派生（R1 永久性）：cursor 已越过 + 无 committed 即为 true", () => {
    // Scenario R1: the user aborted the round AFTER the skip. The 「· 已跳过」
    // marker must still derive, mirroring the skip annotation the reconciler
    // depends on (a dropped marker would rewrite the session prefix → spurious
    // needs_rebase). Permanence is independent of round.phase.
    const aborted = roundFixture({ id: "r-1", phase: "aborted", nextParticipantIndex: 2 });
    const exec = execution({
      executionId: "e-1",
      roundId: "r-1",
      participantId: "p-2",
      state: "failed",
      resultKind: "message",
    });
    expect(isSkippedFailure(exec, [aborted], [exec])).toBe(true);
    // Still false for a non-message kind (the abort-permanence rule covers
    // message skips only; summary never occupies a cursor slot).
    const r = roundFixture({ id: "r-2", nextParticipantIndex: 1 });
    const summaryExec = execution({
      executionId: "e-s",
      roundId: "r-2",
      participantId: "p-1",
      state: "failed",
      resultKind: "summary",
    });
    expect(isSkippedFailure(summaryExec, [r], [summaryExec])).toBe(false);
  });
});
