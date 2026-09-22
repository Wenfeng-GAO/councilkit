import type { RepairEvidence } from "@shared/runtime/repair-observation";
import { IconCheck, IconClock } from "./icons";
const STATUS_LABEL = {
  passed: "通过",
  failed: "未通过",
  pending: "待验证",
  insufficient: "证据不足",
} as const;
export function RepairEvidencePanel({
  evidence,
  onExport,
}: { evidence: RepairEvidence | null; onExport: (format: "json" | "md") => void }) {
  if (!evidence || (!evidence.items.length && !evidence.candidateSha))
    return (
      <section className="ck-repair-evidence" data-testid="repair-evidence" aria-label="验收与改动">
        <div className="ck-repair-evidence-empty">
          <IconClock />
          <h2>暂无验收证据</h2>
          <p>候选和独立核验记录将在这里汇总。执行结束并不代表已经准出。</p>
        </div>
      </section>
    );
  const passed = evidence.items.filter((item) => item.status === "passed").length;
  return (
    <section className="ck-repair-evidence" data-testid="repair-evidence" aria-label="验收与改动">
      <div className="ck-repair-evidence-heading">
        <div>
          <h2>验收证据</h2>
          <p>
            {evidence.items.length
              ? `已通过 ${passed} / ${evidence.items.length} 项`
              : "候选尚待核验"}
          </p>
        </div>
        <button
          type="button"
          className="ck-repair-btn"
          data-testid="repair-export"
          disabled={!evidence.exportableAsApproved && evidence.items.length === 0}
          onClick={() => onExport("json")}
        >
          导出证据 ↗
        </button>
      </div>
      <details className="ck-repair-evidence-identity">
        <summary>
          提交与核验信息 <span>{evidence.candidateSha?.slice(0, 8)}</span>
        </summary>
        <dl>
          <dt>候选</dt>
          <dd>{evidence.candidateSha ?? "未记录"}</dd>
          <dt>基准</dt>
          <dd>{evidence.baseSha ?? "未记录"}</dd>
          <dt>断言版本</dt>
          <dd>{evidence.assertionVersion ?? "未记录"}</dd>
          <dt>核验时间</dt>
          <dd>{evidence.verifiedAt ?? "未记录"}</dd>
        </dl>
      </details>
      {!evidence.gateConsistent ? (
        <p className="ck-repair-evidence-warning">状态与证据不一致</p>
      ) : null}
      <ul className="ck-repair-evidence-list">
        {evidence.items.map((item) => (
          <li key={item.assertionId}>
            <details className="ck-repair-evidence-item">
              <summary>
                <span className={`ck-repair-evidence-status is-${item.status}`}>
                  {item.status === "passed" ? <IconCheck /> : <IconClock />}
                  {STATUS_LABEL[item.status]}
                </span>
                <span>{item.label}</span>
                <span aria-hidden="true">⌄</span>
              </summary>
              <div className="ck-repair-evidence-content">
                {item.detail ? (
                  <pre className="ck-repair-code">{item.detail}</pre>
                ) : (
                  <p>这项断言尚无详细记录。</p>
                )}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
