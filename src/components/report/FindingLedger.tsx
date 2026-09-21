import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import {
  type AgainstLedgerState,
  FINDING_LIST_FILTERS,
  FINDING_LIST_FILTER_LABEL,
  type FindingListFilter,
  type FindingListProblem,
  compareFindingLedgers,
  defaultFindingListFilter,
  emptyFindingListCopy,
  filterFindingProblems,
  formatFindingCountNote,
  formatLedgerComparison,
  projectFindingList,
  reviewCoverageLabel,
  reviewRelationLabel,
  severityLabel,
} from "@/lib/finding-list";
import {
  FINDING_SEVERITIES,
  type LedgerFinding,
  isFindingBlocking,
} from "@shared/runtime/cli-ledger";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";
import { useMemo, useState } from "react";

export function FindingLedger({
  run,
  againstState = { status: "none" },
}: {
  run: CliRunDetailResponse;
  againstState?: AgainstLedgerState;
}) {
  const candidateSha = run.reviewEvidence?.sha ?? null;
  const projection = useMemo(
    () =>
      projectFindingList(run.findings, {
        sha: candidateSha,
        groups: run.findingGroups,
      }),
    [run.findings, run.findingGroups, candidateSha],
  );
  const [filter, setFilter] = useState<FindingListFilter | null>(null);
  if (
    run.kind !== "review" &&
    run.findings.length === 0 &&
    !run.planLock &&
    run.landings.length === 0
  ) {
    return null;
  }
  const effectiveFilter = filter ?? defaultFindingListFilter(projection);
  const visible = filterFindingProblems(projection.problems, effectiveFilter);
  const nextCluster = run.planLock?.clusters.find(
    (cluster) => !run.landings.some((row) => row.clusterId === cluster.id),
  );
  const relation = reviewRelationLabel(run.kind, run.reviewEvidence?.againstRunId);
  const coverage = reviewCoverageLabel({
    kind: run.kind,
    againstRunId: run.reviewEvidence?.againstRunId,
    evidenceComplete: run.reviewEvidence?.evidenceComplete,
    uncoveredIds: run.reviewEvidence?.uncoveredIds,
  });
  const comparison =
    run.kind === "review"
      ? compareFindingLedgers({
          current: run.findings,
          currentSha: candidateSha,
          against: againstState,
        })
      : { status: "none" as const };
  const countNote = formatFindingCountNote(projection);
  const comparisonNote = formatLedgerComparison(comparison);
  const summary = formatProblemSummary(projection, nextCluster?.id ?? null);
  const againstId = run.reviewEvidence?.againstRunId ?? null;
  const prUrl = run.reviewEvidence?.prUrl ?? null;

  return (
    <section className="ck-finding-list" aria-labelledby="ck-ledger">
      <h2 id="ck-ledger">问题清单</h2>
      <p className="ck-finding-list-summary">{summary}</p>
      {countNote ? <p className="ck-finding-list-note">{countNote}</p> : null}
      {relation ? <p className="ck-finding-list-note">{relation}</p> : null}
      {againstId ? (
        <p className="ck-finding-list-note">
          关联对照{" "}
          <a className="ck-finding-list-link" href={`/reports/${againstId}`}>
            {againstId}
          </a>
          {prUrl ? (
            <>
              {" · "}
              <a
                className="ck-finding-list-link"
                href={`/reports?pr=${encodeURIComponent(prUrl)}&against=${run.runId}#review`}
              >
                对照复审
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {coverage ? <p className="ck-finding-list-note">{coverage}</p> : null}
      {comparisonNote ? <p className="ck-finding-list-note">{comparisonNote}</p> : null}
      {run.findings.length > 0 ? (
        <>
          <fieldset className="ck-finding-filters">
            <legend className="ck-finding-filters-legend">问题筛选</legend>
            {FINDING_LIST_FILTERS.map((id) => (
              <button
                key={id}
                type="button"
                className="ck-finding-filter"
                aria-pressed={effectiveFilter === id}
                onClick={() => setFilter(id)}
              >
                {FINDING_LIST_FILTER_LABEL[id]}
              </button>
            ))}
          </fieldset>
          {visible.length > 0 ? (
            <ul className="ck-ledger">
              {visible.map((problem) => (
                <ProblemRow key={problem.key} problem={problem} sha={candidateSha} />
              ))}
            </ul>
          ) : (
            <p className="ck-finding-empty">{emptyFindingListCopy(effectiveFilter)}</p>
          )}
        </>
      ) : (
        <p className="ck-finding-empty">{emptyFindingListCopy("all")}</p>
      )}
      {run.landings.length > 0 ? (
        <div className="ck-finding-landings">
          <p className="font-command text-[0.62rem] uppercase tracking-[0.12em] text-brass">
            落地 SHA
          </p>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {run.landings.map((row) => (
              <li key={`${row.clusterId}-${row.candidateSha ?? row.at}`}>
                <code className="font-command text-parchment">{row.clusterId}</code>
                {" · "}
                {shortSha(row.parentSha)} → {shortSha(row.candidateSha)}
                {(row.claimed ?? row.closed).length > 0
                  ? ` · 声明修复 ${(row.claimed ?? row.closed).join(", ")}（待独立验证）`
                  : ""}
                {row.pushed ? " · 已 push" : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {nextCluster ? (
        <p className="mt-3 text-xs text-muted">
          内置修复默认只落地 <code className="font-command">{nextCluster.id}</code>
          ，一刀一个 SHA。也可{" "}
          <code className="font-command">
            councilkit apply --run {run.runId} --cluster {nextCluster.id}
          </code>
        </p>
      ) : null}
    </section>
  );
}

function ProblemRow({
  problem,
  sha,
}: {
  problem: FindingListProblem;
  sha: string | null;
}) {
  return (
    <li className="ck-ledger-row">
      <details>
        <summary className="ck-finding-summary">
          <span className={`ck-sev ck-sev-${problem.severity}`}>
            {severityLabel(problem.severity)}
          </span>
          <span className={`ck-ledger-status ck-ledger-${statusTone(problem)}`}>
            {problem.statusLabel}
          </span>
          <span className="ck-ledger-title">{problem.title}</span>
          <span className="ck-finding-tags">
            {problem.sourceTags.map((tag) => (
              <span key={tag} className="ck-finding-source">
                {tag}
              </span>
            ))}
          </span>
        </summary>
        <div className="ck-finding-detail">
          {problem.basis ? <p className="ck-finding-basis">{problem.basis}</p> : null}
          {problem.members.map((member) => (
            <MemberEvidence key={member.id} member={member} sha={sha} />
          ))}
        </div>
      </details>
    </li>
  );
}

function MemberEvidence({
  member,
  sha,
}: {
  member: LedgerFinding;
  sha: string | null;
}) {
  return (
    <article className="ck-finding-member">
      <p className="ck-finding-member-meta">
        <span>原始 ID</span>
        <code className="ck-finding-id">{member.id}</code>
      </p>
      <p className="ck-finding-member-meta">
        {member.reviewer ? (
          <span>来源审查者 {member.reviewer}</span>
        ) : (
          <span>来源审查者未记录</span>
        )}
        {member.source === "consensus" ? <span>共识</span> : null}
        {member.source === "unique" ? <span>独有</span> : null}
        {isFindingBlocking(member, sha) ? <span>仍阻塞</span> : null}
      </p>
      {member.files.length > 0 ? (
        <p className="ck-finding-member-meta">
          位置{" "}
          {member.files.map((file) => (
            <code key={file} className="ck-finding-id">
              {file}
            </code>
          ))}
        </p>
      ) : null}
      <SafeMarkdown className="text-sm" variant="document" content={member.text} />
      {member.acceptedReason ? (
        <p className="ck-finding-member-meta">接受不修：{member.acceptedReason}</p>
      ) : null}
      {member.repairClaim ? (
        <p className="ck-finding-member-meta">
          修复声明 {shortSha(member.repairClaim.candidateSha)} · {member.repairClaim.runId}
        </p>
      ) : null}
      {member.verification ? (
        <details className="ck-ledger-verification">
          <summary>
            {member.verification.reviewer} · {shortSha(member.verification.candidateSha)} · 验证依据
          </summary>
          <div className="ck-ledger-verification-body">
            <p>{member.verification.reason}</p>
            <p>
              {member.verification.method === "regression_test"
                ? "独立审查者报告的测试结果"
                : member.verification.method === "not_evaluated"
                  ? "未评估"
                  : "独立审查者代码分析"}
            </p>
            <pre>{member.verification.command ?? member.verification.locations?.join("\n")}</pre>
            <p>{member.verification.evidence}</p>
          </div>
        </details>
      ) : null}
    </article>
  );
}

function formatProblemSummary(
  projection: ReturnType<typeof projectFindingList>,
  nextClusterId: string | null,
): string {
  const parts: string[] = [`${projection.displayCount} 个问题`];
  const statuses = new Map<string, number>();
  for (const problem of projection.problems) {
    statuses.set(problem.statusLabel, (statuses.get(problem.statusLabel) ?? 0) + 1);
  }
  for (const [label, count] of statuses) parts.push(`${count} ${label}`);
  for (const severity of FINDING_SEVERITIES) {
    const n = projection.problems.filter((row) => row.severity === severity).length;
    if (n === 0) continue;
    parts.push(`${n} ${severityLabel(severity)}`);
  }
  parts.push(`${projection.blockingCount} 阻塞`);
  if (nextClusterId) parts.push(`下一刀 ${nextClusterId}`);
  return parts.join(" · ");
}

function statusTone(problem: FindingListProblem): "open" | "closed" | "accepted" | "regress" {
  if (problem.resolved && problem.members.every((row) => row.status === "accepted")) {
    return "accepted";
  }
  if (problem.resolved) return "closed";
  if (problem.members.some((row) => row.status === "regress")) return "regress";
  return "open";
}

function shortSha(sha: string | null): string {
  if (!sha) return "(none)";
  return sha.slice(0, 12);
}
