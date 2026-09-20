import { primaryRunStatus } from "@/lib/cli-run-status";
import { normalizeReviewPr } from "@shared/runtime/review-case";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";
import { WorkbenchMobileMenu } from "./WorkbenchNav";
import type { WorkbenchHostStatus } from "./host-status";
import { ExternalLinkIcon } from "./icons";

const ATTEMPT_TERMINAL = new Set(["success", "failure", "cancelled"]);

export function ContextBar({
  run,
  hostStatus,
}: {
  run: CliRunDetailResponse;
  hostStatus: WorkbenchHostStatus;
}) {
  const status = primaryRunStatus(run);
  const seats = run.progress?.attempts.filter((row) => row.role === "attempt") ?? [];
  const doneSeats = seats.filter((row) => ATTEMPT_TERMINAL.has(row.status)).length;
  const sha = run.reviewEvidence?.sha ?? null;
  // 只有真实 PR 链接才可点；缺失时禁用，绝不伪造 URL。
  const prUrl = normalizeReviewPr(run.reviewEvidence?.prUrl ?? null);

  return (
    <header className="ck-wb-context">
      <div className="ck-wb-crumb">
        <WorkbenchMobileMenu hostStatus={hostStatus} />
        <span aria-hidden="true">报告</span>
        <span aria-hidden="true">/</span>
        <b title={run.title}>{run.title}</b>
      </div>
      <div className="ck-wb-context-right">
        <span className={status.tone === "info" ? "ck-wb-running" : undefined}>{status.text}</span>
        {seats.length > 0 ? (
          <span>
            {doneSeats}/{seats.length} 席位已完成
          </span>
        ) : null}
        {sha ? (
          <code title={sha}>SHA {sha.slice(0, 7)}</code>
        ) : (
          <span title="这次审查没有记录被审提交的 SHA">提交信息缺失</span>
        )}
        {prUrl ? (
          <a className="ck-wb-ghost" href={prUrl} target="_blank" rel="noreferrer">
            打开 PR
            <ExternalLinkIcon className="ck-wb-icon" />
          </a>
        ) : (
          <button type="button" className="ck-wb-ghost" disabled title="这份审查没有可用的 PR 链接">
            打开 PR
            <ExternalLinkIcon className="ck-wb-icon" />
          </button>
        )}
      </div>
    </header>
  );
}
