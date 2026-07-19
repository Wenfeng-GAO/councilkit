import "fake-indexeddb/auto";

import { activateRuntimeBinding, createRuntimeBindingTx } from "@/lib/discussion-transactions";
import { deleteRoomCascade, duplicateRoom, renameRoom } from "@/lib/room-admin";
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type {
  DiscussionAgent,
  DiscussionMessage,
  DiscussionRoom,
  DiscussionRound,
  DiscussionSummary,
  Participant,
} from "@/models/discussion/entities";
import {
  createDecisionReport,
  createDiscussionAgent,
  createDiscussionRoom,
  createModelExecution,
  createParticipant,
  createRuntimeBinding,
  participantSnapshotDigestOf,
} from "@/models/discussion/factories";
import { type ExecutionProfileRecord, profileDigestOf } from "@/models/execution-profile";
import {
  computeContextDigest,
  initializeRoomDigest,
  projectSharedContext,
} from "@/orchestrator/context-snapshot";
import {
  type DiscussionOrchestrator,
  createDiscussionOrchestrator,
} from "@/orchestrator/discussion-orchestrator";
import type { RuntimeClient } from "@/runtime/client";
import { CREDENTIAL_MODE } from "@shared/runtime/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * room-admin (S7): cascade delete / duplicate / rename against real Dexie on
 * fake-indexeddb with a minimal fake client literal (closeScope/takeoverScope
 * only). Covers the plan-a §3 case list: table-zeroing with a control room,
 * warm-scope close ordering, cold idempotency, live-execution and
 * unresolved-round refusals, the legacy zero-read probe, duplicate field
 * fidelity with recomputed digests, facilitator remapping, source immutability,
 * and both rename branches.
 */

let db: CouncilKitRuntimeDB;

beforeEach(() => {
  db = new CouncilKitRuntimeDB(`test-${crypto.randomUUID()}`);
});

