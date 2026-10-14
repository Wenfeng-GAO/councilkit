import {
  type DecisionReport,
  type DiscussionAgent,
  type DiscussionMode,
  type DiscussionRoom,
  type ModelExecution,
  type Participant,
  type ResultKind,
  type RuntimeBinding,
  TransactionError,
  createDecisionReport,
  createDiscussionAgent,
  createDiscussionRoom,
  createModelExecution,
  createParticipant,
  createRuntimeBinding,
  digestOf,
  participantSnapshotDigestOf,
} from "@/models/discussion";
import * as discussion from "@/models/discussion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Runtime surface of the discussion barrel plus factory invariants.
 * Timestamps and ids are frozen so every assertion is an exact literal.
 */

const FIXED_NOW = "2026-10-14T00:00:00.000Z";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const ID_D = "44444444-4444-4444-8444-444444444444";
const ID_E = "55555555-5555-4555-8555-555555555555";

const SNAPSHOT_DIGEST = "cb5534886f5d63be0a410f985140bb4bba5d206f9c6e8139345e7dbcf5e615be";

const validAgentInput = {
  name: "Reviewer",
  personaPrompt: "You are a strict reviewer.",
  executionProfileId: "prof-1",
  modelId: "model-a",
  color: "#a1b2c3",
};

function transactionError(fn: () => unknown): TransactionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TransactionError);
    if (error instanceof TransactionError) return error;
  }
  expect.unreachable("expected TransactionError");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_NOW));
  const ids = [ID_A, ID_B, ID_C, ID_D, ID_E] as const;
  let index = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    const id = ids[index];
    if (!id) throw new Error(`unexpected randomUUID call #${index}`);
    index += 1;
    return id;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("discussion barrel", () => {
  it("re-exports exactly the runtime factory surface", () => {
    expect(Object.keys(discussion).sort()).toEqual([
      "TransactionError",
      "createDecisionReport",
      "createDiscussionAgent",
      "createDiscussionRoom",
      "createModelExecution",
      "createParticipant",
      "createRuntimeBinding",
      "digestOf",
      "participantSnapshotDigestOf",
    ]);
    expect(discussion.createDiscussionAgent).toBe(createDiscussionAgent);
    expect(discussion.digestOf).toBe(digestOf);
    expect(discussion.TransactionError).toBe(TransactionError);
  });
});

describe("TransactionError", () => {
  it("is an Error named TransactionError with the given code and message", () => {
    const error = new TransactionError("INVALID", "name is required");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(TransactionError);
    expect(error.name).toBe("TransactionError");
    expect(error.code).toBe("INVALID");
    expect(error.message).toBe("name is required");
  });
});

