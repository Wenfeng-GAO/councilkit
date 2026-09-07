import { summarizePrCase } from "@shared/runtime/review-case";
import type { CliRunSummaryDto } from "@shared/runtime/schemas";
import { Link } from "react-router-dom";

export function PrCaseSummary({ runs }: { runs: readonly CliRunSummaryDto[] }) {
  const state = summarizePrCase(runs);
  if (!state.prUrl) return null;
  return (
    <div
      className="mb-3 rounded border border-edge bg-surface px-4 py-3 text-sm"
      aria-label="PR 持续工作台"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-muted">
          最近有效审查 SHA：
          <code className="text-fg">
            {state.baseline?.reviewEvidence?.sha?.slice(0, 12) ?? "尚无完整证据"}
          </code>
        </span>
        <span className={state.blockingCount ? "text-warn" : "text-muted"}>
          未决重大项：{state.blockingCount ?? "未知"}
        </span>
        <span className="text-muted">未验证修复：{state.unverifiedFixCount ?? "未知"}</span>
      </div>
      <p className="mt-2 text-fg">下一步：{state.nextAction}</p>
      {state.needsRecovery && state.baseline ? (
        <p className="mt-1 text-xs text-warn">
          最新运行未形成完整审查证据。保留上次基线；它不证明当前 PR 已通过。
        </p>
      ) : null}
      {state.repeatedIds.length > 0 ? (
        <p className="mt-1 text-xs text-warn">
          同一问题在对照链重复出现：{state.repeatedIds.slice(0, 5).join("、")}
          。先补充根因反例，避免继续逐条打补丁。
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-accent">
        {state.baseline ? (
          <Link to={`/reports/${state.baseline.runId}`} className="hover:underline">
            打开有效证据 / 导出修复任务
          </Link>
        ) : null}
        {state.needsRecovery && state.latest ? (
          <Link to={`/reports/${state.latest.runId}`} className="hover:underline">
            打开最新运行并恢复
          </Link>
        ) : null}
        {state.comparison ? (
          <Link
            to={`/reports/compare/${state.comparison.current}/${state.comparison.previous}`}
            className="hover:underline"
          >
            对比本次与对照基线
          </Link>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-muted">
        运行完成表示证据已收集；PR 是否可交付仍需核对当前 SHA、重大项和验收。
      </p>
    </div>
  );
}
