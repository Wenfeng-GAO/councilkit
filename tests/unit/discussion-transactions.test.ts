import "fake-indexeddb/auto";

import {
  type ControllerToken,
  abortRound,
  activateRuntimeBinding,
  appendUserMessage,
  beginExecution,
  commitModelMessage,
  commitSummary,
  createRound,
  createRuntimeBindingTx,
  discardExecution,
  failExecution,
  markAckExpired,
  markAcknowledged,
  markBindingClosed,
  markBindingClosing,
  markExecutionDispatched,
  pauseRound,
  resumeRound,
  takeoverRuntimeBinding,
  transitionRound,
  updateRoomSharedConfig,
} from "@/lib/discussion-transactions";
import { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type { DiscussionRoom, DiscussionRound, Participant } from "@/models/discussion/entities";
import {
  createDiscussionAgent,
  createDiscussionRoom,
  createModelExecution,
  createParticipant,
} from "@/models/discussion/factories";
import type { ModelExecution } from "@/models/discussion/model-execution";
import { computeInstructionDigest, initializeRoomDigest } from "@/orchestrator/context-snapshot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Discussion transactions (U4) against real Dexie on fake-indexeddb:
 * idempotent commit, stale CAS, round/binding/ACK lifecycles, revision
 * counting and terminal-state invariants.
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

interface Seed {
  room: DiscussionRoom;
  p1: Participant;
  p2: Participant;
  token: ControllerToken;
  round: DiscussionRound;
}

async function seedBase(): Promise<Pick<Seed, "room" | "p1" | "p2">> {
  const agent1 = createDiscussionAgent({
    name: "A1",
    personaPrompt: "p1 persona",
    executionProfileId: "prof-1",
    modelId: "model-a",
    color: "#a1b2c3",
  });
  const agent2 = createDiscussionAgent({
    name: "A2",
    personaPrompt: "p2 persona",
    executionProfileId: "prof-1",
    modelId: "model-b",
    color: "#b2c3d4",
  });
  await db.agents.bulkAdd([agent1, agent2]);
  const room = initializeRoomDigest(
    createDiscussionRoom({ topic: "Topic", background: "bg", facilitatorParticipantId: "pending" }),
  );
  await db.rooms.add(room);
  const p1 = createParticipant({ roomId: room.id, agent: agent1, profileDigest: "pd1" });
  const p2 = createParticipant({ roomId: room.id, agent: agent2, profileDigest: "pd2" });
  await db.participants.bulkAdd([p1, p2]);
  room.facilitatorParticipantId = p1.id;
  await db.rooms.put(room);
  return { room, p1, p2 };
}

async function seedBinding(roomId: string): Promise<ControllerToken> {
  const binding = await createRuntimeBindingTx(db, {
    roomId,
    scopeRequestId: crypto.randomUUID(),
  });
  await activateRuntimeBinding(db, {
    id: binding.id,
    hostInstanceId: "host-1",
    executionScopeId: "scope-1",
    controllerId: "ctrl-1",
    leaseEpoch: 1,
  });
  return { controllerId: "ctrl-1", leaseEpoch: 1 };
}

/** agent×2 → participant×2（p1 facilitator）→ room（digest 已初始化）→ active
 * binding+token → createRound([p1,p2]) → prewarming → running。 */
async function seedRunning(): Promise<Seed> {
  const { room, p1, p2 } = await seedBase();
  const token = await seedBinding(room.id);
  const round = await createRound(db, {
    roomId: room.id,
    token,
    participantOrder: [p1.id, p2.id],
  });
  await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "prewarming" });
  await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "running" });
  return { room, p1, p2, token, round };
}

async function beginMessageExecution(
  seed: Seed,
  participant: Participant,
): Promise<ModelExecution> {
  const freshRoom = (await db.rooms.get(seed.room.id)) as DiscussionRoom;
  const execution = createModelExecution({
    executionId: crypto.randomUUID(),
    roomId: seed.room.id,
    roundId: seed.round.id,
    participantId: participant.id,
    resultKind: "message",
    requestedModel: participant.modelId,
    contextRevision: freshRoom.contextRevision,
    expectedRoomDigest: freshRoom.contextDigest,
    participantSnapshotDigest: participant.participantSnapshotDigest,
    instructionDigest: computeInstructionDigest({ kind: "message", text: "speak" }),
  });
  await beginExecution(db, { execution, token: seed.token });
  return execution;
}

