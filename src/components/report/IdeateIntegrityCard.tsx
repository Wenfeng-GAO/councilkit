import { ideateStageLabel, oneLineIdeateMessage } from "@/lib/ideate-integrity";
import type { IdeateIntegrityDto } from "@shared/runtime/schemas";

export function IdeateIntegrityCard({ integrity }: { integrity: IdeateIntegrityDto }) {
  return (
    <section
      className="ck-ideate-integrity"
      aria-label="创意讨论完整性"
      data-degraded={integrity.incomplete ? "true" : "false"}
    >
      <div className="ck-ideate-integrity-heading">
        <p className="ck-eyebrow">{integrity.incomplete ? "DEGRADED" : "INTEGRITY"}</p>
        <h2>{integrity.incomplete ? "降级建议" : "完整性"}</h2>
      </div>
      <p className="ck-ideate-integrity-lead">
        {integrity.incomplete
          ? integrity.degradedReasons.join("；") || "部分席位失败，建议只依据成功提案和成功辩论。"
          : "计划步骤均成功完成。"}
      </p>
      <ul className="ck-ideate-integrity-counts">
        <li>
          提案 <strong>{integrity.successfulProposals}</strong> / {integrity.plannedProposals}
        </li>
        <li>
          辩论发言 <strong>{integrity.successfulDebates}</strong> / {integrity.plannedDebates}
        </li>
        <li>
          型号配置 <strong>{integrity.successfulModels}</strong> / {integrity.configuredModels}
        </li>
      </ul>
      {integrity.contextTruncated ? <p className="ck-ideate-integrity-note">上下文曾被截断。</p> : null}
      {integrity.failedSeats.length > 0 ? (
        <ul className="ck-ideate-integrity-failures">
          {integrity.failedSeats.map((seat) => (
            <li key={`${seat.stage}-${seat.attemptId}`}>
              <span>
                {ideateStageLabel(seat.stage)} · {seat.agentName}
              </span>
              <code>{seat.code}</code>
              {seat.message.trim().length > 0 ? (
                <p>{oneLineIdeateMessage(seat.message)}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
