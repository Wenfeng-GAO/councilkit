/**
 * Designer copy for an interrupted report (B4, #279 / #339), shared by the
 * browser card and the `councilkit run` CLI so both say the same thing.
 * Durations follow the limit that actually fired (`limitMs` on the error, or
 * the Host's configured limit) through formatLimitZh.
 *
 * Review runs that lose their local execution service use a separate card
 * (`EXECUTION_SERVICE_INTERRUPTION`). That copy is not a report-generation code.
 */
import {
  GENERATION_TIMEOUTS,
  driverToolName,
  formatLimitEn,
  formatLimitZh,
} from "./generation-timeouts";

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

export const REPORT_INTERRUPTION_CODES = [
  "INTERRUPTED_UNKNOWN",
  "SAFE_INTERRUPTION",
  "STREAM_IDLE_TIMEOUT",
  "ONESHOT_TIMEOUT",
  "DRIVER_CRASH",
] as const;
export type ReportInterruptionCode = (typeof REPORT_INTERRUPTION_CODES)[number];

export function isReportInterruptionCode(code: string | null | undefined): boolean {
  return (REPORT_INTERRUPTION_CODES as readonly string[]).includes(code ?? "");
}

export interface InterruptionCopyInput {
  code: string;
  /** Driver of the reporter seat; names the tool in the detail line. */
  driverId?: string | null;
  /** The limit that fired; falls back to the default for the code. */
  limitMs?: number | null;
}

export interface InterruptionCopy {
  title: string;
  detail: string;
}

/** Title + Chinese 详情 for an interruption code, or null for other codes. */
export function reportInterruptionCopy(input: InterruptionCopyInput): InterruptionCopy | null {
  const tool = driverToolName(input.driverId) ?? "模型";
  const limit = (fallback: number) =>
    formatLimitZh(input.limitMs && input.limitMs > 0 ? input.limitMs : fallback);
  switch (input.code) {
    case "INTERRUPTED_UNKNOWN":
      return {
        title: "报告生成被中断（可能关闭了页面）",
        detail: "刷新后找不到这次生成的结果。",
      };
    case "SAFE_INTERRUPTION":
      return {
        title: "报告生成被中断（本地执行服务重启或断开）",
        detail: "和本地执行服务的连接断了，这次生成没有完成。",
      };
    case "STREAM_IDLE_TIMEOUT": {
      const d = limit(GENERATION_TIMEOUTS.streamIdleMs);
      return {
        title: `报告生成被中断（模型 ${d}没有输出）`,
        detail: `模型超过 ${d}没有任何输出。`,
      };
    }
    case "ONESHOT_TIMEOUT": {
      const d = limit(GENERATION_TIMEOUTS.oneshotMs);
      return {
        title: `报告生成被中断（模型 ${d}没有写完）`,
        detail: `${tool} 超过 ${d}没有返回结果。`,
      };
    }
    case "DRIVER_CRASH":
      return {
        title: "报告生成被中断（模型进程意外退出）",
        detail: `${tool} 在写完报告前退出了。`,
      };
    default:
      return null;
  }
}

/** The small grey line under 「生成中」 for one-shot tools. */
export function oneShotGeneratingNote(
  driverId: string | null | undefined,
  limitMs: number = GENERATION_TIMEOUTS.oneshotMs,
  lang: "zh" | "en" = "zh",
): string {
  if (lang === "en") {
    const tool = driverToolName(driverId) ?? "The model";
    return `${tool} returns the report all at once when it finishes; nothing streams in between. Waits up to ${formatLimitEn(limitMs)}.`;
  }
  const tool = driverToolName(driverId) ?? "模型";
  return `${tool} 写完后会一次性给出报告，中途不会逐字显示，最长等 ${formatLimitZh(limitMs)}。`;
}

/** The CLI lost its event stream to the Host mid-turn (the Host restarted or
 * went away): `RUNTIME_UNAVAILABLE` in the stream phase. Same card as the
 * page's SAFE_INTERRUPTION (#351). */
export function isHostDisconnectFailure(failure: { code: string; phase?: string }): boolean {
  return failure.code === "RUNTIME_UNAVAILABLE" && failure.phase === "stream";
}

/** Card copy for a CLI run failure, or null unless the report turn was cut
 * off by one of the interruption codes or a Host disconnect. */
export function reportFailureCopy(failure: {
  code: string;
  phase?: string;
  role?: string;
  driverId?: string;
  limitMs?: number;
}): InterruptionCopy | null {
  if (failure.role !== "report") return null;
  const code = isHostDisconnectFailure(failure) ? "SAFE_INTERRUPTION" : failure.code;
  return reportInterruptionCopy({ ...failure, code });
}

/** One-line CLI form of the card (`councilkit run`), same wording as the UI:
 * 「报告生成被中断（模型 10 分钟没有写完）：Kimi 超过 10 分钟没有返回结果。」.
 * Null unless the report turn was cut off by one of the interruption codes. */
export function reportInterruptionLine(failure: {
  code: string;
  phase?: string;
  role?: string;
  driverId?: string;
  limitMs?: number;
}): string | null {
  const copy = reportFailureCopy(failure);
  return copy ? `${copy.title}：${copy.detail}` : null;
}
