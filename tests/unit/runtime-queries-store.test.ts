import "fake-indexeddb/auto";

import { runtimeDb } from "@/lib/runtime-db";
import type {
  DecisionReport,
  DiscussionAgent,
  DiscussionMessage,
  DiscussionRoom,
  DiscussionRound,
  DiscussionSummary,
  Participant,
} from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";
import type { RuntimeBinding } from "@/models/discussion/runtime-binding";
import type { ExecutionProfileRecord } from "@/models/execution-profile";
import {
  type RoomRecoveryFacts,
  filterRoomScopedFacts,
  guardRoomScopedReport,
  keepScopedPlaceholder,
  runtimeKeys,
  useActiveRuntimeBindings,
  useAgents,
  useExecutionProfiles,
  useParticipants,
  useRoomRecoveryFacts,
  useRoomReport,
  useRoundExecutions,
  useRoundMessages,
  useRoundSummary,
  useRuntimeRoom,
  useRuntimeRooms,
  useRuntimeRounds,
} from "@/stores/runtime-queries";
import { QueryClient } from "@tanstack/react-query";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "./render-hook";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-05-01T00:00:00.000Z";
const T2 = "2026-08-01T00:00:00.000Z";

function room(id: string, lastActiveAt: string, topic: string): DiscussionRoom {
  return {
    id,
    topic,
    background: "",
    facilitatorParticipantId: "participant-z",
    runState: "idle",
    activeRoundId: id === "room-1" ? "round-b" : null,
    contextRevision: 1,
    contextDigest: `digest-${id}`,
    mode: "brainstorm",
    targetOutput: "",
    maxRounds: null,
    status: "open",
    createdAt: lastActiveAt,
    lastActiveAt,
  };
}

const roomOld = room("room-2", T0, "Older room");
const roomMid = room("room-1", T1, "Middle room");
const roomNew = room("room-3", T2, "Newest room");

function round(id: string, roomId: string, roundNumber: number): DiscussionRound {
  return {
    id,
    roomId,
    roundNumber,
    participantOrder: ["participant-z", "participant-a"],
    phase: roundNumber === 1 ? "running" : "completed",
    pausedFrom: null,
    pauseReason: null,
    nextParticipantIndex: 0,
    activeExecutionId: null,
    focusMessageId: null,
    createdAt: roundNumber === 1 ? T0 : T1,
    completedAt: roundNumber === 1 ? null : T1,
  };
}

const round1 = round("round-b", "room-1", 1);
const round2 = round("round-a", "room-1", 2);
const roundOther = round("round-9", "room-2", 1);

function message(
  id: string,
  roundId: string,
  createdAt: string,
  content: string,
  sourceExecutionId: string | null,
): DiscussionMessage {
  return {
    id,
    roomId: roundId === "round-9" ? "room-2" : "room-1",
    roundId,
    role: sourceExecutionId === null ? "user" : "participant",
    participantId: sourceExecutionId === null ? null : "participant-z",
    content,
    sourceExecutionId,
    createdAt,
  };
}

const messageEarly = message("message-z", "round-b", T0, "earlier words", null);
const messageLate = message("message-a", "round-b", T1, "later words", "exec-1");
const messageOther = message("message-other", "round-9", T2, "other room", "exec-9");

function participant(id: string, roomId: string, createdAt: string): Participant {
  return {
    id,
    roomId,
    agentId: id === "participant-a" ? "agent-b" : "agent-a",
    personaPrompt: "persona",
    executionProfileId: "profile-a",
    profileRevision: 1,
    profileDigest: "digest-profile",
    modelId: "grok-4",
    participantSnapshotDigest: `digest-${id}`,
    state: "active",
    createdAt,
    endedAt: null,
  };
}

const participantLate = participant("participant-a", "room-1", T1);
const participantEarly = participant("participant-z", "room-1", T0);
const participantOther = participant("participant-other", "room-2", T2);

