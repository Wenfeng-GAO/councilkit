import { updateRoomSharedConfig } from "@/lib/discussion-transactions";
import type { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type { Participant } from "@/models/discussion/entities";
import { TransactionError, createDiscussionRoom } from "@/models/discussion/factories";
import type { RuntimeBinding } from "@/models/discussion/runtime-binding";
import { profileDigestOf } from "@/models/execution-profile";
import {
  computeContextDigest,
  initializeRoomDigest,
  projectSharedContext,
} from "@/orchestrator/context-snapshot";
import type { DiscussionOrchestrator } from "@/orchestrator/discussion-orchestrator";

/**
 * Room admin (S7): delete / duplicate / rename lifecycle operations.
 *
 * Everything here is a COMPOSITION over existing Orchestrator + transaction
 * semantics (no changes to orchestrator/transactions files):
 * - deleteRoomCascade = orchestrator.releaseRuntime (refusal propagates) +
 *   one Dexie rw transaction deleting the 8 room-scoped tables' rows.
 * - duplicateRoom = createDiscussionRoom + initializeRoomDigest +
 *   orchestrator.joinAgent per active source Participant (digests recomputed).
 * - renameRoom = controlRoom takeover + updateRoomSharedConfig when warm;
 *   a 6-line mirror of its bump logic when cold (no active binding ⇒ no
 *   controller token can exist). The cold mirror is the single approved
 *   non-pure-composition write path (plan-a §Q2, ruling #2).
 *
 * legacy 零读取契约：本模块所有查询全部走 roomId 二级索引或主键 get，
 * 无全表扫描；CouncilKitRuntimeDB 只打开 `councilkit-runtime-v1`。
 */

function ts(): string {
  return new Date().toISOString();
}

function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function activeBindingOf(
  db: CouncilKitRuntimeDB,
  roomId: string,
): Promise<RuntimeBinding | undefined> {
  return db.runtimeBindings
    .where("roomId")
    .equals(roomId)
    .filter((binding) => binding.state === "active")
    .first();
}

/**
 * Cascade delete: close a possibly warm scope FIRST (releaseRuntime semantics —
 * reversed order would lose the closeScope token and leak the Host scope to its
 * idle TTL), then delete all room-scoped rows in ONE transaction covering 9
 * tables (8 room-scoped tables delete rows + executionProfiles covered with
 * zero writes; agents/executionProfiles are global tables, never touched —
 * ruling #1). Refusal semantics propagate: a live execution, an unresolved
 * active round, or any non-closed runtime binding (S7 fix-2 #1: a concurrent
 * startRound can complete binding creation between releaseRuntime and the
 * delete transaction) aborts the whole delete with nothing removed.
 */
export async function deleteRoomCascade(
  db: CouncilKitRuntimeDB,
  orchestrator: DiscussionOrchestrator,
  roomId: string,
): Promise<void> {
  // Idempotency short-circuit: releaseRuntime throws "unknown room" on an
  // already-deleted room, so check first (PK get, no scan).
  const existing = await db.rooms.get(roomId);
  if (!existing) return;
  await orchestrator.releaseRuntime(roomId);
  await db.transaction(
    "rw",
    [
      db.rooms,
      db.participants,
      db.rounds,
      db.messages,
      db.summaries,
      db.modelExecutions,
      db.runtimeBindings,
      db.reports,
      db.executionProfiles,
    ],
    async () => {
      const room = await db.rooms.get(roomId);
      if (!room) return; // idempotent: already deleted
      // In-transaction recheck mirroring the releaseRuntime guards: insurance
      // against another tab opening a round between release and delete.
      const live = await db.modelExecutions
        .where("roomId")
        .equals(roomId)
        .filter((execution) =>
          ["prepared", "running", "succeeded_uncommitted"].includes(execution.state),
        )
        .count();
      if (live > 0) {
        throw new TransactionError("ROOM_LIVE", "cannot delete while an execution is running");
      }
      if (room.activeRoundId) {
        const round = await db.rounds.get(room.activeRoundId);
        if (round && !["completed", "aborted"].includes(round.phase)) {
          throw new TransactionError("ROOM_LIVE", "cannot delete: an unresolved round remains");
        }
      }
      // S7 fix-2 #1: a concurrent startRound can finish binding creation (and
      // Host scope activation) in the window between releaseRuntime and this
      // transaction. Any non-closed binding means the room is live or going
      // live — refuse (explainable, retryable); a concurrent create landing
      // after the commit is still backstopped by R1's requireRoom.
      const openBindings = await db.runtimeBindings
        .where("roomId")
        .equals(roomId)
        .filter((binding) => binding.state !== "closed")
        .count();
      if (openBindings > 0) {
        throw new TransactionError(
          "ROOM_LIVE",
          "cannot delete: a runtime binding is active or being created",
        );
      }
      await db.participants.where("roomId").equals(roomId).delete();
      await db.rounds.where("roomId").equals(roomId).delete();
      await db.messages.where("roomId").equals(roomId).delete();
      await db.summaries.where("roomId").equals(roomId).delete();
      await db.modelExecutions.where("roomId").equals(roomId).delete();
      await db.runtimeBindings.where("roomId").equals(roomId).delete();
      await db.reports.where("roomId").equals(roomId).delete();
      await db.rooms.delete(roomId);
      // executionProfiles is covered by this transaction with ZERO writes
      // (the nine-table reading; see ruling #1).
    },
  );
}

/**
 * Duplicate a Room: copies topic (with 「（副本）」 suffix, ruling #3),
 * background, mode, targetOutput, maxRounds and the facilitator pointer, and
 * re-joins every ACTIVE source Participant (Agents with enabled=false are
 * carried — ruling #4; ended Participants stay behind). Messages/rounds/
 * summaries/executions/bindings/reports are NOT copied. profileDigest is
 * recomputed from the CURRENT Profile — a missing Profile (unbound Agent in
 * the source room) cannot be forged, so that is the one honest failure.
 *
 * S7 R2 混合快照防护：
 * ① The whole read phase (source room + active participants + their Agents +
 *    Profiles) runs in ONE readonly transaction — a consistent snapshot, so
 *    every profileDigest shares one digest basis and each Agent's
 *    executionProfileId + revision is captured at that same instant.
 * ② joinAgent re-reads each Agent, so an Agent rebound/upgraded in the window
 *    between the snapshot and the joins would yield a mixed Participant
 *    snapshot (new executionProfileId + stale digest). After the joins, a
 *    verification read compares every Agent's CURRENT executionProfileId +
 *    revision against the digest basis; any drift cascade-deletes the
 *    just-created room via deleteRoomCascade (S7 fix-2 #2: the room is visible
 *    and startable from the first joinAgent on, so a rooms/participants-only
 *    cleanup could leak rounds/executions/bindings and the Host scope) and
 *    throws CONCURRENT_MODIFICATION.
 */
export async function duplicateRoom(
  db: CouncilKitRuntimeDB,
  orchestrator: DiscussionOrchestrator,
  sourceRoomId: string,
): Promise<string> {
  const { source, sourceParticipants, joins } = await db.transaction(
    "r",
    [db.rooms, db.participants, db.agents, db.executionProfiles],
    async () => {
      const source = await db.rooms.get(sourceRoomId);
      if (!source) throw new TransactionError("ROOM_NOT_FOUND", `unknown room ${sourceRoomId}`);
      // activeParticipants semantics mirror (state=active, createdAt ascending).
      const sourceParticipants = await db.participants
        .where("roomId")
        .equals(sourceRoomId)
        .filter((participant) => participant.state === "active")
        .toArray();
      sourceParticipants.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

      const joins: {
        agentId: string;
        profileDigest: string;
        executionProfileId: string;
        agentRevision: number;
      }[] = [];
      for (const participant of sourceParticipants) {
        const agent = await db.agents.get(participant.agentId);
        // "Impossible" (handleDeleteAgent blocks deletion while ANY Participant,
        // ended included, references the Agent) — still defended.
        if (!agent) {
          throw new TransactionError("AGENT_NOT_FOUND", `unknown agent ${participant.agentId}`);
        }
        const profile = await db.executionProfiles.get(agent.executionProfileId);
        if (!profile) {
          throw new TransactionError(
            "PROFILE_NOT_FOUND",
            `Agent「${agent.name}」引用的 Execution Profile 不存在，无法复制`,
          );
        }
        joins.push({
          agentId: agent.id,
          profileDigest: profileDigestOf(profile),
          executionProfileId: agent.executionProfileId,
          agentRevision: agent.revision,
        });
      }
      return { source, sourceParticipants, joins };
    },
  );

  const room = initializeRoomDigest(
    createDiscussionRoom({
      topic: `${source.topic}（副本）`,
      background: source.background,
      facilitatorParticipantId: "pending",
      mode: source.mode,
      targetOutput: source.targetOutput,
      maxRounds: source.maxRounds,
    }),
  );
  await db.rooms.add(room);

  // Reuse joinAgent (idempotent; participantSnapshotDigest recomputed inside;
  // pure Dexie, no Host contact) instead of hand-writing Participant inserts.
  const participants: Participant[] = [];
  for (const join of joins) {
    participants.push(await orchestrator.joinAgent(room.id, join.agentId, join.profileDigest));
  }

  // ② Consistency verification read: every Agent's current executionProfileId
  // + revision must still equal the digest basis captured in the snapshot.
  const drifted = await db.transaction("r", [db.agents], async () => {
    for (const join of joins) {
      const agent = await db.agents.get(join.agentId);
      if (
        !agent ||
        agent.executionProfileId !== join.executionProfileId ||
        agent.revision !== join.agentRevision
      ) {
        return true;
      }
    }
    return false;
  });
  if (drifted) {
    // S7 fix-2 #2: TRUE cascade cleanup. The new room became visible and
    // startable the moment joinAgent invalidated the runtime queries, so the
    // old rooms/participants-only cleanup could leak rounds/executions/
    // runtimeBindings (and the Host scope) if it was started inside the
    // window. deleteRoomCascade reuses the 8-table cascade + releaseRuntime
    // semantics — zero new logic; the source room is never touched.
    //
    // S7 fix-3 #1: if the new room gained REAL liveness inside the window (a
    // running execution / unresolved round / active Host scope), the cascade
    // cleanup is refused just like any other live-room delete. A bare
    // CONCURRENT_MODIFICATION("retry") would lie — it implies the partial room
    // was rolled back, when in fact it visibly remains with live activity.
    // So: attempt the cleanup, then dispatch on whether the new room still
    // exists. Refused ⇒ composite, explainable error naming the residual
    // room id + a manual-cleanup pointer (no silent success, no fake retry).
    // Succeeded ⇒ the honest "retry against current Agents" path.
    try {
      await deleteRoomCascade(db, orchestrator, room.id);
    } catch {
      // Refusal (ROOM_LIVE / releaseRuntime guard) is expected when the new
      // room went live; the still-present recheck below decides the wording.
      // Any other unexpected throw is also surfaced via the same recheck —
      // a still-present room is the honest state either way.
    }
    if ((await db.rooms.get(room.id)) !== undefined) {
      throw new TransactionError(
        "CONCURRENT_MODIFICATION",
        `agent changed during duplicate; the partially-created room ${room.id} could not be auto-removed because it has live activity — stop it and delete it manually`,
      );
    }
    throw new TransactionError("CONCURRENT_MODIFICATION", "agent changed during duplicate; retry");
  }

  // Facilitator mapping: source facilitator Participant → its agentId → the
  // new Room's Participant for the same agent; fallback to the first slot
  // (the NewRoomPage Math.max(0, …) precedent).
  const facilitatorAgentId = sourceParticipants.find(
    (participant) => participant.id === source.facilitatorParticipantId,
  )?.agentId;
  const facilitatorIndex = Math.max(
    0,
    joins.findIndex((join) => join.agentId === facilitatorAgentId),
  );
  if (participants.length > 0) {
    room.facilitatorParticipantId = (participants[facilitatorIndex] as Participant).id;
    await db.rooms.put(room);
  }
  return room.id;
}

/**
 * Rename a Room (topic is a shared-context write ⇒ exactly one revision bump).
 * Two branches:
 * - warm (active binding exists): controlRoom takes over the Host controller
 *   (writing a fresh controllerId/leaseEpoch), then updateRoomSharedConfig —
 *   the shared write with revision semantics. Renaming a running room makes
 *   in-flight commits stale_context-discard (by design, same semantics as
 *   appendUserMessage); the UI warns about this in the confirm modal.
 * - cold (no active binding: fresh or released room): no controller token can
 *   exist, so this mirrors updateRoomSharedConfig + bumpRoomContext (6 lines,
 *   source: discussion-transactions.ts:149-168 / :82-89 — bumpRoomContext is
 *   not exported) with an in-transaction recheck that no active binding
 *   appeared. Approved as the single non-pure-composition path (ruling #2);
 *   the rejected alternative was ensureScope-ing a CLI process per rename.
 */
export async function renameRoom(
  db: CouncilKitRuntimeDB,
  orchestrator: DiscussionOrchestrator,
  roomId: string,
  topic: string,
): Promise<boolean> {
  if (topic.trim().length === 0) throw new TransactionError("INVALID", "topic required");
  const binding = await activeBindingOf(db, roomId);
  if (binding) {
    const handle = await orchestrator.controlRoom(roomId, abortAfter(1500));
    if (!handle) throw new Error("另一个页面正在控制该房间，暂时无法重命名");
    try {
      const fresh = await activeBindingOf(db, roomId);
      if (!fresh || !fresh.controllerId || fresh.leaseEpoch === null) {
        throw new TransactionError("STALE_CONTROLLER", "重命名期间运行时绑定已释放，请重试");
      }
      return await updateRoomSharedConfig(db, {
        roomId,
        token: { controllerId: fresh.controllerId, leaseEpoch: fresh.leaseEpoch },
        topic,
      });
    } finally {
      handle.release();
    }
  }
  return db.transaction(
    "rw",
    [db.rooms, db.messages, db.summaries, db.runtimeBindings],
    async () => {
      const room = await db.rooms.get(roomId);
      if (!room) throw new TransactionError("ROOM_NOT_FOUND", `unknown room ${roomId}`);
      // In-transaction recheck: still no active binding, otherwise the write
      // must go through the warm token path instead.
      const raced = await activeBindingOf(db, roomId);
      if (raced) {
        throw new TransactionError("STALE_CONTROLLER", "房间运行时已预热，请重试");
      }
      if (room.topic === topic) return false;
      room.topic = topic;
      // --- 6-line bumpRoomContext mirror (source noted in the doc comment) ---
      const messages = await db.messages.where("roomId").equals(roomId).toArray();
      const summaries = await db.summaries.where("roomId").equals(roomId).toArray();
      room.contextRevision += 1;
      room.contextDigest = computeContextDigest(projectSharedContext(room, messages, summaries));
      room.lastActiveAt = ts();
      await db.rooms.put(room);
      return true;
    },
  );
}
