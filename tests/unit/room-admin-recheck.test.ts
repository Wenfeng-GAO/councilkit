import "fake-indexeddb/auto";

import { activateRuntimeBinding, createRuntimeBindingTx } from "@/lib/discussion-transactions";
import { deleteRoomCascade, duplicateRoom, renameRoom } from "@/lib/room-admin";
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type {
  DiscussionAgent,
  DiscussionRoom,
  DiscussionRound,
  Participant,
} from "@/models/discussion/entities";
import {
  createDiscussionAgent,
  createDiscussionRoom,
  createModelExecution,
  createParticipant,
} from "@/models/discussion/factories";
import { type ExecutionProfileRecord, profileDigestOf } from "@/models/execution-profile";
import { initializeRoomDigest } from "@/orchestrator/context-snapshot";
import {
  type DiscussionOrchestrator,
  createDiscussionOrchestrator,
} from "@/orchestrator/discussion-orchestrator";
import type { RuntimeClient } from "@/runtime/client";
import { CREDENTIAL_MODE } from "@shared/runtime/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let db: CouncilKitRuntimeDB;

beforeEach(() => {
  db = new CouncilKitRuntimeDB(`test-${crypto.randomUUID()}`);
});

afterEach(async () => {
  await db.delete();
  db.close();
});

function now(): string {
  return new Date().toISOString();
}

function makeProfile(id: string): ExecutionProfileRecord {
  const ts = now();
  return {
    id,
    name: `Profile ${id}`,
    driverId: "codex-app-server",
    installationId: "inst-1",
    credentialMode: CREDENTIAL_MODE,
    options: {},
    revision: 1,
    createdAt: ts,
    updatedAt: ts,
  };
}

function makeOrchestrator(): DiscussionOrchestrator {
  const fake = {
    closeScope: vi.fn(async () => ({ scopeId: "scope-1", state: "closed" as const })),
    takeoverScope: vi.fn(async () => ({
      scopeId: "scope-1",
      controllerId: "ctrl-2",
      leaseEpoch: 2,
    })),
  } as unknown as RuntimeClient;
  return createDiscussionOrchestrator({ db, client: fake });
}

async function seedRoom(topic: string): Promise<{
  room: DiscussionRoom;
  agent: DiscussionAgent;
  participant: Participant;
}> {
  const profile = makeProfile(crypto.randomUUID());
  await db.executionProfiles.add(profile);
  const agent = createDiscussionAgent({
    name: "A1",
    personaPrompt: "A1 的人设",
    executionProfileId: profile.id,
    modelId: "model-a",
    color: "#a1b2c3",
  });
  await db.agents.add(agent);
  const room = initializeRoomDigest(
    createDiscussionRoom({ topic, background: "bg", facilitatorParticipantId: "pending" }),
  );
  await db.rooms.add(room);
  const participant = createParticipant({
    roomId: room.id,
    agent,
    profileDigest: profileDigestOf(profile),
  });
  await db.participants.add(participant);
  room.facilitatorParticipantId = participant.id;
  await db.rooms.put(room);
  return { room, agent, participant };
}

function makeRound(roomId: string, participantId: string): DiscussionRound {
  const ts = now();
  return {
    id: crypto.randomUUID(),
    roomId,
    roundNumber: 1,
    participantOrder: [participantId],
    phase: "paused",
    pausedFrom: "running",
    pauseReason: { code: "execution_failed", participantId },
    nextParticipantIndex: 1,
    activeExecutionId: null,
    focusMessageId: "seeded-focus",
    createdAt: ts,
    completedAt: null,
  };
}

