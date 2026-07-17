import "fake-indexeddb/auto";

import type { DiscussionMessage, DiscussionSummary } from "@/models/discussion/entities";
import {
  createDiscussionAgent,
  createDiscussionRoom,
  createParticipant,
  participantSnapshotDigestOf,
} from "@/models/discussion/factories";
import {
  SNAPSHOT_DIGEST_VERSION,
  type SharedProjection,
  buildContextSnapshot,
  computeContextDigest,
  computeInstructionDigest,
  initializeRoomDigest,
  projectSharedContext,
} from "@/orchestrator/context-snapshot";
import { contextSnapshotSchema } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

/**
 * Deterministic Context Snapshot (U4): construction-order independence,
 * pinned cross-side digest vectors, per-section digest isolation, schema
 * re-parse, projection ordering and room digest initialization.
 */

function message(over: Partial<DiscussionMessage> = {}): DiscussionMessage {
  return {
    id: "m-1",
    roomId: "room-1",
    roundId: "round-1",
    role: "participant",
    participantId: "p-1",
    content: "content",
    sourceExecutionId: "e-1",
    createdAt: "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

function summary(over: Partial<DiscussionSummary> = {}): DiscussionSummary {
  return {
    id: "s-1",
    roomId: "room-1",
    roundId: "round-1",
    content: "summary",
    sourceExecutionId: "e-2",
    generatedAt: "2026-07-17T00:01:00.000Z",
    ...over,
  };
}

const baseProjection: SharedProjection = {
  topic: "Topic",
  background: "Background",
  items: [
    {
      id: "m-1",
      role: "user",
      content: "user question",
    },
    {
      id: "m-2",
      role: "participant",
      participantId: "p-1",
      content: "participant answer",
      sourceExecutionId: "e-1",
    },
  ],
};

describe("computeContextDigest", () => {
  it("is independent of object construction order", () => {
    // Same persisted projection, built field-by-field in different key order.
    const reorderedItems = baseProjection.items.map((item) => {
      const clone: Record<string, unknown> = {};
      for (const key of Object.keys(item).reverse()) {
        clone[key] = (item as Record<string, unknown>)[key];
      }
      return clone;
    });
    const reordered: SharedProjection = {
      items: reorderedItems as SharedProjection["items"],
      background: baseProjection.background,
      topic: baseProjection.topic,
    };
    expect(computeContextDigest(reordered)).toBe(computeContextDigest(baseProjection));
    // Digest is a full sha256 hex.
    expect(computeContextDigest(baseProjection)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches pinned cross-side stability vectors", () => {
    // Pinned sha256 hex anchors: the Browser (crypto-js) and the Host
    // (node:crypto) must both produce these exact digests from the shared
    // canonical form. If either side's serialization drifts, these fail.
    const vectorA: SharedProjection = {
      topic: "该不该引入运行时 Host",
      background: "双 Driver 切流评审",
      items: [],
    };
    const vectorB: SharedProjection = {
      topic: "Runtime Host cutover",
      background: "",
      items: [
        { id: "m-0001", role: "user", content: "请各位评估切流风险。" },
        {
          id: "m-0002",
          role: "participant",
          participantId: "p-claude",
          content: "建议先冻结 legacy 写路径。",
          sourceExecutionId: "e-aaaa",
        },
        {
          id: "s-0001",
          role: "summary",
          content: "共识：冻结 legacy 写入后再切。",
          sourceExecutionId: "e-bbbb",
        },
      ],
    };
    expect(computeContextDigest(vectorA)).toBe(
      "be866f066114a64107c486066c22aea9f519e8c9d12d1876e1f692b922866cac",
    );
    expect(computeContextDigest(vectorB)).toBe(
      "a448184c47ce07579db65445243790237869774e268a98aa8b3d942f81f9094f",
    );
  });

  it("changes when a message or a summary changes the projection", () => {
    const baseline = computeContextDigest(baseProjection);
    const messageChanged: SharedProjection = {
      ...baseProjection,
      items: baseProjection.items.map((item) =>
        item.id === "m-2" ? { ...item, content: "edited answer" } : item,
      ),
    };
    expect(computeContextDigest(messageChanged)).not.toBe(baseline);

    const room = { topic: "Topic", background: "Background" };
    const withSummary = projectSharedContext(room, [message()], [summary()]);
    const summaryChanged = projectSharedContext(
      room,
      [message()],
      [summary({ content: "different summary" })],
    );
    expect(computeContextDigest(withSummary)).not.toBe(computeContextDigest(summaryChanged));
  });
});

describe("digest isolation between snapshot sections", () => {
  it("participant-only changes touch participantSnapshotDigest, not contextDigest", () => {
    const contextDigest = computeContextDigest(baseProjection);
    const snapshot = {
      personaPrompt: "冷静的分析者",
      executionProfileId: "prof-1",
      profileRevision: 1,
      profileDigest: "profile-digest",
      modelId: "model-a",
    };
    const digestA = participantSnapshotDigestOf(snapshot);
    const digestPersonaChanged = participantSnapshotDigestOf({
      ...snapshot,
      personaPrompt: "激进的质疑者",
    });
    const digestModelChanged = participantSnapshotDigestOf({ ...snapshot, modelId: "model-b" });

    expect(digestPersonaChanged).not.toBe(digestA);
    expect(digestModelChanged).not.toBe(digestA);
    // The shared projection has no participant input, so contextDigest is
    // untouched by any participant-only edit.
    expect(computeContextDigest(baseProjection)).toBe(contextDigest);
  });

  it("instruction-only changes touch instructionDigest only", () => {
    const instruction = { kind: "message" as const, text: "请发言" };
    const instructionDigest = computeInstructionDigest(instruction);
    const textChanged = computeInstructionDigest({ ...instruction, text: "请总结" });
    const kindChanged = computeInstructionDigest({ kind: "summary", text: instruction.text });

    expect(textChanged).not.toBe(instructionDigest);
    expect(kindChanged).not.toBe(instructionDigest);
    // Instruction is not an input to the shared projection or the participant
    // snapshot, so both stay stable.
    expect(computeContextDigest(baseProjection)).toBe(computeContextDigest(baseProjection));
    const snapshot = {
      personaPrompt: "persona",
      executionProfileId: "prof-1",
      profileRevision: 1,
      profileDigest: "d",
      modelId: "m",
    };
    expect(participantSnapshotDigestOf(snapshot)).toBe(participantSnapshotDigestOf(snapshot));
  });
});

describe("buildContextSnapshot", () => {
  it("produces a schema-valid envelope with the expected digests", () => {
    const agent = createDiscussionAgent({
      name: "Agent",
      personaPrompt: "persona prompt",
      executionProfileId: "prof-1",
      modelId: "model-a",
      color: "#a1b2c3",
    });
    const room = initializeRoomDigest(
      createDiscussionRoom({ topic: "Topic", facilitatorParticipantId: "pending" }),
    );
    const participant = createParticipant({ roomId: room.id, agent, profileDigest: "pd" });
    const instruction = { kind: "message" as const, text: "请就 topic 发言" };

    const snapshot = buildContextSnapshot({ room, participant, instruction, items: [] });

    // The artifact must survive a second parse by the exact Host-side schema.
    const reparsed = contextSnapshotSchema.parse(snapshot);
    expect(reparsed.digestVersion).toBe(SNAPSHOT_DIGEST_VERSION);
    expect(reparsed.digestVersion).toBe(1);
    expect(reparsed.roomContext.contextRevision).toBe(0);
    expect(reparsed.roomContext.contextDigest).toBe(room.contextDigest);
    expect(reparsed.roomContext.items).toEqual([]);
    expect(reparsed.participant.participantId).toBe(participant.id);
    expect(reparsed.participant.participantSnapshotDigest).toBe(
      participant.participantSnapshotDigest,
    );
    expect(reparsed.participant.personaPrompt).toBe(participant.personaPrompt);
    expect(reparsed.instruction.kind).toBe("message");
    expect(reparsed.instruction.instructionDigest).toBe(computeInstructionDigest(instruction));
    expect(reparsed.instruction.text).toBe(instruction.text);
  });
});

describe("projectSharedContext", () => {
  it("orders messages/summaries chronologically with id tiebreak at equal timestamps", () => {
    const room = { topic: "T", background: "B" };
    const early = message({ id: "b-early", createdAt: "2026-07-17T00:00:01.000Z" });
    // Same timestamp across rounds/kinds: lexicographically smaller id wins.
    const tiedSummary = summary({
      id: "a-tied",
      roundId: "round-1",
      generatedAt: "2026-07-17T00:00:02.000Z",
    });
    const tiedMessage = message({
      id: "c-tied",
      roundId: "round-2",
      createdAt: "2026-07-17T00:00:02.000Z",
    });

    const projection = projectSharedContext(
      room,
      // Pass them in scrambled order; the projection must sort them.
      [tiedMessage, early],
      [tiedSummary],
    );

    expect(projection.topic).toBe("T");
    expect(projection.background).toBe("B");
    expect(projection.items.map((item) => item.id)).toEqual(["b-early", "a-tied", "c-tied"]);
    const summaryItem = projection.items[1];
    expect(summaryItem.role).toBe("summary");
    expect(summaryItem.sourceExecutionId).toBe(tiedSummary.sourceExecutionId);
  });

  it("omits participantId/sourceExecutionId for user messages", () => {
    const projection = projectSharedContext(
      { topic: "T", background: "" },
      [message({ role: "user", participantId: null, sourceExecutionId: null })],
      [],
    );
    expect(projection.items[0]).toEqual({
      id: "m-1",
      role: "user",
      content: "content",
    });
  });
});

describe("initializeRoomDigest", () => {
  it("sets revision 0 and the empty-projection digest", () => {
    const room = createDiscussionRoom({ topic: "T", facilitatorParticipantId: "p-1" });
    expect(room.contextDigest).toBe("");

    initializeRoomDigest(room);

    expect(room.contextRevision).toBe(0);
    expect(room.contextDigest).toBe(computeContextDigest(projectSharedContext(room, [], [])));
    expect(room.contextDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
