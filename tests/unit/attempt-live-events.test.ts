import { LIVE_SUMMARY_MAX, parseAttemptLiveEventLine } from "@shared/runtime/attempt-live-events";
import { describe, expect, it } from "vitest";

describe("parseAttemptLiveEventLine", () => {
  it("parses each legal event type", () => {
    expect(
      parseAttemptLiveEventLine(
        JSON.stringify({ seq: 1, at: "t0", type: "text.delta", text: "hi" }),
      ),
    ).toEqual({ seq: 1, at: "t0", type: "text.delta", text: "hi" });
    expect(
      parseAttemptLiveEventLine(
        JSON.stringify({ seq: 2, at: "t1", type: "thinking.delta", text: "hmm" }),
      ),
    ).toEqual({ seq: 2, at: "t1", type: "thinking.delta", text: "hmm" });
    expect(
      parseAttemptLiveEventLine(
        JSON.stringify({
          seq: 3,
          at: "t2",
          type: "tool.started",
          name: "Bash",
          summary: "ls",
        }),
      ),
    ).toEqual({ seq: 3, at: "t2", type: "tool.started", name: "Bash", summary: "ls" });
    expect(
      parseAttemptLiveEventLine(
        JSON.stringify({
          seq: 4,
          at: "t3",
          type: "tool.completed",
          name: "Bash",
          summary: "ls",
        }),
      ),
    ).toEqual({ seq: 4, at: "t3", type: "tool.completed", name: "Bash", summary: "ls" });
    expect(
      parseAttemptLiveEventLine(
        JSON.stringify({ seq: 5, at: "t4", type: "truncated", dropped: 3 }),
      ),
    ).toEqual({ seq: 5, at: "t4", type: "truncated", dropped: 3 });
  });

  it("returns null for bad JSON, missing fields, and unknown types", () => {
    expect(parseAttemptLiveEventLine("{nope")).toBeNull();
    expect(parseAttemptLiveEventLine("")).toBeNull();
    expect(parseAttemptLiveEventLine("null")).toBeNull();
    expect(parseAttemptLiveEventLine(JSON.stringify({ seq: 1, at: "t", type: "nope" }))).toBeNull();
    expect(
      parseAttemptLiveEventLine(JSON.stringify({ seq: 1, at: "t", type: "text.delta" })),
    ).toBeNull();
    expect(
      parseAttemptLiveEventLine(
        JSON.stringify({ seq: "1", at: "t", type: "text.delta", text: "x" }),
      ),
    ).toBeNull();
    expect(
      parseAttemptLiveEventLine(
        JSON.stringify({ seq: 1.5, at: "t", type: "text.delta", text: "x" }),
      ),
    ).toBeNull();
    expect(
      parseAttemptLiveEventLine(
        JSON.stringify({ seq: 1, at: "t", type: "tool.completed", name: "", summary: "x" }),
      ),
    ).toBeNull();
    expect(
      parseAttemptLiveEventLine(
        JSON.stringify({ seq: 1, at: "t", type: "truncated", dropped: -1 }),
      ),
    ).toBeNull();
  });

  it("clips a long tool summary to 240 UTF-16 code units", () => {
    const long = "x".repeat(300);
    const parsed = parseAttemptLiveEventLine(
      JSON.stringify({ seq: 1, at: "t", type: "tool.started", name: "Bash", summary: long }),
    );
    expect(parsed?.type).toBe("tool.started");
    if (parsed?.type !== "tool.started") return;
    expect(parsed.summary.length).toBe(240);
  });
});

describe("tool summary clip", () => {
  function toolSummary(summary: string): string {
    const parsed = parseAttemptLiveEventLine(
      JSON.stringify({ seq: 1, at: "t", type: "tool.started", name: "Bash", summary }),
    );
    expect(parsed?.type).toBe("tool.started");
    if (parsed?.type !== "tool.started") return "";
    return parsed.summary;
  }

  it("trims and caps at LIVE_SUMMARY_MAX UTF-16 code units", () => {
    expect(toolSummary("  hi  ")).toBe("hi");
    expect(toolSummary("审".repeat(LIVE_SUMMARY_MAX + 1)).length).toBe(LIVE_SUMMARY_MAX);
  });

  it("does not split a surrogate pair at the summary boundary", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);

    const fits = `${"a".repeat(LIVE_SUMMARY_MAX - emoji.length)}${emoji}`;
    expect(fits.length).toBe(LIVE_SUMMARY_MAX);
    expect(toolSummary(fits)).toBe(fits);

    const over = `${"a".repeat(LIVE_SUMMARY_MAX - 1)}${emoji}`;
    expect(over.length).toBe(LIVE_SUMMARY_MAX + 1);
    const clipped = toolSummary(over);
    expect(clipped.length).toBeLessThanOrEqual(LIVE_SUMMARY_MAX);
    expect(clipped).toBe("a".repeat(LIVE_SUMMARY_MAX - 1));
    expect(clipped.endsWith("\uD83D")).toBe(false);
  });
});
