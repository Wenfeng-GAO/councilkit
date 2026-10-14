/**
 * Edge coverage for CLI context-snapshot digests and wire assembly.
 * Expected digests are sha256 hex of the shared canonical JSON, written as
 * literals (not recomputed by the functions under test).
 */
import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_DIGEST_VERSION,
  buildContextSnapshot,
  computeContextDigest,
  computeInstructionDigest,
  computeParticipantDigest,
  contextItem,
  digestOf,
  turnItem,
} from "../src/run/context-snapshot";

const ORDER_HASH = "d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772";
const EMPTY_PERSONA_HASH = "11e9789c29a6b00368a0a0ddaf0ea90b60b0430cc5099ba0c7ca1aeb0105decc";
const PERSONA_HASH = "ef4be4991d3566b699aeb4bba418554fdcb30f912c86921de9c73abd016ef77b";
const WS_PERSONA_HASH = "2562572ab70d18a8ce3ab7d1089e6a3bbfb0f9081dcc03f9773997abdbe7c0df";
const MESSAGE_SPEAK_HASH = "c68bb103b6636b8b050f8747869281728975f57a84b5051bcc04571fdd37bc50";
const SUMMARY_SPEAK_HASH = "c7173644c0cdd55d263d996f36d885daad1d63b9a058748dee53c4269c0a3ac5";
const MESSAGE_REPORT_HASH = "8c3f48f1de0d4aade4a11062f69b20dc9722905232dbd4b44aad2f3411e1db1a";
const SUMMARY_REPORT_HASH = "d7585271b9428fb45d73dff859cb03cb94a2c711a180cf4015bd756bbe8f56a5";
const MESSAGE_EMPTY_HASH = "03310297760204fabe88d2c551c416d5ee3eede61b77f0b436816c219091da0f";
const EMPTY_ITEMS_HASH = "21a5ca5473b3fbdef262476a4dda400977661c5f877200219f8dcc59c3015db7";
const TWO_ITEM_HASH = "152e6cb2f47fa72e503bea72dbc65b84384e2f18bb04314da349a28c19f288f7";
const CHANGED_ITEM_HASH = "b6e23f999b670305ba8e9819fecd77d9f2bc8f7bd6d8aa0f23fca2f35846b5f3";

