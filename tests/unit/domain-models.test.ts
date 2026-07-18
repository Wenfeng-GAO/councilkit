import "fake-indexeddb/auto";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  activateRuntimeBinding,
  beginExecution,
  commitModelMessage,
  commitSummary,
  createRound,
  createRuntimeBindingTx,
  markExecutionDispatched,
  transitionRound,
} from "@/lib/discussion-transactions";
import { CouncilKitRuntimeDB, applyAgentV2Defaults, applyRoomV2Defaults } from "@/lib/runtime-db";
import type {
  DiscussionMessage,
  DiscussionRound,
  DiscussionSummary,
} from "@/models/discussion/entities";
import {
  TransactionError,
  createDecisionReport,
  createDiscussionAgent,
  createDiscussionRoom,
  createModelExecution,
  createParticipant,
  createRuntimeBinding,
  participantSnapshotDigestOf,
} from "@/models/discussion/factories";
import type { ExecutionProfileRecord } from "@/models/execution-profile";
import { computeInstructionDigest, initializeRoomDigest } from "@/orchestrator/context-snapshot";
import { CREDENTIAL_MODE } from "@shared/runtime/contracts";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Discussion domain models + Dexie schema (U4), driven against real Dexie on
 * fake-indexeddb: fresh schema, unique constraints, factory validation,
 * legacy-DB isolation and ModelExecution defaults.
 */

let db: CouncilKitRuntimeDB;

beforeEach(() => {
  db = new CouncilKitRuntimeDB(`test-${crypto.randomUUID()}`);
});

afterEach(async () => {
  await db.delete();
  db.close();
});

function expectThrowsCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TransactionError);
    expect((error as TransactionError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected TransactionError ${code}`);
}

function makeAgent(name: string) {
  return createDiscussionAgent({
    name,
    personaPrompt: `${name} persona`,
    executionProfileId: "prof-1",
    modelId: "model-a",
    color: "#a1b2c3",
  });
}

describe("fresh runtime DB schema", () => {
  it("opens with all ten tables, each writable and readable", async () => {
    await db.open();
    const tableNames = db.tables.map((table) => table.name);
    expect(tableNames).toEqual([
      "agents",
      "participants",
      "rooms",
      "rounds",
      "messages",
      "summaries",
      "modelExecutions",
      "runtimeBindings",
      "executionProfiles",
      "reports",
    ]);

    const agent = makeAgent("A1");
    await db.agents.add(agent);
    const room = initializeRoomDigest(
      createDiscussionRoom({ topic: "T", facilitatorParticipantId: "pending" }),
    );
    await db.rooms.add(room);
    const participant = createParticipant({ roomId: room.id, agent, profileDigest: "pd" });
    await db.participants.add(participant);
    const round: DiscussionRound = {
      id: "round-1",
      roomId: room.id,
      roundNumber: 1,
      participantOrder: [participant.id],
      phase: "pending",
      pausedFrom: null,
      pauseReason: null,
      nextParticipantIndex: 0,
      activeExecutionId: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    await db.rounds.add(round);
    const message: DiscussionMessage = {
      id: "m-1",
      roomId: room.id,
      roundId: round.id,
      role: "user",
      participantId: null,
      content: "hi",
      sourceExecutionId: null,
      createdAt: new Date().toISOString(),
    };
    await db.messages.add(message);
    const summary: DiscussionSummary = {
      id: "s-1",
      roomId: room.id,
      roundId: round.id,
      content: "sum",
      sourceExecutionId: "e-1",
      generatedAt: new Date().toISOString(),
    };
    await db.summaries.add(summary);
    const execution = createModelExecution({
      executionId: "e-1",
      roomId: room.id,
      roundId: round.id,
      participantId: participant.id,
      resultKind: "message",
      requestedModel: "model-a",
      contextRevision: room.contextRevision,
      expectedRoomDigest: room.contextDigest,
      participantSnapshotDigest: participant.participantSnapshotDigest,
      instructionDigest: computeInstructionDigest({ kind: "message", text: "go" }),
    });
    await db.modelExecutions.add(execution);
    const binding = createRuntimeBinding({ roomId: room.id, scopeRequestId: "req-1" });
    await db.runtimeBindings.add(binding);
    const profile: ExecutionProfileRecord = {
      id: "prof-1",
      name: "Profile",
      driverId: "claude-stream-json",
      installationId: "inst-1",
      credentialMode: CREDENTIAL_MODE,
      options: { route: "moonshot" },
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.executionProfiles.add(profile);
    const report = createDecisionReport({
      roomId: room.id,
      content: "ADR",
      sourceExecutionId: "e-report",
    });
    await db.reports.add(report);

    for (const [table, id] of [
      [db.agents, agent.id],
      [db.participants, participant.id],
      [db.rooms, room.id],
      [db.rounds, round.id],
      [db.messages, message.id],
      [db.summaries, summary.id],
      [db.modelExecutions, execution.executionId],
      [db.runtimeBindings, binding.id],
      [db.executionProfiles, profile.id],
      [db.reports, report.id],
    ] as const) {
      expect(await table.get(id)).toBeTruthy();
    }

    // reports.sourceExecutionId is a unique index (brief schema assertion).
    expect(db.reports.schema.indexes.map((i) => i.keyPath)).toContain("sourceExecutionId");
  });
});

describe("unique constraints", () => {
  it("messages.sourceExecutionId is unique but sparse for user messages", async () => {
    const base = {
      roomId: "room-1",
      roundId: "round-1",
      role: "participant" as const,
      participantId: "p-1",
      content: "c",
      createdAt: new Date().toISOString(),
    };
    await db.messages.add({ ...base, id: "m-1", sourceExecutionId: "e-1" });
    await expect(
      db.messages.add({ ...base, id: "m-2", sourceExecutionId: "e-1" }),
    ).rejects.toMatchObject({ name: "ConstraintError" });
    // null sourceExecutionId does not appear in the index: many user messages.
    await db.messages.add({
      ...base,
      id: "m-3",
      role: "user",
      participantId: null,
      sourceExecutionId: null,
    });
    await db.messages.add({
      ...base,
      id: "m-4",
      role: "user",
      participantId: null,
      sourceExecutionId: null,
    });
    expect(await db.messages.count()).toBe(3);
  });

  it("summaries.roundId is unique (one committed summary per round)", async () => {
    const base = {
      roomId: "room-1",
      content: "s",
      generatedAt: new Date().toISOString(),
    };
    await db.summaries.add({ ...base, id: "s-1", roundId: "round-1", sourceExecutionId: "e-1" });
    await expect(
      db.summaries.add({ ...base, id: "s-2", roundId: "round-1", sourceExecutionId: "e-2" }),
    ).rejects.toMatchObject({ name: "ConstraintError" });
    // A different round may take its own summary.
    await db.summaries.add({ ...base, id: "s-3", roundId: "round-2", sourceExecutionId: "e-2" });
    expect(await db.summaries.count()).toBe(2);
  });

  it("runtimeBindings.scopeRequestId is unique", async () => {
    await db.runtimeBindings.add(createRuntimeBinding({ roomId: "r-1", scopeRequestId: "req-1" }));
    await expect(
      db.runtimeBindings.add(createRuntimeBinding({ roomId: "r-2", scopeRequestId: "req-1" })),
    ).rejects.toMatchObject({ name: "ConstraintError" });
    expect(await db.runtimeBindings.count()).toBe(1);
  });

  it("reports.sourceExecutionId is unique", async () => {
    const base = { roomId: "room-1", content: "decision" };
    await db.reports.add({
      ...base,
      id: "r-1",
      sourceExecutionId: "e-1",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    await expect(
      db.reports.add({
        ...base,
        id: "r-2",
        sourceExecutionId: "e-1",
        createdAt: "2026-07-18T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ name: "ConstraintError" });
    // A different execution id may carry its own report.
    await db.reports.add({
      ...base,
      id: "r-3",
      sourceExecutionId: "e-2",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    expect(await db.reports.count()).toBe(2);
  });
});

describe("factory validation", () => {
  const validAgentInput = {
    name: "Agent",
    personaPrompt: "persona",
    executionProfileId: "prof-1",
    modelId: "model-a",
    color: "#a1b2c3",
  };

  it("createDiscussionAgent rejects empty name / empty persona / illegal color", () => {
    expectThrowsCode(() => createDiscussionAgent({ ...validAgentInput, name: "  " }), "INVALID");
    expectThrowsCode(
      () => createDiscussionAgent({ ...validAgentInput, personaPrompt: "" }),
      "INVALID",
    );
    expectThrowsCode(() => createDiscussionAgent({ ...validAgentInput, color: "red" }), "INVALID");
    expectThrowsCode(
      () => createDiscussionAgent({ ...validAgentInput, color: "#abcd" }),
      "INVALID",
    );
  });

  it("createRuntimeBinding rejects an empty scopeRequestId", () => {
    expectThrowsCode(() => createRuntimeBinding({ roomId: "r-1", scopeRequestId: "" }), "INVALID");
  });

  it("createParticipant snapshot digest is deterministic and matches participantSnapshotDigestOf", () => {
    const agent = makeAgent("A1");
    const first = createParticipant({ roomId: "r-1", agent, profileDigest: "pd" });
    const second = createParticipant({ roomId: "r-1", agent, profileDigest: "pd" });
    expect(first.participantSnapshotDigest).toBe(second.participantSnapshotDigest);
    expect(first.participantSnapshotDigest).toBe(
      participantSnapshotDigestOf({
        personaPrompt: agent.personaPrompt,
        executionProfileId: agent.executionProfileId,
        profileRevision: agent.revision,
        profileDigest: "pd",
        modelId: agent.modelId,
      }),
    );
  });
});

describe("legacy DB isolation", () => {
  it("a full two-round commit flow only ever opens the runtime DB, never legacy councilkit", async () => {
    // Record every IndexedDB open while driving a full discussion flow.
    const openedNames: string[] = [];
    const originalOpen = indexedDB.open;
    indexedDB.open = function (this: IDBFactory, name: string, version?: number) {
      openedNames.push(name);
      return originalOpen.call(this, name, version);
    } as typeof indexedDB.open;

    try {
      const agent1 = makeAgent("A1");
      const agent2 = makeAgent("A2");
      await db.agents.bulkAdd([agent1, agent2]);
      const room = initializeRoomDigest(
        createDiscussionRoom({ topic: "T", facilitatorParticipantId: "pending" }),
      );
      await db.rooms.add(room);
      const p1 = createParticipant({ roomId: room.id, agent: agent1, profileDigest: "pd" });
      const p2 = createParticipant({ roomId: room.id, agent: agent2, profileDigest: "pd" });
      await db.participants.bulkAdd([p1, p2]);
      room.facilitatorParticipantId = p1.id;
      await db.rooms.put(room);
      const binding = await createRuntimeBindingTx(db, {
        roomId: room.id,
        scopeRequestId: crypto.randomUUID(),
      });
      const activated = await activateRuntimeBinding(db, {
        id: binding.id,
        hostInstanceId: "host-1",
        executionScopeId: "scope-1",
        controllerId: "ctrl-1",
        leaseEpoch: 1,
      });
      const token = { controllerId: activated.controllerId as string, leaseEpoch: 1 };

      // Two full rounds: message commits by both participants + summary commit.
      for (const participantOrder of [
        [p1.id, p2.id],
        [p1.id, p2.id],
      ]) {
        const round = await createRound(db, { roomId: room.id, token, participantOrder });
        await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "prewarming" });
        await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "running" });
        // S2: a participant message may not begin until the facilitator focus
        // has landed. This round is driven by raw transactions (no orchestrator
        // focus path), so mark a placeholder focus to clear the FOCUS_REQUIRED
        // guard — mirroring seedRunning. No focus message is added, so the
        // legacy-DB-isolation assertions (messages=4, summaries=2) stay intact.
        await db.rounds.update(round.id, { focusMessageId: "seeded-focus" });
        for (const participant of [p1, p2]) {
          const freshRoom = await db.rooms.get(room.id);
          const execution = createModelExecution({
            executionId: crypto.randomUUID(),
            roomId: room.id,
            roundId: round.id,
            participantId: participant.id,
            resultKind: "message",
            requestedModel: "model-a",
            contextRevision: freshRoom?.contextRevision as number,
            expectedRoomDigest: freshRoom?.contextDigest as string,
            participantSnapshotDigest: participant.participantSnapshotDigest,
            instructionDigest: computeInstructionDigest({ kind: "message", text: "go" }),
          });
          await beginExecution(db, { execution, token });
          await markExecutionDispatched(db, {
            executionId: execution.executionId,
            hostInstanceId: "host-1",
            executionScopeId: "scope-1",
            dispatchState: "accepted",
          });
          const outcome = await commitModelMessage(db, {
            executionId: execution.executionId,
            token,
            content: `${participant.id} speaks`,
            effectiveModel: "model-a",
            usage: null,
            finalEventSeq: 1,
            dispatchState: "accepted",
            toolState: "none",
          });
          expect(outcome.outcome).toBe("committed");
        }
        const freshRoom = await db.rooms.get(room.id);
        const summaryExecution = createModelExecution({
          executionId: crypto.randomUUID(),
          roomId: room.id,
          roundId: round.id,
          participantId: p1.id,
          resultKind: "summary",
          requestedModel: "model-a",
          contextRevision: freshRoom?.contextRevision as number,
          expectedRoomDigest: freshRoom?.contextDigest as string,
          participantSnapshotDigest: p1.participantSnapshotDigest,
          instructionDigest: computeInstructionDigest({ kind: "summary", text: "summarize" }),
        });
        await beginExecution(db, { execution: summaryExecution, token });
        await markExecutionDispatched(db, {
          executionId: summaryExecution.executionId,
          hostInstanceId: "host-1",
          executionScopeId: "scope-1",
          dispatchState: "accepted",
        });
        const summaryOutcome = await commitSummary(db, {
          executionId: summaryExecution.executionId,
          token,
          content: "round summary",
          effectiveModel: "model-a",
          usage: null,
          finalEventSeq: 1,
          dispatchState: "accepted",
          toolState: "none",
        });
        expect(summaryOutcome.outcome).toBe("committed");
      }

      expect(await db.messages.count()).toBe(4);
      expect(await db.summaries.count()).toBe(2);
    } finally {
      indexedDB.open = originalOpen;
    }

    // Only the fresh test DB was ever opened; no legacy `councilkit` open.
    expect(openedNames.length).toBeGreaterThan(0);
    for (const name of openedNames) {
      expect(name).toBe(db.name);
    }
    expect(openedNames).not.toContain("councilkit");
  });

  it("runtime-db.ts source never imports the legacy db module (regression)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/lib/runtime-db.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain('"@/lib/db"');
    expect(source).not.toContain("'@/lib/db'");
  });
});

describe("createModelExecution defaults", () => {
  it("starts prepared / not_dispatched with null ack and no retry link", () => {
    const execution = createModelExecution({
      executionId: "e-1",
      roomId: "r-1",
      roundId: "round-1",
      participantId: "p-1",
      resultKind: "message",
      requestedModel: "model-a",
      contextRevision: 0,
      expectedRoomDigest: "digest",
      participantSnapshotDigest: "pdigest",
      instructionDigest: "idigest",
    });
    expect(execution.state).toBe("prepared");
    expect(execution.dispatchState).toBe("not_dispatched");
    expect(execution.ackState).toBeNull();
    expect(execution.retryOfExecutionId).toBeNull();
    expect(execution.committedEntityId).toBeNull();
    expect(execution.runtimeOutcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dexie v1 → v2 migration (ADR-0009 + handoff §S1).
// The v1 schema is frozen here to model a real legacy DB; opening the same DB
// name with CouncilKitRuntimeDB triggers the v2 upgrade.
// ---------------------------------------------------------------------------

/** A frozen v1 schema definition identical to the original pre-v2 runtime-db. */
const V1_STORES = {
  agents: "id, executionProfileId",
  participants: "id, roomId, agentId, state, [roomId+state]",
  rooms: "id, runState, lastActiveAt, activeRoundId",
  rounds: "id, roomId, roundNumber, phase, [roomId+phase]",
  messages: "id, roomId, roundId, &sourceExecutionId",
  summaries: "id, roomId, &roundId, &sourceExecutionId",
  modelExecutions:
    "executionId, roomId, roundId, participantId, state, ackState, retryOfExecutionId",
  runtimeBindings: "id, roomId, &scopeRequestId, state",
  executionProfiles: "id, driverId, installationId",
} as const;

/** Legacy v1 Room row: predates the four v2 fields. */
type V1Room = {
  id: string;
  topic: string;
  background: string;
  facilitatorParticipantId: string;
  runState: string;
  activeRoundId: string | null;
  contextRevision: number;
  contextDigest: string;
  createdAt: string;
  lastActiveAt: string;
};

/** Legacy v1 Agent row: predates `enabled`. */
type V1Agent = {
  id: string;
  name: string;
  personaPrompt: string;
  executionProfileId: string;
  modelId: string;
  color: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

describe("Dexie v1 → v2 migration", () => {
  it("backfills Room and Agent defaults and leaves every pre-existing row byte-identical", async () => {
    const dbName = `mig-${crypto.randomUUID()}`;

    // 1. Build a v1 legacy DB and write one row per table (v1-shaped Room/Agent
    //    deliberately OMIT the four/e one new fields).
    class V1DB extends Dexie {
      constructor(name: string) {
        super(name);
        this.version(1).stores({ ...V1_STORES });
      }
    }
    const v1 = new V1DB(dbName);
    await v1.open();

    const seededRoom: V1Room = {
      id: "room-1",
      topic: "Topic",
      background: "ctx",
      facilitatorParticipantId: "fac-1",
      runState: "idle",
      activeRoundId: null,
      contextRevision: 0,
      contextDigest: "digest",
      createdAt: "2026-07-17T00:00:00.000Z",
      lastActiveAt: "2026-07-17T00:00:00.000Z",
    };
    await v1.table("rooms").add(seededRoom);

    const seededAgent: V1Agent = {
      id: "agent-1",
      name: "Reviewer",
      personaPrompt: "persona",
      executionProfileId: "prof-1",
      modelId: "model-a",
      color: "#a1b2c3",
      revision: 1,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    await v1.table("agents").add(seededAgent);

    const seededRound: DiscussionRound = {
      id: "round-1",
      roomId: seededRoom.id,
      roundNumber: 1,
      participantOrder: ["p-1"],
      phase: "completed",
      pausedFrom: null,
      pauseReason: null,
      nextParticipantIndex: 1,
      activeExecutionId: null,
      createdAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T00:01:00.000Z",
    };
    await v1.table("rounds").add(seededRound);

    const seededUserMessage: DiscussionMessage = {
      id: "m-1",
      roomId: seededRoom.id,
      roundId: seededRound.id,
      role: "user",
      participantId: null,
      content: "hi",
      sourceExecutionId: null,
      createdAt: "2026-07-17T00:00:00.000Z",
    };
    await v1.table("messages").add(seededUserMessage);

    const seededParticipantMessage: DiscussionMessage = {
      id: "m-2",
      roomId: seededRoom.id,
      roundId: seededRound.id,
      role: "participant",
      participantId: "p-1",
      content: "hello",
      sourceExecutionId: "e-1",
      createdAt: "2026-07-17T00:00:30.000Z",
    };
    await v1.table("messages").add(seededParticipantMessage);

    const seededSummary: DiscussionSummary = {
      id: "s-1",
      roomId: seededRoom.id,
      roundId: seededRound.id,
      content: "summary",
      sourceExecutionId: "e-1",
      generatedAt: "2026-07-17T00:00:45.000Z",
    };
    await v1.table("summaries").add(seededSummary);

    const seededExecution = createModelExecution({
      executionId: "e-1",
      roomId: seededRoom.id,
      roundId: seededRound.id,
      participantId: "p-1",
      resultKind: "message",
      requestedModel: "model-a",
      contextRevision: seededRoom.contextRevision,
      expectedRoomDigest: seededRoom.contextDigest,
      participantSnapshotDigest: "pd",
      instructionDigest: computeInstructionDigest({ kind: "message", text: "go" }),
    });
    await v1.table("modelExecutions").add(seededExecution);

    const seededBinding = createRuntimeBinding({ roomId: seededRoom.id, scopeRequestId: "req-1" });
    await v1.table("runtimeBindings").add(seededBinding);

    const seededProfile: ExecutionProfileRecord = {
      id: "prof-1",
      name: "Profile",
      driverId: "claude-stream-json",
      installationId: "inst-1",
      credentialMode: CREDENTIAL_MODE,
      options: { route: "moonshot" },
      revision: 1,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    await v1.table("executionProfiles").add(seededProfile);

    const seededParticipant = {
      id: "p-1",
      roomId: seededRoom.id,
      agentId: seededAgent.id,
      personaPrompt: seededAgent.personaPrompt,
      executionProfileId: seededAgent.executionProfileId,
      profileRevision: 1,
      profileDigest: "pd",
      modelId: seededAgent.modelId,
      participantSnapshotDigest: "snap",
      state: "active",
      createdAt: "2026-07-17T00:00:00.000Z",
      endedAt: null,
    };
    await v1.table("participants").add(seededParticipant);

    v1.close();

    // 2. Re-open under the v2 schema and let the upgrade run.
    const db2 = new CouncilKitRuntimeDB(dbName);
    await db2.open();
    expect(db2.verno).toBe(2);

    // Room: four new fields backfilled; every pre-existing key byte-identical.
    const migratedRoom = await db2.rooms.get(seededRoom.id);
    expect(migratedRoom).not.toBeNull();
    expect(migratedRoom?.mode).toBe("brainstorm");
    expect(migratedRoom?.targetOutput).toBe("");
    expect(migratedRoom?.maxRounds).toBeNull();
    expect(migratedRoom?.status).toBe("open");
    // Strip the four v2 fields and confirm the v1 shape is untouched.
    expect({ ...migratedRoom }).toMatchObject(seededRoom);
    expect(Object.keys(migratedRoom as object).sort()).toEqual(
      [...Object.keys(seededRoom), "mode", "targetOutput", "maxRounds", "status"].sort(),
    );

    // Agent: enabled backfilled; everything else byte-identical.
    const migratedAgent = await db2.agents.get(seededAgent.id);
    expect(migratedAgent?.enabled).toBe(true);
    expect({ ...migratedAgent }).toMatchObject(seededAgent);
    expect(Object.keys(migratedAgent as object).sort()).toEqual(
      [...Object.keys(seededAgent), "enabled"].sort(),
    );

    // Every other table row unchanged.
    expect(await db2.rounds.get(seededRound.id)).toEqual(seededRound);
    expect(await db2.messages.get(seededUserMessage.id)).toEqual(seededUserMessage);
    expect(await db2.messages.get(seededParticipantMessage.id)).toEqual(seededParticipantMessage);
    expect(await db2.summaries.get(seededSummary.id)).toEqual(seededSummary);
    expect(await db2.modelExecutions.get(seededExecution.executionId)).toEqual(seededExecution);
    expect(await db2.runtimeBindings.get(seededBinding.id)).toEqual(seededBinding);
    expect(await db2.executionProfiles.get(seededProfile.id)).toEqual(seededProfile);
    expect(await db2.participants.get(seededParticipant.id)).toEqual(seededParticipant);

    // The reports table is brand-new and empty.
    expect(await db2.reports.count()).toBe(0);

    await db2.delete();
  });

  it("re-opening an already-migrated v2 database is a no-op", async () => {
    const dbName = `mig-${crypto.randomUUID()}`;

    class V1DB extends Dexie {
      constructor(name: string) {
        super(name);
        this.version(1).stores({ ...V1_STORES });
      }
    }
    const v1 = new V1DB(dbName);
    await v1.open();
    await v1.table("rooms").add({
      id: "room-1",
      topic: "Topic",
      background: "",
      facilitatorParticipantId: "fac-1",
      runState: "idle",
      activeRoundId: null,
      contextRevision: 0,
      contextDigest: "",
      createdAt: "2026-07-17T00:00:00.000Z",
      lastActiveAt: "2026-07-17T00:00:00.000Z",
      mode: "review", // explicit value; the upgrade must NOT overwrite it.
      targetOutput: "ADR",
      maxRounds: 3,
      status: "concluded",
    });
    await v1.table("agents").add({
      id: "agent-1",
      name: "A",
      personaPrompt: "p",
      executionProfileId: "prof-1",
      modelId: "model-a",
      color: "#a1b2c3",
      revision: 1,
      enabled: false,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });
    v1.close();

    // First open: runs the upgrade.
    {
      const first = new CouncilKitRuntimeDB(dbName);
      await first.open();
      expect(first.verno).toBe(2);
      const room = await first.rooms.get("room-1");
      expect(room?.mode).toBe("review");
      expect(room?.status).toBe("concluded");
      expect((await first.agents.get("agent-1"))?.enabled).toBe(false);
      first.close();
    }

    // Second open: upgrade does not re-run; values are stable.
    {
      const second = new CouncilKitRuntimeDB(dbName);
      await second.open();
      expect(second.verno).toBe(2);
      const room = await second.rooms.get("room-1");
      expect(room?.mode).toBe("review");
      expect(room?.targetOutput).toBe("ADR");
      expect(room?.maxRounds).toBe(3);
      expect(room?.status).toBe("concluded");
      expect((await second.agents.get("agent-1"))?.enabled).toBe(false);
      expect(await second.rooms.count()).toBe(1);
      expect(await second.agents.count()).toBe(1);
      await second.delete();
    }
  });
});

describe("migration backfill pure functions", () => {
  it("applyRoomV2Defaults fills missing fields with v2 defaults and preserves everything else", () => {
    const empty: Record<string, unknown> = {};
    applyRoomV2Defaults(empty);
    expect(empty).toEqual({
      mode: "brainstorm",
      targetOutput: "",
      maxRounds: null,
      status: "open",
    });

    const partial: Record<string, unknown> = {
      mode: "review",
      targetOutput: "x",
      custom: 1,
    };
    applyRoomV2Defaults(partial);
    // Explicit values are NOT overwritten; unknown keys are preserved; absent
    // keys still get defaults.
    expect(partial).toEqual({
      mode: "review",
      targetOutput: "x",
      custom: 1,
      maxRounds: null,
      status: "open",
    });
  });

  it("applyAgentV2Defaults fills enabled only when absent", () => {
    const empty: Record<string, unknown> = {};
    applyAgentV2Defaults(empty);
    expect(empty).toEqual({ enabled: true });

    const disabled: Record<string, unknown> = { enabled: false, name: "A" };
    applyAgentV2Defaults(disabled);
    expect(disabled).toEqual({ enabled: false, name: "A" });
  });
});
