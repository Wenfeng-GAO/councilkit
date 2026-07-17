import type { ControllerToken } from "@/lib/discussion-transactions";
import {
  abortRound,
  activateRuntimeBinding,
  beginExecution,
  createRound,
  createRuntimeBindingTx,
  discardExecution,
  failExecution,
  markAckExpired,
  markAcknowledged,
  markBindingClosed,
  markExecutionDispatched,
  pauseRound,
  setRoomRunState,
  takeoverRuntimeBinding,
  transitionRound,
} from "@/lib/discussion-transactions";
import type { CouncilKitRuntimeDB } from "@/lib/runtime-db";
import type { DiscussionRoom, DiscussionRound, Participant } from "@/models/discussion/entities";
import { createModelExecution, createParticipant } from "@/models/discussion/factories";
import type {
  ModelExecution,
  ModelExecutionError,
  ResultKind,
} from "@/models/discussion/model-execution";
import type { RuntimeBinding } from "@/models/discussion/runtime-binding";
import { handleCompletedExecution } from "@/orchestrator/commit-execution";
import {
  buildContextSnapshot,
  computeInstructionDigest,
  projectSharedContext,
} from "@/orchestrator/context-snapshot";
import { type RuntimeClient, RuntimeClientError } from "@/runtime/client";
import { followExecutionEvents } from "@/runtime/event-stream";
import type { RuntimeEvent } from "@shared/runtime/events";
import { type ExecutionProfileDto, executionProfileSchema } from "@shared/runtime/schemas";

/**
 * Persistent Discussion Orchestrator (U5): replaces the in-page runRound()
 * loop with a recoverable state machine. Dexie holds every fact (Round
 * phase/cursor, active execution, pause reason, ACK progress); the Zustand
 * store only ever sees disposable display state. The Orchestrator never
 * re-invokes the model on reconnect, replay, or takeover.
 */

export type ControlState = "acquiring" | "controlling" | "observing" | "lost-control";

export interface OrchestratorDisplay {
  onControlState?(roomId: string, state: ControlState): void;
  onPreview?(roomId: string, event: RuntimeEvent): void;
  onRoundChanged?(roomId: string): void;
}

export interface LockHandle {
  release(): void;
}

export interface LockProvider {
  /** Non-blocking: null when another page holds the lock. */
  tryAcquire(name: string): Promise<LockHandle | null>;
  /** Blocking: resolves once the lock is held (null when signalled/aborted). */
  acquire(name: string, signal?: AbortSignal): Promise<LockHandle | null>;
}

export interface OrchestratorDeps {
  db: CouncilKitRuntimeDB;
  client: RuntimeClient;
  display?: OrchestratorDisplay;
  locks?: LockProvider;
  ids?: { uuid(): string };
}

const MESSAGE_INSTRUCTION =
  "请阅读以上讨论上下文，以你的角色立场给出本轮发言；只输出你的发言正文。";
const SUMMARY_INSTRUCTION = "请总结本轮讨论：提炼共识、分歧、风险与下一步问题；只输出总结正文。";

function errorOf(code: string, message: string, retryable = false): ModelExecutionError {
  return { code, phase: "stream", message, retryable };
}

