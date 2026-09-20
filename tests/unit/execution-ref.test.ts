import {
  type AttemptExecutionResolution,
  formatExecutionRef,
  resolveAttemptExecution,
  unavailableExecutionRef,
} from "@shared/runtime/execution-ref";
import { describe, expect, it } from "vitest";

const started = {
  kind: "review.started",
  version: 1,
  runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
  startedAt: "2026-09-20T00:00:00.000Z",
  task: { task: "fixture" },
  attempts: [
    {
      attemptId: "attempt-0",
      agentId: "a",
      agentName: "review-security",
      driverId: "claude-stream-json",
      modelId: "m",
    },
    {
      attemptId: "attempt-1",
      agentId: "b",
      agentName: "review-correctness",
      driverId: "kimi-stream-json",
      modelId: "k",
    },
  ],
  aggregator: {
    attemptId: "aggregator",
    agentId: "b",
    agentName: "review-correctness",
    driverId: "kimi-stream-json",
    modelId: "k",
  },
};

function finished(
  attemptId: string,
  status: "success" | "failure",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "attempt.finished",
    version: 1,
    attemptId,
    agentName: "review-security",
    driverId: "claude-stream-json",
    status,
    output: status === "success" ? "output" : null,
    exitCode: status === "success" ? 0 : 1,
    durationMs: 10,
    ...extra,
  };
}

function aggregationFinished(status: "success" | "failure", output = "agg-output"): unknown {
  return {
    kind: "aggregation.finished",
    version: 1,
    attemptId: "aggregator",
    agentName: "review-correctness",
    driverId: "kimi-stream-json",
    status,
    output: status === "success" ? output : null,
    exitCode: status === "success" ? 0 : 1,
    durationMs: 5,
  };
}

function resumed(reusedAttemptIds: string[], rerunAttemptIds: string[]): unknown {
  return {
    kind: "review.resumed",
    version: 1,
    runId: started.runId,
    resumedAt: "2026-09-20T01:00:00.000Z",
    reusedAttemptIds,
    rerunAttemptIds,
    probe: [],
  };
}

const RUN_ACTIVE = { liveStatus: "running" as const, runActive: true };
const RUN_OVER = { liveStatus: "success" as const, runActive: false };

