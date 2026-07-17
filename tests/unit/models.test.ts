import {
  TransactionError,
  createDiscussionAgent,
  createDiscussionRoom,
  createModelExecution,
  createParticipant,
  createRuntimeBinding,
  digestOf,
  participantSnapshotDigestOf,
} from "@/models/discussion/factories";
import { describe, expect, it } from "vitest";

/**
 * Discussion domain factories (U6): pure validation + invariant coverage,
 * migrated from the legacy `@/models` suite. Complements
 * domain-models.test.ts (Dexie schema, constraints, transaction flows) —
 * this file needs no IndexedDB and pins the factory contract itself:
 * stamping defaults, rejection cases, and digest determinism/sensitivity.
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function expectInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TransactionError);
    expect((error as TransactionError).code).toBe("INVALID");
    return;
  }
  expect.unreachable("expected TransactionError INVALID");
}

function expectIsoTimestamp(value: string): void {
  expect(new Date(value).toISOString()).toBe(value);
}

const validAgentInput = {
  name: "Reviewer",
  personaPrompt: "You are a strict reviewer.",
  executionProfileId: "prof-1",
  modelId: "model-a",
  color: "#a1b2c3",
};

function makeAgent() {
  return createDiscussionAgent(validAgentInput);
}

type ExecutionInput = Parameters<typeof createModelExecution>[0];

function makeExecutionInput(over: Partial<ExecutionInput> = {}): ExecutionInput {
  return {
    executionId: "e-1",
    roomId: "r-1",
    roundId: "round-1",
    participantId: "p-1",
    resultKind: "message",
    requestedModel: "model-a",
    contextRevision: 0,
    expectedRoomDigest: "room-digest",
    participantSnapshotDigest: "participant-digest",
    instructionDigest: "instruction-digest",
    ...over,
  };
}

describe("createDiscussionAgent", () => {
  it("stamps a uuid id, revision 1 and equal ISO createdAt/updatedAt", () => {
    const agent = makeAgent();
    expect(agent.id).toMatch(UUID_SHAPE);
    expect(agent.revision).toBe(1);
    expectIsoTimestamp(agent.createdAt);
    expectIsoTimestamp(agent.updatedAt);
    expect(agent.updatedAt).toBe(agent.createdAt);
  });

  it("rejects an empty name, personaPrompt, executionProfileId or modelId", () => {
    expectInvalid(() => createDiscussionAgent({ ...validAgentInput, name: "" }));
    expectInvalid(() => createDiscussionAgent({ ...validAgentInput, personaPrompt: "   " }));
    expectInvalid(() => createDiscussionAgent({ ...validAgentInput, executionProfileId: "" }));
    expectInvalid(() => createDiscussionAgent({ ...validAgentInput, modelId: " " }));
  });

  it("rejects colors that are not 6-digit hex and preserves valid casing", () => {
    for (const color of ["a1b2c3", "#12345", "#1234567", "#gg0000", "#a1b2c3ff"]) {
      expectInvalid(() => createDiscussionAgent({ ...validAgentInput, color }));
    }
    const agent = createDiscussionAgent({ ...validAgentInput, color: "#A1B2C3" });
    expect(agent.color).toBe("#A1B2C3");
  });
});

describe("createParticipant", () => {
  it("copies the agent's join-time snapshot fields onto the participant", () => {
    const agent = { ...makeAgent(), revision: 7 };
    const participant = createParticipant({ roomId: "r-1", agent, profileDigest: "pd" });
    expect(participant.id).toMatch(UUID_SHAPE);
    expect(participant.roomId).toBe("r-1");
    expect(participant.agentId).toBe(agent.id);
    expect(participant.personaPrompt).toBe(agent.personaPrompt);
    expect(participant.executionProfileId).toBe(agent.executionProfileId);
    expect(participant.profileRevision).toBe(7);
    expect(participant.profileDigest).toBe("pd");
    expect(participant.modelId).toBe(agent.modelId);
  });

  it("starts active with endedAt null and the digest of its own snapshot", () => {
    const agent = makeAgent();
    const participant = createParticipant({ roomId: "r-1", agent, profileDigest: "pd" });
    expect(participant.state).toBe("active");
    expect(participant.endedAt).toBeNull();
    expectIsoTimestamp(participant.createdAt);
    expect(participant.participantSnapshotDigest).toBe(
      participantSnapshotDigestOf({
        personaPrompt: participant.personaPrompt,
        executionProfileId: participant.executionProfileId,
        profileRevision: participant.profileRevision,
        profileDigest: participant.profileDigest,
        modelId: participant.modelId,
      }),
    );
  });

  it("produces a digest that is stable across snapshot key order", () => {
    const first = participantSnapshotDigestOf({
      personaPrompt: "p",
      executionProfileId: "prof-1",
      profileRevision: 1,
      profileDigest: "pd",
      modelId: "m",
    });
    const reordered = participantSnapshotDigestOf({
      modelId: "m",
      profileDigest: "pd",
      profileRevision: 1,
      executionProfileId: "prof-1",
      personaPrompt: "p",
    });
    expect(reordered).toBe(first);
    expect(first).toMatch(SHA256_HEX);
  });

  it("changes the digest when any single snapshot field changes", () => {
    const base = {
      personaPrompt: "p",
      executionProfileId: "prof-1",
      profileRevision: 1,
      profileDigest: "pd",
      modelId: "m",
    };
    const baseDigest = participantSnapshotDigestOf(base);
    const mutations = [
      { ...base, personaPrompt: "p2" },
      { ...base, executionProfileId: "prof-2" },
      { ...base, profileRevision: 2 },
      { ...base, profileDigest: "pd2" },
      { ...base, modelId: "m2" },
    ];
    for (const mutated of mutations) {
      expect(participantSnapshotDigestOf(mutated)).not.toBe(baseDigest);
    }
  });
});

describe("createDiscussionRoom", () => {
  it("requires a non-blank topic and a facilitatorParticipantId", () => {
    expectInvalid(() => createDiscussionRoom({ topic: "", facilitatorParticipantId: "p-1" }));
    expectInvalid(() => createDiscussionRoom({ topic: "  ", facilitatorParticipantId: "p-1" }));
    expectInvalid(() => createDiscussionRoom({ topic: "T", facilitatorParticipantId: "" }));
  });

  it("defaults to idle with no active round, contextRevision 0 and empty background", () => {
    const room = createDiscussionRoom({ topic: "T", facilitatorParticipantId: "p-1" });
    expect(room.id).toMatch(UUID_SHAPE);
    expect(room.runState).toBe("idle");
    expect(room.activeRoundId).toBeNull();
    expect(room.contextRevision).toBe(0);
    expect(room.contextDigest).toBe("");
    expect(room.background).toBe("");
    expectIsoTimestamp(room.createdAt);
    expect(room.lastActiveAt).toBe(room.createdAt);
  });

  it("keeps an explicit background", () => {
    const room = createDiscussionRoom({
      topic: "T",
      background: "ctx",
      facilitatorParticipantId: "p-1",
    });
    expect(room.background).toBe("ctx");
  });
});

describe("createModelExecution", () => {
  it("defaults toolState to none and nulls the retry link unless provided", () => {
    const fresh = createModelExecution(makeExecutionInput());
    expect(fresh.toolState).toBe("none");
    expect(fresh.retryOfExecutionId).toBeNull();

    const retry = createModelExecution(makeExecutionInput({ retryOfExecutionId: "e-0" }));
    expect(retry.retryOfExecutionId).toBe("e-0");
  });

  it("fixes resultKind at creation while committedEntityType stays null", () => {
    for (const resultKind of ["message", "summary"] as const) {
      const execution = createModelExecution(makeExecutionInput({ resultKind }));
      expect(execution.resultKind).toBe(resultKind);
      expect(execution.committedEntityType).toBeNull();
    }
  });
});

describe("createRuntimeBinding", () => {
  it("starts creating with null Host facts and rejects an empty scopeRequestId", () => {
    const binding = createRuntimeBinding({ roomId: "r-1", scopeRequestId: "req-1" });
    expect(binding.id).toMatch(UUID_SHAPE);
    expect(binding.state).toBe("creating");
    expect(binding.hostInstanceId).toBeNull();
    expect(binding.executionScopeId).toBeNull();
    expect(binding.controllerId).toBeNull();
    expect(binding.leaseEpoch).toBeNull();
    expectIsoTimestamp(binding.createdAt);
    expect(binding.updatedAt).toBe(binding.createdAt);

    expectInvalid(() => createRuntimeBinding({ roomId: "r-1", scopeRequestId: "" }));
  });
});

describe("digestOf", () => {
  it("returns a 64-char lowercase sha256 hex", () => {
    expect(digestOf({ a: 1 })).toMatch(SHA256_HEX);
  });

  it("is deterministic across key order and drops undefined fields", () => {
    expect(digestOf({ a: 1, b: { c: 2, d: [3, 4] } })).toBe(
      digestOf({ b: { d: [3, 4], c: 2 }, a: 1 }),
    );
    expect(digestOf({ a: 1, extra: undefined })).toBe(digestOf({ a: 1 }));
  });

  it("changes when the value changes", () => {
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
    expect(digestOf(["a", "b"])).not.toBe(digestOf(["b", "a"]));
  });
});

describe("TransactionError", () => {
  it("exposes name and code and is an Error", () => {
    const error = new TransactionError("INVALID", "bad input");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TransactionError");
    expect(error.code).toBe("INVALID");
    expect(error.message).toBe("bad input");
  });
});
