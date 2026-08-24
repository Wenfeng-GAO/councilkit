import { formatAttemptMs, matchSeatAttempt } from "@/lib/seat-inspector";
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
});
