import "fake-indexeddb/auto";

import {
  type ControllerToken,
  abortRound,
  activateRuntimeBinding,
  appendUserMessage,
  beginExecution,
  beginFocusExecution,
  beginReportExecution,
  commitFocusMessage,
  commitModelMessage,
  commitReport,
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
  skipParticipant,
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
 * binding+token → createRound([p1,p2]) → prewarming → running。
 * S2: a seeded non-empty focusMessageId is written so the FOCUS_REQUIRED
 * begin/commit guards accept the participant message/summary flows tested
 * here. The seed does NOT add a focus message nor bump the revision — the
 * existing assertions count messages and revisions and must stay lean. The
 * dedicated focus/report transactions describe block builds its own rounds. */
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
  await db.rounds.update(round.id, { focusMessageId: "seeded-focus" });
  return { room, p1, p2, token, round };
}

/** Set a seeded non-null focusMessageId on a round built outside
 * seedRunning (e.g. the single-participant room-context-revision test) so the
 * FOCUS_REQUIRED guards accept the message/summary flow. Lean like seedRunning:
 * no message, no revision bump. */
async function markFocusCommitted(roundId: string): Promise<void> {
  await db.rounds.update(roundId, { focusMessageId: "seeded-focus" });
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
    await markFocusCommitted(round.id);
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

// ---------------------------------------------------------------------------
// focus / report transactions (S2)
// ---------------------------------------------------------------------------
//
// The dedicated focus/report transactions describe block builds its own rounds
// (it never relies on seedRunning's seeded focusMessageId placeholder): focus
// flows operate on a post-S2 Round still awaiting its focus (focusMessageId
// === null), while report flows anchor on a genuinely completed Round.

describe("focus / report transactions", () => {
  /** A running Round with focusMessageId === null (post-S2, awaiting focus),
   * unlike seedRunning which pre-seeds focusMessageId for the message/summary
   * suites. No message, no revision bump — lean for the focus assertions. */
  async function seedRunningNoFocus(): Promise<Seed> {
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

  async function beginFocusExec(seed: Seed, participant: Participant): Promise<ModelExecution> {
    const freshRoom = await getRoom(seed.room.id);
    const execution = createModelExecution({
      executionId: crypto.randomUUID(),
      roomId: seed.room.id,
      roundId: seed.round.id,
      participantId: participant.id,
      resultKind: "focus",
      requestedModel: "model-a",
      contextRevision: freshRoom.contextRevision,
      expectedRoomDigest: freshRoom.contextDigest,
      participantSnapshotDigest: participant.participantSnapshotDigest,
      instructionDigest: computeInstructionDigest({ kind: "message", text: "focus" }),
    });
    await beginFocusExecution(db, { execution, token: seed.token });
    return execution;
  }

  /** Seed a genuinely completed Round (focus → both messages → summary) and
   * leave the Room open+idle, ready for report transactions. */
  async function seedCompletedRoom(): Promise<Seed & { anchorRound: DiscussionRound }> {
    const seed = await seedRunning();
    await speakAll(seed);
    const summaryExecution = await beginSummaryExecution(seed);
    await dispatch(summaryExecution.executionId);
    await commitSummary(
      db,
      commitInput(summaryExecution.executionId, seed.token, "round summary", 3),
    );
    const anchorRound = await getRound(seed.round.id);
    return { ...seed, anchorRound };
  }

  async function beginReportExec(
    seed: Seed,
    anchorRoundId: string,
    participant: Participant,
  ): Promise<ModelExecution> {
    const freshRoom = await getRoom(seed.room.id);
    const execution = createModelExecution({
      executionId: crypto.randomUUID(),
      roomId: seed.room.id,
      roundId: anchorRoundId,
      participantId: participant.id,
      resultKind: "report",
      requestedModel: "model-a",
      contextRevision: freshRoom.contextRevision,
      expectedRoomDigest: freshRoom.contextDigest,
      participantSnapshotDigest: participant.participantSnapshotDigest,
      instructionDigest: computeInstructionDigest({ kind: "summary", text: "report" }),
    });
    await beginReportExecution(db, { execution, token: seed.token });
    return execution;
  }

  // ----- beginFocusExecution guards -----

  it("beginFocusExecution 非 facilitator → FACILITATOR_MISMATCH", async () => {
    const seed = await seedRunningNoFocus();
    await expect(beginFocusExec(seed, seed.p2)).rejects.toMatchObject({
      code: "FACILITATOR_MISMATCH",
    });
    const round = await getRound(seed.round.id);
    expect(round.activeExecutionId).toBeNull();
    expect(round.focusMessageId).toBeNull();
  });

  it("beginFocusExecution phase 非 running → ROUND_PHASE", async () => {
    const { room, p1, p2 } = await seedBase();
    const token = await seedBinding(room.id);
    const round = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "prewarming" });
    const seed: Seed = { room, p1, p2, token, round };
    await expect(beginFocusExec(seed, p1)).rejects.toMatchObject({ code: "ROUND_PHASE" });
  });

  it("beginFocusExecution focusMessageId 已存在 → STALE_EXECUTION", async () => {
    const seed = await seedRunningNoFocus();
    await markFocusCommitted(seed.round.id);
    await expect(beginFocusExec(seed, seed.p1)).rejects.toMatchObject({
      code: "STALE_EXECUTION",
    });
  });

  // ----- commitFocusMessage -----

  it("commitFocusMessage：写 focusMessageId、cursor 不动、phase 保持 running、revision +1、replay 同事实返回 replayed", async () => {
    const seed = await seedRunningNoFocus();
    const execution = await beginFocusExec(seed, seed.p1);
    await dispatch(execution.executionId);
    const revisionBefore = (await getRoom(seed.room.id)).contextRevision;
    expect(revisionBefore).toBe(0);

    const outcome = await commitFocusMessage(
      db,
      commitInput(execution.executionId, seed.token, "本轮方向：探索 X", 5),
    );
    expect(outcome.outcome).toBe("committed");
    if (outcome.outcome !== "committed") return;

    const round = await getRound(seed.round.id);
    expect(round.phase).toBe("running");
    expect(round.nextParticipantIndex).toBe(0); // focus does not occupy a slot
    expect(round.activeExecutionId).toBeNull();
    expect(round.focusMessageId).toBe(outcome.entityId);
    expect((await getRoom(seed.room.id)).contextRevision).toBe(1);

    const messages = await db.messages.where("roundId").equals(seed.round.id).toArray();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("participant");
    expect(messages[0]?.participantId).toBe(seed.p1.id);
    expect(messages[0]?.sourceExecutionId).toBe(execution.executionId);

    const replay = await commitFocusMessage(
      db,
      commitInput(execution.executionId, seed.token, "本轮方向：探索 X", 5),
    );
    expect(replay).toEqual({ outcome: "replayed", entityId: outcome.entityId });
    expect(await db.messages.count()).toBe(1);
    expect((await getRoom(seed.room.id)).contextRevision).toBe(1);
  });

  it("commitFocusMessage 漂移 → stale_context discard + round paused(running)", async () => {
    const seed = await seedRunningNoFocus();
    const execution = await beginFocusExec(seed, seed.p1);
    await dispatch(execution.executionId);
    // Shared-context write bumps the revision/digest before the focus commits.
    await appendUserMessage(db, {
      roomId: seed.room.id,
      roundId: seed.round.id,
      token: seed.token,
      content: "user interjects before focus lands",
    });
    const revisionBefore = (await getRoom(seed.room.id)).contextRevision;
    expect(revisionBefore).toBe(1);

    const outcome = await commitFocusMessage(
      db,
      commitInput(execution.executionId, seed.token, "late focus"),
    );
    expect(outcome).toEqual({ outcome: "discarded", runtimeOutcome: "stale_context" });

    const round = await getRound(seed.round.id);
    expect(round.phase).toBe("paused");
    expect(round.pausedFrom).toBe("running");
    expect(round.pauseReason?.code).toBe("stale_context");
    expect(round.activeExecutionId).toBeNull();
    expect(round.focusMessageId).toBeNull(); // focus never landed
    expect(await db.messages.filter((m) => m.role === "participant").count()).toBe(0);
    expect((await getRoom(seed.room.id)).contextRevision).toBe(revisionBefore);

    const persisted = await getExecution(execution.executionId);
    expect(persisted.state).toBe("discarded");
    expect(persisted.runtimeOutcome).toBe("stale_context");
    expect(persisted.ackState).toBe("pending");
  });

  it("commitFocusMessage：resultKind 不匹配（message execution 走 commitFocusMessage）→ IDEMPOTENCY_CONFLICT", async () => {
    const seed = await seedRunning(); // seeded focus lets a message begin
    const execution = await beginMessageExecution(seed, seed.p1);
    await dispatch(execution.executionId);
    await expect(
      commitFocusMessage(db, commitInput(execution.executionId, seed.token, "not a focus")),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await db.messages.count()).toBe(0);
  });

  // ----- beginReportExecution guards -----

  it("beginReportExecution：room concluded → ROOM_CONCLUDED", async () => {
    const seed = await seedCompletedRoom();
    await db.rooms.update(seed.room.id, { status: "concluded" });
    await expect(beginReportExec(seed, seed.anchorRound.id, seed.p1)).rejects.toMatchObject({
      code: "ROOM_CONCLUDED",
    });
  });

  it("beginReportExecution：有活动 execution 的未完 round → ROUND_ACTIVE_EXISTS", async () => {
    const seed = await seedCompletedRoom();
    // Open a fresh running round that holds a live (begun) execution.
    const round2 = await createRound(db, {
      roomId: seed.room.id,
      token: seed.token,
      participantOrder: [seed.p1.id, seed.p2.id],
    });
    await transitionRound(db, {
      roomId: seed.room.id,
      roundId: round2.id,
      token: seed.token,
      to: "prewarming",
    });
    await transitionRound(db, {
      roomId: seed.room.id,
      roundId: round2.id,
      token: seed.token,
      to: "running",
    });
    await markFocusCommitted(round2.id);
    await beginMessageExecution({ ...seed, round: round2 }, seed.p1); // sets activeExecutionId
    await expect(beginReportExec(seed, seed.anchorRound.id, seed.p1)).rejects.toMatchObject({
      code: "ROUND_ACTIVE_EXISTS",
    });
  });

  it("beginReportExecution：anchor round 非 completed → ROUND_PHASE", async () => {
    const { room, p1, p2 } = await seedBase();
    const token = await seedBinding(room.id);
    const round = await createRound(db, {
      roomId: room.id,
      token,
      participantOrder: [p1.id, p2.id],
    });
    await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "prewarming" });
    await transitionRound(db, { roomId: room.id, roundId: round.id, token, to: "running" });
    // Detach the running round from the room so the active-round guard is a
    // no-op and the anchor-completed guard is reached in isolation.
    await db.rooms.update(room.id, { activeRoundId: null });
    const seed: Seed = { room, p1, p2, token, round };
    await expect(beginReportExec(seed, round.id, p1)).rejects.toMatchObject({
      code: "ROUND_PHASE",
    });
  });

  it("beginReportExecution：非 facilitator → FACILITATOR_MISMATCH", async () => {
    const seed = await seedCompletedRoom();
    await expect(beginReportExec(seed, seed.anchorRound.id, seed.p2)).rejects.toMatchObject({
      code: "FACILITATOR_MISMATCH",
    });
  });

  it("beginReportExecution：并发第二个 live report → EXECUTION_ACTIVE", async () => {
    const seed = await seedCompletedRoom();
    // A report execution already in flight (prepared) blocks a second begin.
    await beginReportExec(seed, seed.anchorRound.id, seed.p1);
    await expect(beginReportExec(seed, seed.anchorRound.id, seed.p1)).rejects.toMatchObject({
      code: "EXECUTION_ACTIVE",
    });
  });

  // ----- commitReport -----

  it("commitReport：同事务 reports 一行 + status concluded + runState idle；revision 不增长；sourceExecutionId 锚点", async () => {
    const seed = await seedCompletedRoom();
    const execution = await beginReportExec(seed, seed.anchorRound.id, seed.p1);
    await dispatch(execution.executionId);
    const revisionBefore = (await getRoom(seed.room.id)).contextRevision;

    const outcome = await commitReport(
      db,
      commitInput(execution.executionId, seed.token, "决策报告正文", 9),
    );
    expect(outcome.outcome).toBe("committed");
    if (outcome.outcome !== "committed") return;

    const reports = await db.reports.where("roomId").equals(seed.room.id).toArray();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.content).toBe("决策报告正文");
    expect(reports[0]?.sourceExecutionId).toBe(execution.executionId);

    const room = await getRoom(seed.room.id);
    expect(room.status).toBe("concluded");
    expect(room.runState).toBe("idle");
    expect(room.contextRevision).toBe(revisionBefore); // report never bumps revision

    const persisted = await getExecution(execution.executionId);
    expect(persisted.state).toBe("committed");
    expect(persisted.committedEntityType).toBe("report");
    expect(persisted.committedEntityId).toBe(reports[0]?.id);
    expect(persisted.ackState).toBe("pending");
  });

  it("commitReport 并发双提交（同 execution 不同 finalEventSeq）→ 一成一 IDEMPOTENCY_CONFLICT，reports 一行；同事实 replay → replayed", async () => {
    const seed = await seedCompletedRoom();
    const execution = await beginReportExec(seed, seed.anchorRound.id, seed.p1);
    await dispatch(execution.executionId);

    const results = await Promise.allSettled([
      commitReport(db, commitInput(execution.executionId, seed.token, "report A", 1)),
      commitReport(db, commitInput(execution.executionId, seed.token, "report B", 2)),
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
    expect(await db.reports.where("roomId").equals(seed.room.id).count()).toBe(1);

    const first = committed[0] as PromiseFulfilledResult<{
      outcome: "committed";
      entityId: string;
    }>;
    const replay = await commitReport(
      db,
      commitInput(execution.executionId, seed.token, "report A", 1),
    );
    expect(replay).toEqual({ outcome: "replayed", entityId: first.value.entityId });
    expect(await db.reports.where("roomId").equals(seed.room.id).count()).toBe(1);
  });

  // F3 regression: once a room has a committed report, a SECOND report commit
  // from a different execution must surface IDEMPOTENCY_CONFLICT — including
  // when the room is already concluded. The duplicate-report query precedes
  // the ROOM_CONCLUDED check so a post-conclusion second commit does not leak
  // past it as a confusing ROOM_CONCLUDED.
  it("commitReport：concluded 后另一 execution 提交第二份 report → IDEMPOTENCY_CONFLICT", async () => {
    const seed = await seedCompletedRoom();
    const firstExecution = await beginReportExec(seed, seed.anchorRound.id, seed.p1);
    await dispatch(firstExecution.executionId);

    // A divergent report execution already in flight (state running) — added
    // directly to bypass beginReportExecution's live-report guard, simulating a
    // pre-existing second execution that outlives the first commit.
    const freshRoom = await getRoom(seed.room.id);
    const secondExecution = createModelExecution({
      executionId: crypto.randomUUID(),
      roomId: seed.room.id,
      roundId: seed.anchorRound.id,
      participantId: seed.p1.id,
      resultKind: "report",
      requestedModel: "model-a",
      contextRevision: freshRoom.contextRevision,
      expectedRoomDigest: freshRoom.contextDigest,
      participantSnapshotDigest: seed.p1.participantSnapshotDigest,
      instructionDigest: computeInstructionDigest({ kind: "summary", text: "report2" }),
    });
    await db.modelExecutions.add({ ...secondExecution, state: "running" });

    const first = await commitReport(
      db,
      commitInput(firstExecution.executionId, seed.token, "决策报告正文", 9),
    );
    expect(first.outcome).toBe("committed");
    const room = await getRoom(seed.room.id);
    expect(room.status).toBe("concluded");

    await expect(
      commitReport(db, commitInput(secondExecution.executionId, seed.token, "另一份报告", 10)),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    // Only the first report row persists.
    expect(await db.reports.where("roomId").equals(seed.room.id).count()).toBe(1);
  });

  // F6/G4 regression (commit-time stale_context on the FIRST report): if the
  // shared projection drifted after the report execution began (e.g. a
  // concurrent user message bumped the Room digest), commitReport must discard
  // with stale_context — the report body never lands, the executing is left
  // discarded with ackState pending, the Room stays open, and NOT a single
  // report row exists. The room is NOT concluded (the report is the only path
  // to conclusion), so a retry on a later report can still anchor on the digest.
  it("commitReport：expectedRoomDigest 漂移 → stale_context discard（execution discarded、ackState pending、room open、reports 0）", async () => {
    const seed = await seedCompletedRoom();
    const execution = await beginReportExec(seed, seed.anchorRound.id, seed.p1);
    await dispatch(execution.executionId);
    const revisionBefore = (await getRoom(seed.room.id)).contextRevision;
    // Shared-context drift between begin and commit: a user follow-up bumps the
    // Room revision/digest so the report's anchored expectedRoomDigest no longer
    // matches. There is no active round anymore (the anchor completed), so write
    // the user message onto the completed anchor round's id (appendUserMessage
    // only needs a valid roundId; it bumps the shared projection regardless).
    await appendUserMessage(db, {
      roomId: seed.room.id,
      roundId: seed.anchorRound.id,
      token: seed.token,
      content: "late interjection",
    });
    expect((await getRoom(seed.room.id)).contextRevision).toBe(revisionBefore + 1);

    const outcome = await commitReport(
      db,
      commitInput(execution.executionId, seed.token, "决策报告正文", 9),
    );
    expect(outcome).toEqual({ outcome: "discarded", runtimeOutcome: "stale_context" });

    const persisted = await getExecution(execution.executionId);
    expect(persisted.state).toBe("discarded");
    expect(persisted.runtimeOutcome).toBe("stale_context");
    expect(persisted.ackState).toBe("pending");
    // The room is still open — the report never concluded it.
    const room = await getRoom(seed.room.id);
    expect(room.status).toBe("open");
    expect(room.runState).toBe("idle");
    // No report row, and the revision the report would-not-bump is unchanged by
    // the commit itself (still revisionBefore + 1 from the interjection only).
    expect(await db.reports.where("roomId").equals(seed.room.id).count()).toBe(0);
    expect(room.contextRevision).toBe(revisionBefore + 1);
  });

  // F4 regression: a legacy Round whose focusMessageId is the `undefined` sentinel
  // (rather than the strict null we now require) is rejected at beginFocusExecution
  // instead of silently passing the loose guard.
  it("beginFocusExecution：legacy undefined focusMessageId → STALE_EXECUTION（严格三态）", async () => {
    const seed = await seedRunningNoFocus();
    // Force the legacy undefined sentinel into storage (bypasses the type's
    // string|null by writing through the raw store).
    await db.rounds.put({ ...(await getRound(seed.round.id)), focusMessageId: undefined });
    await expect(beginFocusExec(seed, seed.p1)).rejects.toMatchObject({
      code: "STALE_EXECUTION",
    });
    const round = await getRound(seed.round.id);
    expect(round.activeExecutionId).toBeNull();
  });

  // F4 (commit-side guard): a duplicate focus commit (focusMessageId already
  // set) is rejected at commitFocusMessage, mirroring the begin guard.
  it("commitFocusMessage：round 已有 focusMessageId → STALE_EXECUTION（commit 侧严格三态）", async () => {
    const seed = await seedRunningNoFocus();
    const execution = await beginFocusExec(seed, seed.p1);
    await dispatch(execution.executionId);
    // Simulate a concurrent/duplicate focus already landed on the round.
    await markFocusCommitted(seed.round.id);
    await expect(
      commitFocusMessage(db, commitInput(execution.executionId, seed.token, "late focus", 5)),
    ).rejects.toMatchObject({ code: "STALE_EXECUTION" });
  });

  // F4 (commit-side guard, legacy undefined): symmetric to the begin-side
  // legacy-undefined case above. A legacy Round whose focusMessageId is the
  // `undefined` sentinel (pre-S2 row) must NOT silently pass commitFocusMessage
  // as if it were awaiting focus. The commit-side guard uses strict
  // `!== null`, so an `undefined` (loose `!= null` would treat it as equal) is
  // rejected with STALE_EXECUTION — the focus never commits onto a legacy row.
  // Goes red the moment the guard is loosened to `!= null`.
  it("commitFocusMessage：legacy undefined focusMessageId → STALE_EXECUTION（commit 侧严格三态，与 begin 对称）", async () => {
    const seed = await seedRunningNoFocus();
    const execution = await beginFocusExec(seed, seed.p1);
    await dispatch(execution.executionId);
    // Force the legacy undefined sentinel into storage (bypasses the type's
    // string|null by writing through the raw store).
    await db.rounds.put({ ...(await getRound(seed.round.id)), focusMessageId: undefined });
    await expect(
      commitFocusMessage(db, commitInput(execution.executionId, seed.token, "late focus", 5)),
    ).rejects.toMatchObject({ code: "STALE_EXECUTION" });
    // The focus never landed: no message, no focusMessageId set, revision 0.
    expect(await db.messages.count()).toBe(0);
    expect((await getRound(seed.round.id)).focusMessageId).toBeUndefined();
    expect((await getRoom(seed.room.id)).contextRevision).toBe(0);
  });

  // V-gap: a room that still has an unfinalized active round (with NO live
  // execution) must have beginReportExecution atomically abort that round AND
  // clear activeRoundId AND anchor the report execution, all in one tx.
  it("beginReportExecution：room 有未完 round 且无活动 execution → 同事务 abort round + 清 activeRoundId + 锚定 report", async () => {
    const seed = await seedCompletedRoom();
    // Open a fresh running round (no live execution → activeExecutionId null).
    const round2 = await createRound(db, {
      roomId: seed.room.id,
      token: seed.token,
      participantOrder: [seed.p1.id, seed.p2.id],
    });
    await transitionRound(db, {
      roomId: seed.room.id,
      roundId: round2.id,
      token: seed.token,
      to: "prewarming",
    });
    await transitionRound(db, {
      roomId: seed.room.id,
      roundId: round2.id,
      token: seed.token,
      to: "running",
    });
    await markFocusCommitted(round2.id);
    // No beginMessageExecution: activeExecutionId stays null.
    const roomBefore = await getRoom(seed.room.id);
    expect(roomBefore.activeRoundId).toBe(round2.id);

    const execution = await beginReportExec(seed, seed.anchorRound.id, seed.p1);

    // The unfinalized active round is aborted and the room released.
    const abortedRound = await getRound(round2.id);
    expect(abortedRound.phase).toBe("aborted");
    expect(abortedRound.activeExecutionId).toBeNull();
    const roomAfter = await getRoom(seed.room.id);
    expect(roomAfter.activeRoundId).toBeNull();
    expect(roomAfter.runState).toBe("idle");

    // The report execution is anchored on the completed round.
    const anchored = await getExecution(execution.executionId);
    expect(anchored.resultKind).toBe("report");
    expect(anchored.roundId).toBe(seed.anchorRound.id);
    expect(anchored.state).toBe("prepared");
  });
});

// ---------------------------------------------------------------------------
// skip (S3)
// ---------------------------------------------------------------------------

async function seedPausedAtP2(): Promise<Seed> {
  const seed = await seedRunning();
  // Commit p1 (facilitator) at cursor 0 so the cursor advances to p2.
  const p1Exec = await beginMessageExecution(seed, seed.p1);
  await dispatch(p1Exec.executionId);
  await commitModelMessage(db, commitInput(p1Exec.executionId, seed.token, "p1 speaks"));
  // Fail p2 at cursor 1; pausedFrom running, pauseReason participantId=p2.
  const p2Exec = await beginMessageExecution(seed, seed.p2);
  await dispatch(p2Exec.executionId);
  await failExecution(db, {
    executionId: p2Exec.executionId,
    token: seed.token,
    error: { code: "CLI_CRASH", phase: "stream", message: "died", retryable: false },
    kind: "failed",
  });
  return seed;
}

describe("skipParticipant (S3)", () => {
  it("skip 非末位：cursor +1，phase 回 running，暂停清理；revision/digest 不变", async () => {
    // Build a 3-participant order [p1, p2, p3] so p2 is a MIDDLE slot: skipping
    // p2 advances the cursor to p3 and keeps the round running.
    const base = await seedRunning();
    const agent3 = createDiscussionAgent({
      name: "A3",
      personaPrompt: "p3 persona",
      executionProfileId: "prof-1",
      modelId: "model-c",
      color: "#c3d4e5",
    });
    await db.agents.add(agent3);
    const p3 = createParticipant({ roomId: base.room.id, agent: agent3, profileDigest: "pd3" });
    p3.createdAt = "2026-07-17T00:00:00.002Z";
    await db.participants.add(p3);
    // Re-create the round with the 3-participant order.
    const token = base.token;
    await abortRound(db, { roomId: base.room.id, roundId: base.round.id, token });
    const round = await createRound(db, {
      roomId: base.room.id,
      token,
      participantOrder: [base.p1.id, base.p2.id, p3.id],
    });
    await transitionRound(db, { roomId: base.room.id, roundId: round.id, token, to: "prewarming" });
    await transitionRound(db, { roomId: base.room.id, roundId: round.id, token, to: "running" });
    await db.rounds.update(round.id, { focusMessageId: "seeded-focus" });
    const seed: Seed = { room: base.room, p1: base.p1, p2: base.p2, token, round };

    // Commit p1 (cursor 0 → 1); fail p2 (cursor 1, middle slot) → paused.
    const p1Exec = await beginMessageExecution(seed, seed.p1);
    await dispatch(p1Exec.executionId);
    await commitModelMessage(db, commitInput(p1Exec.executionId, token, "p1 speaks"));
    const p2Exec = await beginMessageExecution(seed, seed.p2);
    await dispatch(p2Exec.executionId);
    await failExecution(db, {
      executionId: p2Exec.executionId,
      token,
      error: { code: "CLI_CRASH", phase: "stream", message: "died", retryable: false },
      kind: "failed",
    });
    const roomBefore = await getRoom(seed.room.id);
    const revisionBefore = roomBefore.contextRevision;
    const digestBefore = roomBefore.contextDigest;

    const result = await skipParticipant(db, {
      roomId: seed.room.id,
      roundId: round.id,
      token,
    });

    expect(result.skippedParticipantId).toBe(seed.p2.id);
    expect(result.roundPhase).toBe("running");
    const stored = await getRound(round.id);
    expect(stored.nextParticipantIndex).toBe(2);
    expect(stored.phase).toBe("running");
    expect(stored.pausedFrom).toBeNull();
    expect(stored.pauseReason).toBeNull();
    expect(stored.activeExecutionId).toBeNull();
    const room = await getRoom(seed.room.id);
    expect(room.contextRevision).toBe(revisionBefore);
    expect(room.contextDigest).toBe(digestBefore);
  });

  it("skip 末位 Participant：cursor 越界翻 summarizing；pausedFrom/pauseReason 清空", async () => {
    const seed = await seedPausedAtP2();
    const roundBefore = await getRound(seed.round.id);
    expect(roundBefore.nextParticipantIndex).toBe(1); // last slot of order [p1,p2]

    const result = await skipParticipant(db, {
      roomId: seed.room.id,
      roundId: seed.round.id,
      token: seed.token,
    });

    expect(result.roundPhase).toBe("summarizing");
    const round = await getRound(seed.round.id);
    expect(round.nextParticipantIndex).toBe(2);
    expect(round.phase).toBe("summarizing");
    expect(round.pausedFrom).toBeNull();
    expect(round.pauseReason).toBeNull();
    expect(round.activeExecutionId).toBeNull();
  });

  it("FACILITATOR_NOT_SKIPPABLE：cursor 在 facilitator 时事务拒绝，round 仍 paused", async () => {
    const seed = await seedRunning();
    // Fail p1 (facilitator) at cursor 0.
    const p1Exec = await beginMessageExecution(seed, seed.p1);
    await dispatch(p1Exec.executionId);
    await failExecution(db, {
      executionId: p1Exec.executionId,
      token: seed.token,
      error: { code: "CLI_CRASH", phase: "stream", message: "died", retryable: false },
      kind: "failed",
    });
    const roundBefore = await getRound(seed.round.id);
    expect(roundBefore.pauseReason?.participantId).toBe(seed.p1.id);

    await expect(
      skipParticipant(db, { roomId: seed.room.id, roundId: seed.round.id, token: seed.token }),
    ).rejects.toMatchObject({ code: "FACILITATOR_NOT_SKIPPABLE" });
    const round = await getRound(seed.round.id);
    expect(round.phase).toBe("paused");
    expect(round.nextParticipantIndex).toBe(0);
  });

  it("ROUND_PHASE：running（非 paused）round 直接 skip 拒绝", async () => {
    const seed = await seedRunning();
    await expect(
      skipParticipant(db, { roomId: seed.room.id, roundId: seed.round.id, token: seed.token }),
    ).rejects.toMatchObject({ code: "ROUND_PHASE" });
  });

  it("STALE_CONTROLLER：错误 token 拒绝", async () => {
    const seed = await seedPausedAtP2();
    await expect(
      skipParticipant(db, {
        roomId: seed.room.id,
        roundId: seed.round.id,
        token: { controllerId: "wrong", leaseEpoch: 99 },
      }),
    ).rejects.toMatchObject({ code: "STALE_CONTROLLER" });
  });

  it("STALE_EXECUTION：pause reason 不指向 cursor 时拒绝", async () => {
    const seed = await seedPausedAtP2();
    // Tamper: move the cursor past the paused participant.
    await db.rounds.update(seed.round.id, { nextParticipantIndex: 2 });
    await expect(
      skipParticipant(db, { roomId: seed.room.id, roundId: seed.round.id, token: seed.token }),
    ).rejects.toMatchObject({ code: "STALE_EXECUTION" });
  });

  it("SKIP_NOT_APPLICABLE：prewarm 暂停（pauseReason 无 participantId）不可跳过", async () => {
    const seed = await seedRunning();
    await db.rounds.update(seed.round.id, {
      phase: "paused",
      pausedFrom: "prewarming",
      pauseReason: { code: "prewarm_failed" },
    });
    await expect(
      skipParticipant(db, { roomId: seed.room.id, roundId: seed.round.id, token: seed.token }),
    ).rejects.toMatchObject({ code: "SKIP_NOT_APPLICABLE" });
  });
});
