import type { CliRunAttemptResultResponse } from "@shared/runtime/schemas";
import type { WorkbenchAttempt } from "./selection";

/**
 * 席位详情的纯函数模型（B2 状态机 + 轮询纪律 + 跟随计数），与 React 解耦，
 * 单测覆盖见 tests/unit/workbench-seat-detail.test.ts。
 */

/** 过程活动行窗口：DOM 只渲染最近 WINDOW_LINES 行折叠活动，更早的行经入口分段加载。 */
export const PROCESS_WINDOW_LINES = 200;
/** 分段扩展步长：每次「显示更早」多渲染的行数（DOM 中活动行任何时候有界）。 */
export const PROCESS_WINDOW_STEP = PROCESS_WINDOW_LINES;
/** 单席过程原始事件缓存预算（原始 JSON 字节）：接近 Host 侧 2 MiB 保存上限并留余量。 */
export const PROCESS_CACHE_BUDGET_BYTES = 2.5 * 1024 * 1024;
/** 常规轮询间隔（与 detail/live 既有 POLL_MS 一致）。 */
export const PROCESS_POLL_MS = 2000;
/** 错误退避封顶（2s → 4s → 8s → 16s → 30s）。 */
export const PROCESS_MAX_BACKOFF_MS = 30_000;

/** 错误退避序列：failures=1 → 4s，随后翻倍，封顶 30s；成功由调用方重置 failures=0 回到 2s。 */
export function nextPollDelayMs(failures: number, baseMs = PROCESS_POLL_MS): number {
  if (failures <= 0) return baseMs;
  const delay = baseMs * 2 ** failures;
  return Math.min(PROCESS_MAX_BACKOFF_MS, delay);
}

/** 服务端游标重置检测：返回的 nextSeq 小于本地已应用游标 → 缓存重建、从头重读。 */
export function isCursorReset(appliedNextSeq: number, serverNextSeq: number): boolean {
  return serverNextSeq < appliedNextSeq;
}

/** AC-03：迟到响应检测。轮询回调 capture 当时的 requestSeq；代次变了即迟到，一律丢弃。 */
export function isStaleResponse(capturedSeq: number, currentSeq: number): boolean {
  return capturedSeq !== currentSeq;
}

/**
 * 分段窗口（容量）：总 folded 行数 total 只渲染最近 visibleCount 行；
 * 「显示更早」每次 +PROCESS_WINDOW_STEP，DOM 活动行任何时候有界。
 */
export function chunkedWindow(
  total: number,
  visibleCount: number,
): { hiddenCount: number; fromIndex: number } {
  const hiddenCount = Math.max(0, total - visibleCount);
  return { hiddenCount, fromIndex: hiddenCount };
}

/**
 * 跟随计数（INTERACTION-SPEC §4.2）：N 按 fold 后的稳定活动行数差值计，
 * 不按字符/delta —— 向同一活动追加字符不改变行数，N 不增加。
 * baseline = 暂停跟随时记住的活动行数；current = 当前活动总行数。
 */
export function newActivityCount(baseline: number, currentFoldedLines: number): number {
  return Math.max(0, currentFoldedLines - baseline);
}

/** 报告 Tab 首屏表达（INTERACTION-SPEC §3 三轴表 → WORKSPACE-STATES §2 状态 02/04）。 */
export type SeatReportView =
  | { kind: "running"; lastActivity: string | null }
  | { kind: "reading" }
  | { kind: "available"; markdown: string }
  | { kind: "empty" }
  | { kind: "failure"; message: string }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

const LIVE_STATUSES = new Set(["pending", "queued", "running"]);

export function seatReportView(input: {
  attempt: Pick<
    WorkbenchAttempt,
    | "status"
    | "lastActivity"
    | "durationMs"
    | "requestedModelId"
    | "observedModelId"
    | "modelId"
    | "driverId"
  >;
  /** null = 尚未取到（首次加载或读取失败）。 */
  result: CliRunAttemptResultResponse | null;
  /** 最近一次读取是否失败（result 为缓存值时为 false）。 */
  lastFetchFailed: boolean;
  /** 终态 availability=pending 的有限自动重试剩余次数。 */
  retriesLeft: number;
}): SeatReportView {
  const { attempt, result } = input;
  const execStatus = result?.executionStatus ?? attempt.status;

  // 执行未完成（running 轴）：当前动作 + 提示切过程，不展示假报告状态。
  if (LIVE_STATUSES.has(execStatus)) {
    const activity = attempt.lastActivity?.trim() ?? null;
    return { kind: "running", lastActivity: activity && activity.length > 0 ? activity : null };
  }

  // 终态，结果未取到：读取失败给 unavailable（手动重读可用），否则按有限重试给 reading。
  if (result === null) {
    return input.lastFetchFailed ? { kind: "unavailable" } : { kind: "reading" };
  }

  switch (result.availability) {
    case "pending":
      // 终态但落盘未就绪：有限重试；穷尽后诚实降级，不永久转圈。
      return input.retriesLeft > 0 ? { kind: "reading" } : { kind: "unavailable" };
    case "available":
      return { kind: "available", markdown: result.markdown ?? "" };
    case "empty":
      return { kind: "empty" };
    case "unavailable":
      if (execStatus === "failure") {
        return {
          kind: "failure",
          message: result.failure?.message?.trim() || "未记录详细原因",
        };
      }
      if (execStatus === "cancelled") return { kind: "cancelled" };
      // success 但正文损坏/无记录（含哨兵 ref #0.0）：有限语义，不回退旧成功。
      return { kind: "unavailable" };
  }
}