describe("resolveAttemptExecution", () => {
  it("formats refs as <attemptId>#<generation>.<ordinal>", () => {
    expect(formatExecutionRef("attempt-0", 1, 1)).toBe("attempt-0#1.1");
    expect(formatExecutionRef("attempt-0", 3, 2)).toBe("attempt-0#3.2");
    expect(unavailableExecutionRef("attempt-0")).toBe("attempt-0#0.0");
  });

  // 场景 1：首次运行 — 运行中与终态 ref 一致。
  it("first run: in-flight ref equals the terminal record ref", () => {
    const inFlight = resolveAttemptExecution({
      records: [started],
      attemptId: "attempt-0",
      liveStatus: "queued",
      runActive: true,
    });
    expect(inFlight).toMatchObject({
      kind: "inflight",
      executionRef: "attempt-0#1.1",
      executionStatus: "queued",
    });

    const records = [started, finished("attempt-0", "success", { output: "first-output" })];
    const done = resolveAttemptExecution({
      records,
      attemptId: "attempt-0",
      liveStatus: "success",
      runActive: false,
    });
    expect(done).toMatchObject({
      kind: "terminal",
      executionRef: "attempt-0#1.1",
      executionStatus: "success",
      output: "first-output",
      reusedExecutionRef: null,
    });
  });

  // 场景 2：自动重试 — 失败首试与重试成功是两个执行，终态取本次成功。
  it("transient retry: failed first try and retried success are distinct executions", () => {
    const failedTry = finished("attempt-0", "failure", {
      output: null,
      attemptNumber: 1,
      exitCode: 1,
      durationMs: 5_000,
      failure: { code: "EXIT", message: "non-zero exit 1" },
    });
    const midRetry = resolveAttemptExecution({
      records: [started, failedTry],
      attemptId: "attempt-0",
      liveStatus: "failure", // progress still shows the first try's failure
      runActive: true,
    });
    expect(midRetry).toMatchObject({
      kind: "inflight",
      executionRef: "attempt-0#1.2",
      executionStatus: "running",
    });

    const retried = finished("attempt-0", "success", {
      output: "retry-output",
      attemptNumber: 2,
      retryOf: 1,
    });
    const done = resolveAttemptExecution({
      records: [started, failedTry, retried],
      attemptId: "attempt-0",
      liveStatus: "success",
      runActive: false,
    });
    expect(done).toMatchObject({
      kind: "terminal",
      executionRef: "attempt-0#1.2",
      executionStatus: "success",
      output: "retry-output",
    });
    expect((done as { output: string }).output).not.toContain("failure");
  });

  // 场景 2b：重试的二次失败是终态，不再预测第三次。
  it("a retried second failure is terminal (never a third try)", () => {
    const first = finished("attempt-0", "failure", {
      attemptNumber: 1,
      exitCode: 1,
      durationMs: 5_000,
      failure: { code: "EXIT", message: "boom" },
    });
    const second = finished("attempt-0", "failure", {
      attemptNumber: 2,
      retryOf: 1,
      exitCode: 1,
      durationMs: 4_000,
      failure: { code: "EXIT", message: "boom again" },
    });
    const res = resolveAttemptExecution({
      records: [started, first, second],
      attemptId: "attempt-0",
      liveStatus: "failure",
      runActive: true,
    });
    expect(res).toMatchObject({
      kind: "terminal",
      executionRef: "attempt-0#1.2",
      executionStatus: "failure",
    });
    expect((res as AttemptExecutionResolution & { kind: "terminal" }).failure).toEqual({
      code: "EXIT",
      message: "boom again",
    });
  });

  // 场景 3：resume 重跑 — 失败记录保留但当前执行切到新代次。
  it("resume rerun: prior failure stays addressed at the old generation", () => {
    const prior = finished("attempt-0", "failure", {
      attemptNumber: 1,
      failure: { code: "NO_OUTPUT", message: "nothing" },
    });
    const records = [started, prior, resumed([], ["attempt-0"])];
    const midRun = resolveAttemptExecution({
      records,
      attemptId: "attempt-0",
      liveStatus: "running",
      runActive: true,
    });
    expect(midRun).toMatchObject({
      kind: "inflight",
      executionRef: "attempt-0#2.1",
      executionStatus: "running",
    });

    const rerun = finished("attempt-0", "success", {
      output: "rerun-output",
      attemptNumber: 1,
      resumedAfterFailure: true,
    });
    const done = resolveAttemptExecution({
      records: [...records, rerun],
      attemptId: "attempt-0",
      liveStatus: "success",
      runActive: false,
    });
    expect(done).toMatchObject({
      kind: "terminal",
      executionRef: "attempt-0#2.1",
      executionStatus: "success",
      output: "rerun-output",
      reusedExecutionRef: null,
    });
  });

  // 场景 4：显式复用 — 当前结果指向源执行并给出 reusedFrom。
  it("explicit reuse: current result resolves to the source execution ref", () => {
    const prior = finished("attempt-0", "success", { output: "reusable-output", attemptNumber: 1 });
    const records = [started, prior, resumed(["attempt-0"], ["attempt-1"])];
    const res = resolveAttemptExecution({
      records,
      attemptId: "attempt-0",
      liveStatus: "success",
      runActive: true,
    });
    expect(res).toMatchObject({
      kind: "terminal",
      executionRef: "attempt-0#1.1",
      executionStatus: "success",
      output: "reusable-output",
      reusedExecutionRef: "attempt-0#1.1",
    });
  });

  // 场景 4b：只有 reusedAttemptIds 才算复用；rerun 席上出现的旧成功记录
  // 不得作为当前结果兜底。
  it("an old success under a rerun seat is not served as the current result", () => {
    const prior = finished("attempt-0", "success", { output: "stale-output", attemptNumber: 1 });
    const records = [started, prior, resumed(["attempt-1"], ["attempt-0"])];
    const midRun = resolveAttemptExecution({
      records,
      attemptId: "attempt-0",
      liveStatus: "running",
      runActive: true,
    });
    expect(midRun).toMatchObject({ kind: "inflight", executionRef: "attempt-0#2.1" });
    const runOver = resolveAttemptExecution({
      records,
      attemptId: "attempt-0",
      liveStatus: "failure",
      runActive: false,
    });
    expect(runOver).toMatchObject({
      kind: "unavailable",
      reason: "no-execution-record",
      executionRef: "attempt-0#2.1",
    });
  });

  // 场景 5：Aggregator 重跑 — 每代一次，resume 后取新一次。
  it("aggregator rerun: each resume generation re-executes the aggregator", () => {
    const agg1 = aggregationFinished("success", "agg-gen1");
    const records = [started, finished("attempt-0", "success"), agg1];
    const first = resolveAttemptExecution({
      records,
      attemptId: "aggregator",
      liveStatus: "success",
      runActive: false,
    });
    expect(first).toMatchObject({
      kind: "terminal",
      executionRef: "aggregator#1.1",
      executionStatus: "success",
      output: "agg-gen1",
      reusedExecutionRef: null,
    });

    const resumedRecords = [...records, resumed(["attempt-0"], ["attempt-1"])];
    const midAgg = resolveAttemptExecution({
      records: resumedRecords,
      attemptId: "aggregator",
      liveStatus: "running",
      runActive: true,
    });
    expect(midAgg).toMatchObject({
      kind: "inflight",
      executionRef: "aggregator#2.1",
      executionStatus: "running",
    });

    const agg2 = aggregationFinished("success", "agg-gen2");
    const done = resolveAttemptExecution({
      records: [...resumedRecords, agg2],
      attemptId: "aggregator",
      liveStatus: "success",
      runActive: false,
    });
    expect(done).toMatchObject({
      kind: "terminal",
      executionRef: "aggregator#2.1",
      executionStatus: "success",
      output: "agg-gen2",
    });
  });

  // Aggregator 未运行（全部失败/被跳过）且 run 终态：有限语义而非永久 pending。
  it("aggregator that never ran after the run ended is unavailable, not pending", () => {
    const records = [started, finished("attempt-0", "failure")];
    const res = resolveAttemptExecution({
      records,
      attemptId: "aggregator",
      liveStatus: "pending",
      runActive: false,
    });
    expect(res).toMatchObject({
      kind: "unavailable",
      reason: "no-execution-record",
      executionRef: "aggregator#1.1",
    });
  });

  // 终态空输出：success 但正文为空/缺失。
  it("terminal success with empty output resolves as empty output", () => {
    const records = [started, finished("attempt-0", "success", { output: "" })];
    const res = resolveAttemptExecution({
      records,
      attemptId: "attempt-0",
      ...RUN_OVER,
    });
    expect(res).toMatchObject({
      kind: "terminal",
      executionStatus: "success",
      output: "",
      executionRef: "attempt-0#1.1",
    });
  });

  // 取消映射：CANCELLED / ABORTED 失败码映射为 cancelled。
  it("maps CANCELLED and ABORTED failure codes to cancelled", () => {
    for (const code of ["CANCELLED", "ABORTED"]) {
      const records = [
        started,
        finished("attempt-0", "failure", {
          attemptNumber: 1,
          failure: { code, message: "run aborted before this attempt started" },
        }),
      ];
      const res = resolveAttemptExecution({ records, attemptId: "attempt-0", ...RUN_OVER });
      expect(res).toMatchObject({ kind: "terminal", executionStatus: "cancelled" });
    }
  });

  // 旧数据退化 A：无 attemptNumber 的旧记录不预测重试，直接给终态。
  it("legacy records without attemptNumber never predict a retry", () => {
    const records = [
      started,
      finished("attempt-0", "failure", {
        exitCode: 1,
        durationMs: 5_000,
        failure: { code: "EXIT", message: "old-era failure" },
      }),
    ];
    const res = resolveAttemptExecution({ records, attemptId: "attempt-0", ...RUN_ACTIVE });
    expect(res).toMatchObject({ kind: "terminal", executionStatus: "failure" });
  });

  // 旧数据退化 B：无 resume 的多记录时代同样落在第 1 代。
  it("legacy transcripts without any resume stay in generation 1", () => {
    const records = [
      started,
      finished("attempt-0", "failure"),
      finished("attempt-0", "success", { output: "second-era-output" }),
    ];
    const res = resolveAttemptExecution({ records, attemptId: "attempt-0", ...RUN_OVER });
    expect(res).toMatchObject({
      kind: "terminal",
      executionRef: "attempt-0#1.2",
      executionStatus: "success",
      output: "second-era-output",
    });
  });

  // 旧数据退化 C：缺少 attemptId 的 aggregation.finished 仍归到 aggregator。
  it("legacy aggregation.finished without attemptId still resolves the aggregator", () => {
    const legacyAgg = {
      kind: "aggregation.finished",
      version: 1,
      status: "success",
      output: "legacy-agg",
      exitCode: 0,
      durationMs: 3,
    };
    const records = [started, finished("attempt-0", "success"), legacyAgg];
    const res = resolveAttemptExecution({ records, attemptId: "aggregator", ...RUN_OVER });
    expect(res).toMatchObject({
      kind: "terminal",
      executionRef: "aggregator#1.1",
      output: "legacy-agg",
    });
  });

  // 损坏/缺失 started：身份无法恢复 → unavailable + 哨兵 ref。
  it("returns unavailable with a sentinel ref when no started record exists", () => {
    const res = resolveAttemptExecution({
      records: [finished("attempt-0", "success")],
      attemptId: "attempt-0",
      ...RUN_OVER,
    });
    expect(res).toMatchObject({
      kind: "unavailable",
      reason: "no-started-record",
      executionRef: "attempt-0#0.0",
      role: null,
    });
  });

  it("returns unknown-attempt for ids outside the started roster", () => {
    const res = resolveAttemptExecution({
      records: [started],
      attemptId: "attempt-9",
      ...RUN_ACTIVE,
    });
    expect(res).toEqual({ kind: "unknown-attempt" });
  });

  // ideate 名册（proposals/debates + aggregator）同样可解析，且恒为第 1 代。
  it("resolves ideate rosters without any resume generation", () => {
    const ideateStarted = {
      kind: "ideate.started",
      version: 1,
      runId: "ck-ideate-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      startedAt: "t",
      idea: "idea",
      background: "",
      debateRounds: 0,
      proposals: [
        {
          attemptId: "attempt-0",
          agentId: "a",
          agentName: "A",
          driverId: "kimi-stream-json",
          modelId: "k",
          stage: "proposal",
          round: 0,
          proposalRef: "p0",
        },
      ],
      debates: [],
      aggregator: {
        attemptId: "aggregator",
        agentId: "b",
        agentName: "B",
        driverId: "kimi-stream-json",
        modelId: "k",
        stage: "aggregate",
        round: 0,
        proposalRef: "p0",
      },
      configuredModels: [],
    };
    const res = resolveAttemptExecution({
      records: [ideateStarted],
      attemptId: "attempt-0",
      liveStatus: "queued",
      runActive: true,
    });
    expect(res).toMatchObject({ kind: "inflight", executionRef: "attempt-0#1.1" });
  });

  // 幂等：同一输入重复解析结果一致（原子重写/append 后语义稳定的前提）。
  it("is deterministic for the same record order", () => {
    const records = [started, finished("attempt-0", "success", { output: "x" })];
    const a = resolveAttemptExecution({ records, attemptId: "attempt-0", ...RUN_OVER });
    const b = resolveAttemptExecution({ records, attemptId: "attempt-0", ...RUN_OVER });
    expect(a).toEqual(b);
  });
});