describe("room-admin in-transaction rechecks", () => {
  it("refuses delete when a live execution appears after releaseRuntime", async () => {
    const seeded = await seedRoom("LiveRace");
    const orchestrator = makeOrchestrator();
    const original = orchestrator.releaseRuntime.bind(orchestrator);
    orchestrator.releaseRuntime = async (roomId: string) => {
      await original(roomId);
      const execution = createModelExecution({
        executionId: crypto.randomUUID(),
        roomId,
        roundId: "round-1",
        participantId: seeded.participant.id,
        resultKind: "message",
        requestedModel: "model-a",
        contextRevision: 0,
        expectedRoomDigest: "d",
        participantSnapshotDigest: seeded.participant.participantSnapshotDigest,
        instructionDigest: "i",
      });
      execution.state = "running";
      await db.modelExecutions.add(execution);
    };

    const error = await deleteRoomCascade(db, orchestrator, seeded.room.id).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: "ROOM_LIVE",
      message: "cannot delete while an execution is running",
    });
    expect(await db.rooms.get(seeded.room.id)).toMatchObject({ topic: "LiveRace" });
    expect(await db.modelExecutions.where("roomId").equals(seeded.room.id).count()).toBe(1);
  });

  it("refuses delete when an unresolved round appears after releaseRuntime", async () => {
    const seeded = await seedRoom("RoundRace");
    const orchestrator = makeOrchestrator();
    const original = orchestrator.releaseRuntime.bind(orchestrator);
    let roundId = "";
    orchestrator.releaseRuntime = async (roomId: string) => {
      await original(roomId);
      const round = makeRound(roomId, seeded.participant.id);
      roundId = round.id;
      await db.rounds.add(round);
      const room = (await db.rooms.get(roomId)) as DiscussionRoom;
      room.activeRoundId = round.id;
      await db.rooms.put(room);
    };

    const error = await deleteRoomCascade(db, orchestrator, seeded.room.id).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: "ROOM_LIVE",
      message: "cannot delete: an unresolved round remains",
    });
    const persisted = await db.rooms.get(seeded.room.id);
    expect(persisted?.topic).toBe("RoundRace");
    expect(persisted?.activeRoundId).toBe(roundId);
    expect(await db.rounds.get(roundId)).toMatchObject({ phase: "paused", roomId: seeded.room.id });
  });

  it("refuses duplicate when an active participant's agent row is gone", async () => {
    const seeded = await seedRoom("MissingAgent");
    await db.agents.delete(seeded.agent.id);
    const roomsBefore = await db.rooms.count();

    const error = await duplicateRoom(db, makeOrchestrator(), seeded.room.id).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: `unknown agent ${seeded.agent.id}`,
    });
    expect(await db.rooms.count()).toBe(roomsBefore);
    expect(await db.participants.where("roomId").equals(seeded.room.id).count()).toBe(1);
  });

  it("refuses a warm rename when the binding loses its controller during takeover", async () => {
    const seeded = await seedRoom("WarmStale");
    const binding = await createRuntimeBindingTx(db, {
      roomId: seeded.room.id,
      scopeRequestId: crypto.randomUUID(),
    });
    await activateRuntimeBinding(db, {
      id: binding.id,
      hostInstanceId: "host-1",
      executionScopeId: "scope-1",
      controllerId: "ctrl-1",
      leaseEpoch: 1,
    });
    const before = await db.rooms.get(seeded.room.id);
    const orchestrator = makeOrchestrator();
    const original = orchestrator.controlRoom.bind(orchestrator);
    orchestrator.controlRoom = async (roomId: string, signal?: AbortSignal) => {
      const handle = await original(roomId, signal);
      await db.runtimeBindings.update(binding.id, { controllerId: null, leaseEpoch: null });
      return handle;
    };

    const error = await renameRoom(db, orchestrator, seeded.room.id, "新名").catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: "STALE_CONTROLLER",
      message: "重命名期间运行时绑定已释放，请重试",
    });
    expect(await db.rooms.get(seeded.room.id)).toMatchObject({
      topic: "WarmStale",
      contextRevision: before?.contextRevision,
    });
  });

  it("refuses a cold rename when an active binding appears before the write", async () => {
    const seeded = await seedRoom("ColdRace");
    const before = await db.rooms.get(seeded.room.id);
    const original = db.transaction.bind(db);
    let injected = false;
    db.transaction = (async (...args: unknown[]) => {
      if (!injected && args[0] === "rw") {
        injected = true;
        const binding = await createRuntimeBindingTx(db, {
          roomId: seeded.room.id,
          scopeRequestId: crypto.randomUUID(),
        });
        await activateRuntimeBinding(db, {
          id: binding.id,
          hostInstanceId: "host-1",
          executionScopeId: "scope-raced",
          controllerId: "ctrl-raced",
          leaseEpoch: 4,
        });
        return Reflect.apply(original, undefined, args);
      }
      return Reflect.apply(original, undefined, args);
    }) as typeof db.transaction;

    const error = await renameRoom(db, makeOrchestrator(), seeded.room.id, "新名").catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      code: "STALE_CONTROLLER",
      message: "房间运行时已预热，请重试",
    });
    expect(await db.rooms.get(seeded.room.id)).toMatchObject({
      topic: "ColdRace",
      contextRevision: before?.contextRevision,
    });
    const raced = await db.runtimeBindings.where("roomId").equals(seeded.room.id).first();
    expect(raced).toMatchObject({ state: "active", controllerId: "ctrl-raced", leaseEpoch: 4 });
  });
});
