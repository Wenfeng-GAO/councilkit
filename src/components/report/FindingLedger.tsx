import {
  FINDING_SEVERITIES,
  type LedgerFinding,
  countLedgerFindings,
  findingStatusLabel,
  isFindingBlocking,
  sortLedgerFindings,
} from "@shared/runtime/cli-ledger";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";

const SEVERITY_LABEL = {
  critical: "致命",
  major: "重大",
  minor: "次要",
  nit: "琐碎",
} as const;

export function FindingLedger({ run }: { run: CliRunDetailResponse }) {
  if (run.findings.length === 0 && !run.planLock && run.landings.length === 0) return null;
  const findings = sortLedgerFindings(run.findings);
  const counts = countLedgerFindings(findings);
  const candidateSha = run.reviewEvidence?.sha ?? null;
  const nextCluster = run.planLock?.clusters.find(
    (cluster) => !run.landings.some((row) => row.clusterId === cluster.id),
  );
  const uncovered = run.reviewEvidence?.uncoveredIds ?? [];
  const coverageNote =
    run.reviewEvidence?.evidenceComplete === false
      ? uncovered.length > 0
        ? ` · 评估覆盖不完整，缺 ${uncovered.slice(0, 5).join("、")}`
        : " · 评估覆盖不完整"
      : run.reviewEvidence?.evidenceComplete === true
        ? " · 评估覆盖完整"
        : "";
  const summary = `${formatLedgerSummary(counts, nextCluster?.id ?? null, findings, candidateSha)} · ${findings.filter((row) => isFindingBlocking(row, candidateSha)).length} 阻塞${coverageNote}`;

  return (
    <section className="border border-edge bg-surface px-4 py-4" aria-labelledby="ck-ledger">
      <p
        id="ck-ledger"
        className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass"
      >
        Finding 账本
      </p>
      <p className="mt-2 text-sm text-muted">{summary}</p>
      {findings.length > 0 ? (
        <ul className="ck-ledger mt-3">
          {findings.map((row) => (
            <li key={row.id} className="ck-ledger-row">
              <span className={`ck-sev ck-sev-${row.severity}`}>
                {SEVERITY_LABEL[row.severity]}
              </span>
              <span className={`ck-ledger-status ck-ledger-${row.status}`}>
                {findingStatusLabel(row, candidateSha)}
              </span>
              <code className="ck-ledger-id">{row.id}</code>
              <span className="ck-ledger-title">{row.title}</span>
              {row.verification ? (
                <details className="ck-ledger-verification">
                  <summary>
                    {row.verification.reviewer} · {shortSha(row.verification.candidateSha)} ·
                    验证依据
                  </summary>
                  <div className="ck-ledger-verification-body">
                    <p>{row.verification.reason}</p>
                    <p>
                      {row.verification.method === "regression_test"
                        ? "独立审查者报告的测试结果"
                        : "独立审查者代码分析"}
                    </p>
                    <pre>{row.verification.command ?? row.verification.locations?.join("\n")}</pre>
                    <p>{row.verification.evidence}</p>
                  </div>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {run.landings.length > 0 ? (
        <div className="mt-4">
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

function formatLedgerSummary(
  counts: ReturnType<typeof countLedgerFindings>,
  nextClusterId: string | null,
  findings: readonly LedgerFinding[],
  candidateSha: string | null,
): string {
  const parts: string[] = [`${counts.total} 条`];
  const statuses = new Map<string, number>();
  for (const row of findings) {
    const label = findingStatusLabel(row, candidateSha);
    statuses.set(label, (statuses.get(label) ?? 0) + 1);
  }
  for (const [label, count] of statuses) parts.push(`${count} ${label}`);
  for (const severity of FINDING_SEVERITIES) {
    const n = counts.bySeverity[severity];
    if (n === 0) continue;
    parts.push(`${n} ${SEVERITY_LABEL[severity]}`);
  }
  if (nextClusterId) parts.push(`下一刀 ${nextClusterId}`);
  return parts.join(" · ");
}

function shortSha(sha: string | null): string {
  if (!sha) return "(none)";
  return sha.slice(0, 12);
}
