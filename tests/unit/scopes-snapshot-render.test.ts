import type { ContextSnapshot, SnapshotItem } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";
import { renderItem, renderItems, renderTurn } from "../../runtime-host/scopes/snapshot-render.ts";

/**
 * Exact prompt text for every snapshot role and for full vs incremental turns.
 * renderTurn is the only place structured items become driver prompt bytes.
 */

function item(over: SnapshotItem): SnapshotItem {
  return over;
}

function snapshot(options: {
  revision: number;
  items: SnapshotItem[];
  topic?: string;
  background?: string;
  kind?: "message" | "summary";
  text?: string;
}): ContextSnapshot {
  return {
    digestVersion: 1,
    roomContext: {
      contextRevision: options.revision,
      contextDigest: "digest-pinned",
      ...(options.topic === undefined ? {} : { topic: options.topic }),
      ...(options.background === undefined ? {} : { background: options.background }),
      items: options.items,
    },
    participant: {
      participantId: "p-1",
      participantSnapshotDigest: "participant-digest-1",
    },
    instruction: {
      kind: options.kind ?? "message",
      instructionDigest: "instr-1",
      text: options.text ?? "Go.",
    },
  };
}

describe("renderItem / renderItems", () => {
  it("renders user, summary, named participant, and unknown participant", () => {
    expect(renderItem(item({ id: "i-user", role: "user", content: "Hello" }))).toBe(
      "[user]\nHello",
    );
    expect(renderItem(item({ id: "i-sum", role: "summary", content: "Sum" }))).toBe(
      "[summary]\nSum",
    );
    expect(
      renderItem(
        item({
          id: "i-p",
          role: "participant",
          participantId: "p-2",
          content: "Other",
          sourceExecutionId: "exec-0",
        }),
      ),
    ).toBe("[participant p-2]\nOther");
    expect(renderItem(item({ id: "i-anon", role: "participant", content: "Anon" }))).toBe(
      "[participant unknown]\nAnon",
    );
    expect(
      renderItem(item({ id: "i-blank", role: "participant", participantId: "", content: "Blank" })),
    ).toBe("[participant ]\nBlank");
  });

  it("joins items with a blank line and renders an empty list as an empty string", () => {
    expect(
      renderItems([
        { id: "i-1", role: "user", content: "Hello" },
        { id: "i-2", role: "summary", content: "Sum" },
      ]),
    ).toBe("[user]\nHello\n\n[summary]\nSum");
    expect(renderItems([])).toBe("");
  });
});

describe("renderTurn", () => {
  const items: SnapshotItem[] = [
    { id: "i-1", role: "user", content: "Hello" },
    { id: "i-2", role: "summary", content: "Sum" },
    {
      id: "i-3",
      role: "participant",
      participantId: "p-2",
      content: "Other",
      sourceExecutionId: "exec-0",
    },
    { id: "i-4", role: "participant", content: "Anon" },
  ];

  it("renders a full turn with topic, background, every item, and the instruction", () => {
    expect(
      renderTurn(
        snapshot({
          revision: 7,
          topic: "T",
          background: "B",
          items,
          kind: "summary",
          text: "Wrap up.",
        }),
        0,
      ),
    ).toEqual({
      itemCount: 4,
      prompt: [
        "# Discussion context (revision 7)",
        "Topic: T",
        "Background:",
        "B",
        "",
        "[user]",
        "Hello",
        "",
        "[summary]",
        "Sum",
        "",
        "[participant p-2]",
        "Other",
        "",
        "[participant unknown]",
        "Anon",
        "",
        "# Instruction (summary)",
        "Wrap up.",
      ].join("\n"),
    });
  });

  it("omits an empty topic and an empty background from the full header", () => {
    expect(
      renderTurn(snapshot({ revision: 3, topic: "", background: "", items: [], text: "Go." }), 0),
    ).toEqual({
      itemCount: 0,
      prompt: "# Discussion context (revision 3)\n\n# Instruction (message)\nGo.",
    });
  });

  it("renders a topic-only header and a background-only header", () => {
    expect(renderTurn(snapshot({ revision: 2, topic: "Only", items: [], text: "Go." }), 0)).toEqual(
      {
        itemCount: 0,
        prompt: "# Discussion context (revision 2)\nTopic: Only\n\n# Instruction (message)\nGo.",
      },
    );
    expect(
      renderTurn(snapshot({ revision: 2, background: "bg", items: [], text: "Go." }), 0),
    ).toEqual({
      itemCount: 0,
      prompt: "# Discussion context (revision 2)\nBackground:\nbg\n\n# Instruction (message)\nGo.",
    });
  });

  it("renders an incremental tail without the header and keeps the full item count", () => {
    expect(
      renderTurn(
        snapshot({
          revision: 7,
          topic: "T",
          background: "B",
          items,
          kind: "summary",
          text: "Wrap up.",
        }),
        2,
      ),
    ).toEqual({
      itemCount: 4,
      prompt: [
        "[participant p-2]",
        "Other",
        "",
        "[participant unknown]",
        "Anon",
        "",
        "# Instruction (summary)",
        "Wrap up.",
      ].join("\n"),
    });
  });

  it("renders only the instruction when the incremental tail is empty", () => {
    expect(
      renderTurn(snapshot({ revision: 7, topic: "T", background: "B", items, text: "Reply." }), 4),
    ).toEqual({
      itemCount: 4,
      prompt: "# Instruction (message)\nReply.",
    });
  });
});
