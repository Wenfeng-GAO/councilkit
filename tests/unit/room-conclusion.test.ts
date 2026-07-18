import {
  canConcludeNow,
  deriveRoomPhase,
  findFailedReportExecution,
  findLiveReportExecution,
} from "@/app/pages/RoomPage";
import { reportFilename } from "@/components/room/ReportView";
import { ROOM_MODE_PILL, roomModeLabel } from "@/components/room/RoomHeader";
import type { DiscussionRound } from "@/models/discussion/entities";
import { createDecisionReport, createModelExecution } from "@/models/discussion/factories";
import type { ModelExecution, ModelExecutionState } from "@/models/discussion/model-execution";
import type { RuntimeBinding } from "@/models/discussion/runtime-binding";
import {
  type RoomRecoveryFacts,
  filterRoomScopedFacts,
  guardRoomScopedReport,
} from "@/stores/runtime-queries";
import { describe, expect, it } from "vitest";

/**
 * Room conclusion pure derivations (S4): the phase picker, the live/failed
 * report-execution reducers, the "can conclude now" truth table, the report
 * filename sanitizer, and the mode label. These mirror the S2 concluding口径
 * (live report = prepared/running/succeeded_uncommitted) and the brief's
 * "总结并结束" guarding conditions. DOM behavior is covered by e2e; vitest
 * runs in the node environment (no testing-library), so only the pure
 * exported functions are pinned here — the parseMaxRoundsInput precedent.
 */

function makeExecution(overrides: {
  resultKind?: ModelExecution["resultKind"];
  state?: ModelExecutionState;
  createdAt?: string;
  executionId?: string;
  participantId?: string;
  error?: ModelExecution["error"];
}): ModelExecution {
  return {
    ...createModelExecution({
      executionId: overrides.executionId ?? `exec-${overrides.createdAt ?? "0"}`,
      roomId: "room-1",
      roundId: "round-1",
      participantId: overrides.participantId ?? "p1",
      resultKind: overrides.resultKind ?? "report",
      requestedModel: "model-a",
      contextRevision: 1,
      expectedRoomDigest: "d",
      participantSnapshotDigest: "pd",
      instructionDigest: "id",
    }),
    state: overrides.state ?? "prepared",
    createdAt: overrides.createdAt ?? "2026-07-19T00:00:00.000Z",
    updatedAt: overrides.createdAt ?? "2026-07-19T00:00:00.000Z",
    error: overrides.error ?? null,
  };
}

describe("deriveRoomPhase", () => {
  it('"concluded" wins even when a live report execution exists', () => {
    const executions = [makeExecution({ state: "running" })];
    expect(deriveRoomPhase({ status: "concluded" }, executions)).toBe("concluded");
  });

  it("open + each live report state → concluding", () => {
    for (const state of ["prepared", "running", "succeeded_uncommitted"] as ModelExecutionState[]) {
      const executions = [makeExecution({ state })];
      expect(deriveRoomPhase({ status: "open" }, executions)).toBe("concluding");
    }
  });

  it("committed/terminal-failure report → discussing (not concluding)", () => {
    for (const state of [
      "committed",
      "failed",
      "interrupted",
      "discarded",
    ] as ModelExecutionState[]) {
      const executions = [makeExecution({ state })];
      expect(deriveRoomPhase({ status: "open" }, executions)).toBe("discussing");
    }
  });

  it("non-report executions in live states do not trigger concluding", () => {
    for (const kind of ["message", "summary", "focus"] as ModelExecution["resultKind"][]) {
      const executions = [makeExecution({ resultKind: kind, state: "running" })];
      expect(deriveRoomPhase({ status: "open" }, executions)).toBe("discussing");
    }
  });

  it("no executions → discussing", () => {
    expect(deriveRoomPhase({ status: "open" }, [])).toBe("discussing");
  });
});

