import type {
  DiscussionMessage,
  DiscussionRoom,
  DiscussionSummary,
  Participant,
} from "@/models/discussion/entities";
import { digestOf } from "@/models/discussion/factories";
import {
  type ContextSnapshot,
  type SnapshotItem,
  contextSnapshotSchema,
} from "@shared/runtime/schemas";

/**
 * Deterministic Context Snapshot construction (U4).
 *
 * The Snapshot is the authoritative per-execution input, split into shared
 * room context, the current Participant snapshot, and this execution's
 * instruction. Digests use the shared canonical serialization with
 * `digestVersion: 1`; only changes to the shared persisted projection bump
 * `contextRevision` — a Participant-only change touches only
 * `participantSnapshotDigest`, a single instruction only `instructionDigest`.
 */

export const SNAPSHOT_DIGEST_VERSION = 1 as const;

/** The normalized shared persisted projection — the ONLY contextDigest input. */
export interface SharedProjection {
  topic: string;
  background: string;
  items: SnapshotItem[];
}

/** contextDigest = sha256(canonicalJson(normalized projection)), stable across
 * object construction order (canonicalJson sorts keys; item order is semantic). */
export function computeContextDigest(projection: SharedProjection): string {
  return digestOf({
    digestVersion: SNAPSHOT_DIGEST_VERSION,
    topic: projection.topic,
    background: projection.background,
    items: projection.items.map((item) => ({
      id: item.id,
      role: item.role,
      participantId: item.participantId,
      content: item.content,
      sourceExecutionId: item.sourceExecutionId,
    })),
  });
}

export function computeInstructionDigest(instruction: {
  kind: "message" | "summary";
  text: string;
}): string {
  return digestOf({
    digestVersion: SNAPSHOT_DIGEST_VERSION,
    kind: instruction.kind,
    text: instruction.text,
  });
}

function messageToItem(message: DiscussionMessage): SnapshotItem {
  return {
    id: message.id,
    role: message.role,
    ...(message.participantId === null ? {} : { participantId: message.participantId }),
    content: message.content,
    ...(message.sourceExecutionId === null ? {} : { sourceExecutionId: message.sourceExecutionId }),
  };
}

function summaryToItem(summary: DiscussionSummary): SnapshotItem {
  return {
    id: summary.id,
    role: "summary",
    content: summary.content,
    sourceExecutionId: summary.sourceExecutionId,
  };
}

/**
 * Chronological projection across Messages and Summaries (a Round's Summary
 * lands after its Messages, before the next Round's). ISO timestamps order
 * lexicographically; id breaks ties deterministically.
 */
export function projectSharedContext(
  room: Pick<DiscussionRoom, "topic" | "background">,
  messages: readonly DiscussionMessage[],
  summaries: readonly DiscussionSummary[],
): SharedProjection {
  const timed = [
    ...messages.map((message) => ({ at: message.createdAt, item: messageToItem(message) })),
    ...summaries.map((summary) => ({ at: summary.generatedAt, item: summaryToItem(summary) })),
  ];
  timed.sort((a, b) => (a.at === b.at ? (a.item.id < b.item.id ? -1 : 1) : a.at < b.at ? -1 : 1));
  return { topic: room.topic, background: room.background, items: timed.map((t) => t.item) };
}

/**
 * Sets a freshly created Room's initial digest: revision 0 over the empty
 * projection. Called wherever Rooms are created (seed, creation flow) so a
 * first-turn Snapshot always carries a schema-valid contextDigest.
 */
export function initializeRoomDigest(room: DiscussionRoom): DiscussionRoom {
  room.contextRevision = 0;
  room.contextDigest = computeContextDigest(projectSharedContext(room, [], []));
  return room;
}

/**
 * Builds the wire Snapshot and validates it against the shared runtime
 * schema — the exact contract the Host parses.
 */
export function buildContextSnapshot(input: {
  room: DiscussionRoom;
  participant: Participant;
  instruction: { kind: "message" | "summary"; text: string };
  items: SnapshotItem[];
}): ContextSnapshot {
  return contextSnapshotSchema.parse({
    digestVersion: SNAPSHOT_DIGEST_VERSION,
    roomContext: {
      contextRevision: input.room.contextRevision,
      contextDigest: input.room.contextDigest,
      ...(input.room.topic ? { topic: input.room.topic } : {}),
      items: input.items,
    },
    participant: {
      participantId: input.participant.id,
      participantSnapshotDigest: input.participant.participantSnapshotDigest,
      personaPrompt: input.participant.personaPrompt,
    },
    instruction: {
      kind: input.instruction.kind,
      instructionDigest: computeInstructionDigest(input.instruction),
      text: input.instruction.text,
    },
  });
}
