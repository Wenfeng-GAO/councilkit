import { fetchAttemptResult } from "@/lib/attempt-result";
import type { CliRunAttemptResultResponse } from "@shared/runtime/schemas";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { WorkbenchAttempt } from "./selection";

/** 终态 availability=pending 的有限自动重试：最多 2 次，间隔退避（2s → 4s）。 */
export const RESULT_PENDING_MAX_RETRIES = 2;
const RESULT_PENDING_BACKOFF_MS = [2000, 4000] as const;

const TERMINAL = new Set(["success", "failure", "cancelled"]);

/**
 * 当前执行的 durable 结果（B1 result 端点）。
 * - 非终态：2s 轮询（TanStack refetchInterval，query 层单请求语义）。
 * - 终态：停轮询，数据缓存于 query cache（切席往返不重新读取）。
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
  const [retryBudget, setRetryBudget] = useState<{ id: string; left: number }>({
    id: attemptKey,
    left: RESULT_PENDING_MAX_RETRIES,
  });
  // 席位身份变化在渲染期重置重试预算（React 认可的 adjust-state-during-render 模式）。
  if (retryBudget.id !== attemptKey) {
    setRetryBudget({ id: attemptKey, left: RESULT_PENDING_MAX_RETRIES });
  }
  const retriesLeft = retryBudget.left;

  const query = useQuery({
    queryKey: ["cli-run-attempt-result", runId, attemptKey],
    queryFn: ({ signal }) => fetchAttemptResult({ runId, attemptId: attemptKey, signal }),
    enabled: attemptKey.length > 0,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: (current) => {
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
      setRetryBudget({ id: attemptKey, left: RESULT_PENDING_MAX_RETRIES });
      void refetch();
    },
  };
}
