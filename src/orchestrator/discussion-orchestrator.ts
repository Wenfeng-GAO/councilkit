import type { ControllerToken } from "@/lib/discussion-transactions";
import {
  abortRound,
  activateRuntimeBinding,
  appendUserMessage,
  beginExecution,
  beginFocusExecution,
  beginReportExecution,
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
import type {
  DiscussionMessage,
  DiscussionRoom,
  DiscussionRound,
  Participant,
  RoundPhase,
} from "@/models/discussion/entities";
import {
  TransactionError,
  createModelExecution,
  createParticipant,
} from "@/models/discussion/factories";
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
import {
  instructionText,
  parseConvergenceSuggestion,
  wireKindOf,
} from "@/orchestrator/discussion-instructions";
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

export type ControlState =
  | "acquiring"
  | "controlling"
  | "observing"
  | "lost-control"
  | "takeover_failed";

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

function errorOf(code: string, message: string, retryable = false): ModelExecutionError {
  return { code, phase: "stream", message, retryable };
}

export function createDiscussionOrchestrator(deps: OrchestratorDeps) {
  const { db, client } = deps;
  const ids = deps.ids ?? { uuid: () => crypto.randomUUID() };
  const display = deps.display ?? {};
  let cachedHostInstanceId: string | null = null;
  /** Web Locks this orchestrator instance currently holds, keyed by roomId.
   * Makes controlRoom re-entrant: a page already holding the room lock must
   * never queue behind itself — the first-ever startRound (no binding yet)
   * would otherwise deadlock against the page's own lock and flip the page
   * to observing. */
  const heldLocks = new Map<string, LockHandle>();

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
    const held = heldLocks.get(roomId);
    if (held) {
      display.onControlState?.(roomId, "controlling");
      return held;
    }
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
    const rawHandle: LockHandle = handle;
    const tracked: LockHandle = {
      release: () => {
        heldLocks.delete(roomId);
        rawHandle.release();
      },
    };
    heldLocks.set(roomId, tracked);
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
          // A live Host refused/errored the takeover: the page must surface
          // the failure instead of silently observing.
          display.onControlState?.(roomId, "takeover_failed");
          throw error;
        }
      }
    }
    display.onControlState?.(roomId, "controlling");
    return tracked;
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
        const status = await client.getScopeStatus(existing.executionScopeId);
        if (status.state === "active") {
          return {
            binding: existing,
            token: {
              controllerId: existing.controllerId as string,
              leaseEpoch: existing.leaseEpoch as number,
            },
          };
        }
        // The Host closed (or is closing) this Scope: converge locally and
        // rebuild cold below — a closed Scope is never reused (this is the
        // needs_rebase recovery path: new cold Scope from the full snapshot).
        await markBindingClosed(db, existing.id);
      } catch (error) {
        if (error instanceof RuntimeClientError && error.status === 404) {
          await markBindingClosed(db, existing.id);
        } else {
          throw error;
        }
      }
    }

    // Resume an interrupted create: a leftover creating binding's
    // scopeRequestId is the idempotency key — the Host keys Scopes by it, so
    // a retry never produces a second Scope (a reaped one is simply
    // recreated under the same request id). Without this, a failed first
    // startRound would poison the room with BINDING_ACTIVE_EXISTS until the
    // startup audit converges the leftover row.
    const reusable = existing && existing.state === "creating" ? existing : null;
    const scopeRequestId = reusable ? reusable.scopeRequestId : ids.uuid();
    const binding = reusable ?? (await createRuntimeBindingTx(db, { roomId, scopeRequestId }));
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
    /** Converge a Room's crash windows only while holding its Web Lock: an
     * observing page must never fail the controlling page's in-flight
     * execution (E2E control-suite finding). Without a LockProvider (tests),
     * the audit is ungated. */
    const auditLocks = new Map<string, LockHandle>();
    async function auditLock(roomId: string): Promise<boolean> {
      if (!deps.locks) return true;
      if (heldLocks.has(roomId) || auditLocks.has(roomId)) return true;
      const handle = await deps.locks.tryAcquire(`councilkit-room-${roomId}`);
      if (!handle) return false;
      auditLocks.set(roomId, handle);
      return true;
    }
    try {
      // creating/closing bindings never stay forever: the Host reaps
      // unactivated creating scopes within 30s; converge the local record.
      const staleBindings = await db.runtimeBindings
        .filter((binding) => binding.state === "creating" || binding.state === "closing")
        .toArray();
      for (const binding of staleBindings) {
        if (!(await auditLock(binding.roomId))) continue;
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
        if (!(await auditLock(execution.roomId))) continue;
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
        if (!(await auditLock(execution.roomId))) continue;
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
    } finally {
      for (const handle of auditLocks.values()) handle.release();
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
   * then drive the loop to completion or pause. Thin shell over
   * startRoundPrepared (S2): no behavior drift. */
  async function startRound(roomId: string): Promise<DiscussionRound | null> {
    return startRoundPrepared(roomId);
  }

  /** Start a new Round, optionally seeding it with a user follow-up message
   * that lands in the shared context BEFORE the round opens (S2). The seed
   * goes into its own transaction after createRound but before prewarming, so
   * the round's first focus snapshot already contains it. content is validated
   * UP FRONT so an INVALID never leaves a pending round behind. */
  async function startRoundWithUserMessage(
    roomId: string,
    content: string,
  ): Promise<DiscussionRound | null> {
    if (content.trim().length === 0) {
      throw new Error("startRoundWithUserMessage: content must be non-empty");
    }
    return startRoundPrepared(roomId, content);
  }

  /** Shared startRound body (S2). seedContent, when provided, is appended to
   * the new round as a user message between createRound and prewarming. */
  async function startRoundPrepared(
    roomId: string,
    seedContent?: string,
  ): Promise<DiscussionRound | null> {
    const room = await db.rooms.get(roomId);
    if (!room) throw new Error(`unknown room ${roomId}`);
    // Fast-fail a concluded room BEFORE touching controlRoom/ensureScope so we
    // don't allocate a Scope or runtime binding for a room that can never
    // accept a round. createRound re-checks inside its transaction as a backstop.
    if (room.status === "concluded") {
      throw new TransactionError(
        "ROOM_CONCLUDED",
        "room is concluded; duplicate the room to continue",
      );
    }
    const participants = await activeParticipants(roomId);
    if (participants.length === 0) throw new Error("room has no active participants");

    // Ensure controller before any mutation (CAS in transactions re-checks).
    let token = await tokenForRoom(roomId);
    if (!token) {
      const handle = await controlRoom(roomId);
      if (!handle) {
        // Observing page: surfaces "no active controller" like currentToken.
        token = await currentToken(roomId);
      } else {
        // A fresh Room has no runtime binding yet: create + activate the
        // Scope now so the Round's mutations have a controller token (the
        // ensureScope below then returns the same binding unchanged).
        token = (await ensureScope(roomId, participants)).token;
      }
    }

    const round = await createRound(db, {
      roomId,
      token,
      participantOrder: participants.map((participant) => participant.id),
    });
    notify(roomId);

    if (seedContent !== undefined) {
      // Seed as its own transaction (tx2): bumps the Room revision 0→1 so the
      // round's first focus snapshot already includes the user follow-up.
      await appendUserMessage(db, { roomId, roundId: round.id, token, content: seedContent });
      notify(roomId);
    }

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
   * the next thing, persist before every step. S2: the Round 0 ring is the
   * facilitator focus — dispatched first in phase "running" when the round
   * is awaiting it (focusMessageId === null), BEFORE any participant speaks.
   * Pre-S2 legacy rows (focusMessageId === undefined) skip focus entirely. */
  async function runLoop(roomId: string): Promise<void> {
    for (;;) {
      const room = await db.rooms.get(roomId);
      if (!room || room.runState === "paused" || !room.activeRoundId) return;
      const round = await db.rounds.get(room.activeRoundId);
      if (!round) return;
      if (round.phase === "running") {
        // Strict `=== null`: only a post-S2 Round awaiting its focus triggers
        // the focus dispatch. undefined (legacy) and string (committed) fall
        // through to the cursor branch — legacy Rounds are never retro-focussed.
        if (round.focusMessageId === null) {
          const proceed = await dispatchTurn(room, round, room.facilitatorParticipantId, "focus");
          if (!proceed) return;
          continue;
        }
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
   * round left `running` (paused/aborted) and the loop must stop, OR when the
   * room is concluding (a report dispatch ends the room). resultKind is
   * generalized to the four ResultKinds (S2); begin dispatches via the
   * matching begin* function. The wire instruction.kind stays message/summary. */
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
    const wireKind = wireKindOf(resultKind);
    const instruction = {
      kind: wireKind,
      text: instructionText(room.mode, resultKind, room.targetOutput),
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
    // re-dispatch. Three-way begin dispatch (S2): focus and report have
    // dedicated entry points; message/summary share beginExecution.
    if (resultKind === "focus") {
      await beginFocusExecution(db, { execution, token });
    } else if (resultKind === "report") {
      await beginReportExecution(db, { execution, token });
    } else {
      await beginExecution(db, { execution, token });
    }
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
      // report/focus are never driven by the message/summary loop continuation
      // logic below. A report commit ends the room; focus just lets the loop
      // re-read the round to advance to the first participant.
      if (current.resultKind === "report") return false;
      if (current.resultKind === "focus") return true;
      // A committed summary may trigger concluding (S2): parse the summary's
      // last-line convergence vote and, if the room should conclude, dispatch
      // the facilitator report in this same synchronous path. Convergence
      // parsing NEVER blocks the summary commit (the commit already landed).
      if (current.resultKind === "summary") {
        await maybeStartConcluding(room.id, round.id, event);
        return false; // summaries end the round; concluding (if any) drives the report
      }
      // Continue the loop for messages.
      return true;
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
      // The retry phase depends on resultKind: report retries from "completed"
      // (the round is already done); summary retries from "summarizing";
      // message/focus retry from "running". Focus re-dispatches into
      // beginFocusExecution on the retry.
      const expectedPhase: RoundPhase =
        execution.resultKind === "report"
          ? "completed"
          : execution.resultKind === "summary"
            ? "summarizing"
            : "running";
      const retried = await db.rounds.get(round.id);
      if (!retried || retried.phase !== expectedPhase) return false;
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

  /** S2 convergence: after a summary commits, decide whether the room should
   * conclude. Concludes iff (suggestion=是 AND ≥1 completed round) OR
   * (maxRounds !== null AND completed rounds ≥ maxRounds). Concluding is a
   * pure synchronous transient — never stored — it dispatches a facilitator
   * report on the same persist→ACK pipeline. The room is re-fetched fresh
   * because the summary commit just bumped its revision/digest; dispatching
   * the report against a stale digest would self-harm with stale_context.
   * Parse failures read as 否 and never block the summary that already landed.
   * Derived口径 (for S4 UI): concluding ⟺ ∃ a resultKind="report" execution
   * in state prepared/running/succeeded_uncommitted, derivable from queries. */
  async function maybeStartConcluding(
    roomId: string,
    roundId: string,
    event: RuntimeEvent,
  ): Promise<void> {
    if (event.type !== "completed") return;
    const freshRoom = await db.rooms.get(roomId);
    if (!freshRoom || freshRoom.status === "concluded") return;
    const anchorRound = await db.rounds.get(roundId);
    if (!anchorRound || anchorRound.phase !== "completed") return;
    const suggestion = parseConvergenceSuggestion(event.output);
    const completedRounds = await db.rounds
      .where("roomId")
      .equals(roomId)
      .filter((candidate) => candidate.phase === "completed")
      .count();
    const maxRounds = freshRoom.maxRounds;
    const shouldConclude =
      completedRounds >= 1 &&
      ((suggestion && completedRounds >= 1) ||
        (maxRounds !== null && completedRounds >= maxRounds));
    if (!shouldConclude) return;
    await dispatchTurn(freshRoom, anchorRound, freshRoom.facilitatorParticipantId, "report");
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

  /** User follow-up into the Room's ACTIVE round: a shared-projection write
   * (bumps the Room revision exactly once), never a model dispatch. */
  async function sendUserMessage(roomId: string, content: string): Promise<DiscussionMessage> {
    const token = await currentToken(roomId);
    const room = await db.rooms.get(roomId);
    if (!room?.activeRoundId) {
      throw new Error(`room ${roomId} has no active round for a user message`);
    }
    const message = await appendUserMessage(db, {
      roomId,
      roundId: room.activeRoundId,
      token,
      content,
    });
    notify(roomId);
    return message;
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

  /** Manual conclusion (S2): the user proactively ends the room with a decision
   * report — the SAME chain as automatic convergence. Requires the controlling
   * page and no running execution. Idempotent on an already-concluded room.
   * An unfinalized active round with no live execution is atomically aborted
   * inside beginReportExecution (ruling §3). The report anchors on the
   * roundNumber-largest completed round. */
  async function concludeRoom(roomId: string): Promise<void> {
    const room = await db.rooms.get(roomId);
    if (!room) throw new Error(`unknown room ${roomId}`);
    if (room.status === "concluded") return; // idempotent
    // currentToken asserts the controlling page (throws if not); the value is
    // not used further because dispatchTalk re-derives its own token.
    await currentToken(roomId);
    if (room.activeRoundId) {
      const activeRound = await db.rounds.get(room.activeRoundId);
      if (activeRound?.activeExecutionId) {
        throw new Error("cannot conclude while an execution is running");
      }
    }
    // The anchor: the latest completed round (no live report exists yet, else
    // the room would already be concluded or a report would be in flight).
    const completedRounds = await db.rounds
      .where("roomId")
      .equals(roomId)
      .filter((candidate) => candidate.phase === "completed")
      .toArray();
    if (completedRounds.length === 0) {
      throw new Error("no completed round to summarize");
    }
    completedRounds.sort((a, b) => b.roundNumber - a.roundNumber);
    const anchor = completedRounds[0] as DiscussionRound;
    // Re-fetch a fresh room: intervening state must not hand the report a
    // stale digest (the atomic abort in beginReportExecution settles the room
    // inside its own transaction, but the dispatch snapshot is built here).
    const freshRoom = (await db.rooms.get(roomId)) as DiscussionRoom;
    await dispatchTurn(freshRoom, anchor, freshRoom.facilitatorParticipantId, "report");
    notify(roomId);
  }

  return {
    controlRoom,
    startupAudit,
    ensureScope,
    joinAgent,
    startRound,
    startRoundWithUserMessage,
    concludeRoom,
    runLoop,
    pauseRoom,
    resumeRoom,
    cancelActiveExecution,
    abortPausedRound,
    sendUserMessage,
    activeParticipants,
  };
}

export type DiscussionOrchestrator = ReturnType<typeof createDiscussionOrchestrator>;
