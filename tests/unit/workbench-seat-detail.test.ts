import {
  isCursorReset,
  newActivityCount,
  nextPollDelayMs,
  seatReportView,
} from "@/components/report/workbench/seatDetailModel";
import { foldLiveEvents, foldLiveEventsAppend } from "@/lib/live-transcript";
import type {
  AttemptLiveEvent,
  AttemptLiveEventPayload,
} from "@shared/runtime/attempt-live-events";
import type { CliRunAttemptResultResponse } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

describe("nextPollDelayMs 错误退避", () => {
  it("2s → 4s → 8s → 16s → 30s 封顶", () => {
    expect(nextPollDelayMs(0)).toBe(2000);
    expect(nextPollDelayMs(1)).toBe(4000);
    expect(nextPollDelayMs(2)).toBe(8000);
    expect(nextPollDelayMs(3)).toBe(16000);
    expect(nextPollDelayMs(4)).toBe(30000);
    expect(nextPollDelayMs(9)).toBe(30000);
  });
});

describe("isCursorReset 游标重置检测", () => {
  it("服务端 nextSeq 小于本地已应用游标视为重置", () => {
    expect(isCursorReset(5, 3)).toBe(true);
    expect(isCursorReset(5, 0)).toBe(true);
    expect(isCursorReset(5, 5)).toBe(false);
    expect(isCursorReset(5, 8)).toBe(false);
    expect(isCursorReset(0, 0)).toBe(false);
  });
});

describe("newActivityCount 按稳定活动行计数", () => {
  it("只认 fold 后行数差值：向同一活动追加字符不增加 N", () => {
    // 暂停时 10 行；同一 text 活动追加字符后仍是 10 行。
    expect(newActivityCount(10, 10)).toBe(0);
    // 新增一个活动行 → N=1；再来一个 → N=2。
    expect(newActivityCount(10, 11)).toBe(1);
    expect(newActivityCount(10, 12)).toBe(2);
    // 回退/淘汰导致行数变少时不出现负数。
    expect(newActivityCount(10, 8)).toBe(0);
    expect(newActivityCount(0, 0)).toBe(0);
  });
});

function result(overrides: Partial<CliRunAttemptResultResponse>): CliRunAttemptResultResponse {
  return {
    runId: "ck-run-1",
    attemptId: "attempt-0",
    executionRef: "attempt-0#1.1",
    executionStatus: "success",
    availability: "available",
    markdown: "# 报告",
    truncated: false,
    failure: null,
    reusedFrom: null,
    ...overrides,
  };
}

const attempt = (status: string, lastActivity: string | null = null) => ({
  status: status as "pending" | "queued" | "running" | "success" | "failure" | "cancelled",
  lastActivity,
  durationMs: 1000,
  requestedModelId: null,
  observedModelId: null,
  modelId: "m",
  driverId: "d",
});

