import { cliRunPhaseHeading } from "@/lib/cli-run-status";
import { extractPrUrl } from "@/lib/fix-prompt";
import type { ParsedReviewReport } from "@/lib/review-report";
import { formatAttemptMs } from "@/lib/seat-inspector";
import { normalizeReviewPr } from "@shared/runtime/review-case";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";

export function ReviewRunHeader({
  run,
  verdict,
}: { run: CliRunDetailResponse; verdict: ParsedReviewReport["verdict"] }) {
  const seats = run.progress?.attempts.filter((row) => row.role === "attempt") ?? [];
  const elapsed =
    run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : null;
  const verdictLabel =
    verdict === "changes-requested" ? "需要修改" : verdict === "approve" ? "通过审查" : "审查意见";
  const pipeline = run.pipeline;
  const pipelineActive = pipeline !== null && pipeline.phase !== "done";
  const endedSeats = seats.filter(
    (row) => row.status === "success" || row.status === "failure" || row.status === "cancelled",
  ).length;
  const showSummary =
    run.status !== "running" ||
    pipelineActive ||
    run.hasReport ||
    (seats.length > 0 && endedSeats === seats.length);
  const prUrl = normalizeReviewPr(extractPrUrl(run.reviewEvidence?.prUrl ?? run.title));
  let title = run.title;
  if (prUrl) {
    const parts = new URL(prUrl).pathname.split("/").filter(Boolean);
    title = `${parts.slice(0, -2).join(" / ")} #${parts.at(-1)}`;
  }
  return (
    <header className="ck-review-run-header">
      <div className="ck-review-run-heading">
        <div>
          <p className="ck-review-eyebrow">PR 审查</p>
          <h1>{title}</h1>
        </div>
        {prUrl ? (
          <a href={prUrl} target="_blank" rel="noreferrer">
            打开 PR ↗
          </a>
        ) : null}
      </div>
      <p className="ck-review-run-description">
        {pipelineActive
          ? "本轮审查结果与当前修复进展分开查看。席位结论可单独打开，不必等修复结束。"
          : run.status === "running"
            ? "各席位独立审查，随后由 Aggregator 汇总。任一席位结束后即可查看结果。"
            : cliRunPhaseHeading(run.kind, run.status, run.progress?.phase ?? "done")}
      </p>
      {showSummary ? (
        <div className="ck-review-result-summary">
          <span>
            本轮审查结果
            {verdict ? (
              <>
                ：
                <strong className={verdict === "changes-requested" ? "text-warn" : "text-brass"}>
                  {verdictLabel}
                </strong>
              </>
            ) : seats.length > 0 ? (
              `：${endedSeats} / ${seats.length} 席执行完成`
            ) : null}
          </span>
          {pipelineActive && pipeline ? (
            <span>
              当前修复进展：
              {cliRunPhaseHeading(run.kind, "running", pipeline.phase)}
            </span>
          ) : null}
          {elapsed !== null && Number.isFinite(elapsed) && elapsed >= 0 ? (
            <span>总历时 {formatAttemptMs(elapsed)}</span>
          ) : null}
          {run.hasReport ? <a href="#review-report-body">阅读报告正文 ↓</a> : null}
        </div>
      ) : null}
      <code className="ck-review-run-id">{run.runId}</code>
    </header>
  );
}
