import {
  applyLiveHeartbeat,
  liveStateFromRecords,
  mapSquadObserveStatus,
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

  it("keeps cancelled squad seats instead of dropping progress", () => {
    const live = parseLiveStateJson(
      JSON.stringify({
        version: 1,
        status: "running",
        progress: {
          phase: "reviewing",
          updatedAt: "t1",
          attempts: [
            {
              attemptId: "review-0",
              agentName: "reviewer",
              driverId: "codex",
              modelId: "gpt-5.6-sol",
              role: "attempt",
              status: "cancelled",
              durationMs: 12,
              lastActivity: null,
            },
          ],
        },
        pipeline: null,
      }),
    );
    expect(live?.progress.attempts[0]?.status).toBe("cancelled");
  });

  it("reads awaiting_orchestrator, closed, and a camelCase handoff", () => {
    const live = parseLiveStateJson(
      JSON.stringify({
        version: 1,
        status: "awaiting_orchestrator",
        progress: { phase: "snapshotting", attempts: [], updatedAt: "t1" },
        pipeline: null,
        handoff: {
          epoch: 9,
          candidateSha: "636e4b58aaaa",
          candidateStatus: "invalidated",
          invalidatedReason: "reviewer P1",
          taskBaseSha: "ec2659baaaaa",
          next: "gate record needs a finished verify receipt",
          approved: false,
        },
      }),
    );
    expect(live?.status).toBe("awaiting_orchestrator");
    expect(live?.handoff?.epoch).toBe(9);
    expect(live?.handoff?.candidateStatus).toBe("invalidated");
    expect(live?.handoff?.approved).toBe(false);
  });

  it("accepts snake_case handoff keys and ignores extra fields", () => {
    const live = parseLiveStateJson(
      JSON.stringify({
        version: 1,
        status: "closed",
        progress: { phase: "integrating", attempts: [], updatedAt: "t1" },
        pipeline: null,
        handoff: {
          candidate_sha: "80b2a77bbbbb",
          candidate_status: "completed",
          task_base_sha: "ec2659baaaaa",
          current_fix: { round: 2, operation_id: "fix-2" },
          leftover: true,
        },
      }),
    );
    expect(live?.status).toBe("closed");
    expect(live?.handoff?.candidateSha).toBe("80b2a77bbbbb");
    expect(live?.handoff?.currentFix).toEqual({ round: 2, operationId: "fix-2" });
  });

  it("keeps progress when handoff is garbage", () => {
    const live = parseLiveStateJson(
      JSON.stringify({
        version: 1,
        status: "running",
        progress: { phase: "implementing", attempts: [], updatedAt: "t1" },
        pipeline: null,
        handoff: "nope",
      }),
    );
    expect(live?.status).toBe("running");
    expect(live?.progress.phase).toBe("implementing");
    expect(live?.handoff).toBeNull();
  });
});

describe("mapSquadObserveStatus", () => {
  const terminal = [
    {
      attemptId: "coder-0",
      agentName: "coder",
      driverId: "grokb",
      modelId: "grok-4.6",
      role: "attempt" as const,
      status: "success" as const,
      durationMs: 1,
      lastActivity: null,
    },
  ];

  it("maps interrupted squad with terminal seats and phase≠done", () => {
    expect(
      mapSquadObserveStatus({
        kind: "squad",
        status: "interrupted",
        progress: { phase: "snapshotting", attempts: terminal, updatedAt: "t" },
      }),
    ).toBe("awaiting_orchestrator");
  });

  it("does not map review interrupted", () => {
    expect(
      mapSquadObserveStatus({
        kind: "review",
        status: "interrupted",
        progress: { phase: "snapshotting", attempts: terminal, updatedAt: "t" },
      }),
    ).toBe("interrupted");
  });

  it("promotes interrupted+running seats to running", () => {
    expect(
      mapSquadObserveStatus({
        kind: "squad",
        status: "interrupted",
        progress: {
          phase: "implementing",
          attempts: [{ ...terminal[0], status: "running", attemptId: "coder-1" }],
          updatedAt: "t",
        },
      }),
    ).toBe("running");
  });

  it("keeps closed and does not remap phase=done", () => {
    expect(
      mapSquadObserveStatus({
        kind: "squad",
        status: "closed",
        progress: { phase: "snapshotting", attempts: terminal, updatedAt: "t" },
      }),
    ).toBe("closed");
    expect(
      mapSquadObserveStatus({
        kind: "squad",
        status: "interrupted",
        progress: { phase: "done", attempts: terminal, updatedAt: "t" },
      }),
    ).toBe("interrupted");
  });
});