describe("digestOf", () => {
  it("hashes null, empty objects, and key order independently of insertion", () => {
    expect(SNAPSHOT_DIGEST_VERSION).toBe(1);
    expect(digestOf(null)).toBe("74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b");
    expect(digestOf({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(digestOf({ b: 1, a: 2 })).toBe(ORDER_HASH);
    expect(digestOf({ a: 2, b: 1, c: undefined })).toBe(ORDER_HASH);
    expect(digestOf(["a", "b"])).toBe(
      "0473ef2dc0d324ab659d3580c1134e9d812035905c4781fdd6d529b0c6860e13",
    );
    expect(digestOf(["b", "a"])).toBe(
      "02d8bc3008a9bb0dcc4b86d7fd3428ced792355c733c19756bec5a56dc61b2c5",
    );
  });

  it("rejects non-finite numbers and unsupported types with the canonical error", () => {
    expect(() => digestOf(Number.NaN)).toThrowError(new Error("canonicalJson: non-finite number"));
    expect(() => digestOf(Number.POSITIVE_INFINITY)).toThrowError(
      new Error("canonicalJson: non-finite number"),
    );
    expect(() => digestOf(() => 1)).toThrowError(
      new Error("canonicalJson: unsupported type function"),
    );
  });
});

describe("computeParticipantDigest", () => {
  it("omits an empty persona and keeps a whitespace persona verbatim", () => {
    expect(computeParticipantDigest("")).toBe(EMPTY_PERSONA_HASH);
    expect(computeParticipantDigest("skeptical architect")).toBe(PERSONA_HASH);
    expect(computeParticipantDigest("  ")).toBe(WS_PERSONA_HASH);
    expect(computeParticipantDigest("skeptical architect")).toBe(PERSONA_HASH);
  });
});

describe("computeInstructionDigest", () => {
  it("changes when kind or text changes and keeps an empty text", () => {
    expect(computeInstructionDigest({ kind: "message", text: "speak" })).toBe(MESSAGE_SPEAK_HASH);
    expect(computeInstructionDigest({ kind: "summary", text: "speak" })).toBe(SUMMARY_SPEAK_HASH);
    expect(computeInstructionDigest({ kind: "message", text: "report" })).toBe(MESSAGE_REPORT_HASH);
    expect(computeInstructionDigest({ kind: "summary", text: "report" })).toBe(SUMMARY_REPORT_HASH);
    expect(computeInstructionDigest({ kind: "message", text: "" })).toBe(MESSAGE_EMPTY_HASH);
  });
});

describe("contextItem and turnItem", () => {
  it("includes background and target output only when they contain non-whitespace", () => {
    expect(
      contextItem("run-1", { topic: "route", background: "cost", targetOutput: "one page" }, [
        { name: "Ada", participantId: "p-ada" },
      ]),
    ).toEqual({
      id: "run-1:context",
      role: "user",
      content:
        "Topic: route\n\nBackground:\ncost\n\nTarget output:\none page\n\nParticipating agents:\n- Ada (participant p-ada)",
    });
    expect(
      contextItem("run-1", { topic: "route", background: " \n", targetOutput: "\t" }, []),
    ).toEqual({
      id: "run-1:context",
      role: "user",
      content: "Topic: route\n\nParticipating agents:\n",
    });
  });

  it("builds a stable turn item from the execution output", () => {
    expect(
      turnItem("run-1", 1, {
        participantId: "p-ada",
        output: "hello",
        executionId: "exec-1",
      }),
    ).toEqual({
      id: "run-1:turn:1",
      role: "participant",
      participantId: "p-ada",
      content: "hello",
      sourceExecutionId: "exec-1",
    });
  });
});

describe("computeContextDigest", () => {
  const context = {
    id: "run-1:context",
    role: "user" as const,
    content: "Topic: route\n\nParticipating agents:\n- Ada (participant p-ada)",
  };

  it("projects only the wire item fields and changes when content changes", () => {
    const noisy = Object.assign(
      turnItem("run-1", 1, { participantId: "p-ada", output: "hello", executionId: "exec-1" }),
      { extra: "ignored" },
    );
    expect(
      computeContextDigest({
        topic: "route",
        background: "",
        items: [context, noisy],
      }),
    ).toBe(TWO_ITEM_HASH);
    expect(
      computeContextDigest({
        topic: "route",
        background: "",
        items: [
          context,
          turnItem("run-1", 1, {
            participantId: "p-ada",
            output: "hello!",
            executionId: "exec-1",
          }),
        ],
      }),
    ).toBe(CHANGED_ITEM_HASH);
    expect(computeContextDigest({ topic: "", background: "bg", items: [] })).toBe(EMPTY_ITEMS_HASH);
  });
});

describe("buildContextSnapshot", () => {
  it("omits empty topic and empty persona and counts zero ordinary turns", () => {
    expect(
      buildContextSnapshot({
        runId: "run-1",
        topic: "",
        background: "bg",
        items: [],
        participantId: "p-ada",
        participantSnapshotDigest: "digest-persona",
        personaPrompt: "",
        instruction: { kind: "summary", text: "report" },
      }),
    ).toEqual({
      digestVersion: 1,
      roomContext: {
        contextRevision: 0,
        contextDigest: EMPTY_ITEMS_HASH,
        items: [],
      },
      participant: {
        participantId: "p-ada",
        participantSnapshotDigest: "digest-persona",
      },
      instruction: {
        kind: "summary",
        instructionDigest: SUMMARY_REPORT_HASH,
        text: "report",
      },
    });
  });

  it("keeps a whitespace persona, a non-empty topic, and revision = items.length - 1", () => {
    const items = [
      contextItem("run-1", { topic: "route", background: "cost", targetOutput: "one page" }, [
        { name: "Ada", participantId: "p-ada" },
      ]),
    ];
    const one = buildContextSnapshot({
      runId: "run-1",
      topic: "route",
      background: "cost",
      items,
      participantId: "p-ada",
      participantSnapshotDigest: PERSONA_HASH,
      personaPrompt: "  ",
      instruction: { kind: "message", text: "speak" },
    });
    expect(one.roomContext.contextRevision).toBe(0);
    expect(one.roomContext.topic).toBe("route");
    expect(one.participant).toEqual({
      participantId: "p-ada",
      participantSnapshotDigest: PERSONA_HASH,
      personaPrompt: "  ",
    });
    expect(one.instruction).toEqual({
      kind: "message",
      instructionDigest: MESSAGE_SPEAK_HASH,
      text: "speak",
    });
    expect(one.digestVersion).toBe(1);

    const three = [
      ...items,
      turnItem("run-1", 1, { participantId: "p-ada", output: "a", executionId: "e1" }),
      turnItem("run-1", 2, { participantId: "p-ada", output: "b", executionId: "e2" }),
    ];
    const later = buildContextSnapshot({
      runId: "run-1",
      topic: "route",
      background: "cost",
      items: three,
      participantId: "p-ada",
      participantSnapshotDigest: PERSONA_HASH,
      personaPrompt: "skeptical architect",
      instruction: { kind: "message", text: "speak" },
    });
    expect(later.roomContext.contextRevision).toBe(2);
    expect(later.roomContext.items).toEqual(three);
    expect(later.participant.personaPrompt).toBe("skeptical architect");
  });
});
