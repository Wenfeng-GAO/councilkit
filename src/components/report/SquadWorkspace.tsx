import { LiveReviewProgress } from "@/components/report/LiveReviewProgress";
import { SquadDocuments } from "@/components/report/SquadDocuments";
import { SquadHandoffCard } from "@/components/report/SquadHandoffCard";
import { cliRunPhaseHeading } from "@/lib/cli-run-status";
import {
  SQUAD_STAGES,
  squadBriefGoal,
  squadDecision,
  squadGateLabel,
  squadStageIndex,
  squadWorkspaceTitle,
} from "@/lib/squad-workspace";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";

export function SquadWorkspace({
  run,
  onInspect,
}: { run: CliRunDetailResponse; onInspect: (id: string) => void }) {
  const decision = squadDecision(run);
  const h = run.handoff;
  const stage = squadStageIndex(run.progress?.phase);
  const active = run.progress?.attempts.filter((a) => a.status === "running").length ?? 0;
  const review = squadGateLabel(h?.reviewerVerdict);
  const verify = squadGateLabel(h?.verifierVerdict);
  const updated = run.progress?.updatedAt;
  const time =
    updated && Number.isFinite(Date.parse(updated))
      ? new Date(updated).toLocaleTimeString("zh-CN", { hour12: false })
      : null;
  return (
    <div className="ck-squad-workspace">
      <header className="ck-squad-hero">
        <div className="ck-squad-eyebrow">
          <span>ENGINEERING SQUAD</span>
          <span className="ck-squad-observation">
            {active > 0 ? <i className="ck-live-dot" aria-hidden /> : null}
            {active > 0 ? `${active} 个席位执行中` : "执行记录"}
            {time ? ` · 更新于 ${time}` : " · 暂无更新时间"}
          </span>
        </div>
        <h1>{squadWorkspaceTitle(run)}</h1>
        <p className="ck-squad-goal">{squadBriefGoal(run)}</p>
        <ol className="ck-squad-stages" aria-label="任务阶段">
          {SQUAD_STAGES.map((label, index) => (
            <li
              key={label}
              data-state={index === stage ? "current" : index < stage ? "reached" : "pending"}
              aria-current={index === stage ? "step" : undefined}
            >
              <span className="ck-squad-stage-number">{String(index + 1).padStart(2, "0")}</span>
              <span>{label}</span>
            </li>
          ))}
        </ol>
      </header>

      <section
        className={`ck-squad-decision ck-squad-decision-${decision.tone}`}
        aria-label="当前验收状态"
      >
        <div className="ck-squad-next">
          <p className="ck-squad-label">
            {run.progress
              ? cliRunPhaseHeading("squad", run.status, run.progress.phase)
              : "当前状态"}
          </p>
          <h2>{decision.label}</h2>
          <p>{decision.detail}</p>
        </div>
        <dl className="ck-squad-evidence">
          <div>
            <dt>候选提交</dt>
            <dd>
              <code title={h?.candidateSha}>{h?.candidateSha?.slice(0, 8) ?? "尚未生成"}</code>
              <small>
                {h?.candidateStatus === "completed"
                  ? "已冻结"
                  : h?.candidateStatus === "invalidated"
                    ? "已失效"
                    : ""}
              </small>
            </dd>
          </div>
          <div>
            <dt>独立评审</dt>
            <dd data-pass={review.passed}>{review.text}</dd>
          </div>
          <div>
            <dt>独立验证</dt>
            <dd data-pass={verify.passed}>{verify.text}</dd>
          </div>
        </dl>
      </section>
      {h?.remainingBlockers?.length ? (
        <ul className="ck-squad-blockers" aria-label="未决阻塞">
          {h.remainingBlockers.map((item, index) => (
            <li key={`${index}-${item}`}>{item}</li>
          ))}
        </ul>
      ) : null}
      <LiveReviewProgress run={run} onInspect={onInspect} />
      <SquadDocuments
        documents={run.documents ?? []}
        reportMarkdown={run.markdown}
        reportTruncated={run.truncated}
      />
      <details className="ck-squad-technical">
        <summary>
          技术详情与原始交接信息 <span>{run.runId}</span>
        </summary>
        <SquadHandoffCard run={run} />
      </details>
    </div>
  );
}
