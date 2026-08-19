import { applyLiveHeartbeat, liveStateFromRecords } from "@shared/runtime/cli-run-progress";
import { describe, expect, it } from "vitest";

const started = {
  kind: "review.started",
  attempts: [
    {
      attemptId: "attempt-0",
      agentName: "review-security",
      driverId: "claude-stream-json",
      modelId: "m",
    },
    {
      attemptId: "attempt-1",
      agentName: "review-correctness",
      driverId: "codex-app-server",
      modelId: "g",
    },
  ],
  aggregator: {
    attemptId: "aggregator",
    agentName: "review-correctness",
    driverId: "codex-app-server",
    modelId: "g",
  },
};

describe("liveStateFromRecords", () => {
  it("marks unfinished attempts running and aggregator pending", () => {
    const live = liveStateFromRecords([started], "t0");
    expect(live?.status).toBe("running");
    expect(live?.progress.phase).toBe("attempts");
    expect(live?.progress.attempts.map((row) => row.status)).toEqual([
      "running",
      "running",
      "pending",
    ]);
    expect(live?.progress.attempts.every((row) => row.lastActivity === null)).toBe(true);
  });

  it("overlays elapsed ms and lastActivity onto a running attempt", () => {
    const live = liveStateFromRecords([started], "t0");
    expect(live).not.toBeNull();
    if (live === null) return;
    applyLiveHeartbeat(live, {
      attemptId: "attempt-1",
      elapsedMs: 45_000,
      lastActivity: "git fetch origin",
    });
    const row = live.progress.attempts.find((item) => item.attemptId === "attempt-1");
    expect(row?.durationMs).toBe(45_000);
    expect(row?.lastActivity).toBe("git fetch origin");
    const other = live.progress.attempts.find((item) => item.attemptId === "attempt-0");
    expect(other?.durationMs).toBeNull();
    expect(other?.lastActivity).toBeNull();
  });

  it("moves to aggregating after every attempt finishes successfully", () => {
    const live = liveStateFromRecords([
      started,
      {
        kind: "attempt.finished",
        attemptId: "attempt-0",
        status: "success",
        durationMs: 10,
      },
      {
        kind: "attempt.finished",
        attemptId: "attempt-1",
        status: "success",
        durationMs: 20,
      },
    ]);
    expect(live?.progress.phase).toBe("aggregating");
    expect(live?.progress.attempts[2]?.status).toBe("running");
  });

  it("marks the run completed from review.finished", () => {
    const live = liveStateFromRecords([
      started,
      {
        kind: "attempt.finished",
        attemptId: "attempt-0",
        status: "success",
        durationMs: 1,
      },
      {
        kind: "attempt.finished",
        attemptId: "attempt-1",
        status: "success",
        durationMs: 1,
      },
      {
        kind: "aggregation.finished",
        status: "success",
        durationMs: 5,
      },
      { kind: "review.finished", status: "completed" },
    ]);
    expect(live?.status).toBe("completed");
    expect(live?.progress.phase).toBe("done");
    expect(live?.progress.attempts[2]?.status).toBe("success");
  });
});
