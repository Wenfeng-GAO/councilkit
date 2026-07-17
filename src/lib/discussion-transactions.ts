import type {
  DiscussionMessage,
  DiscussionRoom,
  DiscussionRound,
  DiscussionSummary,
  RoundPauseReason,
} from "@/models/discussion/entities";
import { TransactionError, createRuntimeBinding, digestOf } from "@/models/discussion/factories";
import type {
  ModelExecution,
  ModelExecutionError,
  ModelExecutionUsage,
  RuntimeOutcome,
} from "@/models/discussion/model-execution";
import type { RuntimeBinding } from "@/models/discussion/runtime-binding";
import { computeContextDigest, projectSharedContext } from "@/orchestrator/context-snapshot";
import type { CouncilKitRuntimeDB } from "./runtime-db";

/**
 * Discussion transactions (U4): every write that affects discussion facts is
 * a single Dexie transaction with controller/leaseEpoch and active-execution
 * CAS. Persist first, ACK second — a Host terminal is never released before
 * its Dexie transaction succeeds.
 *
 * Error codes: STALE_CONTROLLER / STALE_EXECUTION (old page must not
 * advance), IDEMPOTENCY_CONFLICT (same id, different facts — full rollback),
 * ROUND_* / EXECUTION_* invariant violations.
 */

export interface ControllerToken {
  controllerId: string;
  leaseEpoch: number;
}

function ts(): string {
  return new Date().toISOString();
}

function uuid(): string {
  return crypto.randomUUID();
}

async function requireRoom(db: CouncilKitRuntimeDB, roomId: string): Promise<DiscussionRoom> {
  const room = await db.rooms.get(roomId);
  if (!room) throw new TransactionError("ROOM_NOT_FOUND", `unknown room ${roomId}`);
  return room;
}

/** Every mutation checks the caller against the Room's ACTIVE binding. */
async function requireController(
  db: CouncilKitRuntimeDB,
  roomId: string,
  token: ControllerToken,
): Promise<RuntimeBinding> {
  const binding = await db.runtimeBindings
    .where("roomId")
    .equals(roomId)
    .filter((candidate) => candidate.state === "active")
    .first();
  if (
    !binding ||
    binding.controllerId !== token.controllerId ||
    binding.leaseEpoch !== token.leaseEpoch
  ) {
    throw new TransactionError(
      "STALE_CONTROLLER",
      "controllerId/leaseEpoch does not match the active runtime binding",
    );
  }
  return binding;
}

/** Recompute the shared projection digest inside a commit transaction:
 * exactly one revision bump per atomic commit. */
async function bumpRoomContext(db: CouncilKitRuntimeDB, room: DiscussionRoom): Promise<void> {
  const messages = await db.messages.where("roomId").equals(room.id).toArray();
  const summaries = await db.summaries.where("roomId").equals(room.id).toArray();
  room.contextRevision += 1;
  room.contextDigest = computeContextDigest(projectSharedContext(room, messages, summaries));
  room.lastActiveAt = ts();
  await db.rooms.put(room);
}