function execution(executionId: string, roomId: string, roundId: string): ModelExecution {
  return {
    executionId,
    roomId,
    roundId,
    participantId: "participant-z",
    resultKind: "message",
    state: "committed",
    hostInstanceId: "host-1",
    executionScopeId: "scope-1",
    requestedModel: "grok-4",
    effectiveModel: "grok-4",
    dispatchState: "accepted",
    toolState: "none",
    contextRevision: 1,
    expectedRoomDigest: "digest-room-1",
    participantSnapshotDigest: "digest-participant-z",
    instructionDigest: "digest-instruction",
    contentDigest: `digest-${executionId}`,
    committedEntityType: "message",
    committedEntityId: "message-a",
    runtimeOutcome: null,
    usage: { inputTokens: 3, outputTokens: 5, costUsd: null },
    error: null,
    finalEventSeq: 4,
    ackState: "acknowledged",
    retryOfExecutionId: null,
    createdAt: T0,
    updatedAt: T1,
  };
}

const execA = execution("exec-a", "room-1", "round-b");
const execB = execution("exec-b", "room-1", "round-a");
const execOther = execution("exec-z", "room-2", "round-9");

function binding(id: string, roomId: string, state: RuntimeBinding["state"]): RuntimeBinding {
  return {
    id,
    roomId,
    scopeRequestId: `scope-req-${id}`,
    state,
    hostInstanceId: state === "creating" ? null : "host-1",
    executionScopeId: state === "creating" ? null : `scope-${id}`,
    controllerId: state === "active" ? "controller-1" : null,
    leaseEpoch: state === "active" ? 2 : null,
    createdAt: T0,
    updatedAt: T1,
  };
}

const bindingActive = binding("binding-a", "room-1", "active");
const bindingClosed = binding("binding-b", "room-1", "closed");
const bindingCreating = binding("binding-c", "room-1", "creating");
const bindingOtherActive = binding("binding-d", "room-2", "active");

const summary1: DiscussionSummary = {
  id: "summary-1",
  roomId: "room-1",
  roundId: "round-b",
  content: "Round one summary",
  sourceExecutionId: "exec-summary-1",
  generatedAt: T1,
};

const summaryOther: DiscussionSummary = {
  id: "summary-9",
  roomId: "room-2",
  roundId: "round-9",
  content: "Other summary",
  sourceExecutionId: "exec-summary-9",
  generatedAt: T2,
};

const report1: DecisionReport = {
  id: "report-1",
  roomId: "room-1",
  content: "Decision for room 1",
  sourceExecutionId: "exec-report-1",
  createdAt: T1,
};

const reportOther: DecisionReport = {
  id: "report-2",
  roomId: "room-2",
  content: "Decision for room 2",
  sourceExecutionId: "exec-report-2",
  createdAt: T2,
};

const agentA: DiscussionAgent = {
  id: "agent-a",
  name: "Ada",
  personaPrompt: "product",
  executionProfileId: "profile-a",
  modelId: "grok-4",
  color: "#112233",
  revision: 1,
  enabled: true,
  createdAt: T0,
  updatedAt: T1,
};

const agentB: DiscussionAgent = {
  id: "agent-b",
  name: "Bea",
  personaPrompt: "engineering",
  executionProfileId: "profile-b",
  modelId: "kimi",
  color: "#445566",
  revision: 2,
  enabled: false,
  createdAt: T0,
  updatedAt: T2,
};

const profileA: ExecutionProfileRecord = {
  id: "profile-a",
  name: "Claude",
  driverId: "claude-stream-json",
  installationId: "install-a",
  credentialMode: "installation-managed",
  options: { route: "cfuse" },
  revision: 1,
  createdAt: T0,
  updatedAt: T1,
};

const profileB: ExecutionProfileRecord = {
  id: "profile-b",
  name: "Grok",
  driverId: "grok-stream-json",
  installationId: "install-b",
  credentialMode: "installation-managed",
  options: {},
  revision: 3,
  createdAt: T0,
  updatedAt: T2,
};

interface Reads {
  rooms: ReturnType<typeof useRuntimeRooms>;
  room: ReturnType<typeof useRuntimeRoom>;
  rounds: ReturnType<typeof useRuntimeRounds>;
  messages: ReturnType<typeof useRoundMessages>;
  summary: ReturnType<typeof useRoundSummary>;
  participants: ReturnType<typeof useParticipants>;
  executions: ReturnType<typeof useRoundExecutions>;
  report: ReturnType<typeof useRoomReport>;
  recovery: ReturnType<typeof useRoomRecoveryFacts>;
  agents: ReturnType<typeof useAgents>;
  profiles: ReturnType<typeof useExecutionProfiles>;
  bindings: ReturnType<typeof useActiveRuntimeBindings>;
}