async function beginSummaryExecution(seed: Seed): Promise<ModelExecution> {
  const freshRoom = (await db.rooms.get(seed.room.id)) as DiscussionRoom;
  const execution = createModelExecution({
    executionId: crypto.randomUUID(),
    roomId: seed.room.id,
    roundId: seed.round.id,
    participantId: seed.room.facilitatorParticipantId,
    resultKind: "summary",
    requestedModel: "model-a",
    contextRevision: freshRoom.contextRevision,
    expectedRoomDigest: freshRoom.contextDigest,
    participantSnapshotDigest: seed.p1.participantSnapshotDigest,
    instructionDigest: computeInstructionDigest({ kind: "summary", text: "summarize" }),
  });
  await beginExecution(db, { execution, token: seed.token });
  return execution;
}

async function dispatch(executionId: string): Promise<void> {
  await markExecutionDispatched(db, {
    executionId,
    hostInstanceId: "host-1",
    executionScopeId: "scope-1",
    dispatchState: "accepted",
  });
}

function commitInput(
  executionId: string,
  token: ControllerToken,
  content: string,
  finalEventSeq = 1,
) {
  return {
    executionId,
    token,
    content,
    effectiveModel: "model-a",
    usage: null,
    finalEventSeq,
    dispatchState: "accepted" as const,
    toolState: "none" as const,
  };
}

async function getRound(id: string): Promise<DiscussionRound> {
  return (await db.rounds.get(id)) as DiscussionRound;
}

async function getRoom(id: string): Promise<DiscussionRoom> {
  return (await db.rooms.get(id)) as DiscussionRoom;
}

async function getExecution(id: string): Promise<ModelExecution> {
  return (await db.modelExecutions.get(id)) as ModelExecution;
}

/** p1、p2 各 commit 一条 message，round 进入 summarizing。 */
async function speakAll(seed: Seed): Promise<void> {
  for (const participant of [seed.p1, seed.p2]) {
    const execution = await beginMessageExecution(seed, participant);
    await dispatch(execution.executionId);
    await commitModelMessage(
      db,
      commitInput(execution.executionId, seed.token, `${participant.id} says hi`),
    );
  }
}

// ---------------------------------------------------------------------------
// Commit idempotency
// ---------------------------------------------------------------------------