/** Translate the unique sourceExecutionId race into a domain conflict. */
async function withConflictTranslation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error && error.name === "ConstraintError") {
      throw new TransactionError(
        "IDEMPOTENCY_CONFLICT",
        "a committed entity already exists for this executionId",
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Shared-context writes (each bumps Room revision exactly once)
// ---------------------------------------------------------------------------

/** User follow-up: a shared-projection write, so the Room revision bumps in
 * the same transaction as the Message insert. User messages never carry a
 * sourceExecutionId and never touch the Round cursor. */
export async function appendUserMessage(
  db: CouncilKitRuntimeDB,
  input: { roomId: string; roundId: string; token: ControllerToken; content: string },
): Promise<DiscussionMessage> {
  return db.transaction(
    "rw",
    [db.rooms, db.rounds, db.messages, db.summaries, db.runtimeBindings],
    async () => {
      const room = await requireRoom(db, input.roomId);
      await requireController(db, input.roomId, input.token);
      const round = await db.rounds.get(input.roundId);
      if (!round || round.roomId !== input.roomId) {
        throw new TransactionError("ROUND_NOT_FOUND", "unknown round for this room");
      }
      if (input.content.trim().length === 0) {
        throw new TransactionError("INVALID", "content must be non-empty");
      }
      const message: DiscussionMessage = {
        id: uuid(),
        roomId: input.roomId,
        roundId: input.roundId,
        role: "user",
        participantId: null,
        content: input.content,
        sourceExecutionId: null,
        createdAt: ts(),
      };
      await db.messages.add(message);
      await bumpRoomContext(db, room);
      return message;
    },
  );
}

/** Room topic/background (and future context policy) are shared-context
 * writes: a changed value bumps the Room revision exactly once. */
export async function updateRoomSharedConfig(
  db: CouncilKitRuntimeDB,
  input: { roomId: string; token: ControllerToken; topic?: string; background?: string },
): Promise<boolean> {
  return db.transaction(
    "rw",
    [db.rooms, db.messages, db.summaries, db.runtimeBindings],
    async () => {
      const room = await requireRoom(db, input.roomId);
      await requireController(db, input.roomId, input.token);
      const nextTopic = input.topic ?? room.topic;
      const nextBackground = input.background ?? room.background;
      if (nextTopic === room.topic && nextBackground === room.background) return false;
      room.topic = nextTopic;
      room.background = nextBackground;
      await bumpRoomContext(db, room);
      return true;
    },
  );
}

// ---------------------------------------------------------------------------
// Round lifecycle
// ---------------------------------------------------------------------------

/** CAS `activeRoundId` empty: at most one unfinalized Round per Room. */
export async function createRound(
  db: CouncilKitRuntimeDB,
  input: { roomId: string; token: ControllerToken; participantOrder: string[] },
): Promise<DiscussionRound> {
  return db.transaction("rw", [db.rooms, db.rounds, db.runtimeBindings], async () => {
    const room = await requireRoom(db, input.roomId);
    await requireController(db, input.roomId, input.token);
    if (room.runState === "paused") {
      throw new TransactionError("ROOM_PAUSED", "room is paused by the user");
    }
    if (room.activeRoundId !== null) {
      throw new TransactionError("ROUND_ACTIVE_EXISTS", "room already has an unfinalized round");
    }
    const existing = await db.rounds.where("roomId").equals(input.roomId).toArray();
    const roundNumber = existing.reduce((max, round) => Math.max(max, round.roundNumber), 0) + 1;
    const round: DiscussionRound = {
      id: uuid(),
      roomId: input.roomId,
      roundNumber,
      participantOrder: [...input.participantOrder],
      phase: "pending",
      pausedFrom: null,
      pauseReason: null,
      nextParticipantIndex: 0,
      activeExecutionId: null,
      createdAt: ts(),
      completedAt: null,
    };
    await db.rounds.add(round);
    room.activeRoundId = round.id;
    room.runState = "running";
    room.lastActiveAt = ts();
    await db.rooms.put(room);
    return round;
  });
}

export async function transitionRound(
  db: CouncilKitRuntimeDB,
  input: {
    roomId: string;
    roundId: string;
    token: ControllerToken;
    to: "prewarming" | "running";
  },
): Promise<void> {
  await db.transaction("rw", [db.rooms, db.rounds, db.runtimeBindings], async () => {
    await requireRoom(db, input.roomId);
    await requireController(db, input.roomId, input.token);
    const round = await db.rounds.get(input.roundId);
    if (!round) throw new TransactionError("ROUND_NOT_FOUND", `unknown round ${input.roundId}`);
    const expectedFrom = input.to === "prewarming" ? "pending" : "prewarming";
    if (round.phase !== expectedFrom) {
      throw new TransactionError(
        "ROUND_PHASE",
        `cannot enter ${input.to} from phase ${round.phase}`,
      );
    }
    round.phase = input.to;
    await db.rounds.put(round);
  });
}

/** Pause with a structured reason; resumable only into `pausedFrom`. */
export async function pauseRound(
  db: CouncilKitRuntimeDB,
  input: {
    roomId: string;
    roundId: string;
    token: ControllerToken;
    reason: RoundPauseReason;
  },
): Promise<void> {
  await db.transaction("rw", [db.rooms, db.rounds, db.runtimeBindings], async () => {
    await requireRoom(db, input.roomId);
    await requireController(db, input.roomId, input.token);
    const round = await db.rounds.get(input.roundId);
    if (!round) throw new TransactionError("ROUND_NOT_FOUND", `unknown round ${input.roundId}`);
    if (
      round.phase !== "prewarming" &&
      round.phase !== "running" &&
      round.phase !== "summarizing"
    ) {
      throw new TransactionError("ROUND_PHASE", `cannot pause from phase ${round.phase}`);
    }
    round.pausedFrom = round.phase;
    round.phase = "paused";
    round.pauseReason = input.reason;
    await db.rounds.put(round);
  });
}

export async function resumeRound(
  db: CouncilKitRuntimeDB,
  input: { roomId: string; roundId: string; token: ControllerToken },
): Promise<void> {
  await db.transaction("rw", [db.rooms, db.rounds, db.runtimeBindings], async () => {
    await requireRoom(db, input.roomId);
    await requireController(db, input.roomId, input.token);
    const round = await db.rounds.get(input.roundId);
    if (!round) throw new TransactionError("ROUND_NOT_FOUND", `unknown round ${input.roundId}`);
    if (round.phase !== "paused" || !round.pausedFrom) {
      throw new TransactionError("ROUND_PHASE", `cannot resume from phase ${round.phase}`);
    }
    round.phase = round.pausedFrom;
    round.pausedFrom = null;
    round.pauseReason = null;
    await db.rounds.put(round);
  });
}

/** User-ended Round: never completed, Summary not required, no active
 * execution left behind (a live one is marked interrupted). */
export async function abortRound(
  db: CouncilKitRuntimeDB,
  input: { roomId: string; roundId: string; token: ControllerToken },
): Promise<void> {
  await db.transaction(
    "rw",
    [db.rooms, db.rounds, db.modelExecutions, db.runtimeBindings],
    async () => {
      const room = await requireRoom(db, input.roomId);
      await requireController(db, input.roomId, input.token);
      const round = await db.rounds.get(input.roundId);
      if (!round) throw new TransactionError("ROUND_NOT_FOUND", `unknown round ${input.roundId}`);
      if (round.phase === "completed") {
        throw new TransactionError("ROUND_FINAL", "a completed round cannot be aborted");
      }
      if (round.phase === "aborted") return; // idempotent
      if (round.activeExecutionId !== null) {
        const execution = await db.modelExecutions.get(round.activeExecutionId);
        if (
          execution &&
          (execution.state === "prepared" ||
            execution.state === "running" ||
            execution.state === "succeeded_uncommitted")
        ) {
          execution.state = "interrupted";
          execution.error = {
            code: "USER_CANCELLED",
            phase: "dispatch",
            message: "round aborted by user",
            retryable: false,
          };
          execution.ackState = null;
          execution.updatedAt = ts();
          await db.modelExecutions.put(execution);
        }
      }
      round.phase = "aborted";
      round.pausedFrom = null;
      round.pauseReason = null;
      round.activeExecutionId = null;
      round.completedAt = ts();
      await db.rounds.put(round);
      room.activeRoundId = null;
      room.runState = "idle";
      room.lastActiveAt = ts();
      await db.rooms.put(room);
    },
  );
}

// ---------------------------------------------------------------------------
// Execution persistence (dispatch boundary)
// ---------------------------------------------------------------------------

/** Persist the execution anchor and round.activeExecutionId BEFORE any Host
 * dispatch: retries reconnect, they never re-dispatch. */
export async function beginExecution(
  db: CouncilKitRuntimeDB,
  input: { execution: ModelExecution; token: ControllerToken },
): Promise<ModelExecution> {
  return withConflictTranslation(() =>
    db.transaction(
      "rw",
      [db.rounds, db.rooms, db.participants, db.modelExecutions, db.runtimeBindings],
      async () => {
        const { execution } = input;
        const round = await db.rounds.get(execution.roundId);
        if (!round) throw new TransactionError("ROUND_NOT_FOUND", "unknown round");
        const room = await requireRoom(db, round.roomId);
        await requireController(db, round.roomId, input.token);
        if (room.activeRoundId !== round.id) {
          throw new TransactionError("STALE_EXECUTION", "round is not the room's active round");
        }
        const expectedPhase = execution.resultKind === "summary" ? "summarizing" : "running";
        if (round.phase !== expectedPhase) {
          throw new TransactionError(
            "ROUND_PHASE",
            `cannot start a ${execution.resultKind} execution in phase ${round.phase}`,
          );
        }
        if (round.activeExecutionId !== null) {
          throw new TransactionError("EXECUTION_ACTIVE", "round already has an active execution");
        }
        const participant = await db.participants.get(execution.participantId);
        if (!participant || participant.state !== "active") {
          throw new TransactionError("PARTICIPANT_INACTIVE", "participant is not active");
        }
        if (execution.resultKind === "summary") {
          if (execution.participantId !== room.facilitatorParticipantId) {
            throw new TransactionError(
              "FACILITATOR_MISMATCH",
              "summary execution must belong to the room facilitator",
            );
          }
        } else if (round.participantOrder[round.nextParticipantIndex] !== execution.participantId) {
          throw new TransactionError("STALE_EXECUTION", "participant is not at the round cursor");
        }
        await db.modelExecutions.add(execution);
        round.activeExecutionId = execution.executionId;
        await db.rounds.put(round);
        return execution;
      },
    ),
  );
}

/** Host dispatch acknowledged: prepared -> running with Host facts. */
export async function markExecutionDispatched(
  db: CouncilKitRuntimeDB,
  input: {
    executionId: string;
    hostInstanceId: string;
    executionScopeId: string;
    dispatchState: "unknown" | "accepted";
  },
): Promise<void> {
  await db.transaction("rw", [db.modelExecutions], async () => {
    const execution = await db.modelExecutions.get(input.executionId);
    if (!execution) throw new TransactionError("EXECUTION_NOT_FOUND", "unknown execution");
    if (execution.state !== "prepared") {
      throw new TransactionError(
        "EXECUTION_STATE",
        `cannot mark dispatched from state ${execution.state}`,
      );
    }
    execution.state = "running";
    execution.hostInstanceId = input.hostInstanceId;
    execution.executionScopeId = input.executionScopeId;
    execution.dispatchState = input.dispatchState;
    execution.updatedAt = ts();
    await db.modelExecutions.put(execution);
  });
}

/** Host completed; output awaits its commit transaction. */
export async function markExecutionSucceededUncommitted(
  db: CouncilKitRuntimeDB,
  input: {
    executionId: string;
    effectiveModel: string | null;
    usage: ModelExecutionUsage | null;
    finalEventSeq: number;
    dispatchState: "unknown" | "accepted";
    toolState: ModelExecution["toolState"];
  },
): Promise<void> {
  await db.transaction("rw", [db.modelExecutions], async () => {
    const execution = await db.modelExecutions.get(input.executionId);
    if (!execution) throw new TransactionError("EXECUTION_NOT_FOUND", "unknown execution");
    if (execution.state !== "running") {
      throw new TransactionError(
        "EXECUTION_STATE",
        `cannot mark succeeded from state ${execution.state}`,
      );
    }
    execution.state = "succeeded_uncommitted";
    execution.effectiveModel = input.effectiveModel;
    execution.usage = input.usage;
    execution.finalEventSeq = input.finalEventSeq;
    execution.dispatchState = input.dispatchState;
    execution.toolState = input.toolState;
    execution.updatedAt = ts();
    await db.modelExecutions.put(execution);
  });
}

// ---------------------------------------------------------------------------
// Commit (persist → ACK pending) and intentional drop
// ---------------------------------------------------------------------------

export type CommitOutcome =
  | { outcome: "committed"; entityId: string; roundPhase: DiscussionRound["phase"] }
  | { outcome: "replayed"; entityId: string }
  | { outcome: "discarded"; runtimeOutcome: RuntimeOutcome };

interface CommitInput {
  executionId: string;
  token: ControllerToken;
  content: string;
  effectiveModel: string | null;
  usage: ModelExecutionUsage | null;
  finalEventSeq: number;
  dispatchState: "unknown" | "accepted";
  toolState: ModelExecution["toolState"];
}

function contentDigestOf(content: string): string {
  return digestOf({ digestVersion: 1, content });
}

async function loadCommitContext(
  db: CouncilKitRuntimeDB,
  executionId: string,
  token: ControllerToken,
) {
  const execution = await db.modelExecutions.get(executionId);
  if (!execution) throw new TransactionError("EXECUTION_NOT_FOUND", "unknown execution");
  const round = await db.rounds.get(execution.roundId);
  if (!round) throw new TransactionError("ROUND_NOT_FOUND", "unknown round");
  const room = await requireRoom(db, round.roomId);
  await requireController(db, round.roomId, token);
  const participant = await db.participants.get(execution.participantId);
  if (!participant) throw new TransactionError("PARTICIPANT_NOT_FOUND", "unknown participant");
  return { execution, round, room, participant };
}

function replayOrThrow(
  execution: ModelExecution,
  expectedKind: "message" | "summary",
  content: string,
  finalEventSeq: number,
): { outcome: "replayed"; entityId: string } {
  // A replay returns the existing commit only when room, round, participant
  // (all anchored by the stored execution), resultKind, finalEventSeq and the
  // content digest all match; any difference conflicts and rolls back.
  const matches =
    execution.resultKind === expectedKind &&
    execution.finalEventSeq === finalEventSeq &&
    execution.contentDigest === contentDigestOf(content);
  if (!matches) {
    throw new TransactionError(
      "IDEMPOTENCY_CONFLICT",
      "same executionId replayed with different facts",
    );
  }
  return { outcome: "replayed", entityId: execution.committedEntityId as string };
}

function assertCommittable(execution: ModelExecution, expectedKind: "message" | "summary"): void {
  if (execution.resultKind !== expectedKind) {
    throw new TransactionError(
      "IDEMPOTENCY_CONFLICT",
      `execution resultKind is ${execution.resultKind}, not ${expectedKind}`,
    );
  }
  if (execution.state !== "running" && execution.state !== "succeeded_uncommitted") {
    throw new TransactionError(
      "EXECUTION_NOT_COMMITTABLE",
      `cannot commit from state ${execution.state}`,
    );
  }
}

/** Context/participant drift: never commit the body, never advance the
 * cursor — persist stale_context + paused, then a discarded ACK follows. */
async function discardLockedExecution(
  db: CouncilKitRuntimeDB,
  execution: ModelExecution,
  round: DiscussionRound,
  outcome: RuntimeOutcome,
  finalEventSeq: number | null,
  error: ModelExecutionError | null,
): Promise<{ outcome: "discarded"; runtimeOutcome: RuntimeOutcome }> {
  execution.state = "discarded";
  execution.runtimeOutcome = outcome;
  execution.finalEventSeq = finalEventSeq;
  execution.ackState = "pending";
  if (error) execution.error = error;
  execution.updatedAt = ts();
  await db.modelExecutions.put(execution);
  if (round.activeExecutionId === execution.executionId) {
    round.activeExecutionId = null;
    if (round.phase === "running" || round.phase === "summarizing") {
      round.pausedFrom = round.phase;
      round.phase = "paused";
      round.pauseReason = {
        code: outcome,
        participantId: execution.participantId,
        executionId: execution.executionId,
      };
    }
    await db.rounds.put(round);
  }
  return { outcome: "discarded", runtimeOutcome: outcome };
}

/** Commit a participant Message: one transaction — body insert, execution
 * committed with ackState pending, Room revision/digest bump, cursor advance. */
export async function commitModelMessage(
  db: CouncilKitRuntimeDB,
  input: CommitInput,
): Promise<CommitOutcome> {
  return withConflictTranslation(() =>
    db.transaction(
      "rw",
      [
        db.modelExecutions,
        db.rounds,
        db.rooms,
        db.messages,
        db.summaries,
        db.participants,
        db.runtimeBindings,
      ],
      async () => {
        const { execution, round, room, participant } = await loadCommitContext(
          db,
          input.executionId,
          input.token,
        );
        if (execution.state === "committed") {
          return replayOrThrow(execution, "message", input.content, input.finalEventSeq);
        }
        assertCommittable(execution, "message");
        if (room.activeRoundId !== round.id || round.phase !== "running") {
          throw new TransactionError("STALE_EXECUTION", "round is not actively running");
        }
        if (round.activeExecutionId !== execution.executionId) {
          throw new TransactionError("STALE_EXECUTION", "execution is not the round's active one");
        }
        if (
          execution.expectedRoomDigest !== room.contextDigest ||
          execution.contextRevision !== room.contextRevision ||
          execution.participantSnapshotDigest !== participant.participantSnapshotDigest
        ) {
          return discardLockedExecution(
            db,
            execution,
            round,
            "stale_context",
            input.finalEventSeq,
            null,
          );
        }
        const message: DiscussionMessage = {
          id: uuid(),
          roomId: room.id,
          roundId: round.id,
          role: "participant",
          participantId: participant.id,
          content: input.content,
          sourceExecutionId: execution.executionId,
          createdAt: ts(),
        };
        await db.messages.add(message);
        execution.state = "committed";
        execution.contentDigest = contentDigestOf(input.content);
        execution.committedEntityType = "message";
        execution.committedEntityId = message.id;
        execution.effectiveModel = input.effectiveModel;
        execution.usage = input.usage;
        execution.finalEventSeq = input.finalEventSeq;
        execution.dispatchState = input.dispatchState;
        execution.toolState = input.toolState;
        execution.ackState = "pending";
        execution.updatedAt = ts();
        await db.modelExecutions.put(execution);
        await bumpRoomContext(db, room);
        round.activeExecutionId = null;
        round.nextParticipantIndex += 1;
        if (round.nextParticipantIndex >= round.participantOrder.length) {
          round.phase = "summarizing";
        }
        await db.rounds.put(round);
        return { outcome: "committed", entityId: message.id, roundPhase: round.phase };
      },
    ),
  );
}

/** Commit the facilitator Summary; the only path to phase completed, which
 * requires the committed Summary, cursor at end, and no active execution. */
export async function commitSummary(
  db: CouncilKitRuntimeDB,
  input: CommitInput,
): Promise<CommitOutcome> {
  return withConflictTranslation(() =>
    db.transaction(
      "rw",
      [
        db.modelExecutions,
        db.rounds,
        db.rooms,
        db.messages,
        db.summaries,
        db.participants,
        db.runtimeBindings,
      ],
      async () => {
        const { execution, round, room, participant } = await loadCommitContext(
          db,
          input.executionId,
          input.token,
        );
        if (execution.state === "committed") {
          return replayOrThrow(execution, "summary", input.content, input.finalEventSeq);
        }
        assertCommittable(execution, "summary");
        if (room.activeRoundId !== round.id || round.phase !== "summarizing") {
          throw new TransactionError("STALE_EXECUTION", "round is not summarizing");
        }
        if (round.activeExecutionId !== execution.executionId) {
          throw new TransactionError("STALE_EXECUTION", "execution is not the round's active one");
        }
        if (round.nextParticipantIndex < round.participantOrder.length) {
          throw new TransactionError(
            "ROUND_INVARIANT",
            "completed requires the cursor at the end of the participant order",
          );
        }
        if (
          execution.expectedRoomDigest !== room.contextDigest ||
          execution.contextRevision !== room.contextRevision ||
          execution.participantSnapshotDigest !== participant.participantSnapshotDigest
        ) {
          return discardLockedExecution(
            db,
            execution,
            round,
            "stale_context",
            input.finalEventSeq,
            null,
          );
        }
        const summary: DiscussionSummary = {
          id: uuid(),
          roomId: room.id,
          roundId: round.id,
          content: input.content,
          sourceExecutionId: execution.executionId,
          generatedAt: ts(),
        };
        await db.summaries.add(summary);
        execution.state = "committed";
        execution.contentDigest = contentDigestOf(input.content);
        execution.committedEntityType = "summary";
        execution.committedEntityId = summary.id;
        execution.effectiveModel = input.effectiveModel;
        execution.usage = input.usage;
        execution.finalEventSeq = input.finalEventSeq;
        execution.dispatchState = input.dispatchState;
        execution.toolState = input.toolState;
        execution.ackState = "pending";
        execution.updatedAt = ts();
        await db.modelExecutions.put(execution);
        await bumpRoomContext(db, room);
        round.phase = "completed";
        round.activeExecutionId = null;
        round.completedAt = ts();
        await db.rounds.put(round);
        room.activeRoundId = null;
        room.runState = "idle";
        room.lastActiveAt = ts();
        await db.rooms.put(room);
        return { outcome: "committed", entityId: summary.id, roundPhase: round.phase };
      },
    ),
  );
}

/** Persist an intentionally dropped terminal (mismatch / tool unknown /
 * empty / needs_rebase / user_cancelled): no entity, Round paused, ACK
 * follows with disposition discarded. No Room revision bump. */
export async function discardExecution(
  db: CouncilKitRuntimeDB,
  input: {
    executionId: string;
    token: ControllerToken;
    outcome: RuntimeOutcome;
    finalEventSeq: number;
    error?: ModelExecutionError;
  },
): Promise<{ outcome: "discarded"; runtimeOutcome: RuntimeOutcome } | { outcome: "replayed" }> {
  return db.transaction(
    "rw",
    [db.modelExecutions, db.rounds, db.rooms, db.participants, db.runtimeBindings],
    async () => {
      const { execution, round } = await loadCommitContext(db, input.executionId, input.token);
      if (execution.state === "committed") {
        throw new TransactionError(
          "IDEMPOTENCY_CONFLICT",
          "a committed execution cannot become discarded",
        );
      }
      if (execution.state === "discarded") {
        if (
          execution.runtimeOutcome === input.outcome &&
          execution.finalEventSeq === input.finalEventSeq
        ) {
          return { outcome: "replayed" };
        }
        throw new TransactionError(
          "IDEMPOTENCY_CONFLICT",
          "same executionId discarded with different facts",
        );
      }
      if (execution.state !== "running" && execution.state !== "succeeded_uncommitted") {
        throw new TransactionError(
          "EXECUTION_STATE",
          `cannot discard from state ${execution.state}`,
        );
      }
      return discardLockedExecution(
        db,
        execution,
        round,
        input.outcome,
        input.finalEventSeq,
        input.error ?? null,
      );
    },
  );
}

/** No-ACK terminal (crash / protocol failure / interrupt without an ACKable
 * terminal): never becomes committed or discarded; Round pauses. */
export async function failExecution(
  db: CouncilKitRuntimeDB,
  input: {
    executionId: string;
    token: ControllerToken;
    error: ModelExecutionError;
    kind: "failed" | "interrupted";
  },
): Promise<void> {
  await db.transaction(
    "rw",
    [db.modelExecutions, db.rounds, db.rooms, db.participants, db.runtimeBindings],
    async () => {
      const { execution, round } = await loadCommitContext(db, input.executionId, input.token);
      if (execution.state === "committed" || execution.state === "discarded") {
        throw new TransactionError(
          "IDEMPOTENCY_CONFLICT",
          `a ${execution.state} execution cannot become ${input.kind}`,
        );
      }
      if (execution.state === "failed" || execution.state === "interrupted") {
        return; // idempotent: the terminal is already persisted
      }
      execution.state = input.kind;
      execution.error = input.error;
      execution.ackState = null;
      execution.updatedAt = ts();
      await db.modelExecutions.put(execution);
      if (round.activeExecutionId === execution.executionId) {
        round.activeExecutionId = null;
        if (round.phase === "running" || round.phase === "summarizing") {
          round.pausedFrom = round.phase;
          round.phase = "paused";
          round.pauseReason = {
            code: input.error.code === "USER_CANCELLED" ? "user_cancelled" : "execution_failed",
            participantId: execution.participantId,
            executionId: execution.executionId,
            detail: input.error.message.slice(0, 256),
          };
        }
        await db.rounds.put(round);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// ACK lifecycle (U5 sends the actual ACKs)
// ---------------------------------------------------------------------------

export async function markAcknowledged(
  db: CouncilKitRuntimeDB,
  executionId: string,
): Promise<void> {
  await db.transaction("rw", [db.modelExecutions], async () => {
    const execution = await db.modelExecutions.get(executionId);
    if (!execution) throw new TransactionError("EXECUTION_NOT_FOUND", "unknown execution");
    if (execution.ackState === "pending") {
      execution.ackState = "acknowledged";
      execution.updatedAt = ts();
      await db.modelExecutions.put(execution);
    }
  });
}

/** Host instance changed or the terminal provably no longer exists: the ACK
 * converges to expired; the model is NEVER re-invoked. */
export async function markAckExpired(db: CouncilKitRuntimeDB, executionId: string): Promise<void> {
  await db.transaction("rw", [db.modelExecutions], async () => {
    const execution = await db.modelExecutions.get(executionId);
    if (!execution) throw new TransactionError("EXECUTION_NOT_FOUND", "unknown execution");
    if (execution.ackState === "pending") {
      execution.ackState = "expired";
      execution.updatedAt = ts();
      await db.modelExecutions.put(execution);
    }
  });
}

// ---------------------------------------------------------------------------
// RuntimeBinding lifecycle
// ---------------------------------------------------------------------------

/** CAS write of a creating binding; the same scopeRequestId retry returns the
 * existing one — the Host never sees a duplicate create. */
export async function createRuntimeBindingTx(
  db: CouncilKitRuntimeDB,
  input: { roomId: string; scopeRequestId: string },
): Promise<RuntimeBinding> {
  return db.transaction("rw", [db.runtimeBindings], async () => {
    const existing = await db.runtimeBindings
      .where("scopeRequestId")
      .equals(input.scopeRequestId)
      .first();
    if (existing) {
      if (existing.roomId !== input.roomId) {
        throw new TransactionError(
          "IDEMPOTENCY_CONFLICT",
          "scopeRequestId already used for another room",
        );
      }
      return existing;
    }
    const live = await db.runtimeBindings
      .where("roomId")
      .equals(input.roomId)
      .filter((binding) => binding.state === "creating" || binding.state === "active")
      .first();
    if (live) {
      throw new TransactionError(
        "BINDING_ACTIVE_EXISTS",
        "room already has a live runtime binding",
      );
    }
    const binding = createRuntimeBinding(input);
    await db.runtimeBindings.add(binding);
    return binding;
  });
}

/** creating -> active with the Host's scope/controller facts. A failed CAS
 * must be compensated by closing the returned Host scope (caller duty). */
export async function activateRuntimeBinding(
  db: CouncilKitRuntimeDB,
  input: {
    id: string;
    hostInstanceId: string;
    executionScopeId: string;
    controllerId: string;
    leaseEpoch: number;
  },
): Promise<RuntimeBinding> {
  return db.transaction("rw", [db.runtimeBindings], async () => {
    const binding = await db.runtimeBindings.get(input.id);
    if (!binding) throw new TransactionError("BINDING_NOT_FOUND", "unknown binding");
    if (binding.state !== "creating") {
      throw new TransactionError(
        "BINDING_STALE",
        `cannot activate a binding in state ${binding.state}`,
      );
    }
    binding.state = "active";
    binding.hostInstanceId = input.hostInstanceId;
    binding.executionScopeId = input.executionScopeId;
    binding.controllerId = input.controllerId;
    binding.leaseEpoch = input.leaseEpoch;
    binding.updatedAt = ts();
    await db.runtimeBindings.put(binding);
    return binding;
  });
}

/** After a Host takeover: the new controller generation replaces the old. */
export async function takeoverRuntimeBinding(
  db: CouncilKitRuntimeDB,
  input: { id: string; controllerId: string; leaseEpoch: number },
): Promise<void> {
  await db.transaction("rw", [db.runtimeBindings], async () => {
    const binding = await db.runtimeBindings.get(input.id);
    if (!binding) throw new TransactionError("BINDING_NOT_FOUND", "unknown binding");
    if (binding.state !== "active") {
      throw new TransactionError("BINDING_STALE", `cannot take over a ${binding.state} binding`);
    }
    binding.controllerId = input.controllerId;
    binding.leaseEpoch = input.leaseEpoch;
    binding.updatedAt = ts();
    await db.runtimeBindings.put(binding);
  });
}

export async function markBindingClosing(db: CouncilKitRuntimeDB, id: string): Promise<void> {
  await db.transaction("rw", [db.runtimeBindings], async () => {
    const binding = await db.runtimeBindings.get(id);
    if (!binding) throw new TransactionError("BINDING_NOT_FOUND", "unknown binding");
    if (binding.state === "creating" || binding.state === "active") {
      binding.state = "closing";
      binding.updatedAt = ts();
      await db.runtimeBindings.put(binding);
    }
  });
}

export async function markBindingClosed(db: CouncilKitRuntimeDB, id: string): Promise<void> {
  await db.transaction("rw", [db.runtimeBindings], async () => {
    const binding = await db.runtimeBindings.get(id);
    if (!binding) throw new TransactionError("BINDING_NOT_FOUND", "unknown binding");
    if (binding.state !== "closed") {
      binding.state = "closed";
      binding.updatedAt = ts();
      await db.runtimeBindings.put(binding);
    }
  });
}