describe("findLiveReportExecution", () => {
  it("only matches report kind in the three live states", () => {
    const live = makeExecution({ executionId: "live", state: "running" });
    const messageLive = makeExecution({
      executionId: "msg",
      resultKind: "message",
      state: "running",
    });
    const reportCommitted = makeExecution({
      executionId: "rep",
      state: "committed",
    });
    const found = findLiveReportExecution([messageLive, reportCommitted, live]);
    expect(found?.executionId).toBe("live");
  });

  it("returns undefined when none live", () => {
    expect(findLiveReportExecution([makeExecution({ state: "committed" })])).toBeUndefined();
  });

  it("returns the newest by createdAt when multiple live", () => {
    const older = makeExecution({
      executionId: "old",
      state: "running",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    const newer = makeExecution({
      executionId: "new",
      state: "prepared",
      createdAt: "2026-07-19T12:00:00.000Z",
    });
    expect(findLiveReportExecution([older, newer])?.executionId).toBe("new");
  });
});

describe("findFailedReportExecution", () => {
  it("matches failed/interrupted/discarded report executions only", () => {
    for (const state of ["failed", "interrupted", "discarded"] as ModelExecutionState[]) {
      const executions = [makeExecution({ state })];
      expect(findFailedReportExecution(executions)?.state).toBe(state);
    }
  });

  it("non-report failures are ignored", () => {
    const msgFail = makeExecution({
      resultKind: "message",
      state: "failed",
    });
    expect(findFailedReportExecution([msgFail])).toBeUndefined();
  });

  it("returns the newest by createdAt across multiple failures", () => {
    const earlier = makeExecution({
      executionId: "e1",
      state: "failed",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    const later = makeExecution({
      executionId: "e2",
      state: "interrupted",
      createdAt: "2026-07-19T12:00:00.000Z",
    });
    expect(findFailedReportExecution([earlier, later])?.executionId).toBe("e2");
  });
});

describe("canConcludeNow", () => {
  const base = {
    controlling: true,
    roomStatus: "open" as const,
    hasActiveExecution: false,
    hasLiveReport: false,
    hasCompletedRound: true,
  };

  it("all satisfied → true", () => {
    expect(canConcludeNow(base)).toBe(true);
  });

  it("not controlling → false", () => {
    expect(canConcludeNow({ ...base, controlling: false })).toBe(false);
  });

  it("concluded → false", () => {
    expect(canConcludeNow({ ...base, roomStatus: "concluded" })).toBe(false);
  });

  it("active round execution → false", () => {
    expect(canConcludeNow({ ...base, hasActiveExecution: true })).toBe(false);
  });

  it("live report in flight → false", () => {
    expect(canConcludeNow({ ...base, hasLiveReport: true })).toBe(false);
  });

  it("no completed round → false", () => {
    expect(canConcludeNow({ ...base, hasCompletedRound: false })).toBe(false);
  });
});

describe("reportFilename", () => {
  it("plain Chinese topic → <topic>-report.md", () => {
    expect(reportFilename("迁移方案讨论")).toBe("迁移方案讨论-report.md");
  });

  it("collapses filesystem-hostile chars and whitespace runs to single dashes", () => {
    expect(reportFilename("a/b:c*d?e<f>g|h")).toBe("a-b-c-d-e-f-g-h-report.md");
    expect(reportFilename("two   spaces\there")).toBe("two-spaces-here-report.md");
  });

  it("empty / whitespace-only topic → room-report.md", () => {
    expect(reportFilename("")).toBe("room-report.md");
    expect(reportFilename("   ")).toBe("room-report.md");
    expect(reportFilename('\\/:*?"<>|')).toBe("room-report.md");
  });

  it("truncates a long topic to 50 chars before suffixing", () => {
    const long = "x".repeat(120);
    const name = reportFilename(long);
    expect(name.endsWith("-report.md")).toBe(true);
    expect(name.length).toBe(50 + "-report.md".length);
  });
});

describe("roomModeLabel", () => {
  it("maps all three modes", () => {
    expect(roomModeLabel("brainstorm")).toBe("头脑风暴");
    expect(roomModeLabel("planning")).toBe("规划");
    expect(roomModeLabel("review")).toBe("评审");
  });

  it("matches ROOM_MODE_PILL exhaustively (one label per mode)", () => {
    const modes = ["brainstorm", "planning", "review"] as const;
    for (const mode of modes) {
      expect(roomModeLabel(mode)).toBe(ROOM_MODE_PILL[mode]);
    }
    expect(Object.keys(ROOM_MODE_PILL).sort()).toEqual(["brainstorm", "planning", "review"]);
  });
});

// F3 cross-room guard (useRoomReport / useRoomRecoveryFacts keepPreviousData
// leakage): both queryFn bodies call these exported pure guards so a stale
// placeholder from room A can never be served to room B's ReportView / recovery
// rendering. The guards are exercised directly here per the parseMaxRoundsInput
// precedent (QueryClient + fake-indexeddb hook harness stays out of unit scope).
// ExecutionDetail-style payloads are stubbed to just the slice each guard reads
// (roomId); the rest is irrelevant to the invariant.

describe("guardRoomScopedReport", () => {
  function makeReport(roomId: string) {
    return createDecisionReport({
      roomId,
      content: "决策报告正文",
      sourceExecutionId: "exec-1",
    });
  }

  it("returns the report when roomId matches", () => {
    const report = makeReport("room-A");
    expect(guardRoomScopedReport(report, "room-A")).toBe(report);
  });

  it("returns undefined when the report belongs to another room (stale placeholder)", () => {
    const report = makeReport("room-A");
    expect(guardRoomScopedReport(report, "room-B")).toBeUndefined();
  });

  it("returns undefined when roomId is undefined (no room selected yet)", () => {
    const report = makeReport("room-A");
    expect(guardRoomScopedReport(report, undefined)).toBeUndefined();
  });

  it("returns undefined when the report itself is undefined", () => {
    expect(guardRoomScopedReport(undefined, "room-A")).toBeUndefined();
    expect(guardRoomScopedReport(undefined, undefined)).toBeUndefined();
  });
});

describe("filterRoomScopedFacts", () => {
  function factsAll(roomId: string, n = 2) {
    return {
      executions: Array.from({ length: n }, () => ({ roomId })) as unknown as ModelExecution[],
      bindings: Array.from({ length: n }, () => ({ roomId })) as unknown as RuntimeBinding[],
      rounds: Array.from({ length: n }, () => ({ roomId })) as unknown as DiscussionRound[],
    };
  }

  function factsMixed(roomId: string, other: string) {
    return {
      executions: [{ roomId }, { roomId: other }] as unknown as ModelExecution[],
      bindings: [{ roomId }, { roomId: other }] as unknown as RuntimeBinding[],
      rounds: [{ roomId }, { roomId: other }] as unknown as DiscussionRound[],
    };
  }

  it("passes same-room facts through untouched (reference equal)", () => {
    const facts = factsAll("room-A");
    expect(filterRoomScopedFacts(facts, "room-A")).toBe(facts);
  });

  it("filters every array to empty when facts belong to another room", () => {
    const facts = factsAll("room-A");
    const filtered = filterRoomScopedFacts(facts, "room-B");
    expect(filtered.executions).toEqual([]);
    expect(filtered.bindings).toEqual([]);
    expect(filtered.rounds).toEqual([]);
  });

  it("filters every array to empty when roomId is undefined", () => {
    const facts = factsAll("room-A");
    const filtered = filterRoomScopedFacts(facts, undefined);
    expect(filtered.executions).toEqual([]);
    expect(filtered.bindings).toEqual([]);
    expect(filtered.rounds).toEqual([]);
  });

  it("drops only the foreign rows when facts are mixed (partial filtering)", () => {
    const mixed = {
      executions: [
        { roomId: "room-A" },
        { roomId: "room-B" },
        { roomId: "room-A" },
      ] as unknown as ModelExecution[],
      bindings: [{ roomId: "room-A" }] as unknown as RuntimeBinding[],
      rounds: [] as unknown as DiscussionRound[],
    };
    const filtered = filterRoomScopedFacts(mixed, "room-A");
    expect(filtered.executions.map((execution) => execution.roomId)).toEqual(["room-A", "room-A"]);
    expect(filtered.bindings.map((binding) => binding.roomId)).toEqual(["room-A"]);
    expect(filtered.rounds).toEqual([]);
  });

  it("a mixed placeholder under the original room is reduced to its same-room rows", () => {
    const facts = factsMixed("room-A", "room-OTHER");
    const filtered = filterRoomScopedFacts(facts, "room-A");
    expect(filtered.executions).toHaveLength(1);
    expect(filtered.executions[0]?.roomId).toBe("room-A");
    expect(filtered.bindings).toHaveLength(1);
    expect(filtered.rounds).toHaveLength(1);
  });

  it("empty facts pass through untouched when roomId matches", () => {
    const empty = {
      executions: [],
      bindings: [],
      rounds: [],
    } satisfies RoomRecoveryFacts;
    expect(filterRoomScopedFacts(empty, "room-A")).toBe(empty);
  });
});
