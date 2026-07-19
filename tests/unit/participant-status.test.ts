import {
  PARTICIPANT_STATUS_LABELS,
  deriveParticipantRoundStatus,
} from "@/components/room/RoomHeader";
import type { DiscussionRound } from "@/models/discussion/entities";
import { createModelExecution } from "@/models/discussion/factories";
import type {
  ModelExecution,
  ModelExecutionState,
  ResultKind,
} from "@/models/discussion/model-execution";
import { describe, expect, it } from "vitest";

/**
 * S8 Participant 本轮状态条推导（plan-a §1.2）：四态是对 participantOrder 的
 * 干净划分（generating/done/failed/skipped）+ waiting，无需显式 cursor 比较。
 * deriveParticipantRoundStatus 是纯函数，从 RoomHeader 导出按 parseMaxRoundsInput
 * 先例单测；fail/skipped 与时间线 isSkippedFailure 同口径。
 */

function round(over: Partial<DiscussionRound> & { id: string }): DiscussionRound {
  return {
    roomId: "room-1",
    roundNumber: 1,
    participantOrder: ["p-1", "p-2"],
    phase: "running",
    pausedFrom: null,
    pauseReason: null,
    nextParticipantIndex: 0,
    activeExecutionId: null,
    focusMessageId: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    completedAt: null,
    ...over,
  };
}

function exec(over: {
  executionId: string;
  participantId: string;
  state?: ModelExecutionState;
  resultKind?: ResultKind;
}): ModelExecution {
  return {
    ...createModelExecution({
      executionId: over.executionId,
      roomId: "room-1",
      roundId: "r-1",
      participantId: over.participantId,
      resultKind: over.resultKind ?? "message",
      requestedModel: "model-x",
      contextRevision: 1,
      expectedRoomDigest: "d",
      participantSnapshotDigest: "s",
      instructionDigest: "i",
    }),
    state: over.state ?? "prepared",
  };
}

describe("deriveParticipantRoundStatus — null guards", () => {
  it("returns null when there is no active round", () => {
    expect(
      deriveParticipantRoundStatus({
        participantId: "p-1",
        round: null,
        executions: [],
        rounds: [],
      }),
    ).toBeNull();
  });

  it("returns null when the participant is not in the round's order", () => {
    const r = round({ id: "r-1" });
    expect(
      deriveParticipantRoundStatus({
        participantId: "p-late",
        round: r,
        executions: [],
        rounds: [r],
      }),
    ).toBeNull();
  });
});

describe("deriveParticipantRoundStatus — generating", () => {
  it("activeExecution on this participant + live state → generating", () => {
    const e = exec({ executionId: "e-1", participantId: "p-1", state: "running" });
    const r = round({ id: "r-1", activeExecutionId: "e-1", nextParticipantIndex: 0 });
    expect(
      deriveParticipantRoundStatus({
        participantId: "p-1",
        round: r,
        executions: [e],
        rounds: [r],
      }),
    ).toBe("generating");
  });

  it("activeExecution on this participant but terminal → not generating (falls through)", () => {
    const e = exec({ executionId: "e-1", participantId: "p-1", state: "failed" });
    const r = round({ id: "r-1", activeExecutionId: "e-1", nextParticipantIndex: 0 });
    // terminal failed message + cursor on slot + no committed → failed（不判 generating）
    expect(
      deriveParticipantRoundStatus({
        participantId: "p-1",
        round: r,
        executions: [e],
        rounds: [r],
      }),
    ).toBe("failed");
  });

  it("summarizing phase: facilitator holding the summary activeExecution → generating", () => {
    const summary = exec({
      executionId: "e-sum",
      participantId: "p-fac",
      state: "running",
      resultKind: "summary",
    });
    const r = round({
      id: "r-1",
      participantOrder: ["p-1", "p-fac"],
      phase: "summarizing",
      activeExecutionId: "e-sum",
      nextParticipantIndex: 2,
    });
    expect(
      deriveParticipantRoundStatus({
        participantId: "p-fac",
        round: r,
        executions: [summary],
        rounds: [r],
      }),
    ).toBe("generating");
  });
});

describe("deriveParticipantRoundStatus — waiting", () => {
  it("activeExecution on another participant + this participant has no records → waiting", () => {
    const e = exec({ executionId: "e-1", participantId: "p-2", state: "running" });
    const r = round({ id: "r-1", activeExecutionId: "e-1", nextParticipantIndex: 0 });
    expect(
      deriveParticipantRoundStatus({
        participantId: "p-1",
        round: r,
        executions: [e],
        rounds: [r],
      }),
    ).toBe("waiting");
  });

  it("pre-warm (zero executions, cursor=0) → every participant waiting", () => {
    const r = round({ id: "r-1", nextParticipantIndex: 0 });
    for (const pid of r.participantOrder) {
      expect(
        deriveParticipantRoundStatus({
          participantId: pid,
          round: r,
          executions: [],
          rounds: [r],
        }),
      ).toBe("waiting");
    }
  });
});

describe("deriveParticipantRoundStatus — done", () => {
  it("committed message present (even with an older failure) → done", () => {
    const failed = exec({ executionId: "e-fail", participantId: "p-1", state: "failed" });
    const committed = exec({ executionId: "e-ok", participantId: "p-1", state: "committed" });
    const r = round({ id: "r-1", activeExecutionId: null, nextParticipantIndex: 1 });
    expect(
      deriveParticipantRoundStatus({
        participantId: "p-1",
        round: r,
        executions: [failed, committed],
        rounds: [r],
      }),
    ).toBe("done");
  });

  it("a committed focus execution does not mark the facilitator done", () => {
    const focusCommitted = exec({
      executionId: "e-focus",
      participantId: "p-fac",
      state: "committed",
      resultKind: "focus",
    });
    const r = round({
      id: "r-1",
      participantOrder: ["p-fac", "p-1"],
      activeExecutionId: null,
      nextParticipantIndex: 1,
    });
    const status = deriveParticipantRoundStatus({
      participantId: "p-fac",
      round: r,
      executions: [focusCommitted],
      rounds: [r],
    });
    expect(status).not.toBe("done");
    // focus committed（resultKind="focus"，非 message）不计入 committed message → 落 waiting
    expect(status).toBe("waiting");
  });
});

describe("deriveParticipantRoundStatus — failed / skipped (isSkippedFailure同口径)", () => {
  it("terminal failure + no committed + cursor still on slot → failed", () => {
    const e = exec({ executionId: "e-1", participantId: "p-1", state: "failed" });
    const r = round({ id: "r-1", activeExecutionId: null, nextParticipantIndex: 0 });
    expect(
      deriveParticipantRoundStatus({
        participantId: "p-1",
        round: r,
        executions: [e],
        rounds: [r],
      }),
    ).toBe("failed");
  });

  it("terminal failure + cursor passed + no committed → skipped", () => {
    const e = exec({ executionId: "e-1", participantId: "p-1", state: "failed" });
    const r = round({ id: "r-1", activeExecutionId: null, nextParticipantIndex: 1 });
    expect(
      deriveParticipantRoundStatus({
        participantId: "p-1",
        round: r,
        executions: [e],
        rounds: [r],
      }),
    ).toBe("skipped");
  });
});

describe("PARTICIPANT_STATUS_LABELS", () => {
  it("maps all five statuses to Chinese", () => {
    expect(PARTICIPANT_STATUS_LABELS).toEqual({
      waiting: "等待中",
      generating: "生成中",
      done: "已完成",
      failed: "失败",
      skipped: "已跳过",
    });
  });
});
