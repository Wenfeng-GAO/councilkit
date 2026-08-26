import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAttemptLiveEventLine } from "@shared/runtime/attempt-live-events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiveEventCollector, LiveEventWriter, type RawLiveEvent } from "../src/auto/live-events";

function feedLines(coll: LiveEventCollector, payload: string, splitAt?: number): RawLiveEvent[] {
  const buf = Buffer.from(payload, "utf8");
  if (splitAt === undefined) {
    const events = coll.feed(buf);
    return [...events, ...coll.end()];
  }
  const a = coll.feed(buf.subarray(0, splitAt));
  const b = coll.feed(buf.subarray(splitAt));
  return [...a, ...b, ...coll.end()];
}

describe("LiveEventCollector", () => {
  it("claude: stream_event text/thinking deltas and assistant tool_use completed", () => {
    const lines = [
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "plan" },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", name: "Bash", input: { command: "git status" } },
          ],
        },
      }),
    ].join("\n");
    const coll = new LiveEventCollector("claude-stream-json");
    expect(feedLines(coll, `${lines}\n`)).toEqual([
      { type: "thinking.delta", text: "plan" },
      { type: "text.delta", text: "hello" },
      { type: "tool.completed", name: "Bash", summary: "git status" },
    ]);
  });

  it("claude: Read file_path becomes the tool summary", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "pkg/foo.go" } }],
      },
    });
    const coll = new LiveEventCollector("claude-stream-json");
    expect(feedLines(coll, `${line}\n`)).toEqual([
      { type: "tool.completed", name: "Read", summary: "pkg/foo.go" },
    ]);
  });

  it("claude: does not emit assistant text/thinking blocks (covered by stream_event)", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "final" },
          { type: "thinking", thinking: "secret" },
        ],
      },
    });
    const coll = new LiveEventCollector("claude-stream-json");
    expect(feedLines(coll, `${line}\n`)).toEqual([]);
  });

  it("kimi: tool_calls plus intermediate content; last frame is flushed on end", () => {
    const lines = [
      JSON.stringify({
        role: "assistant",
        content: "working",
        tool_calls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } }],
      }),
      JSON.stringify({ role: "assistant", content: "final deliverable" }),
    ].join("\n");
    const coll = new LiveEventCollector("kimi-stream-json");
    expect(feedLines(coll, `${lines}\n`)).toEqual([
      { type: "tool.completed", name: "bash", summary: "ls" },
      { type: "text.delta", text: "working" },
      { type: "text.delta", text: "final deliverable" },
    ]);
  });

  it("kimi: args.cmd tool without content", () => {
    const line = JSON.stringify({
      role: "assistant",
      content: "",
      tool_calls: [{ name: "shell", args: { cmd: "pnpm test" } }],
    });
    const coll = new LiveEventCollector("kimi-stream-json");
    expect(feedLines(coll, `${line}\n`)).toEqual([
      { type: "tool.completed", name: "shell", summary: "pnpm test" },
    ]);
  });

  it("codex: item.started/completed tools, reasoning, agent_message", () => {
    const lines = [
      JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", command: "ls" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "ls" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "think" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      }),
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
    ].join("\n");
    const coll = new LiveEventCollector("codex-app-server");
    expect(feedLines(coll, `${lines}\n`)).toEqual([
      { type: "tool.started", name: "command_execution", summary: "ls" },
      { type: "tool.completed", name: "command_execution", summary: "ls" },
      { type: "thinking.delta", text: "think" },
      { type: "text.delta", text: "done" },
    ]);
  });

  it("cursor: assistant text + tool_call started/completed", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "reading" }] },
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        tool_call: { readToolCall: { args: { path: "README.md" } } },
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        tool_call: { readToolCall: { args: { path: "README.md" } } },
      }),
    ].join("\n");
    const coll = new LiveEventCollector("cursor-stream-json");
    expect(feedLines(coll, `${lines}\n`)).toEqual([
      { type: "text.delta", text: "reading" },
      { type: "tool.started", name: "readToolCall", summary: "README.md" },
      { type: "tool.completed", name: "readToolCall", summary: "README.md" },
    ]);
  });

  it("grok: shares the claude parser (thinking/text deltas + tool_use from assistant frames)", () => {
    const coll = new LiveEventCollector("grok-stream-json");
    const events = feedLines(
      coll,
      `${[
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "想" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "答" } },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }],
          },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "答" }),
      ].join("\n")}\n`,
    );
    expect(events).toEqual([
      { type: "thinking.delta", text: "想" },
      { type: "text.delta", text: "答" },
      { type: "tool.completed", name: "Bash", summary: "ls -la" },
    ]);
  });

  it("grok: legacy single-object json output produces no events", () => {
    const coll = new LiveEventCollector("grok-stream-json");
    expect(feedLines(coll, `${JSON.stringify({ text: "hi" })}\n`)).toEqual([]);
  });

  it("ignores bad JSON and decodes a multibyte delta split across chunks", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "审查" } },
    });
    const payload = `{broken\n${line}\n`;
    const buf = Buffer.from(payload, "utf8");
    const coll = new LiveEventCollector("claude-stream-json");
    const mid = Math.floor(buf.length / 2);
    expect(feedLines(coll, payload, mid)).toEqual([{ type: "text.delta", text: "审查" }]);
  });

  it("strips a proxy env prefix and caps summary at 240", () => {
    const long = `echo ${"x".repeat(300)}`;
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: `NO_PROXY='*' ${long}` },
          },
        ],
      },
    });
    const coll = new LiveEventCollector("claude-stream-json");
    const events = feedLines(coll, `${line}\n`);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool.completed");
    if (events[0]?.type !== "tool.completed") return;
    expect(events[0].summary.startsWith("echo ")).toBe(true);
    expect(Array.from(events[0].summary).length).toBe(240);
  });
});

