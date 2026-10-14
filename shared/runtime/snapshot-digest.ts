/**
 * Objects hashed into a context snapshot digest.
 *
 * The browser room snapshot and the CLI review snapshot must hash this
 * projection. Item order is part of the digest. Key order is not: callers
 * hash the result with canonical JSON.
 */
import type { SnapshotItem } from "./schemas";

export const SNAPSHOT_DIGEST_VERSION = 1 as const;

export function contextDigestMaterial(projection: {
  topic: string;
  background: string;
  items: readonly SnapshotItem[];
}) {
  return {
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
  };
}

export function instructionDigestMaterial(instruction: {
  kind: "message" | "summary";
  text: string;
}) {
  return {
    digestVersion: SNAPSHOT_DIGEST_VERSION,
    kind: instruction.kind,
    text: instruction.text,
  };
}

/** An empty prompt is omitted. A whitespace-only prompt is kept. */
export function participantPromptDigestMaterial(personaPrompt: string) {
  return {
    digestVersion: SNAPSHOT_DIGEST_VERSION,
    personaPrompt: personaPrompt.length > 0 ? personaPrompt : undefined,
  };
}
