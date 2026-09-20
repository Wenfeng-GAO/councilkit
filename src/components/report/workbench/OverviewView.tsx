import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { FindingLedger } from "@/components/report/FindingLedger";
import { ReviewReportView } from "@/components/report/ReviewReportView";
import { primaryRunStatus } from "@/lib/cli-run-status";
import type { ParsedReviewReport } from "@/lib/review-report";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";
import { ChevronRightIcon, CircleHelpIcon, Clock3Icon, STATUS_ICONS } from "./icons";

const ATTEMPT_TERMINAL = new Set(["success", "failure", "cancelled"]);

/**
 * 本轮总览主内容（WORKSPACE-STATES 状态 01）：
 * Run 状态与席位完成计数 → 可靠账本（FindingLedger，数据不变）→ 汇总正文
 * （ReviewReportView/SafeMarkdown 渲染 run 级 markdown）。只展示 run 数据里真实存在的字段。
 */
export function OverviewView({
  run,
  parsed,
  hasRepair,
  onOpenRepair,
}: {
  run: CliRunDetailResponse;
  parsed: ParsedReviewReport | null;
  hasRepair: boolean;
  onOpenRepair: () => void;
}) {
  const status = primaryRunStatus(run);
  const seats = run.progress?.attempts.filter((row) => row.role === "attempt") ?? [];
  const doneSeats = seats.filter((row) => ATTEMPT_TERMINAL.has(row.status)).length;
  const partial = seats.length > 0 && doneSeats < seats.length;
  const aggregator = run.progress?.attempts.find((row) => row.role === "aggregator") ?? null;
  const aggregatorLive =
    aggregator !== null && !ATTEMPT_TERMINAL.has(aggregator.status) && run.status === "running";
  const hasMarkdown = run.markdown.trim().length > 0;
  const StatusIcon = STATUS_ICONS[aggregator?.status ?? "pending"] ?? CircleHelpIcon;

  return (
    <article className="ck-wb-document">
      <h1>{status.text}</h1>
      <p className="ck-wb-report-meta">
        {seats.length > 0 ? (
          <span>
            {doneSeats}/{seats.length} 席位已完成
          </span>
        ) : null}
        {run.truncated ? <span>报告超过 2MB，已截断显示</span> : null}
      </p>
      {partial ? (
        <p className="ck-wb-source">结果尚不完整 · 缺席或失败的席位不代表没有意见</p>
      ) : null}
      {hasRepair ? (
        <p className="ck-wb-source">
          <button type="button" className="ck-wb-ghost" onClick={onOpenRepair}>
            当前修复
            <ChevronRightIcon className="ck-wb-icon" />
          </button>
        </p>
      ) : null}
      <FindingLedger run={run} />
      <section aria-label="汇总正文">
        <h2>汇总正文</h2>
        {hasMarkdown ? (
          parsed ? (
            <ReviewReportView report={parsed} />
          ) : (
            <SafeMarkdown variant="document" content={run.markdown} />
          )
        ) : aggregatorLive ? (
          <p className="ck-wb-source">
            <StatusIcon className="ck-wb-icon ck-wb-icon-state ck-wb-running-icon" />
            正在汇总 · 已完成席位可直接阅读，无需等待汇总
          </p>
        ) : (
          <p className="ck-wb-source">
            <Clock3Icon className="ck-wb-icon ck-wb-icon-state" />
            汇总报告尚未生成
          </p>
        )}
      </section>
    </article>
  );
}
