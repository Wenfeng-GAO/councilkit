import { formatAttemptMs, inspectorDuration, matchSeatAttempt } from "@/lib/seat-inspector";
import { describe, expect, it } from "vitest";

const seats = [
  {
    attemptId: "attempt-sec",
    agentName: "review-security",
    driverId: "claude-stream-json",
    modelId: "antchat/GLM-5.2[1m]",
  },
  {
    attemptId: "attempt-corr",
    agentName: "review-correctness",
    driverId: "kimi-stream-json",
    modelId: "kimi-code/k3",
  },
  {
    attemptId: "attempt-agg",
    agentName: "review-correctness",
    driverId: "grok-stream-json",
    modelId: "grok-4.6",
  },
];

describe("matchSeatAttempt", () => {
  it("matches a unique name", () => {
    expect(matchSeatAttempt(seats, "review-security")?.attemptId).toBe("attempt-sec");
  });

  it("disambiguates same name by driver/model", () => {
    expect(
      matchSeatAttempt(seats, "review-correctness", "grok-stream-json/grok-4.6")?.attemptId,
    ).toBe("attempt-agg");
    expect(
      matchSeatAttempt(seats, "review-correctness", "kimi-stream-json/kimi-code/k3")?.attemptId,
    ).toBe("attempt-corr");
  });

  it("falls back to the first name match", () => {
    expect(matchSeatAttempt(seats, "review-correctness")?.attemptId).toBe("attempt-corr");
  });

  it("returns undefined when the seat is missing", () => {
    expect(matchSeatAttempt(seats, "review-adversarial")).toBeUndefined();
  });
});

describe("formatAttemptMs", () => {
  it("formats seconds and minutes", () => {
    expect(formatAttemptMs(900)).toBe("0s");
    expect(formatAttemptMs(4000)).toBe("4s");
    expect(formatAttemptMs(125000)).toBe("2m05s");
  });

  it("rolls an hour the same way the review report does, and clamps a negative clock", () => {
    expect(formatAttemptMs(3_599_999)).toBe("59m59s");
    expect(formatAttemptMs(3_600_000)).toBe("1h00m00s");
    expect(formatAttemptMs(3_723_000)).toBe("1h02m03s");
    expect(formatAttemptMs(36_000_000)).toBe("10h00m00s");
    expect(formatAttemptMs(-500)).toBe("0s");
  });
});

describe("inspectorDuration", () => {
  const span = { hasTimeline: true, spanMs: 12_000, eventCount: 4 };

  it("running seats keep receipt elapsed and do not overlay live span", () => {
    expect(inspectorDuration(45_000, span, "running")).toBe("45s");
  });

  it("finished seats show receipt and process span separately", () => {
    expect(inspectorDuration(90_000, span, "success")).toBe("1m30s · 过程 12s");
  });

  it("rolls hours on both the receipt and the process span", () => {
    expect(
      inspectorDuration(
        3_723_000,
        { hasTimeline: true, spanMs: 3_600_000, eventCount: 4 },
        "success",
      ),
    ).toBe("1h02m03s · 过程 1h00m00s");
  });
});
