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
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type {
  DiscussionMessage,
  DiscussionRound,
  DiscussionSummary,
} from "@/models/discussion/entities";
import {
  TransactionError,
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
  it("opens with all nine tables, each writable and readable", async () => {
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
    ] as const) {
      expect(await table.get(id)).toBeTruthy();
    }
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