describe("digestOf", () => {
  it("is the sha256 hex of canonical json, independent of key order", () => {
    expect(digestOf({ a: 1 })).toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
    expect(digestOf(null)).toBe("74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b");
    expect(digestOf({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    const nested = "d20de737209179d2edce447762ae912f3aa6fdf1afbc5d06064ec74f65e807e5";
    expect(digestOf({ a: 1, b: { c: 2, d: [3, 4] } })).toBe(nested);
    expect(digestOf({ b: { d: [3, 4], c: 2 }, a: 1 })).toBe(nested);
    expect(digestOf({ a: 1, extra: undefined })).toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
    expect(digestOf(["a", "b"])).toBe(
      "0473ef2dc0d324ab659d3580c1134e9d812035905c4781fdd6d529b0c6860e13",
    );
    expect(digestOf(["b", "a"])).toBe(
      "02d8bc3008a9bb0dcc4b86d7fd3428ced792355c733c19756bec5a56dc61b2c5",
    );
  });
});

describe("createDiscussionAgent", () => {
  it("stamps a fixed id, revision 1, enabled true, and equal timestamps", () => {
    const agent: DiscussionAgent = createDiscussionAgent(validAgentInput);
    expect(agent).toEqual({
      id: ID_A,
      name: "Reviewer",
      personaPrompt: "You are a strict reviewer.",
      executionProfileId: "prof-1",
      modelId: "model-a",
      color: "#a1b2c3",
      revision: 1,
      enabled: true,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
  });

  it("preserves surrounding whitespace and uppercase hex that already pass validation", () => {
    const agent = createDiscussionAgent({
      name: "  Reviewer  ",
      personaPrompt: "  persona  ",
      executionProfileId: " ",
      modelId: " model-a ",
      color: "#A1B2C3",
    });
    expect(agent).toEqual({
      id: ID_A,
      name: "  Reviewer  ",
      personaPrompt: "  persona  ",
      executionProfileId: " ",
      modelId: " model-a ",
      color: "#A1B2C3",
      revision: 1,
      enabled: true,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
  });

  it("rejects blank name, persona, profile id, model id, and non-hex colors", () => {
    const cases: Array<{ patch: Partial<typeof validAgentInput>; message: string }> = [
      { patch: { name: "" }, message: "name is required" },
      { patch: { name: " \t " }, message: "name is required" },
      { patch: { personaPrompt: "" }, message: "personaPrompt is required" },
      { patch: { personaPrompt: "   " }, message: "personaPrompt is required" },
      { patch: { executionProfileId: "" }, message: "executionProfileId is required" },
      { patch: { modelId: "" }, message: "modelId required" },
      { patch: { modelId: " " }, message: "modelId required" },
      { patch: { color: "a1b2c3" }, message: "color must be a 6-digit hex" },
      { patch: { color: "#12345" }, message: "color must be a 6-digit hex" },
      { patch: { color: "#1234567" }, message: "color must be a 6-digit hex" },
      { patch: { color: "#gg0000" }, message: "color must be a 6-digit hex" },
      { patch: { color: "#a1b2c3ff" }, message: "color must be a 6-digit hex" },
      { patch: { color: " #a1b2c3" }, message: "color must be a 6-digit hex" },
    ];
    for (const { patch, message } of cases) {
      const error = transactionError(() => createDiscussionAgent({ ...validAgentInput, ...patch }));
      expect(error.name).toBe("TransactionError");
      expect(error.code).toBe("INVALID");
      expect(error.message).toBe(message);
    }
  });
});

describe("participantSnapshotDigestOf and createParticipant", () => {
  it("hashes digestVersion 1 plus the snapshot, ignoring key order", () => {
    const forward = participantSnapshotDigestOf({
      personaPrompt: "p",
      executionProfileId: "prof-1",
      profileRevision: 1,
      profileDigest: "pd",
      modelId: "m",
    });
    const reversed = participantSnapshotDigestOf({
      modelId: "m",
      profileDigest: "pd",
      profileRevision: 1,
      executionProfileId: "prof-1",
      personaPrompt: "p",
    });
    expect(forward).toBe(SNAPSHOT_DIGEST);
    expect(reversed).toBe(SNAPSHOT_DIGEST);
  });

  it("changes the digest when any single snapshot field changes", () => {
    expect(
      participantSnapshotDigestOf({
        personaPrompt: "p2",
        executionProfileId: "prof-1",
        profileRevision: 1,
        profileDigest: "pd",
        modelId: "m",
      }),
    ).toBe("390c2815847792da02a0ce32158d2ed89641df492c76eeb60c0a3bd5be7d1626");
    expect(
      participantSnapshotDigestOf({
        personaPrompt: "p",
        executionProfileId: "prof-2",
        profileRevision: 1,
        profileDigest: "pd",
        modelId: "m",
      }),
    ).toBe("39626c2571e751625da397a0612ef7dd9215a4a7d20ebcba48d7b6086c01f925");
    expect(
      participantSnapshotDigestOf({
        personaPrompt: "p",
        executionProfileId: "prof-1",
        profileRevision: 7,
        profileDigest: "pd",
        modelId: "m",
      }),
    ).toBe("6bc57605e46929e34b39db4d3468758013b3570769bd907c455b013859bf7c8b");
    expect(
      participantSnapshotDigestOf({
        personaPrompt: "p",
        executionProfileId: "prof-1",
        profileRevision: 1,
        profileDigest: "pd2",
        modelId: "m",
      }),
    ).toBe("f2686e98b91a28a1246bb67f9ffe8fa06c05cea6ad826599e307747d49c8521e");
    expect(
      participantSnapshotDigestOf({
        personaPrompt: "p",
        executionProfileId: "prof-1",
        profileRevision: 1,
        profileDigest: "pd",
        modelId: "m2",
      }),
    ).toBe("9116283efa56ba9e82c775f7ce0402b770546753c779900b5ca9ea58cdc99b5b");
  });

  it("copies the join-time snapshot, starts active, and stores that digest", () => {
    const agent = createDiscussionAgent({
      name: "Reviewer",
      personaPrompt: "p",
      executionProfileId: "prof-1",
      modelId: "m",
      color: "#a1b2c3",
    });
    const participant: Participant = createParticipant({
      roomId: "r-1",
      agent: { ...agent, revision: 7 },
      profileDigest: "pd",
    });
    expect(participant).toEqual({
      id: ID_B,
      roomId: "r-1",
      agentId: ID_A,
      personaPrompt: "p",
      executionProfileId: "prof-1",
      profileRevision: 7,
      profileDigest: "pd",
      modelId: "m",
      participantSnapshotDigest: "6bc57605e46929e34b39db4d3468758013b3570769bd907c455b013859bf7c8b",
      state: "active",
      createdAt: FIXED_NOW,
      endedAt: null,
    });
  });
});

describe("createDiscussionRoom", () => {
  it("rejects a blank topic and an empty facilitatorParticipantId", () => {
    const blankTopic = transactionError(() =>
      createDiscussionRoom({ topic: "", facilitatorParticipantId: "p-1" }),
    );
    expect(blankTopic.code).toBe("INVALID");
    expect(blankTopic.message).toBe("topic required");

    const whitespaceTopic = transactionError(() =>
      createDiscussionRoom({ topic: "  ", facilitatorParticipantId: "p-1" }),
    );
    expect(whitespaceTopic.code).toBe("INVALID");
    expect(whitespaceTopic.message).toBe("topic required");

    const missingFacilitator = transactionError(() =>
      createDiscussionRoom({ topic: "T", facilitatorParticipantId: "" }),
    );
    expect(missingFacilitator.code).toBe("INVALID");
    expect(missingFacilitator.message).toBe("facilitatorParticipantId required");
  });

  it("defaults to an idle open brainstorm with no cap and empty background", () => {
    const room: DiscussionRoom = createDiscussionRoom({
      topic: "T",
      facilitatorParticipantId: "p-1",
    });
    expect(room).toEqual({
      id: ID_A,
      topic: "T",
      background: "",
      facilitatorParticipantId: "p-1",
      runState: "idle",
      activeRoundId: null,
      contextRevision: 0,
      contextDigest: "",
      mode: "brainstorm",
      targetOutput: "",
      maxRounds: null,
      status: "open",
      createdAt: FIXED_NOW,
      lastActiveAt: FIXED_NOW,
    });
  });

  it("keeps explicit background, mode, target output, and a zero round cap", () => {
    const mode: DiscussionMode = "planning";
    const room = createDiscussionRoom({
      topic: "  Roadmap  ",
      background: "ctx",
      facilitatorParticipantId: " p-1 ",
      mode,
      targetOutput: "ADR",
      maxRounds: 0,
    });
    expect(room).toEqual({
      id: ID_A,
      topic: "  Roadmap  ",
      background: "ctx",
      facilitatorParticipantId: " p-1 ",
      runState: "idle",
      activeRoundId: null,
      contextRevision: 0,
      contextDigest: "",
      mode: "planning",
      targetOutput: "ADR",
      maxRounds: 0,
      status: "open",
      createdAt: FIXED_NOW,
      lastActiveAt: FIXED_NOW,
    });
  });

  it("keeps review mode, an empty background, and an explicit null cap", () => {
    const room = createDiscussionRoom({
      topic: "T",
      background: "",
      facilitatorParticipantId: "p-1",
      mode: "review",
      targetOutput: "",
      maxRounds: null,
    });
    expect(room).toEqual({
      id: ID_A,
      topic: "T",
      background: "",
      facilitatorParticipantId: "p-1",
      runState: "idle",
      activeRoundId: null,
      contextRevision: 0,
      contextDigest: "",
      mode: "review",
      targetOutput: "",
      maxRounds: null,
      status: "open",
      createdAt: FIXED_NOW,
      lastActiveAt: FIXED_NOW,
    });
  });
});

describe("createModelExecution", () => {
  function prepared(resultKind: ResultKind, retryOfExecutionId: string | null): ModelExecution {
    return {
      executionId: "e-1",
      roomId: "r-1",
      roundId: "round-1",
      participantId: "p-1",
      resultKind,
      state: "prepared",
      hostInstanceId: null,
      executionScopeId: null,
      requestedModel: "model-a",
      effectiveModel: null,
      dispatchState: "not_dispatched",
      toolState: "none",
      contextRevision: 4,
      expectedRoomDigest: "room-digest",
      participantSnapshotDigest: "participant-digest",
      instructionDigest: "instruction-digest",
      contentDigest: null,
      committedEntityType: null,
      committedEntityId: null,
      runtimeOutcome: null,
      usage: null,
      error: null,
      finalEventSeq: null,
      ackState: null,
      retryOfExecutionId,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
  }

  it("starts prepared, undispatched, and unlinked when retryOfExecutionId is omitted", () => {
    const execution = createModelExecution({
      executionId: "e-1",
      roomId: "r-1",
      roundId: "round-1",
      participantId: "p-1",
      resultKind: "message",
      requestedModel: "model-a",
      contextRevision: 4,
      expectedRoomDigest: "room-digest",
      participantSnapshotDigest: "participant-digest",
      instructionDigest: "instruction-digest",
    });
    expect(execution).toEqual(prepared("message", null));
  });

  it("keeps an explicit null retry link and each fixed resultKind", () => {
    const kinds: ResultKind[] = ["message", "summary", "focus", "report"];
    for (const resultKind of kinds) {
      const execution = createModelExecution({
        executionId: "e-1",
        roomId: "r-1",
        roundId: "round-1",
        participantId: "p-1",
        resultKind,
        requestedModel: "model-a",
        contextRevision: 4,
        expectedRoomDigest: "room-digest",
        participantSnapshotDigest: "participant-digest",
        instructionDigest: "instruction-digest",
        retryOfExecutionId: null,
      });
      expect(execution).toEqual(prepared(resultKind, null));
    }
  });

  it("keeps a non-null retry link, including an empty string", () => {
    const linked = createModelExecution({
      executionId: "e-1",
      roomId: "r-1",
      roundId: "round-1",
      participantId: "p-1",
      resultKind: "summary",
      requestedModel: "model-a",
      contextRevision: 4,
      expectedRoomDigest: "room-digest",
      participantSnapshotDigest: "participant-digest",
      instructionDigest: "instruction-digest",
      retryOfExecutionId: "e-0",
    });
    expect(linked).toEqual(prepared("summary", "e-0"));

    const emptyLink = createModelExecution({
      executionId: "e-1",
      roomId: "r-1",
      roundId: "round-1",
      participantId: "p-1",
      resultKind: "report",
      requestedModel: "model-a",
      contextRevision: 4,
      expectedRoomDigest: "room-digest",
      participantSnapshotDigest: "participant-digest",
      instructionDigest: "instruction-digest",
      retryOfExecutionId: "",
    });
    expect(emptyLink).toEqual(prepared("report", ""));
  });
});

describe("createRuntimeBinding", () => {
  it("starts creating with null host facts", () => {
    const binding: RuntimeBinding = createRuntimeBinding({
      roomId: "r-1",
      scopeRequestId: "req-1",
    });
    expect(binding).toEqual({
      id: ID_A,
      roomId: "r-1",
      scopeRequestId: "req-1",
      state: "creating",
      hostInstanceId: null,
      executionScopeId: null,
      controllerId: null,
      leaseEpoch: null,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
  });

  it("rejects an empty scopeRequestId", () => {
    const error = transactionError(() =>
      createRuntimeBinding({ roomId: "r-1", scopeRequestId: "" }),
    );
    expect(error.code).toBe("INVALID");
    expect(error.message).toBe("scopeRequestId required");
  });
});

describe("createDecisionReport", () => {
  it("stamps a fixed id and createdAt and echoes the committed fields", () => {
    const report: DecisionReport = createDecisionReport({
      roomId: "r-1",
      content: " Decision: ship it. ",
      sourceExecutionId: "e-1",
    });
    expect(report).toEqual({
      id: ID_A,
      roomId: "r-1",
      content: " Decision: ship it. ",
      sourceExecutionId: "e-1",
      createdAt: FIXED_NOW,
    });
  });

  it("rejects an empty roomId, blank content, or an empty sourceExecutionId", () => {
    const missingRoom = transactionError(() =>
      createDecisionReport({ roomId: "", content: "c", sourceExecutionId: "e-1" }),
    );
    expect(missingRoom.code).toBe("INVALID");
    expect(missingRoom.message).toBe("roomId required");

    const blankContent = transactionError(() =>
      createDecisionReport({ roomId: "r-1", content: " \n ", sourceExecutionId: "e-1" }),
    );
    expect(blankContent.code).toBe("INVALID");
    expect(blankContent.message).toBe("content is required");

    const missingSource = transactionError(() =>
      createDecisionReport({ roomId: "r-1", content: "c", sourceExecutionId: "" }),
    );
    expect(missingSource.code).toBe("INVALID");
    expect(missingSource.message).toBe("sourceExecutionId required");
  });
});
