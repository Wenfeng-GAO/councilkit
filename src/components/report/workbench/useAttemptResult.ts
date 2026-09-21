import { fetchAttemptResult } from "@/lib/attempt-result";
import type { CliRunAttemptResultResponse } from "@shared/runtime/schemas";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { WorkbenchAttempt } from "./selection";

/** 终态 availability=pending 的有限自动重试：最多 2 次，间隔退避（2s → 4s）。 */
export const RESULT_PENDING_MAX_RETRIES = 2;
const RESULT_PENDING_BACKOFF_MS = [2000, 4000] as const;

const TERMINAL = new Set(["success", "failure", "cancelled"]);
const LIVE = new Set(["pending", "queued", "running"]);

export interface ResultEpochState {
  id: string;
  epoch: number;
  /** 上一轮渲染时席位是否处于非终态（执行进行中）。 */
  wasLive: boolean;
}

/**
 * AC-02 执行代次（纯函数，可测）：progress 是「当前执行」的权威信号。
 * 席位从终态回到 pending/queued/running（resume/重跑）时，已缓存的旧终态结果
 * 在新执行下定义失效 → 代次 +1，旧缓存不再被引用（ TanStack gc 回收）。
 */
export function reduceResultEpoch(
  prev: ResultEpochState,
  attemptId: string,
  status: string,
): ResultEpochState {
  const live = LIVE.has(status);
  if (prev.id !== attemptId) {
    return { id: attemptId, epoch: 0, wasLive: live };
  }
  if (live === prev.wasLive) {
    return prev; // 无变化返回原对象，避免渲染期 adjust 触发无限重渲染
  }
  if (live) {
    return { id: attemptId, epoch: prev.epoch + 1, wasLive: true };
  }
  return { id: attemptId, epoch: prev.epoch, wasLive: false };
}

/**
 * 当前执行的 durable 结果（B1 result 端点）。
 * - 执行代次（epoch）进入 queryKey：resume/重跑后旧成功正文绝不显示为当前结果。
 * - 席位非终态：2s 轮询（以 progress 为准，不看缓存结果的 executionStatus）。
 * - 终态：停轮询；切席往返同代次内复用缓存。
 * - 终态 availability=pending：有限自动重试（最多 2 次、间隔退避），穷尽交回 UI 降级。
 */
export function useAttemptResult(
  runId: string,
  attempt: WorkbenchAttempt | null,
): {
  result: CliRunAttemptResultResponse | null;
  /** 终态 pending 的有限重试是否已穷尽。 */
  retriesExhausted: boolean;
  /** 最近一次读取失败且没有任何缓存值（报告轴独立降级，不影响过程轴）。 */
  lastFetchFailed: boolean;
  refetch: () => void;
} {
  const attemptKey = attempt?.attemptId ?? "";
  const status = attempt?.status ?? "success";
  const [epochState, setEpochState] = useState<ResultEpochState>({
    id: attemptKey,
    epoch: 0,
    wasLive: LIVE.has(status),
  });
  // 渲染期推进执行代次（React 认可的 adjust-state-during-render 模式）。
  const nextEpoch = reduceResultEpoch(epochState, attemptKey, status);
  if (nextEpoch !== epochState) setEpochState(nextEpoch);

  const [retryBudget, setRetryBudget] = useState<{ id: string; left: number }>({
    id: `${attemptKey}#0`,
    left: RESULT_PENDING_MAX_RETRIES,
  });
  // 席位身份或执行代次变化时重置重试预算（新执行重新获得有限重试）。
  const budgetKey = `${attemptKey}#${nextEpoch.epoch}`;
  if (retryBudget.id !== budgetKey) {
    setRetryBudget({ id: budgetKey, left: RESULT_PENDING_MAX_RETRIES });
  }
  const retriesLeft = retryBudget.left;

  const query = useQuery({
    queryKey: ["cli-run-attempt-result", runId, attemptKey, nextEpoch.epoch],
    queryFn: ({ signal }) => fetchAttemptResult({ runId, attemptId: attemptKey, signal }),
    enabled: attemptKey.length > 0,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: (current) => {
      // progress 权威：席位仍在执行就轮询；缓存里的旧终态结果不作数。
      if (attemptKey.length > 0 && LIVE.has(status)) return 2000;
      const data = current.state.data;
      if (!data) return false;
      return TERMINAL.has(data.executionStatus) ? false : 2000;
    },
  });

  const result = query.data ?? null;
  const { refetch } = query;
  const terminalPending =
    result !== null && TERMINAL.has(result.executionStatus) && result.availability === "pending";

  // 终态 pending：有限自动重试，不永久转圈。
  useEffect(() => {
    if (!terminalPending || retriesLeft <= 0) return;
    const delay = RESULT_PENDING_BACKOFF_MS[RESULT_PENDING_MAX_RETRIES - retriesLeft] ?? 4000;
    const timer = window.setTimeout(() => {
      setRetryBudget((budget) => ({ ...budget, left: budget.left - 1 }));
      void refetch();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [terminalPending, retriesLeft, refetch]);

  return {
    result,
    retriesExhausted: terminalPending && retriesLeft <= 0,
    lastFetchFailed: query.isError && query.data == null,
    refetch: () => {
      setRetryBudget({ id: budgetKey, left: RESULT_PENDING_MAX_RETRIES });
      void refetch();
    },
  };
}
