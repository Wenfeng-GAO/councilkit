/**
 * CLI Context Snapshot construction (plan-a §5). Ports the verified algorithm
 * of `src/orchestrator/context-snapshot.ts` into the CLI's no-Dexie world —
 * copied + annotated, NOT imported (the source pulls Dexie entities).
 *
 * Sync-point: if `src/orchestrator/context-snapshot.ts` changes its digest
 * projection or the stable-first-item convention, mirror it here.
 *
 * SessionReconciler contract (verified against
 * `runtime-host/scopes/session-reconciler.ts`): the reconciler records each
 * participant's `participantSnapshotDigest` + an exact id/content prefix of
 * applied items, then on the next turn requires (a) digestVersion unchanged,
 * (b) revision non-decreasing, (c) participant digest unchanged, (d) the
 * previously-applied item prefix hashes byte-identical. It does NOT compare
 * `contextDigest` or `instructionDigest` across sides — those are recorded but
 * never re-derived. So the CLI's hard rules are:
 *   - stable FIRST item carries background/targetOutput/participating agents;
 *   - items are PURELY appended (id/content/sourceExecutionId never rewritten);
 *   - `contextRevision` = number of persisted ordinary speeches, monotonic;
 *   - `participantSnapshotDigest` computed once per agent and reused every turn.
 *
 * Every snapshot is run through `contextSnapshotSchema.parse` before execute.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/runtime/digest";
import {
  type ContextSnapshot,
  type SnapshotItem,
  contextSnapshotSchema,
} from "@shared/runtime/schemas";

export const SNAPSHOT_DIGEST_VERSION = 1 as const;

/** sha256 hex over the shared canonical form (same algorithm as the Host's
 * `hashItem` / the browser's `digestOf`; the reconciler records-then-compares
 * our value, so cross-side byte-match is not required, but determinism is). */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Participant digest = sha256(canonicalJson({digestVersion, personaPrompt})).
 * Stable for the whole Scope life of one agent (reconciler keys on it). */
export function computeParticipantDigest(personaPrompt: string): string {
  return digestOf({
    digestVersion: SNAPSHOT_DIGEST_VERSION,
    personaPrompt: personaPrompt.length > 0 ? personaPrompt : undefined,
  });
}

/** Instruction digest = sha256(canonicalJson({digestVersion, kind, text})). */
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

/** The normalized shared projection — the contextDigest input. Mirrors the
 * source's `SharedProjection` (sync-point). */
export interface SharedProjection {
  topic: string;
  background: string;
  items: SnapshotItem[];
}

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

/** Build the stable first context item that carries background + target output
 * + the participating agent roster. The shared schema has no top-level
 * background/targetOutput fields, so this stable user-role item is their only
 * injection point (plan-a §5). Its id/content NEVER change across the run. */
export function contextItem(
  runId: string,
  council: {
    topic: string;
    background: string;
    targetOutput: string;
  },
  agents: ReadonlyArray<{ name: string; participantId: string }>,
): SnapshotItem {
  const roster = agents.map((a) => `- ${a.name} (participant ${a.participantId})`).join("\n");
  const parts: string[] = [`Topic: ${council.topic}`];
  if (council.background.trim().length > 0) parts.push(`Background:\n${council.background}`);
  if (council.targetOutput.trim().length > 0) parts.push(`Target output:\n${council.targetOutput}`);
  parts.push(`Participating agents:\n${roster}`);
  return {
    id: `${runId}:context`,
    role: "user",
    content: parts.join("\n\n"),
  };
}

/** A completed ordinary speech appended to the shared items. Stable id keyed
 * by its monotonic sequence; content = the authoritative completed output. */
export function turnItem(
  runId: string,
  seq: number,
  turn: {
    participantId: string;
    output: string;
    executionId: string;
  },
): SnapshotItem {
  return {
    id: `${runId}:turn:${seq}`,
    role: "participant",
    participantId: turn.participantId,
    content: turn.output,
    sourceExecutionId: turn.executionId,
  };
}

/** Assemble + schema-validate the wire snapshot for one execution. `items` is
 * the full shared projection (stable first item + every completed ordinary
 * speech so far, in completion order); `revision` = items.length minus the
 * context item count (here, ordinary-speech count = items.length - 1). */
export function buildContextSnapshot(input: {
  runId: string;
  topic: string;
  background: string;
  items: SnapshotItem[];
  participantId: string;
  participantSnapshotDigest: string;
  personaPrompt: string;
  instruction: { kind: "message" | "summary"; text: string };
}): ContextSnapshot {
  const ordinaryCount = Math.max(0, input.items.length - 1);
  const projection: SharedProjection = {
    topic: input.topic,
    background: input.background,
    items: input.items,
  };
  const snapshot = {
    digestVersion: SNAPSHOT_DIGEST_VERSION,
    roomContext: {
      contextRevision: ordinaryCount,
      contextDigest: computeContextDigest(projection),
      topic: input.topic.length > 0 ? input.topic : undefined,
      items: input.items,
    },
    participant: {
      participantId: input.participantId,
      participantSnapshotDigest: input.participantSnapshotDigest,
      ...(input.personaPrompt.length > 0 ? { personaPrompt: input.personaPrompt } : {}),
    },
    instruction: {
      kind: input.instruction.kind,
      instructionDigest: computeInstructionDigest(input.instruction),
      text: input.instruction.text,
    },
  };
  return contextSnapshotSchema.parse(snapshot);
}
