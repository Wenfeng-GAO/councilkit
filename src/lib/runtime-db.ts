import type {
  DecisionReport,
  DiscussionAgent,
  DiscussionMessage,
  DiscussionRoom,
  DiscussionRound,
  DiscussionSummary,
  Participant,
} from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";
import type { RuntimeBinding } from "@/models/discussion/runtime-binding";
import type { ExecutionProfileRecord } from "@/models/execution-profile";
import Dexie, { type Table } from "dexie";

/**
 * Target Runtime DB (U4): `councilkit-runtime-v1`, fresh schema.
 *
 * This module NEVER instantiates, opens, migrates, or deletes the legacy
 * `councilkit` DB, and never reads legacy localStorage keys. There is no
 * fallback if initialization fails. Relationship facts live in table indexes
 * (no Room.agentIds / Room.roundIds style arrays).
 */
export class CouncilKitRuntimeDB extends Dexie {
  agents!: Table<DiscussionAgent, string>;
  participants!: Table<Participant, string>;
  rooms!: Table<DiscussionRoom, string>;
  rounds!: Table<DiscussionRound, string>;
  messages!: Table<DiscussionMessage, string>;
  summaries!: Table<DiscussionSummary, string>;
  modelExecutions!: Table<ModelExecution, string>;
  runtimeBindings!: Table<RuntimeBinding, string>;
  executionProfiles!: Table<ExecutionProfileRecord, string>;
  reports!: Table<DecisionReport, string>;

  constructor(name = "councilkit-runtime-v1") {
    super(name);
    this.version(1).stores({
      agents: "id, executionProfileId",
      participants: "id, roomId, agentId, state, [roomId+state]",
      rooms: "id, runState, lastActiveAt, activeRoundId",
      rounds: "id, roomId, roundNumber, phase, [roomId+phase]",
      // sourceExecutionId is unique but sparse: user messages (null) simply
      // do not appear in the index.
      messages: "id, roomId, roundId, &sourceExecutionId",
      // One committed Summary per Round; execution-anchored.
      summaries: "id, roomId, &roundId, &sourceExecutionId",
      modelExecutions:
        "executionId, roomId, roundId, participantId, state, ackState, retryOfExecutionId",
      runtimeBindings: "id, roomId, &scopeRequestId, state",
      executionProfiles: "id, driverId, installationId",
    });
    this.version(2)
      .stores({
        // v2 diff only: the nine v1 tables are inherited unchanged.
        reports: "id, roomId, &sourceExecutionId, createdAt",
      })
      .upgrade(async (tx) => {
        await tx.table("rooms").toCollection().modify(applyRoomV2Defaults);
        await tx.table("agents").toCollection().modify(applyAgentV2Defaults);
      });
  }
}

export const ROOM_V2_DEFAULTS = {
  mode: "brainstorm",
  targetOutput: "",
  maxRounds: null,
  status: "open",
} as const;

/** v2 backfill: fills ONLY the four new Room fields; never touches any other key. */
export function applyRoomV2Defaults(room: Record<string, unknown>): void {
  room.mode ??= ROOM_V2_DEFAULTS.mode;
  room.targetOutput ??= ROOM_V2_DEFAULTS.targetOutput;
  room.maxRounds ??= ROOM_V2_DEFAULTS.maxRounds;
  room.status ??= ROOM_V2_DEFAULTS.status;
}

/** v2 backfill: fills ONLY Agent.enabled. */
export function applyAgentV2Defaults(agent: Record<string, unknown>): void {
  agent.enabled ??= true;
}

export const runtimeDb = new CouncilKitRuntimeDB();
