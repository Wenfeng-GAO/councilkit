import type { DiscussionMessage, DiscussionSummary } from "@/models/discussion/entities";
import {
  createDiscussionAgent,
  createDiscussionRoom,
  createParticipant,
} from "@/models/discussion/factories";
import {
  buildContextSnapshot,
  initializeRoomDigest,
  projectSharedContext,
} from "@/orchestrator/context-snapshot";
import { describe, expect, it } from "vitest";

/**
 * Context snapshot edges the existing suite leaves dark: an empty topic is
 * omitted from the wire room context, and an equal-timestamp id tie takes the
 * lesser-id arm of the projection sort.
 */

const EMPTY_TOPIC_DIGEST = "be866f066114a64107c486066c22aea9f519e8c9d12d1876e1f692b922866cac";
const MESSAGE_INSTRUCTION_DIGEST =
  "519c5f4aaafcbda5378539194e0e72ef8c90c180128af3abd01a9f95e45e0893";
const SUMMARY_INSTRUCTION_DIGEST =
  "725415e5253995ea7569b469aa37a57296ef494f15e5576e0c958169e661176c";
const PARTICIPANT_DIGEST = "49aa059a3dca3cb98e40f2765f471d9b854fc783d252afd3d9ca18a410ccc9f1";

function message(over: Partial<DiscussionMessage> = {}): DiscussionMessage {
  return {
    id: "m-1",
    roomId: "room-1",
    roundId: "round-1",
    role: "participant",
    participantId: "p-1",
    content: "content",
    sourceExecutionId: "e-1",
    createdAt: "2026-08-01T00:00:00.000Z",
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
    generatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

describe("buildContextSnapshot empty topic", () => {
  it("omits a blank topic and keeps background, items, and pinned digests", () => {
    const agent = createDiscussionAgent({
      name: "Agent",
      personaPrompt: "冷静的分析者",
      executionProfileId: "prof-1",
      modelId: "model-a",
      color: "#a1b2c3",
    });
    const room = initializeRoomDigest(
      createDiscussionRoom({
        topic: "该不该引入运行时 Host",
        background: "双 Driver 切流评审",
        facilitatorParticipantId: "p-fac",
      }),
    );
    room.topic = "";
    const participant = createParticipant({
      roomId: room.id,
      agent,
      profileDigest: "pd-blank",
    });
    const items = [
      {
        id: "m-user",
        role: "user" as const,
        content: "请各位评估切流风险。",
      },
    ];

    const snapshot = buildContextSnapshot({
      room,
      participant,
      instruction: { kind: "message", text: "请就空白主题发言" },
      items,
    });

    expect(snapshot).toEqual({
      digestVersion: 1,
      roomContext: {
        contextRevision: 0,
        contextDigest: EMPTY_TOPIC_DIGEST,
        background: "双 Driver 切流评审",
        items,
      },
      participant: {
        participantId: participant.id,
        participantSnapshotDigest: PARTICIPANT_DIGEST,
        personaPrompt: "冷静的分析者",
      },
      instruction: {
        kind: "message",
        instructionDigest: MESSAGE_INSTRUCTION_DIGEST,
        text: "请就空白主题发言",
      },
    });
  });

  it("omits a whitespace-only background together with an empty topic", () => {
    const agent = createDiscussionAgent({
      name: "Agent",
      personaPrompt: "冷静的分析者",
      executionProfileId: "prof-1",
      modelId: "model-a",
      color: "#a1b2c3",
    });
    const room = initializeRoomDigest(
      createDiscussionRoom({
        topic: "该不该引入运行时 Host",
        background: "双 Driver 切流评审",
        facilitatorParticipantId: "p-fac",
      }),
    );
    room.topic = "";
    room.background = " \n\t ";
    const participant = createParticipant({
      roomId: room.id,
      agent,
      profileDigest: "pd-blank",
    });

    const snapshot = buildContextSnapshot({
      room,
      participant,
      instruction: { kind: "summary", text: "请就空白主题发言" },
      items: [],
    });

    expect(snapshot.roomContext).toEqual({
      contextRevision: 0,
      contextDigest: EMPTY_TOPIC_DIGEST,
      items: [],
    });
    expect(snapshot.instruction).toEqual({
      kind: "summary",
      instructionDigest: SUMMARY_INSTRUCTION_DIGEST,
      text: "请就空白主题发言",
    });
    expect(snapshot.participant.participantSnapshotDigest).toBe(PARTICIPANT_DIGEST);
    expect(snapshot.participant.personaPrompt).toBe("冷静的分析者");
  });
});

describe("projectSharedContext id tiebreak", () => {
  it("places the lesser id first when that id is the summary and the message id is greater", () => {
    const at = "2026-08-01T00:00:00.000Z";
    const projection = projectSharedContext(
      { topic: "Sort topic", background: "" },
      [message({ id: "id-z", content: "later id", createdAt: at })],
      [summary({ id: "id-a", content: "earlier id", generatedAt: at })],
    );

    expect(projection).toEqual({
      topic: "Sort topic",
      background: "",
      items: [
        {
          id: "id-a",
          role: "summary",
          content: "earlier id",
          sourceExecutionId: "e-2",
        },
        {
          id: "id-z",
          role: "participant",
          participantId: "p-1",
          content: "later id",
          sourceExecutionId: "e-1",
        },
      ],
    });
  });

  it("keeps an already-ascending id pair in place when timestamps match", () => {
    const at = "2026-08-01T00:00:00.000Z";
    const projection = projectSharedContext(
      { topic: "Sort topic", background: "bg" },
      [
        message({
          id: "id-a",
          content: "earlier id",
          createdAt: at,
          participantId: null,
          sourceExecutionId: null,
          role: "user",
        }),
      ],
      [summary({ id: "id-z", content: "later id", generatedAt: at })],
    );

    expect(projection).toEqual({
      topic: "Sort topic",
      background: "bg",
      items: [
        { id: "id-a", role: "user", content: "earlier id" },
        {
          id: "id-z",
          role: "summary",
          content: "later id",
          sourceExecutionId: "e-2",
        },
      ],
    });
  });
});
