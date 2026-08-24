import {
  displayToolName,
  foldLiveEvents,
  formatElapsed,
  formatSpan,
  hasUnmatchedFence,
  isDeliverableText,
  isPathTool,
  showsTick,
  silentToolTally,
  unwrapShellSummary,
} from "@/lib/live-transcript";
import { describe, expect, it } from "vitest";

describe("foldLiveEvents", () => {
  it("merges consecutive text and thinking deltas", () => {
    const blocks = foldLiveEvents([
      { seq: 1, at: "t0", type: "thinking.delta", text: "hmm" },
      { seq: 2, at: "t1", type: "thinking.delta", text: "…" },
      { seq: 3, at: "t2", type: "text.delta", text: "## 发现\n" },
      { seq: 4, at: "t3", type: "text.delta", text: "- a" },
    ]);
    expect(blocks).toEqual([
      { kind: "thinking", text: "hmm…", at: "t0" },
      { kind: "text", text: "## 发现\n- a", at: "t2" },
    ]);
  });

  it("pairs tool.started with the matching tool.completed", () => {
    const blocks = foldLiveEvents([
      { seq: 1, at: "t0", type: "tool.started", name: "Bash", summary: "ls" },
      { seq: 2, at: "t1", type: "tool.started", name: "Read", summary: "a.ts" },
      { seq: 3, at: "t2", type: "tool.completed", name: "Read", summary: "src/a.ts" },
      { seq: 4, at: "t3", type: "tool.completed", name: "Bash", summary: "ls -la" },
    ]);
    expect(blocks).toEqual([
      { kind: "tool", name: "Bash", summary: "ls -la", status: "completed", at: "t0", endAt: "t3" },
      {
        kind: "tool",
        name: "Read",
        summary: "src/a.ts",
        status: "completed",
        at: "t1",
        endAt: "t2",
      },
    ]);
  });

  it("keeps an unmatched started tool and a completed-only tool", () => {
    const blocks = foldLiveEvents([
      { seq: 1, at: "t0", type: "tool.started", name: "Bash", summary: "sleep 9" },
      { seq: 2, at: "t1", type: "tool.completed", name: "Read", summary: "pkg.go" },
    ]);
    expect(blocks).toEqual([
      { kind: "tool", name: "Bash", summary: "sleep 9", status: "started", at: "t0" },
      { kind: "tool", name: "Read", summary: "pkg.go", status: "completed", at: "t1" },
    ]);
  });

  it("keeps the started summary when completed summary is empty", () => {
    const blocks = foldLiveEvents([
      { seq: 1, at: "t0", type: "tool.started", name: "Bash", summary: "git status" },
      { seq: 2, at: "t1", type: "tool.completed", name: "Bash", summary: "" },
    ]);
    expect(blocks).toEqual([
      {
        kind: "tool",
        name: "Bash",
        summary: "git status",
        status: "completed",
        at: "t0",
        endAt: "t1",
      },
    ]);
  });

  it("keeps empty-summary tools in the fold so tally can lift them", () => {
    const blocks = foldLiveEvents([
      { seq: 1, at: "t0", type: "tool.completed", name: "Read", summary: "" },
      { seq: 2, at: "t1", type: "thinking.delta", text: "hmm" },
      { seq: 3, at: "t2", type: "tool.completed", name: "Read", summary: "" },
      { seq: 4, at: "t3", type: "tool.completed", name: "Bash", summary: "ls" },
    ]);
    expect(silentToolTally(blocks)).toEqual({
      tally: [{ name: "Read", count: 2 }],
      timeline: [
        { kind: "thinking", text: "hmm", at: "t1" },
        { kind: "tool", name: "Bash", summary: "ls", status: "completed", at: "t3" },
      ],
    });
  });
});

