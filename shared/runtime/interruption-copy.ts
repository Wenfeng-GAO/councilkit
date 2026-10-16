/** Copy for a review that lost its local execution service. One source for every surface. */
export const EXECUTION_SERVICE_INTERRUPTION = {
  title: "审查被中断（本地执行服务重启或断开）",
  detail: "和本地执行服务的连接断了，这次审查没有完成。",
  primaryAction: "只再审一遍（不改代码）",
  secondaryAction: "返回报告列表",
} as const;

/** Shown when 只再审一遍 is refused because the previous review process is still alive. */
export const REVIEW_STILL_RUNNING_REASON = "上一次审查还在运行";

export const RE_REVIEW_STARTING_LABEL = "正在启动复审…";

export function reReviewStartFailure(reason: string): string {
  return `复审没有启动：${reason}。可以再试一次。`;
}

/**
 * A review the index marked interrupted because nothing finished it.
 * A recorded review.finished interruption has endedAt and keeps the short label.
 */
export function isLostExecutionReview(run: {
  kind: string;
  status: string;
  endedAt?: string | null;
}): boolean {
  return run.kind === "review" && run.status === "interrupted" && (run.endedAt ?? null) === null;
}