afterEach(async () => {
  await db.delete();
  db.close();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString();
}

function makeAgent(name: string, profileId: string): DiscussionAgent {
  return createDiscussionAgent({
    name,
    personaPrompt: `${name} 的人设`,
    executionProfileId: profileId,
    modelId: "model-a",
    color: "#a1b2c3",
  });
}

function makeProfile(id: string, revision = 1): ExecutionProfileRecord {
  const ts = now();
  return {
    id,
    name: `Profile ${id}`,
    driverId: "codex-app-server",
    installationId: "inst-1",
    credentialMode: CREDENTIAL_MODE,
    options: {},
    revision,
    createdAt: ts,
    updatedAt: ts,
  };
}

function makeOrchestrator(client?: Partial<RuntimeClient>): DiscussionOrchestrator {
  const fake = {
    closeScope: vi.fn(async () => ({ scopeId: "scope-1", state: "closed" as const })),
    takeoverScope: vi.fn(async () => ({
      scopeId: "scope-1",
      controllerId: "ctrl-2",
      leaseEpoch: 2,
    })),
    ...client,
  } as unknown as RuntimeClient;
  return createDiscussionOrchestrator({ db, client: fake });
}

interface SeededRoom {
  profile: ExecutionProfileRecord;
  agents: DiscussionAgent[];
  room: DiscussionRoom;
  participants: Participant[];
}

/** profile + N agents + N active participants + room (digest initialized),
 * facilitator = last participant by default. profileId defaults to a fresh
 * uuid so multiple seeds in one test never collide on the PK. */
async function seedRoom(
  topic: string,
  agentCount = 1,
  profileId = crypto.randomUUID(),
): Promise<SeededRoom> {
  const profile = makeProfile(profileId);
  await db.executionProfiles.add(profile);
  const agents = Array.from({ length: agentCount }, (_, index) =>
    makeAgent(`A${index + 1}`, profileId),
  );
  await db.agents.bulkAdd(agents);
  const room = initializeRoomDigest(
    createDiscussionRoom({ topic, background: "bg", facilitatorParticipantId: "pending" }),
  );
  await db.rooms.add(room);
  const participants = agents.map((agent) =>
    createParticipant({ roomId: room.id, agent, profileDigest: profileDigestOf(profile) }),
  );
  await db.participants.bulkAdd(participants);
  room.facilitatorParticipantId = (participants[participants.length - 1] as Participant).id;
  await db.rooms.put(room);
  return { profile, agents, room, participants };
}

function makeRound(
  roomId: string,
  participantId: string,
  phase: DiscussionRound["phase"],
): DiscussionRound {
  const ts = now();
  return {
    id: crypto.randomUUID(),
    roomId,
    roundNumber: 1,
    participantOrder: [participantId],
    phase,
    pausedFrom: phase === "paused" ? "running" : null,
    pauseReason: phase === "paused" ? { code: "execution_failed", participantId } : null,
    nextParticipantIndex: 1,
    activeExecutionId: null,
    focusMessageId: "seeded-focus",
    createdAt: ts,
    completedAt: phase === "completed" || phase === "aborted" ? ts : null,
  };
}

/** Seed one row into each of the 8 room-scoped tables (terminal states only,
 * so the release guards stay quiet). */
async function seedAllRoomTables(seeded: SeededRoom): Promise<void> {
  const { room, participants } = seeded;
  const participant = participants[0] as Participant;
  const round = makeRound(room.id, participant.id, "completed");
  await db.rounds.add(round);
  const message: DiscussionMessage = {
    id: crypto.randomUUID(),
    roomId: room.id,
    roundId: round.id,
    role: "participant",
    participantId: participant.id,
    content: "发言",
    sourceExecutionId: crypto.randomUUID(),
    createdAt: now(),
  };
  await db.messages.add(message);
  const summary: DiscussionSummary = {
    id: crypto.randomUUID(),
    roomId: room.id,
    roundId: round.id,
    content: "小结",
    sourceExecutionId: crypto.randomUUID(),
    generatedAt: now(),
  };
  await db.summaries.add(summary);
  const execution = createModelExecution({
    executionId: crypto.randomUUID(),
    roomId: room.id,
    roundId: round.id,
    participantId: participant.id,
    resultKind: "message",
    requestedModel: "model-a",
    contextRevision: room.contextRevision,
    expectedRoomDigest: room.contextDigest,
    participantSnapshotDigest: participant.participantSnapshotDigest,
    instructionDigest: "i",
  });
  execution.state = "committed";
  await db.modelExecutions.add(execution);
  // 终态（本 helper 的契约）：工厂产物的 "creating" 会触发 S7 fix-2 #1 的
  // 非 closed binding 复查，挡住删除。
  const releasedBinding = createRuntimeBinding({
    roomId: room.id,
    scopeRequestId: crypto.randomUUID(),
  });
  releasedBinding.state = "closed";
  await db.runtimeBindings.add(releasedBinding);
  await db.reports.add(
    createDecisionReport({
      roomId: room.id,
      content: "报告",
      sourceExecutionId: crypto.randomUUID(),
    }),
  );
}

const ROOM_SCOPED_TABLES = (database: CouncilKitRuntimeDB) =>
  [
    database.participants,
    database.rounds,
    database.messages,
    database.summaries,
    database.modelExecutions,
    database.runtimeBindings,
    database.reports,
  ] as const;

// ---------------------------------------------------------------------------
// deleteRoomCascade
// ---------------------------------------------------------------------------

describe("deleteRoomCascade", () => {
  it("级联删除后 8 表 roomId 行全归零，agents/executionProfiles 行数不变，对照房间完好", async () => {
    const target = await seedRoom("Target");
    await seedAllRoomTables(target);
    const control = await seedRoom("Control");
    await seedAllRoomTables(control);
    const agentsBefore = await db.agents.count();
    const profilesBefore = await db.executionProfiles.count();

    await deleteRoomCascade(db, makeOrchestrator(), target.room.id);

    expect(await db.rooms.get(target.room.id)).toBeUndefined();
    for (const table of ROOM_SCOPED_TABLES(db)) {
      expect(await table.where("roomId").equals(target.room.id).count()).toBe(0);
    }
    // Control room fully intact.
    expect(await db.rooms.get(control.room.id)).toBeDefined();
    for (const table of ROOM_SCOPED_TABLES(db)) {
      expect(await table.where("roomId").equals(control.room.id).count()).toBe(1);
    }
    // Global tables untouched (ruling #1: deleting their rows would strand
    // every Agent as 待绑定 — a misreading of the nine-table wording).
    expect(await db.agents.count()).toBe(agentsBefore);
    expect(await db.executionProfiles.count()).toBe(profilesBefore);
  });

  it("暖 scope 被关闭：closeScope 以 binding 的 controllerId/leaseEpoch 调用，且先于行删除", async () => {
    const seeded = await seedRoom("Warm");
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
    let roomPresentAtClose: boolean | null = null;
    const closeScope = vi.fn(async () => {
      roomPresentAtClose = (await db.rooms.get(seeded.room.id)) !== undefined;
      return { scopeId: "scope-1", state: "closed" as const };
    });
    await deleteRoomCascade(db, makeOrchestrator({ closeScope }), seeded.room.id);

    expect(closeScope).toHaveBeenCalledWith("scope-1", { controllerId: "ctrl-1", leaseEpoch: 1 });
    expect(roomPresentAtClose).toBe(true);
    expect(await db.rooms.get(seeded.room.id)).toBeUndefined();
    expect(await db.runtimeBindings.where("roomId").equals(seeded.room.id).count()).toBe(0);
  });

  it("冷房间（无 binding）删除幂等成功", async () => {
    const seeded = await seedRoom("Cold");
    await deleteRoomCascade(db, makeOrchestrator(), seeded.room.id);
    // Second delete: releaseRuntime would throw "unknown room" without the
    // idempotency short-circuit — must be a no-op instead.
    await deleteRoomCascade(db, makeOrchestrator(), seeded.room.id);
    expect(await db.rooms.get(seeded.room.id)).toBeUndefined();
  });

  it("活执行存在 → 拒绝且零删除", async () => {
    const seeded = await seedRoom("Live");
    const participant = seeded.participants[0] as Participant;
    const execution = createModelExecution({
      executionId: crypto.randomUUID(),
      roomId: seeded.room.id,
      roundId: "round-1",
      participantId: participant.id,
      resultKind: "message",
      requestedModel: "model-a",
      contextRevision: 0,
      expectedRoomDigest: "d",
      participantSnapshotDigest: participant.participantSnapshotDigest,
      instructionDigest: "i",
    });
    await db.modelExecutions.add(execution); // state "prepared" = live

    await expect(deleteRoomCascade(db, makeOrchestrator(), seeded.room.id)).rejects.toThrow(
      /running/,
    );
    expect(await db.rooms.get(seeded.room.id)).toBeDefined();
    expect(await db.modelExecutions.where("roomId").equals(seeded.room.id).count()).toBe(1);
  });

  it("paused active round → 拒绝（镜像 V1 unresolved 语义）", async () => {
    const seeded = await seedRoom("Paused");
    const participant = seeded.participants[0] as Participant;
    const round = makeRound(seeded.room.id, participant.id, "paused");
    await db.rounds.add(round);
    seeded.room.activeRoundId = round.id;
    await db.rooms.put(seeded.room);

    await expect(deleteRoomCascade(db, makeOrchestrator(), seeded.room.id)).rejects.toThrow(
      /unresolved/,
    );
    expect(await db.rooms.get(seeded.room.id)).toBeDefined();
    expect(await db.rounds.where("roomId").equals(seeded.room.id).count()).toBe(1);
  });

  it("legacy 探针零读取：删除/复制/重命名全程只打开测试库", async () => {
    const openedNames: string[] = [];
    const originalOpen = indexedDB.open;
    indexedDB.open = function (this: IDBFactory, name: string, version?: number) {
      openedNames.push(name);
      return originalOpen.call(this, name, version);
    } as typeof indexedDB.open;

    try {
      const seeded = await seedRoom("Probe");
      await renameRoom(db, makeOrchestrator(), seeded.room.id, "改名");
      const copyId = await duplicateRoom(db, makeOrchestrator(), seeded.room.id);
      await deleteRoomCascade(db, makeOrchestrator(), seeded.room.id);
      await deleteRoomCascade(db, makeOrchestrator(), copyId);
    } finally {
      indexedDB.open = originalOpen;
    }

    expect(openedNames.length).toBeGreaterThan(0);
    for (const name of openedNames) {
      expect(name).toBe(db.name);
    }
    expect(openedNames).not.toContain("councilkit");
  });
});

// ---------------------------------------------------------------------------
// 死房不得有 binding (S7 R1): 删除 ⇄ 并发 startRound 的孤儿 Scope 封堵
// ---------------------------------------------------------------------------

describe("runtime binding 房间存在性复查 (S7 R1)", () => {
  it("删除提交后 createRuntimeBindingTx 拒建（ROOM_NOT_FOUND），无 zombie binding 行", async () => {
    const seeded = await seedRoom("Doomed");
    await deleteRoomCascade(db, makeOrchestrator(), seeded.room.id);

    // 另一页面的 startRound 在删除提交后才到达事务层：必须被拒。
    await expect(
      createRuntimeBindingTx(db, {
        roomId: seeded.room.id,
        scopeRequestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    expect(await db.runtimeBindings.where("roomId").equals(seeded.room.id).count()).toBe(0);
    // 登记：若 Host createScope 与删除提交交错（Dexie 拒建但 Host 已建 scope），
    // 该 Host 侧 scope 残余由 idle TTL 兜底回收，UI 无需也无法释放它。
  });

  it("release 后并发启动交错（S7 fix-2 #1）：删除事务复查非 closed binding → 拒删且零删除", async () => {
    const seeded = await seedRoom("Interleaved");
    const orchestrator = makeOrchestrator();
    const originalRelease = orchestrator.releaseRuntime.bind(orchestrator);
    // 模拟并发 startRound：releaseRuntime 返回后、删除事务开始前完成 binding
    // 创建（Host scope 激活被同一复查挡住——active 同样是非 closed）。
    orchestrator.releaseRuntime = async (roomId: string) => {
      await originalRelease(roomId);
      await createRuntimeBindingTx(db, { roomId, scopeRequestId: crypto.randomUUID() });
    };

    const error = await deleteRoomCascade(db, orchestrator, seeded.room.id).catch(
      (caught) => caught,
    );
    expect(error).toMatchObject({ code: "ROOM_LIVE" });
    expect(error.message).toContain("a runtime binding is active or being created");

    // 零删除：房、Participant 与并发创建的 binding 全部保留（可解释、可重试）。
    expect(await db.rooms.get(seeded.room.id)).toBeDefined();
    expect(await db.participants.where("roomId").equals(seeded.room.id).count()).toBe(1);
    const bindings = await db.runtimeBindings.where("roomId").equals(seeded.room.id).toArray();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.state).toBe("creating");
  });

  it("activateRuntimeBinding 复查：房已删的 creating binding 拒激活且状态不被推进", async () => {
    const seeded = await seedRoom("Vanished");
    const binding = await createRuntimeBindingTx(db, {
      roomId: seeded.room.id,
      scopeRequestId: crypto.randomUUID(),
    });
    // 模拟删除与激活交错后的发散状态：binding 行残留而房行已删
    // （级联删除正常会一并清 binding；此守卫防御的是任何绕开级联的路径）。
    await db.rooms.delete(seeded.room.id);

    await expect(
      activateRuntimeBinding(db, {
        id: binding.id,
        hostInstanceId: "host-1",
        executionScopeId: "scope-orphan",
        controllerId: "ctrl-1",
        leaseEpoch: 1,
      }),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
    const persisted = await db.runtimeBindings.get(binding.id);
    expect(persisted?.state).toBe("creating");
    expect(persisted?.executionScopeId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// duplicateRoom
// ---------------------------------------------------------------------------

describe("duplicateRoom", () => {
  it("字段全拷（topic+（副本）/background/mode/targetOutput/maxRounds）、零消息零轮次、revision=0 且 contextDigest=空投影 digest", async () => {
    const seeded = await seedRoom("原始话题");
    await seedAllRoomTables(seeded);
    seeded.room.contextRevision = 7;
    seeded.room.mode = "planning";
    seeded.room.targetOutput = "一份计划";
    seeded.room.maxRounds = 3;
    await db.rooms.put(seeded.room);

    const newId = await duplicateRoom(db, makeOrchestrator(), seeded.room.id);
    const copy = await db.rooms.get(newId);
    expect(copy?.topic).toBe("原始话题（副本）");
    expect(copy?.background).toBe("bg");
    expect(copy?.mode).toBe("planning");
    expect(copy?.targetOutput).toBe("一份计划");
    expect(copy?.maxRounds).toBe(3);
    expect(copy?.status).toBe("open");
    expect(copy?.contextRevision).toBe(0);
    expect(copy?.contextDigest).toBe(
      computeContextDigest(
        projectSharedContext({ topic: "原始话题（副本）", background: "bg" }, [], []),
      ),
    );
    // No discussion facts are copied.
    for (const table of [
      db.rounds,
      db.messages,
      db.summaries,
      db.modelExecutions,
      db.runtimeBindings,
      db.reports,
    ] as const) {
      expect(await table.where("roomId").equals(newId).count()).toBe(0);
    }
  });

  it("新 Participant 的 digest 按复制时的 Profile revision 现算", async () => {
    const seeded = await seedRoom("Digest");
    const agent = seeded.agents[0] as DiscussionAgent;
    const sourceParticipant = seeded.participants[0] as Participant;
    expect(sourceParticipant.profileRevision).toBe(1);
    // Edit the Profile AFTER the source room joined: the duplicate must use
    // the CURRENT revision/options, not the source snapshot.
    const updated: ExecutionProfileRecord = {
      ...seeded.profile,
      options: { reasoningEffort: "high" },
      revision: 2,
      updatedAt: now(),
    };
    await db.executionProfiles.put(updated);

    const newId = await duplicateRoom(db, makeOrchestrator(), seeded.room.id);
    const [copyParticipant] = await db.participants.where("roomId").equals(newId).toArray();
    expect(copyParticipant?.profileDigest).toBe(profileDigestOf(updated));
    expect(copyParticipant?.participantSnapshotDigest).toBe(
      participantSnapshotDigestOf({
        personaPrompt: agent.personaPrompt,
        executionProfileId: agent.executionProfileId,
        profileRevision: agent.revision,
        profileDigest: profileDigestOf(updated),
        modelId: agent.modelId,
      }),
    );
    expect(copyParticipant?.participantSnapshotDigest).not.toBe(
      sourceParticipant.participantSnapshotDigest,
    );
  });

  it("facilitator 指向新房同 agent 的新 Participant id", async () => {
    const seeded = await seedRoom("Facilitator", 2);
    const sourceFacilitator = seeded.participants[1] as Participant;
    expect(seeded.room.facilitatorParticipantId).toBe(sourceFacilitator.id);

    const newId = await duplicateRoom(db, makeOrchestrator(), seeded.room.id);
    const copy = await db.rooms.get(newId);
    const copyParticipants = await db.participants.where("roomId").equals(newId).toArray();
    expect(copyParticipants).toHaveLength(2);
    const facilitator = copyParticipants.find((p) => p.id === copy?.facilitatorParticipantId);
    expect(facilitator).toBeDefined();
    expect(facilitator?.agentId).toBe(sourceFacilitator.agentId);
    expect(facilitator?.id).not.toBe(sourceFacilitator.id);
  });

  it("源房间与其 Participant 行零变化；Agent/Profile 零新行", async () => {
    const seeded = await seedRoom("Immutable", 2);
    const roomBefore = await db.rooms.get(seeded.room.id);
    const participantsBefore = await db.participants
      .where("roomId")
      .equals(seeded.room.id)
      .toArray();
    const agentsBefore = await db.agents.count();
    const profilesBefore = await db.executionProfiles.count();

    await duplicateRoom(db, makeOrchestrator(), seeded.room.id);

    expect(await db.rooms.get(seeded.room.id)).toEqual(roomBefore);
    expect(await db.participants.where("roomId").equals(seeded.room.id).toArray()).toEqual(
      participantsBefore,
    );
    expect(await db.agents.count()).toBe(agentsBefore);
    expect(await db.executionProfiles.count()).toBe(profilesBefore);
  });

  it("未知房间 → ROOM_NOT_FOUND；Profile 缺失 → 诚实失败且零新房间", async () => {
    await expect(duplicateRoom(db, makeOrchestrator(), "nope")).rejects.toMatchObject({
      code: "ROOM_NOT_FOUND",
    });

    const seeded = await seedRoom("Unbound");
    const roomsBefore = await db.rooms.count();
    await db.executionProfiles.delete(seeded.profile.id); // 源房间变成含待绑定 Agent
    await expect(duplicateRoom(db, makeOrchestrator(), seeded.room.id)).rejects.toMatchObject({
      code: "PROFILE_NOT_FOUND",
    });
    expect(await db.rooms.count()).toBe(roomsBefore);
  });

  it("S7 R2：复制窗口内 Agent 改绑 → CONCURRENT_MODIFICATION，新房已清理，源房零影响", async () => {
    const seeded = await seedRoom("Raced", 2);
    const otherProfile = makeProfile(crypto.randomUUID());
    await db.executionProfiles.add(otherProfile);
    const roomsBefore = await db.rooms.count();
    const participantsBefore = await db.participants.count();
    const sourceRoomBefore = await db.rooms.get(seeded.room.id);
    const sourceParticipantsBefore = await db.participants
      .where("roomId")
      .equals(seeded.room.id)
      .toArray();

    // 在首次 joinAgent 之后注入「另一页面的合法改绑」（executionProfileId +
    // revision 双变），正好落在快照读与校验读之间的窗口内。joins 顺序由
    // Participant.createdAt 决定（同毫秒时比较器会反转），故记录实际被改的
    // agentId 而非假定 agents[0]。
    const orchestrator = makeOrchestrator();
    const originalJoin = orchestrator.joinAgent.bind(orchestrator);
    const mutatedAgentIds: string[] = [];
    orchestrator.joinAgent = async (roomId: string, agentId: string, profileDigest: string) => {
      const participant = await originalJoin(roomId, agentId, profileDigest);
      if (mutatedAgentIds.length === 0) {
        mutatedAgentIds.push(agentId);
        const agent = (await db.agents.get(agentId)) as DiscussionAgent;
        await db.agents.put({
          ...agent,
          executionProfileId: otherProfile.id,
          revision: agent.revision + 1,
          updatedAt: now(),
        });
      }
      return participant;
    };

    const error = await duplicateRoom(db, orchestrator, seeded.room.id).catch((caught) => caught);
    expect(error).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect(error.message).toContain("agent changed during duplicate; retry");

    // 新房级联清理干净：rooms/participants 行数回到复制前。
    expect(await db.rooms.count()).toBe(roomsBefore);
    expect(await db.participants.count()).toBe(participantsBefore);
    // 源房与其 Participant 零影响。
    expect(await db.rooms.get(seeded.room.id)).toEqual(sourceRoomBefore);
    expect(await db.participants.where("roomId").equals(seeded.room.id).toArray()).toEqual(
      sourceParticipantsBefore,
    );
    // 注入的并发改绑本身不被回滚（那是另一页面的合法写入）。
    expect(mutatedAgentIds).toHaveLength(1);
    const rebound = await db.agents.get(mutatedAgentIds[0] as string);
    expect(rebound?.executionProfileId).toBe(otherProfile.id);
  });

  it("S7 fix-2 #2：校验失败清理是真级联——窗口内启动新房的 round/binding/execution 全归零，Host scope 被关闭", async () => {
    const seeded = await seedRoom("CascadeCleanup");
    const otherProfile = makeProfile(crypto.randomUUID());
    await db.executionProfiles.add(otherProfile);

    let newRoomId = "";
    let injectedBindingId = "";
    let bindingStateAtClose: string | null = null;
    const closeScope = vi.fn(async () => {
      // releaseRuntime 先于删除事务关闭 Host scope：此刻 binding 行必须已 closed。
      bindingStateAtClose = (await db.runtimeBindings.get(injectedBindingId))?.state ?? null;
      return { scopeId: "scope-dup", state: "closed" as const };
    });
    const orchestrator = makeOrchestrator({ closeScope });
    const originalJoin = orchestrator.joinAgent.bind(orchestrator);
    orchestrator.joinAgent = async (roomId: string, agentId: string, profileDigest: string) => {
      const participant = await originalJoin(roomId, agentId, profileDigest);
      if (!newRoomId) {
        newRoomId = roomId;
        // ① 另一页面的合法改绑（executionProfileId + revision 双变 → drift）。
        const agent = (await db.agents.get(agentId)) as DiscussionAgent;
        await db.agents.put({
          ...agent,
          executionProfileId: otherProfile.id,
          revision: agent.revision + 1,
          updatedAt: now(),
        });
        // ② 新房在校验前已可见可启动（joinAgent 触发刷新）：终态 round +
        // committed execution + 已激活 binding（暖 Host scope）。
        const round = makeRound(roomId, participant.id, "completed");
        await db.rounds.add(round);
        const execution = createModelExecution({
          executionId: crypto.randomUUID(),
          roomId,
          roundId: round.id,
          participantId: participant.id,
          resultKind: "message",
          requestedModel: "model-a",
          contextRevision: 0,
          expectedRoomDigest: "d",
          participantSnapshotDigest: participant.participantSnapshotDigest,
          instructionDigest: "i",
        });
        execution.state = "committed";
        await db.modelExecutions.add(execution);
        const binding = await createRuntimeBindingTx(db, {
          roomId,
          scopeRequestId: crypto.randomUUID(),
        });
        await activateRuntimeBinding(db, {
          id: binding.id,
          hostInstanceId: "host-1",
          executionScopeId: "scope-dup",
          controllerId: "ctrl-dup",
          leaseEpoch: 1,
        });
        injectedBindingId = binding.id;
      }
      return participant;
    };

    const error = await duplicateRoom(db, orchestrator, seeded.room.id).catch((caught) => caught);
    expect(error).toMatchObject({ code: "CONCURRENT_MODIFICATION" });

    // 真级联：releaseRuntime 先关闭暖 Host scope（binding → closed，不残留到
    // idle TTL），删除事务再把 8 个 room 作用域表全清零。
    expect(closeScope).toHaveBeenCalledWith("scope-dup", {
      controllerId: "ctrl-dup",
      leaseEpoch: 1,
    });
    expect(bindingStateAtClose).toBe("closed");
    expect(await db.rooms.get(newRoomId)).toBeUndefined();
    for (const table of ROOM_SCOPED_TABLES(db)) {
      expect(await table.where("roomId").equals(newRoomId).count()).toBe(0);
    }
    // 源房与其 Participant 零影响；注入的改绑不被回滚。
    expect(await db.rooms.get(seeded.room.id)).toBeDefined();
    expect(await db.participants.where("roomId").equals(seeded.room.id).count()).toBe(1);
    const rebound = await db.agents.get((seeded.agents[0] as DiscussionAgent).id);
    expect(rebound?.executionProfileId).toBe(otherProfile.id);
  });

  it("S7 fix-3 #1：drift 清理撞上新房真实启动（running execution + activeRoundId）→ 复合可解释错误，新房及其现场完整保留，源房零影响", async () => {
    const seeded = await seedRoom("CleanupRefused", 1);
    const otherProfile = makeProfile(crypto.randomUUID());
    await db.executionProfiles.add(otherProfile);
    const sourceRoomBefore = await db.rooms.get(seeded.room.id);
    const sourceParticipantsBefore = await db.participants
      .where("roomId")
      .equals(seeded.room.id)
      .toArray();

    let newRoomId = "";
    let injectedRoundId = "";
    let injectedExecutionId = "";
    // closeScope 不应被调用到（活执行让 releaseRuntime 早抛，根本到不了 Host 关闭）。
    const closeScope = vi.fn(async () => ({ scopeId: "scope-dup", state: "closed" as const }));
    const orchestrator = makeOrchestrator({ closeScope });
    const originalJoin = orchestrator.joinAgent.bind(orchestrator);
    orchestrator.joinAgent = async (roomId: string, agentId: string, profileDigest: string) => {
      const participant = await originalJoin(roomId, agentId, profileDigest);
      if (!newRoomId) {
        newRoomId = roomId;
        // ① 另一页面的合法改绑（双变 → drift 触发清理）。
        const agent = (await db.agents.get(agentId)) as DiscussionAgent;
        await db.agents.put({
          ...agent,
          executionProfileId: otherProfile.id,
          revision: agent.revision + 1,
          updatedAt: now(),
        });
        // ② 新房真实启动：activeRoundId 指向 running round + 一条 running execution。
        // 这是需求里的「真实路径」——有别于 fix-2 用例的 completed round / committed
        // execution / 无 activeRoundId（那绕开了 releaseRuntime 拒删支路）。
        const round = makeRound(roomId, participant.id, "running");
        injectedRoundId = round.id;
        await db.rounds.add(round);
        const execution = createModelExecution({
          executionId: crypto.randomUUID(),
          roomId,
          roundId: round.id,
          participantId: participant.id,
          resultKind: "message",
          requestedModel: "model-a",
          contextRevision: 0,
          expectedRoomDigest: "d",
          participantSnapshotDigest: participant.participantSnapshotDigest,
          instructionDigest: "i",
        });
        execution.state = "running"; // 真实活执行
        injectedExecutionId = execution.executionId;
        await db.modelExecutions.add(execution);
        const freshRoom = (await db.rooms.get(roomId)) as DiscussionRoom;
        freshRoom.activeRoundId = round.id;
        await db.rooms.put(freshRoom);
      }
      return participant;
    };

    const error = await duplicateRoom(db, orchestrator, seeded.room.id).catch((caught) => caught);

    // 复合可解释错误：CONCURRENT_MODIFICATION + 如实命名残留新房 id + 人工清理指引。
    expect(error).toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    expect(newRoomId.length).toBeGreaterThan(0);
    expect(error.message).toContain(newRoomId);
    expect(error.message).toContain("could not be auto-removed");
    expect(error.message).toContain("stop it and delete it manually");

    // 新房及其现场完整保留（可解释残留，非静默）：房 + running round + running execution。
    expect(await db.rooms.get(newRoomId)).toBeDefined();
    expect(await db.rounds.get(injectedRoundId)).toBeDefined();
    const persistedExecution = await db.modelExecutions.get(injectedExecutionId);
    expect(persistedExecution?.state).toBe("running");

    // Host scope 未被关闭（清理在 releaseRuntime 阶段即被活执行拒绝，根本到不了 closeScope）。
    expect(closeScope).not.toHaveBeenCalled();

    // 源房与其 Participant 零影响；注入改绑不被回滚。
    expect(await db.rooms.get(seeded.room.id)).toEqual(sourceRoomBefore);
    expect(await db.participants.where("roomId").equals(seeded.room.id).toArray()).toEqual(
      sourceParticipantsBefore,
    );
    const rebound = await db.agents.get((seeded.agents[0] as DiscussionAgent).id);
    expect(rebound?.executionProfileId).toBe(otherProfile.id);
  });
});

// ---------------------------------------------------------------------------
// renameRoom
// ---------------------------------------------------------------------------

describe("renameRoom", () => {
  it("无 binding 冷路径：revision 恰好 +1、digest 变化、同值返回 false、空 topic 抛 INVALID", async () => {
    const seeded = await seedRoom("旧名");
    const before = await db.rooms.get(seeded.room.id);

    const changed = await renameRoom(db, makeOrchestrator(), seeded.room.id, "新名");
    expect(changed).toBe(true);
    const after = await db.rooms.get(seeded.room.id);
    expect(after?.topic).toBe("新名");
    expect(after?.contextRevision).toBe((before?.contextRevision ?? 0) + 1);
    expect(after?.contextDigest).not.toBe(before?.contextDigest);

    // Same value: no bump, returns false.
    expect(await renameRoom(db, makeOrchestrator(), seeded.room.id, "新名")).toBe(false);
    const final = await db.rooms.get(seeded.room.id);
    expect(final?.contextRevision).toBe(after?.contextRevision);

    await expect(renameRoom(db, makeOrchestrator(), seeded.room.id, "   ")).rejects.toMatchObject({
      code: "INVALID",
    });
  });

  it("有 binding 暖路径：controlRoom takeover 后走 updateRoomSharedConfig，revision 恰好 +1", async () => {
    const seeded = await seedRoom("暖房旧名");
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
    const takeoverScope = vi.fn(async () => ({
      scopeId: "scope-1",
      controllerId: "ctrl-2",
      leaseEpoch: 2,
    }));
    const before = await db.rooms.get(seeded.room.id);

    const changed = await renameRoom(
      db,
      makeOrchestrator({ takeoverScope }),
      seeded.room.id,
      "暖房新名",
    );

    expect(changed).toBe(true);
    expect(takeoverScope).toHaveBeenCalledWith("scope-1", expect.any(String));
    const after = await db.rooms.get(seeded.room.id);
    expect(after?.topic).toBe("暖房新名");
    expect(after?.contextRevision).toBe((before?.contextRevision ?? 0) + 1);
    const persisted = await db.runtimeBindings.get(binding.id);
    expect(persisted?.leaseEpoch).toBe(2);
  });
});