describe("formatElapsed", () => {
  it("renders m:ss from the origin event", () => {
    expect(formatElapsed("2026-08-24T07:30:22.000Z", "2026-08-24T07:33:34.000Z")).toBe("3:12");
    expect(formatElapsed("2026-08-24T07:30:22.000Z", "2026-08-24T07:30:30.000Z")).toBe("0:08");
    expect(formatElapsed("2026-08-24T07:30:22.000Z", "2026-08-24T08:31:22.000Z")).toBe("1:01:00");
    expect(formatElapsed("nope", "2026-08-24T07:30:22.000Z")).toBe("");
  });
});

describe("formatSpan", () => {
  it("skips sub-second spans", () => {
    expect(formatSpan("2026-08-24T07:30:22.000Z", "2026-08-24T07:30:28.000Z")).toBe("6s");
    expect(formatSpan("2026-08-24T07:30:22.000Z", "2026-08-24T07:31:27.000Z")).toBe("1m05s");
    expect(formatSpan("2026-08-24T07:30:22.000Z", "2026-08-24T07:30:22.400Z")).toBe("");
  });
});

describe("showsTick", () => {
  it("marks tools and collapsed deliverables only", () => {
    expect(
      showsTick({ kind: "tool", name: "Bash", summary: "ls", status: "completed", at: "t" }, false),
    ).toBe(true);
    expect(showsTick({ kind: "thinking", text: "hmm", at: "t" }, true)).toBe(false);
    const body = `## 概览\n\n${"字".repeat(320)}\n\n## 结论\n`;
    expect(showsTick({ kind: "text", text: body, at: "t" }, true)).toBe(true);
    expect(showsTick({ kind: "text", text: body, at: "t" }, false)).toBe(false);
  });
});

describe("isDeliverableText", () => {
  it("detects a long jury-report restatement", () => {
    const body = `## 概览\n\n${"字".repeat(320)}\n\n## 结论\n\nchanges-requested\n`;
    expect(isDeliverableText(body)).toBe(true);
    expect(isDeliverableText("## 发现\n- one item")).toBe(false);
  });

  it("detects a long planner JSON claims blob", () => {
    const body = JSON.stringify({
      schema_version: 1,
      planner_id: "planner-a",
      intent_check: "pass",
      claims: [{ claim_id: "C1", statement: "x".repeat(200) }],
      invariants: ["bounded"],
    });
    expect(isDeliverableText(body)).toBe(true);
    expect(isDeliverableText('{"ok":true}')).toBe(false);
  });
});

describe("hasUnmatchedFence", () => {
  it("detects an open fence and ignores a closed pair", () => {
    expect(hasUnmatchedFence("```ts\nconst x = 1")).toBe(true);
    expect(hasUnmatchedFence("```ts\nconst x = 1\n```")).toBe(false);
    expect(hasUnmatchedFence("plain")).toBe(false);
  });
});

describe("unwrapShellSummary", () => {
  it("strips zsh -lc wrapping and incomplete quotes", () => {
    expect(unwrapShellSummary('/bin/zsh -lc "rg -n foo vendor | head -50"')).toBe(
      "rg -n foo vendor | head -50",
    );
    expect(unwrapShellSummary('/bin/zsh -lc "rg -n foo | head')).toBe("rg -n foo | head");
    expect(unwrapShellSummary("pytest -q")).toBe("pytest -q");
  });
});

describe("displayToolName", () => {
  it("renames command_execution to shell", () => {
    expect(displayToolName("command_execution")).toBe("shell");
    expect(displayToolName("Bash")).toBe("Bash");
  });
});

describe("isPathTool", () => {
  it("recognizes read / glob / list_dir spellings", () => {
    expect(isPathTool("Read")).toBe(true);
    expect(isPathTool("read_file")).toBe(true);
    expect(isPathTool("Glob")).toBe(true);
    expect(isPathTool("list_dir")).toBe(true);
    expect(isPathTool("Bash")).toBe(false);
    expect(isPathTool("grep")).toBe(false);
  });
});
