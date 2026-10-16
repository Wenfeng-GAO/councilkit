/** Copy for a review that lost its local execution service. One source for every surface. */
export const EXECUTION_SERVICE_INTERRUPTION = {
  title: "审查被中断（本地执行服务重启或断开）",
  detail: "和本地执行服务的连接断了，这次审查没有完成。",
  primaryAction: "只再审一遍（不改代码）",
  secondaryAction: "返回报告列表",
} as const;

/** Streaming seats: this long with no output → interrupt. */
export const STREAM_SILENCE_MS = 2 * 60 * 1000;
/** One-shot seats (grok, kimi, cursor): this long unfinished → interrupt. */
export const ONESHOT_UNFINISHED_MS = 10 * 60 * 1000;

export const ONESHOT_DRIVER_IDS = [
  "grok-stream-json",
  "kimi-stream-json",
  "cursor-stream-json",
] as const;

export const INTERRUPTION_CODES = [
  "IDLE_TIMEOUT",
  "UNFINISHED",
  "PROCESS_CRASH",
  "DRIVER_DRIFT",
] as const;

export type InterruptionCode = (typeof INTERRUPTION_CODES)[number];

export const INCOMPLETE_CONCLUSION_LABEL = "结论不完整";
export const BLOCKING_ZERO_INCOMPLETE = "未发现阻塞项（结论不完整）";
export const REAGGREGATE_ACTION = "只重跑汇总";
export const REAGGREGATE_BUSY = "重跑汇总进行中…";

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

export function isOneshotDriver(driverId: string): boolean {
  return (ONESHOT_DRIVER_IDS as readonly string[]).includes(driverId);
}

/** Silence budget for streaming drivers; hard unfinished budget for one-shot drivers. */
export function interruptionBudget(driverId: string): {
  silenceMs: number | null;
  unfinishedMs: number | null;
} {
  if (isOneshotDriver(driverId)) return { silenceMs: null, unfinishedMs: ONESHOT_UNFINISHED_MS };
  return { silenceMs: STREAM_SILENCE_MS, unfinishedMs: null };
}

export function isInterruptionCode(code: string | null | undefined): code is InterruptionCode {
  return (
    code === "IDLE_TIMEOUT" ||
    code === "UNFINISHED" ||
    code === "PROCESS_CRASH" ||
    code === "DRIVER_DRIFT"
  );
}

/** Short tool name used inside the designer strings. grok-stream-json → grok. */
export function toolDisplayName(driverId: string): string {
  switch (driverId) {
    case "grok-stream-json":
      return "grok";
    case "kimi-stream-json":
      return "kimi";
    case "cursor-stream-json":
      return "cursor";
    case "claude-stream-json":
      return "claude";
    case "codex-app-server":
      return "codex";
    default:
      return driverId;
  }
}

/** Reason enum, verbatim. Drift keeps the space before 可执行文件. */
export function interruptionReason(code: InterruptionCode, tool?: string): string {
  switch (code) {
    case "IDLE_TIMEOUT":
      return `${STREAM_SILENCE_MS / 60_000} 分钟没有输出`;
    case "UNFINISHED":
      return `${ONESHOT_UNFINISHED_MS / 60_000} 分钟没有写完`;
    case "PROCESS_CRASH":
      return "进程意外退出";
    case "DRIVER_DRIFT":
      return `${tool && tool.length > 0 ? tool : "驱动"} 可执行文件在运行中被更新`;
  }
}

export function incompleteBanner(interruptedSeats: number): string {
  return `结论不完整：${interruptedSeats} 路审查没有完成`;
}

export function seatInterruptionLine(seat: string, tool: string, reason: string): string {
  return `${seat}（${tool}）：${reason}。`;
}

export function incompleteClosing(completedSeats: number): string {
  return `这份报告只汇总了其余 ${completedSeats} 路的结果，缺的这几路负责查的问题可能没被发现。`;
}

export function seatCountLabel(completed: number, total: number): string {
  const missing = Math.max(0, total - completed);
  const base = `${completed}/${total} 席位已完成`;
  return missing > 0 ? `${base}（缺 ${missing} 路）` : base;
}

export function aggregationInterruptedHeading(): string {
  return "审查未完成（汇总中断）";
}

export function seatsInterruptedHeading(interruptedSeats: number): string {
  return `审查未完成（${interruptedSeats} 路席位中断）`;
}

/** Designer card for an aggregator stopped because the driver binary changed. */
export function driftAggregationCard(tool: string, completedSeats: number) {
  return {
    title: `审查汇总被中断（${tool}在运行中被更新）`,
    detail: `${tool}的程序在审查过程中被更新了，为了安全，汇总没有换用新版本接着跑。已完成的 ${completedSeats} 路审查结果都还在，可以直接查看。`,
    primaryAction: REAGGREGATE_ACTION,
    secondaryAction: EXECUTION_SERVICE_INTERRUPTION.secondaryAction,
    hint: `用已完成的 ${completedSeats} 路结果，以当前安装的${tool}重新汇总，不会重跑审查。`,
  } as const;
}

export interface ReviewAttemptInterrupt {
  role: string;
  status: string;
  agentName: string;
  driverId: string;
  failureCode?: string;
}

export type ReviewInterruption =
  | {
      kind: "aggregation";
      code: InterruptionCode;
      driverId: string;
      tool: string;
      completedSeats: number;
      drift: boolean;
      heading: string;
    }
  | {
      kind: "seats";
      heading: string;
      interrupted: Array<{ seat: string; tool: string; reason: string; line: string }>;
      completedSeats: number;
      totalSeats: number;
      banner: string;
      closing: string;
    };

/**
 * Seat or aggregator interruption already recorded on the run.
 * A lost execution (no endedAt) keeps its own card. A live or completed run stays that way.
 */
export function reviewInterruptionOf(run: {
  kind: string;
  status: string;
  endedAt?: string | null;
  progress?: { attempts?: readonly ReviewAttemptInterrupt[] } | null;
}): ReviewInterruption | null {
  if (run.kind !== "review") return null;
  if (
    run.status === "running" ||
    run.status === "awaiting_orchestrator" ||
    run.status === "completed"
  ) {
    return null;
  }
  if (isLostExecutionReview(run)) return null;
  const attempts = run.progress?.attempts ?? [];
  const seats = attempts.filter((row) => row.role === "attempt");
  const aggregator = attempts.find((row) => row.role === "aggregator");
  const completedSeats = seats.filter((row) => row.status === "success").length;
  if (aggregator && isInterruptionCode(aggregator.failureCode)) {
    const tool = toolDisplayName(aggregator.driverId);
    return {
      kind: "aggregation",
      code: aggregator.failureCode,
      driverId: aggregator.driverId,
      tool,
      completedSeats,
      drift: aggregator.failureCode === "DRIVER_DRIFT",
      heading: aggregationInterruptedHeading(),
    };
  }
  const interrupted = seats.flatMap((row) => {
    if (!isInterruptionCode(row.failureCode)) return [];
    const tool = toolDisplayName(row.driverId);
    const reason = interruptionReason(row.failureCode, tool);
    return [
      {
        seat: row.agentName,
        tool,
        reason,
        line: seatInterruptionLine(row.agentName, tool, reason),
      },
    ];
  });
  if (interrupted.length === 0) return null;
  return {
    kind: "seats",
    heading: seatsInterruptedHeading(interrupted.length),
    interrupted,
    completedSeats,
    totalSeats: seats.length,
    banner: incompleteBanner(interrupted.length),
    closing: incompleteClosing(completedSeats),
  };
}
