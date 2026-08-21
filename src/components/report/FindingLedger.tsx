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

export function FindingLedger({ run }: { run: CliRunDetailResponse }) {
  if (run.findings.length === 0 && !run.planLock && run.landings.length === 0) return null;
  const counts = {
    open: run.findings.filter((row) => row.status === "open").length,
    closed: run.findings.filter((row) => row.status === "closed").length,
    regress: run.findings.filter((row) => row.status === "regress").length,
    accepted: run.findings.filter((row) => row.status === "accepted").length,
  };
  const nextCluster = run.planLock?.clusters.find(
    (cluster) => !run.landings.some((row) => row.clusterId === cluster.id),
  );

  return (
    <section className="border border-edge bg-surface px-4 py-4" aria-labelledby="ck-ledger">
      <p
        id="ck-ledger"
        className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass"
      >
        Finding 账本
      </p>
      <p className="mt-2 text-sm text-muted">
        {counts.open} 未关 · {counts.closed} 已关 · {counts.regress} 回归
        {counts.accepted > 0 ? ` · ${counts.accepted} 接受不修` : ""}
        {nextCluster ? ` · 下一刀 ${nextCluster.id}` : ""}
      </p>
      {run.findings.length > 0 ? (
        <ul className="ck-ledger mt-3">
          {run.findings.map((row) => (
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

function shortSha(sha: string | null): string {
  if (!sha) return "(none)";
  return sha.slice(0, 12);
}