function useReads(roomId: string | undefined, roundId: string | undefined, tick: number): Reads {
  return {
    rooms: useRuntimeRooms(tick),
    room: useRuntimeRoom(roomId, tick),
    rounds: useRuntimeRounds(roomId, tick),
    messages: useRoundMessages(roundId, tick),
    summary: useRoundSummary(roundId, tick),
    participants: useParticipants(roomId, tick),
    executions: useRoundExecutions(roundId, tick),
    report: useRoomReport(roomId, tick),
    recovery: useRoomRecoveryFacts(roomId, tick),
    agents: useAgents(),
    profiles: useExecutionProfiles(),
    bindings: useActiveRuntimeBindings(tick),
  };
}

function mountReads(roomId: string | undefined, roundId: string | undefined, tick = 0) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
    },
  });
  return renderHook(() => useReads(roomId, roundId, tick), client);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  if (!predicate()) throw new Error(`timed out waiting for ${label}`);
}

async function resetDb(): Promise<void> {
  runtimeDb.close();
  await runtimeDb.delete();
  await runtimeDb.open();
}

describe("runtime query keys and room guards", () => {
  it("builds the shared runtime query keys", () => {
    expect(runtimeKeys.all).toEqual(["rt"]);
    expect(runtimeKeys.rooms).toEqual(["rt", "rooms"]);
    expect(runtimeKeys.room("room-1")).toEqual(["rt", "room", "room-1"]);
    expect(runtimeKeys.rounds("room-1")).toEqual(["rt", "rounds", "room-1"]);
    expect(runtimeKeys.round("round-1")).toEqual(["rt", "round", "round-1"]);
    expect(runtimeKeys.messages("round-1")).toEqual(["rt", "messages", "round-1"]);
    expect(runtimeKeys.summary("round-1")).toEqual(["rt", "summary", "round-1"]);
    expect(runtimeKeys.participants("room-1")).toEqual(["rt", "participants", "room-1"]);
    expect(runtimeKeys.executions("round-1")).toEqual(["rt", "executions", "round-1"]);
    expect(runtimeKeys.report("room-1")).toEqual(["rt", "report", "room-1"]);
    expect(runtimeKeys.recovery("room-1")).toEqual(["rt", "recovery", "room-1"]);
    expect(runtimeKeys.agents).toEqual(["rt", "agents"]);
    expect(runtimeKeys.profiles).toEqual(["rt", "profiles"]);
  });

  it("keeps a scoped placeholder only when the query key names that scope", () => {
    const keep = keepScopedPlaceholder<string | null>("room-1");
    expect(keep("body", { queryKey: ["rt", "room", "room-1", 3] })).toBe("body");
    expect(keep(null, { queryKey: ["rt", "summary", "room-1", 0] })).toBeNull();
    expect(keep("body", { queryKey: ["rt", "room", "room-2", 3] })).toBeUndefined();
    expect(keep("body", { queryKey: ["rt", "rounds", "none"] })).toBeUndefined();
    expect(keep(undefined, { queryKey: ["rt", "room", "room-1", 0] })).toBeUndefined();
    expect(keep("body", undefined)).toBeUndefined();
    expect(
      keepScopedPlaceholder<string>(undefined)("stale", { queryKey: ["rt", "room", "room-1", 0] }),
    ).toBeUndefined();
  });

  it("returns a report only when it belongs to the queried room", () => {
    expect(guardRoomScopedReport(report1, "room-1")).toBe(report1);
    expect(guardRoomScopedReport(report1, "room-2")).toBeUndefined();
    expect(guardRoomScopedReport(report1, undefined)).toBeUndefined();
    expect(guardRoomScopedReport(undefined, "room-1")).toBeUndefined();
    expect(guardRoomScopedReport(undefined, undefined)).toBeUndefined();
  });

  it("passes same-room recovery facts through and drops every other row", () => {
    const same = {
      executions: [execA],
      bindings: [bindingActive],
      rounds: [round1],
    } satisfies RoomRecoveryFacts;
    expect(filterRoomScopedFacts(same, "room-1")).toBe(same);

    const empty = { executions: [], bindings: [], rounds: [] } satisfies RoomRecoveryFacts;
    expect(filterRoomScopedFacts(empty, "room-1")).toBe(empty);

    const foreign = {
      executions: [execOther],
      bindings: [bindingOtherActive],
      rounds: [roundOther],
    } satisfies RoomRecoveryFacts;
    expect(filterRoomScopedFacts(foreign, "room-1")).toEqual({
      executions: [],
      bindings: [],
      rounds: [],
    });
    expect(filterRoomScopedFacts(foreign, undefined)).toEqual({
      executions: [],
      bindings: [],
      rounds: [],
    });

    const mixed = {
      executions: [execA, execOther],
      bindings: [bindingActive, bindingOtherActive],
      rounds: [round1, roundOther],
    } satisfies RoomRecoveryFacts;
    expect(filterRoomScopedFacts(mixed, "room-1")).toEqual({
      executions: [execA],
      bindings: [bindingActive],
      rounds: [round1],
    });
  });
});