describe("commit idempotency", () => {
  it("两个并发 commitModelMessage 同一 execution：一个 committed，另一个 IDEMPOTENCY_CONFLICT", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);

    const results = await Promise.allSettled([
      commitModelMessage(db, commitInput(execution.executionId, seed.token, "version A")),
      commitModelMessage(db, commitInput(execution.executionId, seed.token, "version B", 2)),
    ]);
    const committed = results.filter(
      (r) => r.status === "fulfilled" && r.value.outcome === "committed",
    );
    const conflicted = results.filter(
      (r) =>
        r.status === "rejected" && (r.reason as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
    );
    expect(committed).toHaveLength(1);
    expect(conflicted).toHaveLength(1);

    expect(await db.messages.where("roundId").equals(seed.round.id).count()).toBe(1);
    const persisted = await getExecution(execution.executionId);
    expect(persisted.state).toBe("committed");
    expect(persisted.ackState).toBe("pending");
  });

  it("同一 execution 并发提交 Message/Summary：resultKind=message 成功，summary 拒 IDEMPOTENCY_CONFLICT", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);

    const results = await Promise.allSettled([
      commitSummary(db, commitInput(execution.executionId, seed.token, "a summary")),
      commitModelMessage(db, commitInput(execution.executionId, seed.token, "a message")),
    ]);
    expect(results[0].status).toBe("rejected");
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(results[1].status).toBe("fulfilled");
    expect(await db.messages.where("roundId").equals(seed.round.id).count()).toBe(1);
    expect(await db.summaries.count()).toBe(0);
  });

  it("幂等重放：同内容同 finalEventSeq 返回 replayed，不产生第二条 message", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);
    const first = await commitModelMessage(
      db,
      commitInput(execution.executionId, seed.token, "hello", 7),
    );
    expect(first.outcome).toBe("committed");
    if (first.outcome !== "committed") return;
    const revisionAfterCommit = (await getRoom(seed.room.id)).contextRevision;

    const replay = await commitModelMessage(
      db,
      commitInput(execution.executionId, seed.token, "hello", 7),
    );
    expect(replay).toEqual({ outcome: "replayed", entityId: first.entityId });
    expect(await db.messages.count()).toBe(1);
    expect((await getRoom(seed.room.id)).contextRevision).toBe(revisionAfterCommit);
  });

  it("不同正文或不同 finalEventSeq 的重放 → IDEMPOTENCY_CONFLICT 且整体回滚", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);
    await commitModelMessage(db, commitInput(execution.executionId, seed.token, "hello", 7));
    const revision = (await getRoom(seed.room.id)).contextRevision;

    await expect(
      commitModelMessage(db, commitInput(execution.executionId, seed.token, "different", 7)),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      commitModelMessage(db, commitInput(execution.executionId, seed.token, "hello", 8)),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    // 整体回滚：无新增 message、revision 不增长、execution 保持原提交。
    expect(await db.messages.count()).toBe(1);
    expect((await getRoom(seed.room.id)).contextRevision).toBe(revision);
    const persisted = await getExecution(execution.executionId);
    expect(persisted.state).toBe("committed");
    expect(persisted.finalEventSeq).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Stale CAS
// ---------------------------------------------------------------------------

describe("stale CAS", () => {
  it("错误 controller token → STALE_CONTROLLER", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);
    await expect(
      commitModelMessage(
        db,
        commitInput(execution.executionId, { controllerId: "ctrl-x", leaseEpoch: 1 }, "hi"),
      ),
    ).rejects.toMatchObject({ code: "STALE_CONTROLLER" });
    await expect(
      commitModelMessage(
        db,
        commitInput(execution.executionId, { controllerId: "ctrl-1", leaseEpoch: 99 }, "hi"),
      ),
    ).rejects.toMatchObject({ code: "STALE_CONTROLLER" });
  });

  it("commit 推进后再对旧 execution 以相同事实 commit → replay 路径", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);
    const first = await commitModelMessage(
      db,
      commitInput(execution.executionId, seed.token, "hello", 7),
    );
    expect(first.outcome).toBe("committed");
    if (first.outcome !== "committed") return;
    // 此时 round.activeExecutionId 已清空、cursor 已推进；同事实重放走 replay。
    const replay = await commitModelMessage(
      db,
      commitInput(execution.executionId, seed.token, "hello", 7),
    );
    expect(replay).toEqual({ outcome: "replayed", entityId: first.entityId });
    expect(await db.messages.count()).toBe(1);
  });

  it("round.activeExecutionId 已指向别处 → STALE_EXECUTION", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);
    // 模拟崩溃窗口：库里的 active execution 指针被别的执行取代。
    await db.rounds.update(seed.round.id, { activeExecutionId: "some-other-execution" });
    await expect(
      commitModelMessage(db, commitInput(execution.executionId, seed.token, "hi")),
    ).rejects.toMatchObject({ code: "STALE_EXECUTION" });
    expect(await db.messages.count()).toBe(0);
  });

  it("dispatch 后 room 上下文变化 → stale_context 丢弃 + round paused，revision 不增长", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);
    // 另一条共享投影写：user follow-up 使 revision/digest 前进。
    await appendUserMessage(db, {
      roomId: seed.room.id,
      roundId: seed.round.id,
      token: seed.token,
      content: "user follow-up",
    });
    const revisionBefore = (await getRoom(seed.room.id)).contextRevision;

    const outcome = await commitModelMessage(
      db,
      commitInput(execution.executionId, seed.token, "late body"),
    );
    expect(outcome).toEqual({ outcome: "discarded", runtimeOutcome: "stale_context" });

    const persisted = await getExecution(execution.executionId);
    expect(persisted.state).toBe("discarded");
    expect(persisted.runtimeOutcome).toBe("stale_context");
    expect(persisted.ackState).toBe("pending");
    const round = await getRound(seed.round.id);
    expect(round.phase).toBe("paused");
    expect(round.pausedFrom).toBe("running");
    expect(round.pauseReason?.code).toBe("stale_context");
    expect(round.activeExecutionId).toBeNull();
    expect(round.nextParticipantIndex).toBe(0);
    // 正文未提交、cursor 未推进、contextRevision 未因本次 commit 增长。
    expect(await db.messages.filter((m) => m.role === "participant").count()).toBe(0);
    expect((await getRoom(seed.room.id)).contextRevision).toBe(revisionBefore);
  });

  it("participant digest 变化 → 同样走 stale_context 丢弃路径", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);
    // 直接改库中的 participant 快照 digest（模拟 Participant-only 配置变更）。
    await db.participants.update(seed.p1.id, { participantSnapshotDigest: "tampered-digest" });
    const revisionBefore = (await getRoom(seed.room.id)).contextRevision;

    const outcome = await commitModelMessage(
      db,
      commitInput(execution.executionId, seed.token, "late body"),
    );
    expect(outcome).toEqual({ outcome: "discarded", runtimeOutcome: "stale_context" });

    const round = await getRound(seed.round.id);
    expect(round.phase).toBe("paused");
    expect(round.pauseReason?.code).toBe("stale_context");
    expect(await db.messages.count()).toBe(0);
    expect((await getRoom(seed.room.id)).contextRevision).toBe(revisionBefore);
  });
});

