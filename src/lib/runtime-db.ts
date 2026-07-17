import type {
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
  }
}

export const runtimeDb = new CouncilKitRuntimeDB();
