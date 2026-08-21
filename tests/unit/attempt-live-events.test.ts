import { clipLiveSummary, parseAttemptLiveEventLine } from "@shared/runtime/attempt-live-events";
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

describe("clipLiveSummary", () => {
  it("trims and caps at 240 UTF-16 code units", () => {
    expect(clipLiveSummary("  hi  ")).toBe("hi");
    expect(clipLiveSummary("审".repeat(241)).length).toBe(240);
  });

  it("does not split a surrogate pair at the 240-unit boundary", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);

    const fits = "a".repeat(238) + emoji;
    expect(fits.length).toBe(240);
    expect(clipLiveSummary(fits)).toBe(fits);

    const over = "a".repeat(239) + emoji;
    expect(over.length).toBe(241);
    const clipped = clipLiveSummary(over);
    expect(clipped.length).toBeLessThanOrEqual(240);
    expect(clipped).toBe("a".repeat(239));
  });
});