export function createDiscussionOrchestrator(deps: OrchestratorDeps) {
  const { db, client } = deps;
  const ids = deps.ids ?? { uuid: () => crypto.randomUUID() };
  const display = deps.display ?? {};
  let cachedHostInstanceId: string | null = null;

  async function hostInstanceId(): Promise<string> {
    if (!cachedHostInstanceId) {
      cachedHostInstanceId = (await client.health()).hostInstanceId;
    }
    return cachedHostInstanceId;
  }

  function notify(roomId: string): void {
    display.onRoundChanged?.(roomId);
  }

  // -------------------------------------------------------------------------
  // Controller (Web Lock + Host fencing)
  // -------------------------------------------------------------------------

  /** Hold the per-Room Web Lock, then take over the Host controller with a
   * fresh, higher leaseEpoch. While waiting the page is an observer; the
   * lock dropping later flips it to controller automatically. */
  async function controlRoom(roomId: string, signal?: AbortSignal): Promise<LockHandle | null> {
    display.onControlState?.(roomId, "acquiring");
    let handle: LockHandle | null = null;
    if (deps.locks) {
      const name = `councilkit-room-${roomId}`;
      handle = await deps.locks.tryAcquire(name);
      if (!handle) {
        // Another page controls this room: observe until the lock drops,
        // then take over automatically with a higher epoch.
        display.onControlState?.(roomId, "observing");
        handle = await deps.locks.acquire(name, signal);
      }
    } else {
      handle = { release() {} };
    }
    if (!handle) {
      display.onControlState?.(roomId, "observing");
      return null;
    }
    const binding = await latestBinding(roomId);
    if (binding && binding.state === "active" && binding.executionScopeId) {
      try {
        const controllerId = ids.uuid();
        const takeover = await client.takeoverScope(binding.executionScopeId, controllerId);
        await takeoverRuntimeBinding(db, {
          id: binding.id,
          controllerId,
          leaseEpoch: takeover.leaseEpoch,
        });
      } catch (error) {
        // The old scope may be gone (Host restarted): converge locally and
        // let ensureScope rebuild on the next round.
        if (error instanceof RuntimeClientError && error.status === 404) {
          await markBindingClosed(db, binding.id);
        } else {
          throw error;
        }
      }
    }
    display.onControlState?.(roomId, "controlling");
    return handle;
  }

  async function currentToken(roomId: string): Promise<ControllerToken> {
    const binding = await db.runtimeBindings
      .where("roomId")
      .equals(roomId)
      .filter((candidate) => candidate.state === "active")
      .first();
    if (!binding || !binding.controllerId || binding.leaseEpoch === null) {
      display.onControlState?.(roomId, "lost-control");
      throw new Error(`no active controller for room ${roomId}`);
    }
    return { controllerId: binding.controllerId, leaseEpoch: binding.leaseEpoch };
  }

  async function latestBinding(roomId: string): Promise<RuntimeBinding | undefined> {
    const bindings = await db.runtimeBindings.where("roomId").equals(roomId).toArray();
    return bindings
      .filter((binding) => binding.state !== "closed")
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  }

  // -------------------------------------------------------------------------
  // Scope lifecycle (binding CAS + Host create + compensate)
  // -------------------------------------------------------------------------

  async function ensureScope(
    roomId: string,
    participants: Participant[],
  ): Promise<{ binding: RuntimeBinding; token: ControllerToken }> {
    const existing = await latestBinding(roomId);
    if (existing && existing.state === "active" && existing.executionScopeId) {
      try {
        await client.getScopeStatus(existing.executionScopeId);
        return {
          binding: existing,
          token: {
            controllerId: existing.controllerId as string,
            leaseEpoch: existing.leaseEpoch as number,
          },
        };
      } catch (error) {
        if (error instanceof RuntimeClientError && error.status === 404) {
          await markBindingClosed(db, existing.id);
        } else {
          throw error;
        }
      }
    }

    const scopeRequestId = ids.uuid();
    const binding = await createRuntimeBindingTx(db, { roomId, scopeRequestId });
    const specs = await Promise.all(
      participants.map(async (participant) => {
        const profile = await db.executionProfiles.get(participant.executionProfileId);
        if (!profile) {
          throw new Error(`missing execution profile ${participant.executionProfileId}`);
        }
        const dto: ExecutionProfileDto = executionProfileSchema.parse({
          driverId: profile.driverId,
          installationId: profile.installationId,
          credentialMode: profile.credentialMode,
          options: profile.options,
        });
        return {
          participantId: participant.id,
          profile: dto,
          modelId: participant.modelId,
          personaPrompt: participant.personaPrompt,
        };
      }),
    );
    let created: Awaited<ReturnType<RuntimeClient["createScope"]>> | null = null;
    try {
      created = await client.createScope({ scopeRequestId, participants: specs });
      // The Host only dispatches on an ACTIVE scope (a creating one is reaped
      // after 30s): activate before persisting the active binding.
      await client.activateScope(created.scopeId, {
        controllerId: created.controllerId,
        leaseEpoch: created.leaseEpoch,
      });
      const activated = await activateRuntimeBinding(db, {
        id: binding.id,
        hostInstanceId: created.scope.hostInstanceId,
        executionScopeId: created.scopeId,
        controllerId: created.controllerId,
        leaseEpoch: created.leaseEpoch,
      });
      return {
        binding: activated,
        token: {
          controllerId: activated.controllerId as string,
          leaseEpoch: activated.leaseEpoch as number,
        },
      };
    } catch (error) {
      // The Host create succeeded but the active CAS failed: compensate with
      // the returned token so no warm Scope leaks.
      if (created) {
        await client
          .closeScope(created.scopeId, {
            controllerId: created.controllerId,
            leaseEpoch: created.leaseEpoch,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Startup audit: converge, never resume, never re-invoke
  // -------------------------------------------------------------------------

  async function startupAudit(): Promise<void> {
    const hostId = await hostInstanceId();

    // creating/closing bindings never stay forever: the Host reaps
    // unactivated creating scopes within 30s; converge the local record.
    const staleBindings = await db.runtimeBindings
      .filter((binding) => binding.state === "creating" || binding.state === "closing")
      .toArray();
    for (const binding of staleBindings) {
      if (binding.hostInstanceId && binding.hostInstanceId !== hostId) {
        await markBindingClosed(db, binding.id);
        continue;
      }
      if (binding.state === "closing" && binding.executionScopeId && binding.controllerId) {
        await client
          .closeScope(binding.executionScopeId, {
            controllerId: binding.controllerId,
            leaseEpoch: binding.leaseEpoch ?? 1,
          })
          .catch(() => undefined);
      }
      // creating without Host facts: Host TTL reaps; nothing to compensate.
      await markBindingClosed(db, binding.id);
    }

    // Unfinished executions: no auto-resume, no cleanup fraud — classify
    // into explainable paused states from persisted dispatch facts + Host query.
    const unfinished = await db.modelExecutions
      .filter((execution) =>
        ["prepared", "running", "succeeded_uncommitted"].includes(execution.state),
      )
      .toArray();
    for (const execution of unfinished) {
      const token = await tokenForRoom(execution.roomId);
      if (!token) continue; // no controller here; leave for the controlling page
      const kind = execution.state === "prepared" ? "failed" : "interrupted";
      let code = "SAFE_INTERRUPTION";
      if (execution.hostInstanceId === hostId && execution.executionScopeId) {
        try {
          await client.getExecution(execution.executionScopeId, execution.executionId);
          code = "INTERRUPTED_UNKNOWN";
        } catch (error) {
          if (!(error instanceof RuntimeClientError && error.status === 404)) throw error;
        }
      }
      await failExecution(db, {
        executionId: execution.executionId,
        token,
        error: errorOf(
          code,
          code === "SAFE_INTERRUPTION"
            ? "host restarted or terminal lost before commit"
            : "execution still exists but its outcome is unknown after reload",
        ),
        kind,
      });
      notify(execution.roomId);
    }

    // Pending ACKs: resend against the same Host instance; converge to
    // expired when the Host changed or the terminal is gone.
    const pendingAcks = await db.modelExecutions
      .filter(
        (execution) =>
          execution.ackState === "pending" &&
          (execution.state === "committed" || execution.state === "discarded"),
      )
      .toArray();
    for (const execution of pendingAcks) {
      if (execution.hostInstanceId !== hostId || execution.finalEventSeq === null) {
        await markAckExpired(db, execution.executionId);
        continue;
      }
      const token = await tokenForRoom(execution.roomId);
      if (!token) continue;
      try {
        const response = await client.ack(
          execution.executionScopeId as string,
          execution.executionId,
          {
            controllerId: token.controllerId,
            leaseEpoch: token.leaseEpoch,
            finalSeq: execution.finalEventSeq,
            disposition: execution.state === "committed" ? "committed" : "discarded",
          },
        );
        if (response.ackState === "acknowledged") {
          await markAcknowledged(db, execution.executionId);
        } else if (response.ackState === "expired") {
          await markAckExpired(db, execution.executionId);
        }
      } catch (error) {
        if (error instanceof RuntimeClientError && error.status === 404) {
          await markAckExpired(db, execution.executionId);
        }
        // else: stays pending for the next scan; the model is never re-invoked.
      }
    }
  }

  async function tokenForRoom(roomId: string): Promise<ControllerToken | null> {
    const binding = await db.runtimeBindings
      .where("roomId")
      .equals(roomId)
      .filter((candidate) => candidate.state === "active")
      .first();
    if (!binding || !binding.controllerId || binding.leaseEpoch === null) return null;
    return { controllerId: binding.controllerId, leaseEpoch: binding.leaseEpoch };
  }

  // -------------------------------------------------------------------------
  // Round driving
  // -------------------------------------------------------------------------

  /** Join an Agent into a Room (idempotent per agent while active). */
  async function joinAgent(roomId: string, agentId: string, profileDigest: string) {
    const agent = await db.agents.get(agentId);
    if (!agent) throw new Error(`unknown agent ${agentId}`);
    const existing = await db.participants
      .where("roomId")
      .equals(roomId)
      .filter((participant) => participant.agentId === agentId && participant.state === "active")
      .first();
    if (existing) return existing;
    const participant = createParticipant({ roomId, agent, profileDigest });
    await db.participants.add(participant);
    notify(roomId);
    return participant;
  }

  async function activeParticipants(roomId: string): Promise<Participant[]> {
    const participants = await db.participants
      .where("roomId")
      .equals(roomId)
      .filter((participant) => participant.state === "active")
      .toArray();
    return participants.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /** Start a new Round: snapshot the participant order, gate on prewarm
   * (any participant failure pauses atomically before the first speech),
   * then drive the loop to completion or pause. */
  async function startRound(roomId: string): Promise<DiscussionRound | null> {
    const room = await db.rooms.get(roomId);
    if (!room) throw new Error(`unknown room ${roomId}`);
    const participants = await activeParticipants(roomId);
    if (participants.length === 0) throw new Error("room has no active participants");

    // Ensure controller before any mutation (CAS in transactions re-checks).
    let token = await tokenForRoom(roomId);
    if (!token) {
      await controlRoom(roomId);
      token = await currentToken(roomId);
    }

    const round = await createRound(db, {
      roomId,
      token,
      participantOrder: participants.map((participant) => participant.id),
    });
    notify(roomId);
    await transitionRound(db, { roomId, roundId: round.id, token, to: "prewarming" });
    notify(roomId);

    try {
      const { token: scopeToken } = await ensureScope(roomId, participants);
      token = scopeToken;
      const binding = await latestBinding(roomId);
      const status = await client.getScopeStatus(binding?.executionScopeId as string);
      const notReady = status.participants.filter((participant) => participant.runtime !== "ready");
      if (notReady.length > 0) {
        await pauseRound(db, {
          roomId,
          roundId: round.id,
          token,
          reason: {
            code: "prewarm_failed",
            participantId: notReady[0]?.participantId,
            detail: `${notReady.length} participant(s) not ready`,
          },
        });
        notify(roomId);
        return (await db.rounds.get(round.id)) ?? null;
      }
    } catch (error) {
      await pauseRound(db, {
        roomId,
        roundId: round.id,
        token,
        reason: {
          code: "prewarm_failed",
          detail: error instanceof Error ? error.message.slice(0, 256) : "prewarm failed",
        },
      });
      notify(roomId);
      return (await db.rounds.get(round.id)) ?? null;
    }

    await transitionRound(db, { roomId, roundId: round.id, token, to: "running" });
    notify(roomId);
    await runLoop(roomId);
    return db.rounds.get(round.id) as Promise<DiscussionRound>;
  }

  /** The recoverable loop: read the durable Round state, dispatch exactly
   * the next thing, persist before every step. */
  async function runLoop(roomId: string): Promise<void> {
    for (;;) {
      const room = await db.rooms.get(roomId);
      if (!room || room.runState === "paused" || !room.activeRoundId) return;
      const round = await db.rounds.get(room.activeRoundId);
      if (!round) return;
      if (round.phase === "running") {
        const participantId = round.participantOrder[round.nextParticipantIndex] as string;
        const proceed = await dispatchTurn(room, round, participantId, "message");
        if (!proceed) return;
        continue;
      }
      if (round.phase === "summarizing") {
        await dispatchTurn(room, round, room.facilitatorParticipantId, "summary");
        return;
      }
      return; // paused / completed / aborted / pending / prewarming
    }
  }

  /** Dispatch one turn and drive it to its terminal. Returns false when the
   * round left `running` (paused/aborted) and the loop must stop. */
  async function dispatchTurn(
    room: DiscussionRoom,
    round: DiscussionRound,
    participantId: string,
    resultKind: ResultKind,
    retryOfExecutionId: string | null = null,
  ): Promise<boolean> {
    const token = await currentToken(room.id);
    const participant = await db.participants.get(participantId);
    if (!participant) throw new Error(`unknown participant ${participantId}`);
    const binding = await latestBinding(room.id);
    if (!binding || !binding.executionScopeId) throw new Error("no active scope");
    const scopeId = binding.executionScopeId;

    const messages = await db.messages.where("roomId").equals(room.id).toArray();
    const summaries = await db.summaries.where("roomId").equals(room.id).toArray();
    const items = projectSharedContext(room, messages, summaries).items;
    const instruction = {
      kind: resultKind,
      text: resultKind === "summary" ? SUMMARY_INSTRUCTION : MESSAGE_INSTRUCTION,
    } as const;
    const snapshot = buildContextSnapshot({ room, participant, instruction, items });
    const execution = createModelExecution({
      executionId: ids.uuid(),
      roomId: room.id,
      roundId: round.id,
      participantId,
      resultKind,
      requestedModel: participant.modelId,
      contextRevision: room.contextRevision,
      expectedRoomDigest: room.contextDigest,
      participantSnapshotDigest: participant.participantSnapshotDigest,
      instructionDigest: computeInstructionDigest(instruction),
      retryOfExecutionId,
    });
    // Persist the anchor BEFORE any Host call: retries reconnect, never
    // re-dispatch.
    await beginExecution(db, { execution, token });
    notify(room.id);

    try {
      await client.execute(scopeId, {
        controllerId: token.controllerId,
        leaseEpoch: token.leaseEpoch,
        executionId: execution.executionId,
        participantId,
        snapshot,
      });
      await markExecutionDispatched(db, {
        executionId: execution.executionId,
        hostInstanceId: await hostInstanceId(),
        executionScopeId: scopeId,
        dispatchState: "unknown",
      });
    } catch (error) {
      await failExecution(db, {
        executionId: execution.executionId,
        token,
        error: errorOf(
          "DISPATCH_FAILED",
          error instanceof Error ? error.message.slice(0, 256) : "execute failed",
        ),
        kind: "failed",
      });
      notify(room.id);
      return false;
    }

    return driveToTerminal(room, round, execution, token, 0);
  }

  /** Follow the event stream to the terminal, reconnecting with afterSeq;
   * the stream never re-dispatches. */
  async function driveToTerminal(
    room: DiscussionRoom,
    round: DiscussionRound,
    execution: ModelExecution,
    token: ControllerToken,
    afterSeq: number,
  ): Promise<boolean> {
    const binding = await latestBinding(room.id);
    const scopeId = binding?.executionScopeId as string;
    let resumeAt = afterSeq;
    for (;;) {
      const outcome = await followExecutionEvents({
        fetchInput: client.eventStreamFetch({
          scopeId,
          executionId: execution.executionId,
          afterSeq: resumeAt,
        }),
        onEvent: (event) => {
          display.onPreview?.(room.id, event);
        },
      });
      if (outcome.kind === "terminal") {
        return handleTerminal(room, round, execution.executionId, outcome.event, token);
      }
      resumeAt = outcome.lastSeq;
      // Connection ended without a terminal: check the Host's record.
      try {
        const status = await client.getExecution(scopeId, execution.executionId);
        if (status.state === "running") continue; // keep following from afterSeq
      } catch (error) {
        if (error instanceof RuntimeClientError && error.status === 404) {
          await failExecution(db, {
            executionId: execution.executionId,
            token,
            error: errorOf("SAFE_INTERRUPTION", "host lost the execution before its terminal"),
            kind: "interrupted",
          });
          notify(room.id);
          return false;
        }
        throw error;
      }
    }
  }

  async function handleTerminal(
    room: DiscussionRoom,
    round: DiscussionRound,
    executionId: string,
    event: RuntimeEvent,
    token: ControllerToken,
  ): Promise<boolean> {
    if (event.type === "completed") {
      const current = (await db.modelExecutions.get(executionId)) as ModelExecution;
      const result = await handleCompletedExecution(
        {
          db,
          client,
          scopeId: (await latestBinding(room.id))?.executionScopeId as string,
          token,
          currentHostInstanceId: await hostInstanceId(),
        },
        executionId,
        event,
      );
      notify(room.id);
      if (result.kind === "discarded") return false;
      // Continue the loop for messages; summaries end the round via commitSummary.
      return current.resultKind === "message";
    }

    // failed / interrupted: user cancel is an intentional drop; retryable
    // pre-dispatch failures retry exactly once; everything else pauses.
    if (event.type !== "failed" && event.type !== "interrupted") {
      throw new Error(`handleTerminal: unexpected non-terminal event ${event.type}`);
    }
    const execution = (await db.modelExecutions.get(executionId)) as ModelExecution;
    if (event.type === "interrupted" && event.reason === "user_cancelled") {
      await discardExecution(db, {
        executionId,
        token,
        outcome: "user_cancelled",
        finalEventSeq: event.seq,
        error: errorOf("USER_CANCELLED", "cancelled by user"),
      });
      notify(room.id);
      return false;
    }
    const retryable =
      event.dispatchState === "not_dispatched" &&
      (event.type === "failed" ? event.retryable : true) &&
      execution.retryOfExecutionId === null;
    if (retryable) {
      await failExecution(db, {
        executionId,
        token,
        error: errorOf(
          event.type === "failed" ? event.error.code : "INTERRUPTED",
          "pre-dispatch failure; retrying once with a new executionId",
          true,
        ),
        kind: event.type === "failed" ? "failed" : "interrupted",
        pause: false,
      });
      const retried = await db.rounds.get(round.id);
      if (!retried || retried.phase !== "running") return false;
      // The retry drives the SAME turn with a fresh executionId; its result
      // decides whether the loop continues (returning false here would stop
      // the loop on a still-running round).
      return dispatchTurn(
        room,
        retried,
        execution.participantId,
        execution.resultKind,
        execution.executionId,
      );
    }
    await failExecution(db, {
      executionId,
      token,
      error:
        event.type === "failed"
          ? {
              code: event.error.code,
              phase: event.error.phase,
              message: event.error.message,
              retryable: event.retryable,
            }
          : errorOf("INTERRUPTED", `interrupted (${event.reason})`),
      kind: event.type === "failed" ? "failed" : "interrupted",
    });
    notify(room.id);
    return false;
  }

  // -------------------------------------------------------------------------
  // User actions
  // -------------------------------------------------------------------------

  /** Pause the Room's scheduling gate; an in-flight execution is cancelled
   * and its interrupted(user_cancelled) terminal is discarded + ACKed by the
   * normal terminal path. */
  async function pauseRoom(roomId: string): Promise<void> {
    const token = await currentToken(roomId);
    await setRoomRunState(db, { roomId, token, runState: "paused" });
    const room = await db.rooms.get(roomId);
    if (room?.activeRoundId) {
      const round = await db.rounds.get(room.activeRoundId);
      if (round?.activeExecutionId) {
        const binding = await latestBinding(roomId);
        await client
          .cancelExecution(binding?.executionScopeId as string, round.activeExecutionId, token)
          .catch(() => undefined);
      }
    }
    notify(roomId);
  }

  async function resumeRoom(roomId: string): Promise<void> {
    const token = await currentToken(roomId);
    await setRoomRunState(db, { roomId, token, runState: "running" });
    notify(roomId);
    await runLoop(roomId);
  }

  /** User stop of the in-flight execution (round stays resumable after the
   * discarded terminal; the loop's terminal path pauses with user_cancelled). */
  async function cancelActiveExecution(roomId: string): Promise<void> {
    const token = await currentToken(roomId);
    const room = await db.rooms.get(roomId);
    if (!room?.activeRoundId) return;
    const round = await db.rounds.get(room.activeRoundId);
    if (!round?.activeExecutionId) return;
    const binding = await latestBinding(roomId);
    await client.cancelExecution(
      binding?.executionScopeId as string,
      round.activeExecutionId,
      token,
    );
  }

  /** The page may only END a paused Round; fixes happen on a new Round. */
  async function abortPausedRound(roomId: string): Promise<void> {
    const token = await currentToken(roomId);
    const room = await db.rooms.get(roomId);
    if (!room?.activeRoundId) return;
    const round = await db.rounds.get(room.activeRoundId);
    if (!round || round.phase !== "paused") {
      throw new Error("only a paused round can be ended");
    }
    await abortRound(db, { roomId, roundId: round.id, token });
    notify(roomId);
  }

  return {
    controlRoom,
    startupAudit,
    ensureScope,
    joinAgent,
    startRound,
    runLoop,
    pauseRoom,
    resumeRoom,
    cancelActiveExecution,
    abortPausedRound,
    activeParticipants,
  };
}

export type DiscussionOrchestrator = ReturnType<typeof createDiscussionOrchestrator>;
