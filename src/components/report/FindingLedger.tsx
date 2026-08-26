import {
  FINDING_SEVERITIES,
  countLedgerFindings,
  sortLedgerFindings,
} from "@shared/runtime/cli-ledger";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";

const STATUS_LABEL = {
  open: "未关",
  closed: "已关",
  regress: "回归",
  accepted: "接受不修",
} as const;

const SEVERITY_LABEL = {
  critical: "致命",
  major: "重大",
  minor: "次要",
  nit: "琐碎",
} as const;

const STATUS_SUMMARY_ORDER = ["open", "regress", "closed", "accepted"] as const;

export function FindingLedger({ run }: { run: CliRunDetailResponse }) {
  if (run.findings.length === 0 && !run.planLock && run.landings.length === 0) return null;
  const findings = sortLedgerFindings(run.findings);
  const counts = countLedgerFindings(findings);
  const nextCluster = run.planLock?.clusters.find(
    (cluster) => !run.landings.some((row) => row.clusterId === cluster.id),
  );
  const summary = formatLedgerSummary(counts, nextCluster?.id ?? null);

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
                {STATUS_LABEL[row.status]}
              </span>
              <code className="ck-ledger-id">{row.id}</code>
              <span className="ck-ledger-title">{row.title}</span>
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
                {row.closed.length > 0 ? ` · 关闭 ${row.closed.join(", ")}` : ""}
                {row.pushed ? " · 已 push" : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {nextCluster ? (
        <p className="mt-3 text-xs text-muted">
          立即修复默认只落地 <code className="font-command">{nextCluster.id}</code>
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
): string {
  const parts: string[] = [`${counts.total} 条`];
  for (const status of STATUS_SUMMARY_ORDER) {
    const n = counts.byStatus[status];
    if (n === 0 && status !== "open") continue;
    parts.push(`${n} ${STATUS_LABEL[status]}`);
  }
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