describe("seatReportView B2 状态机（INTERACTION-SPEC §3 三轴）", () => {
  it("执行未完成 → running（带当前活动）", () => {
    expect(
      seatReportView({
        attempt: attempt("running", "git diff"),
        result: null,
        lastFetchFailed: false,
        retriesLeft: 1,
      }),
    ).toEqual({ kind: "running", lastActivity: "git diff" });
    const runningResult = result({ executionStatus: "running", availability: "pending" });
    expect(
      seatReportView({
        attempt: attempt("running"),
        result: runningResult,
        lastFetchFailed: false,
        retriesLeft: 1,
      }),
    ).toEqual({ kind: "running", lastActivity: null });
  });

  it("success + available → 正常阅读态", () => {
    expect(
      seatReportView({
        attempt: attempt("success"),
        result: result({}),
        lastFetchFailed: false,
        retriesLeft: 1,
      }),
    ).toEqual({ kind: "available", markdown: "# 报告" });
  });

  it("success + empty → 空输出态（不等同零发现）", () => {
    expect(
      seatReportView({
        attempt: attempt("success"),
        result: result({ availability: "empty", markdown: null }),
        lastFetchFailed: false,
        retriesLeft: 1,
      }),
    ).toEqual({ kind: "empty" });
  });

  it("failure → 失败态带已记录原因；无原因给保守文案", () => {
    expect(
      seatReportView({
        attempt: attempt("failure"),
        result: result({
          executionStatus: "failure",
          availability: "unavailable",
          markdown: null,
          failure: { code: "EXIT", message: "exit 1" },
        }),
        lastFetchFailed: false,
        retriesLeft: 1,
      }),
    ).toEqual({ kind: "failure", message: "exit 1" });
    expect(
      seatReportView({
        attempt: attempt("failure"),
        result: result({
          executionStatus: "failure",
          availability: "unavailable",
          markdown: null,
          failure: null,
        }),
        lastFetchFailed: false,
        retriesLeft: 1,
      }),
    ).toEqual({ kind: "failure", message: "未记录详细原因" });
  });

  it("cancelled → 已取消", () => {
    expect(
      seatReportView({
        attempt: attempt("cancelled"),
        result: result({
          executionStatus: "cancelled",
          availability: "unavailable",
          markdown: null,
        }),
        lastFetchFailed: false,
        retriesLeft: 1,
      }),
    ).toEqual({ kind: "cancelled" });
  });

  it("success 但正文损坏/无记录 → unavailable（不回退旧成功）", () => {
    expect(
      seatReportView({
        attempt: attempt("success"),
        result: result({ availability: "unavailable", markdown: null }),
        lastFetchFailed: false,
        retriesLeft: 1,
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("终态结果未取到：读取失败 → unavailable；仍在读 → reading", () => {
    expect(
      seatReportView({
        attempt: attempt("success"),
        result: null,
        lastFetchFailed: true,
        retriesLeft: 1,
      }),
    ).toEqual({ kind: "unavailable" });
    expect(
      seatReportView({
        attempt: attempt("success"),
        result: null,
        lastFetchFailed: false,
        retriesLeft: 1,
      }),
    ).toEqual({ kind: "reading" });
  });

  it("终态 availability=pending：有限重试内 reading，穷尽 unavailable（不永久转圈）", () => {
    const pending = result({ availability: "pending", markdown: null });
    expect(
      seatReportView({
        attempt: attempt("success"),
        result: pending,
        lastFetchFailed: false,
        retriesLeft: 2,
      }),
    ).toEqual({ kind: "reading" });
    expect(
      seatReportView({
        attempt: attempt("success"),
        result: pending,
        lastFetchFailed: false,
        retriesLeft: 0,
      }),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("foldLiveEventsAppend 增量折叠等价性", () => {
  const ev = (seq: number, payload: AttemptLiveEventPayload): AttemptLiveEvent => ({
    seq,
    at: `2026-09-21T00:00:${String(seq).padStart(2, "0")}Z`,
    ...payload,
  });

  const head: AttemptLiveEvent[] = [
    ev(1, { type: "text.delta", text: "第一段" }),
    ev(2, { type: "text.delta", text: "续写" }),
    ev(3, { type: "tool.started", name: "shell", summary: "pnpm test" }),
  ];
  const tail: AttemptLiveEvent[] = [
    ev(4, { type: "tool.completed", name: "shell", summary: "pnpm test" }),
    ev(5, { type: "text.delta", text: "第二段" }),
    ev(6, { type: "truncated", dropped: 3 }),
  ];

  it("分段折叠与整体折叠结果一致（含跨边界的工具配对与 delta 合并）", () => {
    expect(foldLiveEventsAppend(foldLiveEvents(head), tail)).toEqual(
      foldLiveEvents([...head, ...tail]),
    );
  });

  it("空追加不改变已有折叠", () => {
    const folded = foldLiveEvents(head);
    expect(foldLiveEventsAppend(folded, [])).toEqual(folded);
  });
});
