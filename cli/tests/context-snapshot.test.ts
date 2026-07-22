/**
 * ContextSnapshot unit tests (plan-a §10 AC1, snapshot bucket). Covers:
 *  - every snapshot passes `contextSnapshotSchema.parse`;
 *  - background/targetOutput are visible in the stable first item;
 *  - digest is deterministic;
 *  - items are purely appended (id/content never rewrite) across alternating
 *    participants, multiple rounds, and the Reporter turn;
 *  - directly verified against the Host's `createSessionReconciler` so the
 *    prefix stays in_sync (no history_replaced / participant_changed).
 */
import { createSessionReconciler } from "@host/scopes/session-reconciler";
import type { ContextSnapshot, SnapshotItem } from "@shared/runtime/schemas";
import { contextSnapshotSchema } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";
import {
  buildContextSnapshot,
  computeParticipantDigest,
  contextItem,
  digestOf,
  turnItem,
} from "../src/run/context-snapshot";

const RUN_ID = "ck-run-test";

function council() {
  return {
    topic: "route local models cheaply",
    background: "cost pressure; three viable routes",
    targetOutput: "a one-page recommendation",
  };
}

interface Agent {
  name: string;
  participantId: string;
  persona: string;
}

const AGENTS: Agent[] = [
  { name: "Alpha", participantId: "p-alpha", persona: "skeptical architect" },
  { name: "Beta", participantId: "p-beta", persona: "cost-focused operator" },
];

describe("cli context-snapshot", () => {
  it("builds a schema-valid snapshot with the stable context first item", () => {
    const items = [contextItem(RUN_ID, council(), AGENTS)];
    const snap = buildContextSnapshot({
      runId: RUN_ID,
      topic: council().topic,
      background: council().background,
      items,
      participantId: "p-alpha",
      participantSnapshotDigest: computeParticipantDigest("skeptical architect"),
      personaPrompt: "skeptical architect",
      instruction: { kind: "message", text: "speak" },
    });
    expect(contextSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(snap.roomContext.items[0].content).toContain("Background:");
    expect(snap.roomContext.items[0].content).toContain("Target output:");
    expect(snap.roomContext.items[0].content).toContain("Alpha");
    expect(snap.roomContext.items[0].content).toContain("Beta");
  });

  it("every snapshot across the whole run parses against the shared schema", () => {
    const completed: SnapshotItem[] = [contextItem(RUN_ID, council(), AGENTS)];
    const digests = AGENTS.map((a) => computeParticipantDigest(a.persona));
    const snapshots: ContextSnapshot[] = [];
    // 2 rounds × 2 agents
    for (let round = 1; round <= 2; round += 1) {
      for (let i = 0; i < AGENTS.length; i += 1) {
        const a = AGENTS[i] as Agent;
        const snap = buildContextSnapshot({
          runId: RUN_ID,
          topic: council().topic,
          background: council().background,
          items: completed,
          participantId: a.participantId,
          participantSnapshotDigest: digests[i] as string,
          personaPrompt: a.persona,
          instruction: { kind: "message", text: `round ${round} speak` },
        });
        snapshots.push(snap);
        completed.push(
          turnItem(RUN_ID, completed.length, {
            participantId: a.participantId,
            output: `output r${round}-${a.name}`,
            executionId: `exec-r${round}-${a.name}`,
          }),
        );
      }
    }
    // Reporter snapshot
    const reporter = AGENTS[1] as Agent;
    snapshots.push(
      buildContextSnapshot({
        runId: RUN_ID,
        topic: council().topic,
        background: council().background,
        items: completed,
        participantId: reporter.participantId,
        participantSnapshotDigest: digests[1] as string,
        personaPrompt: reporter.persona,
        instruction: { kind: "summary", text: "report" },
      }),
    );
    for (const s of snapshots) {
      expect(contextSnapshotSchema.safeParse(s).success).toBe(true);
    }
  });

  it("appends items purely — earlier item ids/content never change", () => {
    const items = [contextItem(RUN_ID, council(), AGENTS)];
    const firstId = items[0].id;
    const firstContent = items[0].content;
    for (let i = 1; i <= 4; i += 1) {
      items.push(
        turnItem(RUN_ID, i, {
          participantId: "p-alpha",
          output: `out ${i}`,
          executionId: `exec-${i}`,
        }),
      );
    }
    expect(items[0].id).toBe(firstId);
    expect(items[0].content).toBe(firstContent);
    expect(items.map((i) => i.id)).toEqual([
      "ck-run-test:context",
      "ck-run-test:turn:1",
      "ck-run-test:turn:2",
      "ck-run-test:turn:3",
      "ck-run-test:turn:4",
    ]);
  });

  it("computes a deterministic digest", () => {
    const a = digestOf({ digestVersion: 1, topic: "x", background: "y", items: [] });
    const b = digestOf({ digestVersion: 1, topic: "x", background: "y", items: [] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the SessionReconciler in_sync across alternating participants + Reporter", () => {
    const rec = createSessionReconciler();
    const completed: SnapshotItem[] = [contextItem(RUN_ID, council(), AGENTS)];
    const digests = AGENTS.map((a) => computeParticipantDigest(a.persona));

    const drive = (
      participantIndex: number,
      kind: "message" | "summary",
      text: string,
      expectBasis: "full" | "incremental",
    ) => {
      const a = AGENTS[participantIndex] as Agent;
      const snap = buildContextSnapshot({
        runId: RUN_ID,
        topic: council().topic,
        background: council().background,
        items: completed,
        participantId: a.participantId,
        participantSnapshotDigest: digests[participantIndex] as string,
        personaPrompt: a.persona,
        instruction: { kind, text },
      });
      const outcome = rec.reconcile(a.participantId, snap, 1, null);
      expect(outcome.kind).toBe("ok");
      if (expectBasis === "full" && outcome.kind === "ok") {
        expect(outcome.basis).toBe("full");
      }
      if (expectBasis === "incremental" && outcome.kind === "ok") {
        expect(outcome.basis).toBe("incremental");
      }
      rec.recordApplied(a.participantId, snap, `exec-${participantIndex}-${completed.length}`, 1, {
        inputTokens: 10,
      });
    };

    // Round 1
    drive(0, "message", "r1-alpha", "full"); // Alpha first turn → cold session, full
    completed.push(turn(RUN_ID, 1, "p-alpha", "alpha r1", "exec-a1"));
    drive(1, "message", "r1-beta", "full"); // Beta first turn → also cold (own session)
    completed.push(turn(RUN_ID, 2, "p-beta", "beta r1", "exec-b1"));
    // Round 2
    drive(0, "message", "r2-alpha", "incremental");
    completed.push(turn(RUN_ID, 3, "p-alpha", "alpha r2", "exec-a2"));
    drive(1, "message", "r2-beta", "incremental");
    completed.push(turn(RUN_ID, 4, "p-beta", "beta r2", "exec-b2"));
    // Reporter (Beta) — incremental, sees all 4 ordinary speeches
    drive(1, "summary", "report", "incremental");
  });

  it("the same participant digest is stable across turns (participant_changed never fires)", () => {
    const d1 = computeParticipantDigest("persona X");
    const d2 = computeParticipantDigest("persona X");
    expect(d1).toBe(d2);
  });
});

function turn(
  runId: string,
  seq: number,
  participantId: string,
  output: string,
  executionId: string,
): SnapshotItem {
  return turnItem(runId, seq, { participantId, output, executionId });
}
