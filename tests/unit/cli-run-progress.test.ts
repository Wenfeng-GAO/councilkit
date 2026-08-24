import {
  applyLiveHeartbeat,
  liveStateFromRecords,
  mergeLiveProgress,
  parseLiveStateJson,
} from "@shared/runtime/cli-run-progress";
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
  it("marks unfinished attempts queued and aggregator pending", () => {
    const live = liveStateFromRecords([started], "t0");
    expect(live?.status).toBe("running");
    expect(live?.progress.phase).toBe("attempts");
    expect(live?.progress.attempts.map((row) => row.status)).toEqual([
      "queued",
      "queued",
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
      started: true,
    });
    const row = live.progress.attempts.find((item) => item.attemptId === "attempt-1");
    expect(row?.status).toBe("running");
    expect(row?.durationMs).toBe(45_000);
    expect(row?.lastActivity).toBe("git fetch origin");
    const other = live.progress.attempts.find((item) => item.attemptId === "attempt-0");
    expect(other?.status).toBe("queued");
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

  it("review.resumed clears rerun failures and reopens the run", () => {
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
        status: "failure",
        durationMs: 45,
      },
      {
        kind: "aggregation.finished",
        status: "success",
        durationMs: 5,
      },
      { kind: "review.finished", status: "completed" },
      {
        kind: "review.resumed",
        rerunAttemptIds: ["attempt-1"],
      },
    ]);
    expect(live?.status).toBe("running");
    expect(live?.progress.phase).toBe("attempts");
    expect(live?.progress.attempts.map((row) => row.status)).toEqual([
      "success",
      "queued",
      "pending",
    ]);
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

describe("mergeLiveProgress", () => {
  it("refills empty status.json attempts from the transcript", () => {
    const fromTranscript = liveStateFromRecords(
      [
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
        {
          kind: "aggregation.finished",
          status: "success",
          durationMs: 5,
        },
        { kind: "review.finished", status: "completed" },
      ],
      "t-done",
    )?.progress;
    expect(fromTranscript?.attempts.length).toBeGreaterThan(0);
    const merged = mergeLiveProgress(
      { phase: "done", attempts: [], updatedAt: "t-pipe" },
      fromTranscript ?? null,
    );
    expect(merged?.phase).toBe("done");
    expect(merged?.updatedAt).toBe("t-pipe");
    expect(merged?.attempts.map((row) => row.attemptId)).toEqual([
      "attempt-0",
      "attempt-1",
      "aggregator",
    ]);
  });

  it("keeps live attempts when they are already present", () => {
    const live = {
      phase: "attempts" as const,
      attempts: [
        {
          attemptId: "live-0",
          agentName: "A",
          driverId: "kimi-stream-json",
          modelId: "k",
          role: "attempt" as const,
          status: "running" as const,
          durationMs: 1,
          lastActivity: "grep",
        },
      ],
      updatedAt: "t-live",
    };
    const merged = mergeLiveProgress(live, liveStateFromRecords([started], "t0")?.progress ?? null);
    expect(merged?.attempts).toHaveLength(1);
    expect(merged?.attempts[0]?.attemptId).toBe("live-0");
  });
});

describe("parseLiveStateJson pipeline", () => {
  it("reads planning phase and pipeline sidecar", () => {
    const live = parseLiveStateJson(
      JSON.stringify({
        version: 1,
        status: "running",
        progress: { phase: "plan-review", attempts: [], updatedAt: "t1" },
        pipeline: {
          phase: "plan-review",
          round: 1,
          maxRounds: 2,
          planVerdict: null,
          applyStatus: "pending",
          followUpRunId: null,
          summary: null,
          updatedAt: "t1",
        },
      }),
    );
    expect(live?.progress.phase).toBe("plan-review");
    expect(live?.pipeline?.round).toBe(1);
    expect(live?.pipeline?.applyStatus).toBe("pending");
  });
});
