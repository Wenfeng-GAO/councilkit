import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { FindingLedger } from "@/components/report/FindingLedger";
import { ReviewReportView } from "@/components/report/ReviewReportView";
import { reviewOverviewHeading } from "@/lib/cli-run-status";
import type { AgainstLedgerState } from "@/lib/finding-list";
import type { ParsedReviewReport } from "@/lib/review-report";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";
import { ChevronRightIcon, CircleHelpIcon, Clock3Icon, STATUS_ICONS } from "./icons";

const ATTEMPT_TERMINAL = new Set(["success", "failure", "cancelled"]);

const VERDICT_LABEL: Record<NonNullable<ParsedReviewReport["verdict"]>, string> = {
  approve: "Approve",
  "changes-requested": "Changes requested",
  comment: "Comment",
};

/**
 * 本轮总览主内容：审查结论与简短概览 → 统一问题清单 → 可展开原始汇总报告。
 * 执行完成写「审查已完成」，不暗示问题已解决。
 */
export function OverviewView({
  run,
  parsed,
  hasRepair,
  onOpenRepair,
  againstState = { status: "none" },
}: {
  run: CliRunDetailResponse;
  parsed: ParsedReviewReport | null;
  hasRepair: boolean;
  onOpenRepair: () => void;
  againstState?: AgainstLedgerState;
}) {
  const heading = reviewOverviewHeading(run);
  const seats = run.progress?.attempts.filter((row) => row.role === "attempt") ?? [];
  const doneSeats = seats.filter((row) => ATTEMPT_TERMINAL.has(row.status)).length;
  const partial = seats.length > 0 && doneSeats < seats.length;
  const aggregator = run.progress?.attempts.find((row) => row.role === "aggregator") ?? null;
  const aggregatorLive =
    aggregator !== null && !ATTEMPT_TERMINAL.has(aggregator.status) && run.status === "running";
  const hasMarkdown = run.markdown.trim().length > 0;
  const StatusIcon = STATUS_ICONS[aggregator?.status ?? "pending"] ?? CircleHelpIcon;
  const overview = parsed?.sections.find((section) => section.title === "概览");
  const disagreement = parsed?.sections.find((section) => section.title === "分歧");
  const overviewBody = [parsed?.preface, overview?.body]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join("\n\n");

  return (
    <article className="ck-wb-document">
      <h1>{heading}</h1>
      <p className="ck-wb-report-meta">
        {seats.length > 0 ? (
          <span>
            {doneSeats}/{seats.length} 席位已完成
          </span>
        ) : null}
        {run.truncated ? <span>报告超过 2MB，已截断显示</span> : null}
      </p>
      {parsed?.verdict ? (
        <p
          className={`ck-verdict ck-verdict-${verdictClass(parsed.verdict)} ck-wb-overview-verdict`}
        >
          {VERDICT_LABEL[parsed.verdict]}
        </p>
      ) : null}
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
      {overviewBody ? (
        <section className="ck-wb-overview-brief" aria-label="审查概览">
          <h2>概览</h2>
          <SafeMarkdown className="text-sm" variant="document" content={overviewBody} />
        </section>
      ) : null}
      <FindingLedger run={run} againstState={againstState} />
      {disagreement && disagreement.body.trim().length > 0 ? (
        <details className="ck-wb-history ck-wb-disagreements">
          <summary>
            <strong>分歧</strong>
            <span>查看审查者之间的不同意见</span>
          </summary>
          <SafeMarkdown className="text-sm" variant="document" content={disagreement.body} />
        </details>
      ) : null}
      <section aria-label="原始汇总报告">
        <details className="ck-wb-history ck-wb-source-report">
          <summary>
            <strong>原始汇总报告</strong>
            <span>完整共识、独有、附录与席位摘要</span>
          </summary>
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
        </details>
      </section>
    </article>
  );
}

function verdictClass(verdict: NonNullable<ParsedReviewReport["verdict"]>): string {
  if (verdict === "changes-requested") return "changes";
  return verdict;
}
