import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { FindingLedger } from "@/components/report/FindingLedger";
import { ReviewReportView } from "@/components/report/ReviewReportView";
import { reviewOverviewHeading } from "@/lib/cli-run-status";
import {
  type AgainstLedgerState,
  type FindingListFilter,
  defaultFindingListFilter,
  projectFindingList,
} from "@/lib/finding-list";
import type { ParsedReviewReport } from "@/lib/review-report";
import { FULL_COMMIT_SHA } from "@shared/runtime/cli-ledger";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";
import { useState } from "react";
import { ChevronRightIcon, CircleHelpIcon, Clock3Icon, STATUS_ICONS } from "./icons";

const ATTEMPT_TERMINAL = new Set(["success", "failure", "cancelled"]);

const VERDICT_LABEL: Record<NonNullable<ParsedReviewReport["verdict"]>, string> = {
  approve: "建议通过（APPROVE）",
  "changes-requested": "要求修改（CHANGES REQUESTED）",
  comment: "有意见（COMMENT）",
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
  filter,
  onFilterChange,
}: {
  run: CliRunDetailResponse;
  parsed: ParsedReviewReport | null;
  hasRepair: boolean;
  onOpenRepair: () => void;
  againstState?: AgainstLedgerState;
  filter?: FindingListFilter;
  onFilterChange?: (filter: FindingListFilter) => void;
}) {
  const projection = projectFindingList(run.findings, {
    sha: run.reviewEvidence?.sha ?? null,
    groups: run.findingGroups,
  });
  const [internalFilter, setInternalFilter] = useState<FindingListFilter | null>(null);
  const effectiveFilter = filter ?? internalFilter ?? defaultFindingListFilter(projection);
  const handleFilterChange = (next: FindingListFilter) => {
    if (filter === undefined) setInternalFilter(next);
    onFilterChange?.(next);
  };
  const hasLedger = run.hasFindings || run.findings.length > 0;
  const ledgerComplete =
    run.reviewEvidence?.complete === true &&
    FULL_COMMIT_SHA.test(run.reviewEvidence.sha ?? "") &&
    run.reviewEvidence.evidenceComplete !== false;
  const decisionConflict =
    run.status === "completed" &&
    projection.blockingCount > 0 &&
    (parsed?.verdict === "approve" || parsed?.verdict === "comment");
  const heading = decisionConflict ? "审查结论待核对" : reviewOverviewHeading(run);
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
        {run.status === "completed" ? <span>审查执行已完成</span> : null}
        {seats.length > 0 ? (
          <span>
            {doneSeats}/{seats.length} 席位已完成
          </span>
        ) : null}
        {run.truncated ? <span>报告超过 2MB，已截断显示</span> : null}
      </p>
      {parsed?.verdict ? (
        <section className="ck-wb-review-decision" aria-label="审查结论">
          <p className="ck-wb-decision-verdict">
            <span>报告意见</span>
            <strong>{VERDICT_LABEL[parsed.verdict]}</strong>
          </p>
          <p>
            账本门禁：
            {hasLedger ? (
              <a className="ck-finding-list-link" href="#ck-ledger">
                {projection.blockingCount > 0
                  ? `${projection.blockingCount} 个阻塞问题，待处理`
                  : ledgerComplete
                    ? "账本无阻塞"
                    : "账本证据不完整，尚无法判断阻塞"}
              </a>
            ) : (
              "账本未生成，尚无法判断阻塞"
            )}
          </p>
          {decisionConflict ? (
            <p className="ck-wb-decision-conflict">
              报告意见与账本门禁尚未对齐。请核对问题的适用范围和处置依据，再判断是否可以通过。
            </p>
          ) : null}
          {parsed.verdict === "comment" ? (
            <p className="ck-finding-list-note">COMMENT 表示审查有意见，尚未给出通过建议。</p>
          ) : null}
        </section>
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
      <FindingLedger
        run={run}
        againstState={againstState}
        filter={effectiveFilter}
        onFilterChange={handleFilterChange}
      />
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