describe("runtime query hooks", () => {
  let unmount: (() => void) | undefined;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await resetDb();
  });

  afterEach(async () => {
    unmount?.();
    unmount = undefined;
    runtimeDb.close();
    await runtimeDb.delete();
  });

  it("leaves id-scoped queries idle and returns empty catalogs when nothing is stored", async () => {
    const mounted = mountReads(undefined, undefined, 4);
    unmount = mounted.unmount;
    await waitFor(
      () =>
        mounted.read().rooms.isSuccess === true &&
        mounted.read().agents.isSuccess === true &&
        mounted.read().profiles.isSuccess === true &&
        mounted.read().bindings.isSuccess === true,
      "empty catalogs",
    );
    const value = mounted.read();

    expect(value.rooms.data).toEqual([]);
    expect(value.agents.data).toEqual([]);
    expect(value.profiles.data).toEqual([]);
    expect(value.bindings.data).toEqual([]);

    expect(value.room.status).toBe("pending");
    expect(value.room.fetchStatus).toBe("idle");
    expect(value.room.isFetched).toBe(false);
    expect(value.room.isLoading).toBe(false);
    expect(value.room.data).toBeUndefined();

    for (const query of [value.rounds, value.participants, value.report, value.recovery]) {
      expect(query.status).toBe("pending");
      expect(query.fetchStatus).toBe("idle");
      expect(query.isFetched).toBe(false);
      expect(query.data).toBeUndefined();
    }
    for (const query of [value.messages, value.summary, value.executions]) {
      expect(query.status).toBe("pending");
      expect(query.fetchStatus).toBe("idle");
      expect(query.isFetched).toBe(false);
      expect(query.data).toBeUndefined();
    }

    expect(
      mounted.client
        .getQueryCache()
        .findAll()
        .map((query) => query.queryKey),
    ).toEqual([
      ["rt", "rooms", 4],
      ["rt", "room", "none"],
      ["rt", "rounds", "none"],
      ["rt", "messages", "none"],
      ["rt", "summary", "none"],
      ["rt", "participants", "none"],
      ["rt", "executions", "none"],
      ["rt", "report", "none"],
      ["rt", "recovery", "none"],
      ["rt", "agents"],
      ["rt", "profiles"],
      ["rt", "active-bindings", 4],
    ]);
  });

  it("reads committed rooms, rounds, speech, reports, and active bindings", async () => {
    await runtimeDb.rooms.bulkAdd([roomOld, roomMid, roomNew]);
    await runtimeDb.rounds.bulkAdd([round2, roundOther, round1]);
    await runtimeDb.messages.bulkAdd([messageLate, messageOther, messageEarly]);
    await runtimeDb.participants.bulkAdd([participantLate, participantOther, participantEarly]);
    await runtimeDb.modelExecutions.bulkAdd([execB, execOther, execA]);
    await runtimeDb.runtimeBindings.bulkAdd([
      bindingClosed,
      bindingOtherActive,
      bindingCreating,
      bindingActive,
    ]);
    await runtimeDb.summaries.bulkAdd([summaryOther, summary1]);
    await runtimeDb.reports.bulkAdd([reportOther, report1]);
    await runtimeDb.agents.bulkAdd([agentB, agentA]);
    await runtimeDb.executionProfiles.bulkAdd([profileB, profileA]);

    const mounted = mountReads("room-1", "round-b", 2);
    unmount = mounted.unmount;
    await waitFor(() => {
      const value = mounted.read();
      return (
        value.rooms.isSuccess &&
        value.room.isSuccess &&
        value.rounds.isSuccess &&
        value.messages.isSuccess &&
        value.summary.isSuccess &&
        value.participants.isSuccess &&
        value.executions.isSuccess &&
        value.report.isSuccess &&
        value.recovery.isSuccess &&
        value.agents.isSuccess &&
        value.profiles.isSuccess &&
        value.bindings.isSuccess
      );
    }, "populated reads");
    const value = mounted.read();

    expect(value.rooms.data).toEqual([roomNew, roomMid, roomOld]);
    expect(value.room.data).toEqual(roomMid);
    expect(value.rounds.data).toEqual([round1, round2]);
    expect(value.messages.data).toEqual([messageEarly, messageLate]);
    expect(value.summary.data).toEqual(summary1);
    expect(value.participants.data).toEqual([participantEarly, participantLate]);
    expect(value.executions.data).toEqual([execA]);
    expect(value.report.data).toEqual(report1);
    expect(value.recovery.data).toEqual({
      executions: [execA, execB],
      bindings: [bindingActive, bindingClosed, bindingCreating],
      rounds: [round2, round1],
    });
    expect(value.agents.data).toEqual([agentA, agentB]);
    expect(value.profiles.data).toEqual([profileA, profileB]);
    expect(value.bindings.data).toEqual([bindingActive, bindingOtherActive]);
    expect(
      mounted.client.getQueryCache().find({ queryKey: runtimeKeys.room("room-1"), exact: false })
        ?.queryKey,
    ).toEqual(["rt", "room", "room-1", 2]);
  });

  it("returns an empty active-binding list when every binding is closed", async () => {
    await runtimeDb.runtimeBindings.bulkAdd([bindingClosed, bindingCreating]);
    const mounted = mountReads(undefined, undefined, 0);
    unmount = mounted.unmount;
    await waitFor(() => mounted.read().bindings.isSuccess, "closed bindings");
    expect(mounted.read().bindings.data).toEqual([]);
  });

  it("resolves a missing room as success with no row", async () => {
    const mounted = renderHook(
      () => useRuntimeRoom("room-missing"),
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
        },
      }),
    );
    unmount = mounted.unmount;
    await waitFor(() => mounted.read().isSuccess || mounted.read().isError, "missing room");
    expect(mounted.read().status).toBe("success");
    expect(mounted.read().data).toBeNull();
    expect(mounted.read().error).toBeNull();
  });

  it("resolves a round with no summary as success with no row", async () => {
    await runtimeDb.rounds.add(round1);
    const mounted = renderHook(
      () => useRoundSummary("round-b"),
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
        },
      }),
    );
    unmount = mounted.unmount;
    await waitFor(() => mounted.read().isSuccess || mounted.read().isError, "missing summary");
    expect(mounted.read().status).toBe("success");
    expect(mounted.read().data).toBeNull();
    expect(mounted.read().error).toBeNull();
  });

  it("resolves a room with no report as success with no row", async () => {
    await runtimeDb.rooms.add(roomMid);
    const mounted = renderHook(
      () => useRoomReport("room-1"),
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
        },
      }),
    );
    unmount = mounted.unmount;
    await waitFor(() => mounted.read().isSuccess || mounted.read().isError, "missing report");
    expect(mounted.read().status).toBe("success");
    expect(mounted.read().data).toBeNull();
    expect(mounted.read().error).toBeNull();
  });

  it("keeps rows across a tick bump and drops them when the room or round changes", async () => {
    await runtimeDb.rooms.bulkAdd([roomMid, roomOld]);
    await runtimeDb.rounds.bulkAdd([round1, roundOther]);
    await runtimeDb.messages.bulkAdd([messageEarly, messageOther]);
    await runtimeDb.participants.bulkAdd([participantEarly, participantOther]);
    await runtimeDb.modelExecutions.bulkAdd([execA, execOther]);
    await runtimeDb.runtimeBindings.bulkAdd([bindingActive, bindingOtherActive]);
    await runtimeDb.summaries.bulkAdd([summary1, summaryOther]);
    await runtimeDb.reports.bulkAdd([report1, reportOther]);

    const scope = { roomId: "room-1", roundId: "round-b", tick: 0 };
    let update: (() => void) | undefined;
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
      },
    });
    const mounted = renderHook(() => {
      const [, bump] = useState(0);
      update = () => bump((value) => value + 1);
      return useReads(scope.roomId, scope.roundId, scope.tick);
    }, client);
    unmount = mounted.unmount;

    await waitFor(() => {
      const value = mounted.read();
      return value.room.data?.id === "room-1" && value.summary.data?.roundId === "round-b";
    }, "room-1 scope loaded");

    const gate = holdDbReads();
    try {
      scope.roomId = "room-2";
      scope.roundId = "round-9";
      act(() => update?.());
      const fromSettled = mounted.read();
      expect(fromSettled.report.isPending).toBe(true);
      expect(fromSettled.report.isPlaceholderData).toBe(false);
      expect(fromSettled.recovery.isPending).toBe(true);
      expect(fromSettled.recovery.isPlaceholderData).toBe(false);

      scope.roomId = "room-1";
      scope.roundId = "round-b";
      act(() => update?.());
      scope.tick = 1;
      act(() => update?.());
      const bumped = mounted.read();
      expect(bumped.room.data).toEqual(roomMid);
      expect(bumped.room.isPlaceholderData).toBe(true);
      expect(bumped.rounds.data).toEqual([round1]);
      expect(bumped.messages.data).toEqual([messageEarly]);
      expect(bumped.summary.data).toEqual(summary1);
      expect(bumped.participants.data).toEqual([participantEarly]);
      expect(bumped.executions.data).toEqual([execA]);
      expect(bumped.report.data).toEqual(report1);
      expect(bumped.recovery.data?.executions).toEqual([execA]);

      scope.roomId = "room-2";
      scope.roundId = "round-9";
      act(() => update?.());
      const switched = mounted.read();
      expect(switched.room.data ?? null).toBeNull();
      expect(switched.room.isPending).toBe(true);
      expect(switched.room.isLoading).toBe(true);
      expect(switched.rounds.data ?? null).toBeNull();
      expect(switched.messages.data ?? null).toBeNull();
      expect(switched.summary.data ?? null).toBeNull();
      expect(switched.participants.data ?? null).toBeNull();
      expect(switched.executions.data ?? null).toBeNull();
      expect(switched.report.data ?? null).toBeNull();
      expect(switched.report.isPending).toBe(true);
      expect(switched.report.isPlaceholderData).toBe(false);
      expect(switched.recovery.data?.executions ?? []).toEqual([]);
      expect(switched.recovery.data?.rounds ?? []).toEqual([]);
      expect(switched.recovery.isPending).toBe(true);
      expect(switched.recovery.isPlaceholderData).toBe(false);

      gate.release();
      await waitFor(() => mounted.read().room.data?.id === "room-2", "room-2 scope loaded");
      const loaded = mounted.read();
      expect(loaded.room.data).toEqual(roomOld);
      expect(loaded.rounds.data).toEqual([roundOther]);
      expect(loaded.messages.data).toEqual([messageOther]);
      expect(loaded.summary.data).toEqual(summaryOther);
      expect(loaded.participants.data).toEqual([participantOther]);
      expect(loaded.executions.data).toEqual([execOther]);
      expect(loaded.report.data).toEqual(reportOther);
      expect(loaded.recovery.data?.rounds).toEqual([roundOther]);
      expect(loaded.recovery.data?.executions).toEqual([execOther]);
    } finally {
      gate.release();
      gate.restore();
    }
  });
});

