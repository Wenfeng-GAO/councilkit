import { PAUSE_REASON_COPY, pauseReasonCopy } from "@/components/room/pause-reasons";
import {
  USER_SPEAKER,
  failureRecordDisplay,
  isFailedExecution,
  resolveSpeaker,
  roomRunStateLabel,
  roundPhaseLabel,
} from "@/components/room/round-timeline";
import type { DiscussionAgent, Participant } from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";
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
