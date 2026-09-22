import type { RepairEvidence } from "@shared/runtime/repair-observation";

const STATUS_LABEL = {
  passed: "通过",
  failed: "未通过",
  pending: "待验证",
  insufficient: "证据不足",
} as const;

export function RepairEvidencePanel({
  evidence,
  onExport,
}: {
  evidence: RepairEvidence | null;
  onExport: (format: "json" | "md") => void;
}) {
  if (!evidence) {
    return (
      <section className="ck-repair-evidence" data-testid="repair-evidence" aria-label="验收与改动">
        <p className="ck-repair-empty">暂无验收证据</p>
      </section>
    );
  }
  return (
    <section className="ck-repair-evidence" data-testid="repair-evidence" aria-label="验收与改动">
      <p className="ck-repair-meta">
        候选 {evidence.candidateSha ?? "未记录"} · 基准 {evidence.baseSha ?? "未记录"}
      </p>
      <p className="ck-repair-meta">
        断言版本 {evidence.assertionVersion ?? "未记录"} · 核验 {evidence.verifiedAt ?? "未记录"}
      </p>
      {!evidence.gateConsistent ? (
        <p className="ck-repair-attention">状态与证据不一致</p>
      ) : null}
      <ul className="ck-repair-evidence-list">
        {evidence.items.map((item) => (
          <li key={item.assertionId} className="ck-repair-evidence-item">
            <span className={`ck-repair-evidence-status is-${item.status}`}>
              {STATUS_LABEL[item.status]}
            </span>
            <span>{item.label}</span>
            {item.detail ? <pre className="ck-repair-code">{item.detail}</pre> : null}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="ck-repair-btn"
        data-testid="repair-export"
        disabled={!evidence.exportableAsApproved && evidence.items.length === 0}
        onClick={() => onExport("json")}
      >
        导出已核验记录
      </button>
    </section>
  );
}