describe("LiveEventWriter", () => {
  let dir: string;
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ck-live-writer-"));
  });

  function readEvents(attemptId: string) {
    const text = readFileSync(join(dir, "live", `${attemptId}.jsonl`), "utf8");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => parseAttemptLiveEventLine(line));
  }

  it("merges consecutive same-type deltas on flush and assigns monotonic seq", () => {
    const writer = new LiveEventWriter(dir, { mergeWindowMs: 60_000 });
    writer.append("attempt-0", [
      { type: "text.delta", text: "hel" },
      { type: "text.delta", text: "lo" },
    ]);
    writer.flush("attempt-0");
    const events = readEvents("attempt-0");
    expect(events).toEqual([
      expect.objectContaining({ seq: 1, type: "text.delta", text: "hello" }),
    ]);
  });

  it("flushes pending text when a tool event arrives", () => {
    const writer = new LiveEventWriter(dir, { mergeWindowMs: 60_000 });
    writer.append("attempt-0", [
      { type: "text.delta", text: "hi" },
      { type: "tool.completed", name: "Bash", summary: "ls" },
    ]);
    const events = readEvents("attempt-0");
    expect(events.map((e) => e?.type)).toEqual(["text.delta", "tool.completed"]);
    expect(events[0]).toMatchObject({ seq: 1, text: "hi" });
    expect(events[1]).toMatchObject({ seq: 2, name: "Bash", summary: "ls" });
  });

  it("flushes a pending delta after the merge window", () => {
    const timers: Array<{ fn: () => void }> = [];
    const writer = new LiveEventWriter(dir, {
      mergeWindowMs: 250,
      setTimeout: (fn) => {
        timers.push({ fn });
        return timers.length;
      },
      clearTimeout: () => undefined,
    });
    writer.append("attempt-0", [{ type: "text.delta", text: "a" }]);
    expect(() => readFileSync(join(dir, "live", "attempt-0.jsonl"), "utf8")).toThrow();
    timers[0]?.fn();
    expect(readEvents("attempt-0")[0]).toMatchObject({ type: "text.delta", text: "a" });
  });

  it("flushes immediately when merged deltas reach 2KB", () => {
    const writer = new LiveEventWriter(dir, { mergeWindowMs: 60_000, mergeBytes: 16 });
    writer.append("attempt-0", [{ type: "text.delta", text: "abcdefghijklmnop" }]);
    expect(readEvents("attempt-0")[0]).toMatchObject({ text: "abcdefghijklmnop" });
  });

  it("drops later deltas after the byte cap, keeps tools, and writes truncated", () => {
    const writer = new LiveEventWriter(dir, { maxBytes: 200, mergeWindowMs: 60_000 });
    writer.append("attempt-0", [{ type: "text.delta", text: "hello" }]);
    writer.flush("attempt-0");
    writer.append("attempt-0", [
      { type: "text.delta", text: "y".repeat(400) },
      { type: "tool.completed", name: "Bash", summary: "ls" },
    ]);
    const types = readEvents("attempt-0").map((e) => e?.type);
    expect(types[0]).toBe("text.delta");
    expect(types).toContain("truncated");
    expect(types[types.length - 1]).toBe("tool.completed");
    expect(types.filter((t) => t === "text.delta")).toHaveLength(1);
  });

  it("swallows write failures", () => {
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "file");
    const writer = new LiveEventWriter(blocked);
    expect(() => {
      writer.append("attempt-0", [{ type: "text.delta", text: "x" }]);
      writer.flush("attempt-0");
    }).not.toThrow();
  });

  it("continues seq from an existing sidecar (retry / resume)", () => {
    mkdirSync(join(dir, "live"), { recursive: true });
    writeFileSync(
      join(dir, "live", "attempt-0.jsonl"),
      `${JSON.stringify({ seq: 3, at: "t", type: "text.delta", text: "old" })}\n`,
    );
    const writer = new LiveEventWriter(dir, { mergeWindowMs: 60_000 });
    writer.append("attempt-0", [{ type: "tool.completed", name: "Bash", summary: "ls" }]);
    const events = readEvents("attempt-0");
    expect(events[1]).toMatchObject({ seq: 4, type: "tool.completed" });
  });
});
