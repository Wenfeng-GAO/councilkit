import { canonicalJson } from "@shared/runtime/digest";
import CryptoJS from "crypto-js";
import type { DiscussionAgent, DiscussionRoom, Participant } from "./entities";
import type { ModelExecution, ResultKind } from "./model-execution";
import type { RuntimeBinding } from "./runtime-binding";

/** Deterministic sha256 hex over the shared canonical form (same algorithm
 * as the Host's node:crypto hashing, so digests stay cross-side stable). */
export function digestOf(value: unknown): string {
  return CryptoJS.SHA256(canonicalJson(value)).toString();
}

/** Domain error for model/transaction invariant violations. */
export class TransactionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TransactionError";
  }
}

function now(): string {
  return new Date().toISOString();
}

function uuid(): string {
  return crypto.randomUUID();
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function createDiscussionAgent(input: {
  name: string;
  personaPrompt: string;
  executionProfileId: string;
  modelId: string;
  color: string;
}): DiscussionAgent {
  if (input.name.trim().length === 0) throw new TransactionError("INVALID", "name is required");
  if (input.personaPrompt.trim().length === 0) {
    throw new TransactionError("INVALID", "personaPrompt is required");
  }
  if (input.executionProfileId.length === 0) {
    throw new TransactionError("INVALID", "executionProfileId is required");
  }
  if (input.modelId.trim().length === 0) throw new TransactionError("INVALID", "modelId required");
  if (!HEX_COLOR.test(input.color)) {
    throw new TransactionError("INVALID", "color must be a 6-digit hex");
  }
  const ts = now();
  return {
    id: uuid(),
    name: input.name,
    personaPrompt: input.personaPrompt,
    executionProfileId: input.executionProfileId,
    modelId: input.modelId,
    color: input.color,
    revision: 1,
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Digest over a Participant's full join-time snapshot (deterministic). */
export function participantSnapshotDigestOf(snapshot: {
  personaPrompt: string;
  executionProfileId: string;
  profileRevision: number;
  profileDigest: string;
  modelId: string;
}): string {
  return digestOf({ digestVersion: 1, ...snapshot });
}

export function createParticipant(input: {
  roomId: string;
  agent: DiscussionAgent;
  profileDigest: string;
}): Participant {
  const snapshot = {
    personaPrompt: input.agent.personaPrompt,
    executionProfileId: input.agent.executionProfileId,
    profileRevision: input.agent.revision,
    profileDigest: input.profileDigest,
    modelId: input.agent.modelId,
  };
  return {
    id: uuid(),
    roomId: input.roomId,
    agentId: input.agent.id,
    ...snapshot,
    participantSnapshotDigest: participantSnapshotDigestOf(snapshot),
    state: "active",
    createdAt: now(),
    endedAt: null,
  };
}

export function createDiscussionRoom(input: {
  topic: string;
  background?: string;
  facilitatorParticipantId: string;
}): DiscussionRoom {
  if (input.topic.trim().length === 0) throw new TransactionError("INVALID", "topic required");
  if (input.facilitatorParticipantId.length === 0) {
    throw new TransactionError("INVALID", "facilitatorParticipantId required");
  }
  const ts = now();
  return {
    id: uuid(),
    topic: input.topic,
    background: input.background ?? "",
    facilitatorParticipantId: input.facilitatorParticipantId,
    runState: "idle",
    activeRoundId: null,
    contextRevision: 0,
    contextDigest: "",
    createdAt: ts,
    lastActiveAt: ts,
  };
}

export function createModelExecution(input: {
  executionId: string;
  roomId: string;
  roundId: string;
  participantId: string;
  resultKind: ResultKind;
  requestedModel: string;
  contextRevision: number;
  expectedRoomDigest: string;
  participantSnapshotDigest: string;
  instructionDigest: string;
  retryOfExecutionId?: string | null;
}): ModelExecution {
  const ts = now();
  return {
    executionId: input.executionId,
    roomId: input.roomId,
    roundId: input.roundId,
    participantId: input.participantId,
    resultKind: input.resultKind,
    state: "prepared",
    hostInstanceId: null,
    executionScopeId: null,
    requestedModel: input.requestedModel,
    effectiveModel: null,
    dispatchState: "not_dispatched",
    toolState: "none",
    contextRevision: input.contextRevision,
    expectedRoomDigest: input.expectedRoomDigest,
    participantSnapshotDigest: input.participantSnapshotDigest,
    instructionDigest: input.instructionDigest,
    contentDigest: null,
    committedEntityType: null,
    committedEntityId: null,
    runtimeOutcome: null,
    usage: null,
    error: null,
    finalEventSeq: null,
    ackState: null,
    retryOfExecutionId: input.retryOfExecutionId ?? null,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function createRuntimeBinding(input: {
  roomId: string;
  scopeRequestId: string;
}): RuntimeBinding {
  if (input.scopeRequestId.length === 0) {
    throw new TransactionError("INVALID", "scopeRequestId required");
  }
  const ts = now();
  return {
    id: uuid(),
    roomId: input.roomId,
    scopeRequestId: input.scopeRequestId,
    state: "creating",
    hostInstanceId: null,
    executionScopeId: null,
    controllerId: null,
    leaseEpoch: null,
    createdAt: ts,
    updatedAt: ts,
  };
}