function holdDbReads(): { release: () => void; restore: () => void } {
  let resolveGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  const tableProto = Object.getPrototypeOf(runtimeDb.rooms) as {
    get: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  };
  const collectionProto = Object.getPrototypeOf(
    runtimeDb.rounds.where("roomId").equals("none"),
  ) as {
    toArray: (this: unknown, ...args: unknown[]) => Promise<unknown>;
    first: (this: unknown, ...args: unknown[]) => Promise<unknown>;
  };
  const originalGet = tableProto.get;
  const originalToArray = collectionProto.toArray;
  const originalFirst = collectionProto.first;
  const wait = <T>(read: () => Promise<T>) => gate.then(read);
  tableProto.get = function (this: unknown, ...args: unknown[]) {
    return wait(() => originalGet.apply(this, args));
  };
  collectionProto.toArray = function (this: unknown, ...args: unknown[]) {
    return wait(() => originalToArray.apply(this, args));
  };
  collectionProto.first = function (this: unknown, ...args: unknown[]) {
    return wait(() => originalFirst.apply(this, args));
  };
  return {
    release: () => resolveGate?.(),
    restore: () => {
      tableProto.get = originalGet;
      collectionProto.toArray = originalToArray;
      collectionProto.first = originalFirst;
    },
  };
}
