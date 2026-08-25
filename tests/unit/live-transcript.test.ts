import {
  displayLastActivity,
  displayToolName,
  foldLiveEvents,
  formatElapsed,
  formatSpan,
  hasUnmatchedFence,
  isDeliverableText,
  isPathTool,
  liveEventSpan,
  shortenActivityPath,
  showsTick,
  silentToolTally,
  unwrapShellSummary,
} from "@/lib/live-transcript";
import { describe, expect, it } from "vitest";

describe("foldLiveEvents", () => {
  it("folds a kimi-style character spray into one text block", () => {
    const events = Array.from({ length: 40 }, (_, i) => ({
      seq: i + 1,
      at: `t${i}`,
      type: "text.delta" as const,
      text: i % 2 === 0 ? "{" : "}",
    }));
    const blocks = foldLiveEvents(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("text");
    expect(blocks[0] && blocks[0].kind === "text" ? blocks[0].text : "").toHaveLength(40);
  });

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

  it("lifts nameless empty tools even when still started", () => {
    const blocks = foldLiveEvents([
      { seq: 1, at: "t0", type: "tool.started", name: "tool", summary: "" },
      { seq: 2, at: "t1", type: "tool.completed", name: "tool", summary: "" },
      { seq: 3, at: "t2", type: "tool.completed", name: "Read", summary: "a.go" },
    ]);
    expect(silentToolTally(blocks).tally).toEqual([{ name: "tool", count: 1 }]);
    expect(silentToolTally(blocks).timeline).toEqual([
      { kind: "tool", name: "Read", summary: "a.go", status: "completed", at: "t2" },
    ]);
  });

  it("pairs a generic completed tool onto the last open seat", () => {
    const blocks = foldLiveEvents([
      { seq: 1, at: "t0", type: "tool.started", name: "read", summary: "Read" },
      {
        seq: 2,
        at: "t1",
        type: "tool.completed",
        name: "tool",
        summary: "/tmp/squad/planner-a.json",
      },
    ]);
    expect(blocks).toEqual([
      {
        kind: "tool",
        name: "read",
        summary: "/tmp/squad/planner-a.json",
        status: "completed",
        at: "t0",
        endAt: "t1",
      },
    ]);
    expect(silentToolTally(blocks).tally).toEqual([]);
    expect(silentToolTally(blocks).timeline).toHaveLength(1);
  });

  it("does not close execute with a later path completion", () => {
    const blocks = foldLiveEvents([
      { seq: 1, at: "t0", type: "tool.started", name: "execute", summary: "Bash" },
      { seq: 2, at: "t1", type: "tool.started", name: "read", summary: "Read" },
      {
        seq: 3,
        at: "t2",
        type: "tool.completed",
        name: "tool",
        summary: "/tmp/pkg/runtime/acp/session.go",
      },
    ]);
    expect(blocks[0]).toMatchObject({ name: "execute", status: "started" });
    expect(blocks[1]).toMatchObject({
      name: "read",
      status: "completed",
      summary: "/tmp/pkg/runtime/acp/session.go",
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

  it("strips zsh -c wrapping used by Codex", () => {
    expect(unwrapShellSummary('/bin/zsh -c "pwd && git rev-parse HEAD"')).toBe(
      "pwd && git rev-parse HEAD",
    );
  });
});

describe("displayLastActivity", () => {
  it("hides receipt JSON and empty tool placeholders", () => {
    expect(displayLastActivity('{"schema_version":1,"run_id":"verify-0"}')).toBeNull();
    expect(displayLastActivity("tool")).toBeNull();
    expect(displayLastActivity('/bin/zsh -c "go test ./pkg/events"')).toBe("go test ./pkg/events");
    expect(displayLastActivity("}")).toBeNull();
    expect(displayLastActivity('{ "run_id": "verify-0", "ok": true }')).toBeNull();
    expect(displayLastActivity("## 概览\n\n结论")).toBeNull();
  });

  it("shortens a bare absolute path", () => {
    expect(
      displayLastActivity(
        "/Users/hengzhuo/code/ant/agentrun/.squad/20260824-pr126-cmfix-k4p2/planner-a.json",
      ),
    ).toBe("20260824-pr126-cmfix-k4p2/planner-a.json");
    expect(shortenActivityPath("sed -n '1,80p' /tmp/brief.md")).toBe(
      "sed -n '1,80p' /tmp/brief.md",
    );
  });
});

describe("liveEventSpan", () => {
  it("treats a single backfilled timestamp as no timeline", () => {
    const at = "2026-08-24T15:23:34.924Z";
    expect(liveEventSpan([{ at }, { at }, { at }])).toEqual({
      spanMs: null,
      hasTimeline: false,
      eventCount: 3,
    });
  });

  it("uses first-to-last live timestamps when they actually move", () => {
    expect(
      liveEventSpan([{ at: "2026-08-24T14:48:00.000Z" }, { at: "2026-08-24T15:03:00.000Z" }]),
    ).toEqual({ spanMs: 15 * 60 * 1000, hasTimeline: true, eventCount: 2 });
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