// ---------------------------------------------------------------------------
// Round lifecycle
// ---------------------------------------------------------------------------

describe("round lifecycle", () => {
  it("prewarm 暂停 → abort → 可新开 roundNumber=2，abort 后 room.activeRoundId=null", async () => {
    const { room, p1, p2 } = await seedBase();
    const token = await seedBinding(room.id);
    const round = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "prewarming" });
    await pauseRound(db, {
      roomId: room.id,
      roundId: round.id,
      token,
      reason: { code: "prewarm_failed", participantId: p2.id },
    });
    let persisted = await getRound(round.id);
    expect(persisted.phase).toBe("paused");
    expect(persisted.pausedFrom).toBe("prewarming");
    expect(persisted.pauseReason?.code).toBe("prewarm_failed");

    await abortRound(db, { roomId: room.id, roundId: round.id, token });
    persisted = await getRound(round.id);
    expect(persisted.phase).toBe("aborted");
    expect(persisted.activeExecutionId).toBeNull();
    expect((await getRoom(room.id)).activeRoundId).toBeNull();

    const next = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    expect(next.roundNumber).toBe(2);
  });

  it("并发 createRound：一个成功，另一个 ROUND_ACTIVE_EXISTS；rounds 表仅 1 条", async () => {
    const { room, p1, p2 } = await seedBase();
    const token = await seedBinding(room.id);
    const results = await Promise.allSettled([
      createRound(db, { roomId: room.id, token, participantOrder: [p1.id, p2.id] }),
      createRound(db, { roomId: room.id, token, participantOrder: [p1.id, p2.id] }),
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r) =>
        r.status === "rejected" && (r.reason as { code?: string }).code === "ROUND_ACTIVE_EXISTS",
    );
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(await db.rounds.where("roomId").equals(room.id).count()).toBe(1);
  });

  it("completed 不变量：双发言后 summarizing，facilitator summary commit 后 round completed", async () => {
    const seed = await seedRunning();
    await speakAll(seed);
    let round = await getRound(seed.round.id);
    expect(round.phase).toBe("summarizing");
    expect(round.nextParticipantIndex).toBe(2);

    const summaryExecution = await beginSummaryExecution(seed);
    await dispatch(summaryExecution.executionId);
    const outcome = await commitSummary(
      db,
      commitInput(summaryExecution.executionId, seed.token, "round summary", 3),
    );
    expect(outcome).toEqual({
      outcome: "committed",
      entityId: outcome.outcome === "committed" ? outcome.entityId : "",
      roundPhase: "completed",
    });

    round = await getRound(seed.round.id);
    expect(round.phase).toBe("completed");
    expect(round.completedAt).not.toBeNull();
    expect(round.activeExecutionId).toBeNull();
    const room = await getRoom(seed.room.id);
    expect(room.activeRoundId).toBeNull();
    expect(room.runState).toBe("idle");

    const summaries = await db.summaries.toArray();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].sourceExecutionId).toBe(summaryExecution.executionId);
  });

  it("无 committed Summary 不能 completed：running phase 伪造 summary execution → STALE_EXECUTION", async () => {
    const seed = await seedRunning();
    const freshRoom = await getRoom(seed.room.id);
    const forged = createModelExecution({
      executionId: crypto.randomUUID(),
      roomId: seed.room.id,
      roundId: seed.round.id,
      participantId: seed.p1.id,
      resultKind: "summary",
      requestedModel: "model-a",
      contextRevision: freshRoom.contextRevision,
      expectedRoomDigest: freshRoom.contextDigest,
      participantSnapshotDigest: seed.p1.participantSnapshotDigest,
      instructionDigest: computeInstructionDigest({ kind: "summary", text: "summarize" }),
    });
    // 直接落一条 running 状态的 summary execution（绕过 beginExecution 的 phase 守卫）。
    await db.modelExecutions.add({ ...forged, state: "running" });
    await expect(
      commitSummary(db, commitInput(forged.executionId, seed.token, "forged summary")),
    ).rejects.toMatchObject({ code: "STALE_EXECUTION" });
    expect(await db.summaries.count()).toBe(0);
    expect((await getRound(seed.round.id)).phase).toBe("running");
  });

  it("completed round abortRound → ROUND_FINAL", async () => {
    const seed = await seedRunning();
    await speakAll(seed);
    const summaryExecution = await beginSummaryExecution(seed);
    await dispatch(summaryExecution.executionId);
    await commitSummary(db, commitInput(summaryExecution.executionId, seed.token, "summary"));
    await expect(
      abortRound(db, { roomId: seed.room.id, roundId: seed.round.id, token: seed.token }),
    ).rejects.toMatchObject({ code: "ROUND_FINAL" });
  });

  it("非 paused round resumeRound → ROUND_PHASE", async () => {
    const seed = await seedRunning();
    await expect(
      resumeRound(db, { roomId: seed.room.id, roundId: seed.round.id, token: seed.token }),
    ).rejects.toMatchObject({ code: "ROUND_PHASE" });
  });

  it("对已 committed execution discardExecution → IDEMPOTENCY_CONFLICT", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);
    await commitModelMessage(db, commitInput(execution.executionId, seed.token, "hi"));
    await expect(
      discardExecution(db, {
        executionId: execution.executionId,
        token: seed.token,
        outcome: "user_cancelled",
        finalEventSeq: 9,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("abort 带活跃 execution：execution → interrupted，round aborted、activeExecutionId=null", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await abortRound(db, { roomId: seed.room.id, roundId: seed.round.id, token: seed.token });
    const persisted = await getExecution(execution.executionId);
    expect(persisted.state).toBe("interrupted");
    expect(persisted.error?.code).toBe("USER_CANCELLED");
    expect(persisted.ackState).toBeNull();
    const round = await getRound(seed.round.id);
    expect(round.phase).toBe("aborted");
    expect(round.activeExecutionId).toBeNull();
    const room = await getRoom(seed.room.id);
    expect(room.activeRoundId).toBeNull();
    expect(room.runState).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// beginExecution guards
// ---------------------------------------------------------------------------

describe("beginExecution guards", () => {
  it("phase 不对（pending 时 begin message execution）→ ROUND_PHASE", async () => {
    const { room, p1, p2 } = await seedBase();
    const token = await seedBinding(room.id);
    const round = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    const seed: Seed = { room, p1, p2, token, round };
    await expect(beginMessageExecution(seed, p1)).rejects.toMatchObject({ code: "ROUND_PHASE" });
  });

  it("非 cursor participant → STALE_EXECUTION", async () => {
    const seed = await seedRunning();
    await expect(beginMessageExecution(seed, seed.p2)).rejects.toMatchObject({
      code: "STALE_EXECUTION",
    });
  });

  it("summary 非 facilitator → FACILITATOR_MISMATCH", async () => {
    const seed = await seedRunning();
    await speakAll(seed);
    const freshRoom = await getRoom(seed.room.id);
    const execution = createModelExecution({
      executionId: crypto.randomUUID(),
      roomId: seed.room.id,
      roundId: seed.round.id,
      participantId: seed.p2.id,
      resultKind: "summary",
      requestedModel: "model-b",
      contextRevision: freshRoom.contextRevision,
      expectedRoomDigest: freshRoom.contextDigest,
      participantSnapshotDigest: seed.p2.participantSnapshotDigest,
      instructionDigest: computeInstructionDigest({ kind: "summary", text: "summarize" }),
    });
    await expect(beginExecution(db, { execution, token: seed.token })).rejects.toMatchObject({
      code: "FACILITATOR_MISMATCH",
    });
  });

  it("已有 active execution 再 begin → EXECUTION_ACTIVE", async () => {
    const seed = await seedRunning();
    await beginMessageExecution(seed, seed.p1);
    await expect(beginMessageExecution(seed, seed.p1)).rejects.toMatchObject({
      code: "EXECUTION_ACTIVE",
    });
  });
});

// ---------------------------------------------------------------------------
// Room context revision 精确计数
// ---------------------------------------------------------------------------

describe("room context revision", () => {
  it("空投影 0 → message 1 → summary 2 → appendUserMessage 3 → updateRoomSharedConfig 4；同值 update 返回 false", async () => {
    const { room, p1 } = await seedBase();
    const token = await seedBinding(room.id);
    // 单 participant round：commit message 后直接进入 summarizing。
    const round = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id],
    });
    await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "prewarming" });
    await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "running" });
    const seed: Seed = { room, p1, p2: p1, token, round };

    const digests = new Set<string>();
    const expectRevision = async (revision: number) => {
      const fresh = await getRoom(room.id);
      expect(fresh.contextRevision).toBe(revision);
      expect(fresh.contextDigest).toMatch(/^[0-9a-f]{64}$/);
      digests.add(fresh.contextDigest);
    };

    await expectRevision(0);
    const messageExecution = await beginMessageExecution(seed, p1);
    await dispatch(messageExecution.executionId);
    await commitModelMessage(db, commitInput(messageExecution.executionId, token, "only voice"));
    await expectRevision(1);

    const summaryExecution = await beginSummaryExecution(seed);
    await dispatch(summaryExecution.executionId);
    await commitSummary(db, commitInput(summaryExecution.executionId, token, "summary"));
    await expectRevision(2);

    await appendUserMessage(db, { roomId: room.id, roundId: round.id, token, content: "追问" });
    await expectRevision(3);

    const changed = await updateRoomSharedConfig(db, { roomId: room.id, token, topic: "新主题" });
    expect(changed).toBe(true);
    await expectRevision(4);

    const unchanged = await updateRoomSharedConfig(db, {
      roomId: room.id,
      token,
      topic: "新主题",
    });
    expect(unchanged).toBe(false);
    await expectRevision(4);

    // 每次 revision 增长都伴随新的 contextDigest。
    expect(digests.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// RuntimeBinding 生命周期
// ---------------------------------------------------------------------------

describe("runtime binding lifecycle", () => {
  it("幂等创建 / activate / takeover / closing / closed / closed 后 takeover 拒绝", async () => {
    const { room } = await seedBase();
    const scopeRequestId = crypto.randomUUID();

    const first = await createRuntimeBindingTx(db, { roomId: room.id, scopeRequestId });
    const retry = await createRuntimeBindingTx(db, { roomId: room.id, scopeRequestId });
    expect(retry.id).toBe(first.id);
    expect(await db.runtimeBindings.count()).toBe(1);
    expect(first.state).toBe("creating");

    const active = await activateRuntimeBinding(db, {
      id: first.id,
      hostInstanceId: "host-1",
      executionScopeId: "scope-1",
      controllerId: "ctrl-1",
      leaseEpoch: 1,
    });
    expect(active.state).toBe("active");
    expect(active.controllerId).toBe("ctrl-1");
    expect(active.leaseEpoch).toBe(1);

    await expect(
      activateRuntimeBinding(db, {
        id: first.id,
        hostInstanceId: "host-1",
        executionScopeId: "scope-1",
        controllerId: "ctrl-1",
        leaseEpoch: 1,
      }),
    ).rejects.toMatchObject({ code: "BINDING_STALE" });

    await takeoverRuntimeBinding(db, { id: first.id, controllerId: "ctrl-2", leaseEpoch: 2 });
    let persisted = await db.runtimeBindings.get(first.id);
    expect(persisted?.controllerId).toBe("ctrl-2");
    expect(persisted?.leaseEpoch).toBe(2);

    await markBindingClosing(db, first.id);
    persisted = await db.runtimeBindings.get(first.id);
    expect(persisted?.state).toBe("closing");
    await markBindingClosed(db, first.id);
    persisted = await db.runtimeBindings.get(first.id);
    expect(persisted?.state).toBe("closed");

    await expect(
      takeoverRuntimeBinding(db, { id: first.id, controllerId: "ctrl-3", leaseEpoch: 3 }),
    ).rejects.toMatchObject({ code: "BINDING_STALE" });
  });
});

// ---------------------------------------------------------------------------
// ACK 生命周期
// ---------------------------------------------------------------------------

describe("ack lifecycle", () => {
  it("commit 后 pending → acknowledged（幂等）；另一条 → expired", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);
    await commitModelMessage(db, commitInput(execution.executionId, seed.token, "hi"));
    expect((await getExecution(execution.executionId)).ackState).toBe("pending");

    await markAcknowledged(db, execution.executionId);
    expect((await getExecution(execution.executionId)).ackState).toBe("acknowledged");
    await markAcknowledged(db, execution.executionId);
    expect((await getExecution(execution.executionId)).ackState).toBe("acknowledged");

    const second = await beginMessageExecution(seed, seed.p2);
    await dispatch(second.executionId);
    await commitModelMessage(db, commitInput(second.executionId, seed.token, "hi again"));
    expect((await getExecution(second.executionId)).ackState).toBe("pending");
    await markAckExpired(db, second.executionId);
    expect((await getExecution(second.executionId)).ackState).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// discard / fail 终态
// ---------------------------------------------------------------------------

describe("discard / fail terminals", () => {
  it("discardExecution 幂等：同事实 replayed，不同事实 IDEMPOTENCY_CONFLICT", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);

    const discarded = await discardExecution(db, {
      executionId: execution.executionId,
      token: seed.token,
      outcome: "empty_output",
      finalEventSeq: 7,
    });
    expect(discarded).toEqual({ outcome: "discarded", runtimeOutcome: "empty_output" });
    const persisted = await getExecution(execution.executionId);
    expect(persisted.state).toBe("discarded");
    expect(persisted.ackState).toBe("pending");
    expect((await getRound(seed.round.id)).phase).toBe("paused");

    const replay = await discardExecution(db, {
      executionId: execution.executionId,
      token: seed.token,
      outcome: "empty_output",
      finalEventSeq: 7,
    });
    expect(replay).toEqual({ outcome: "replayed" });

    await expect(
      discardExecution(db, {
        executionId: execution.executionId,
        token: seed.token,
        outcome: "model_mismatch",
        finalEventSeq: 7,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("failExecution：execution → failed（无 ACK），round paused(execution_failed)，revision 不增长", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);
    const revisionBefore = (await getRoom(seed.room.id)).contextRevision;

    await failExecution(db, {
      executionId: execution.executionId,
      token: seed.token,
      error: { code: "CLI_CRASH", phase: "stream", message: "process died", retryable: false },
      kind: "failed",
    });

    const persisted = await getExecution(execution.executionId);
    expect(persisted.state).toBe("failed");
    expect(persisted.ackState).toBeNull();
    expect(persisted.error?.code).toBe("CLI_CRASH");
    const round = await getRound(seed.round.id);
    expect(round.phase).toBe("paused");
    expect(round.pausedFrom).toBe("running");
    expect(round.pauseReason?.code).toBe("execution_failed");
    expect(round.activeExecutionId).toBeNull();
    // 失败不是共享投影写：Room revision 不增长。
    expect((await getRoom(seed.room.id)).contextRevision).toBe(revisionBefore);
  });

  it("execution 处于 failed 终态后：commit → EXECUTION_NOT_COMMITTABLE，且无正文", async () => {
    const seed = await seedRunning();
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);
    await failExecution(db, {
      executionId: execution.executionId,
      token: seed.token,
      error: { code: "CLI_CRASH", phase: "stream", message: "process died", retryable: false },
      kind: "failed",
    });

    await expect(
      commitModelMessage(db, commitInput(execution.executionId, seed.token, "too late")),
    ).rejects.toMatchObject({ code: "EXECUTION_NOT_COMMITTABLE" });
    expect(await db.messages.count()).toBe(0);
  });
});
