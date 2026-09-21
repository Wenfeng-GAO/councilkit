import { FixPipeline } from "@/components/report/FixPipeline";
import { type RepairProfileSummary, RepairRunPanel } from "@/components/report/RepairRunPanel";
import type { CliRunDetailResponse, CliRunSummaryDto } from "@shared/runtime/schemas";

export interface WorkbenchPipelineProps {
  busy: boolean;
  pendingAction: "fix" | "re-review" | null;
  error: string | null;
  followUpRun: Pick<CliRunSummaryDto, "runId" | "status"> | null;
  onFix: () => void;
  onReReview: () => void;
}

export interface WorkbenchRepairProps {
  profiles: RepairProfileSummary[];
  activeRepair: Pick<
    CliRunSummaryDto,
    "runId" | "status" | "progress" | "businessResult" | "reasonCode"
  > | null;
  sourceBranchDefault: string;
  baseDefault: string;
  hintSource: "pr" | "review" | "worktree" | null;
  bridgeAvailable?: boolean;
  bridgeLoading?: boolean;
  bridgeReason?: string | null;
  outerUsed?: number;
  outerMax?: number;
  error: string | null;
  pending: boolean;
  onStart: (profile: string) => void;
  onStop: () => void;
  onResume: () => void;
  onSaveProfile: (input: { name: string; sourceBranch: string; base: string }) => void;
}

/**
 * 当前修复主内容（WORKSPACE-STATES 状态 06）：头部是原审查引用与 SHA，
 * 正文复用现有 FixPipeline + RepairRunPanel，mutation 能力保持不变。
 * 审查席位计数不充当修复进度；pipeline 缺字段时不补猜测。
 */
export function RepairView({
  run,
  repair,
  pipeline,
}: {
  run: CliRunDetailResponse;
  repair: WorkbenchRepairProps;
  pipeline: WorkbenchPipelineProps;
}) {
  const sha = run.reviewEvidence?.sha ?? null;
  const notStarted = run.pipeline === null && repair.activeRepair === null;
  return (
    <article className="ck-wb-document">
      <h1>当前修复</h1>
      <p className="ck-wb-source">
        原审查：{run.title} · {sha ? `SHA ${sha.slice(0, 7)}` : "提交信息缺失"}
      </p>
      {notStarted ? (
        <p className="ck-wb-source">尚未启动修复 · 使用下方真实面板启动（无占位动作）</p>
      ) : null}
      <FixPipeline
        run={run}
        busy={pipeline.busy}
        pendingAction={pipeline.pendingAction}
        error={pipeline.error}
        followUpRun={pipeline.followUpRun}
        onFix={pipeline.onFix}
        onReReview={pipeline.onReReview}
      />
      <RepairRunPanel
        run={run}
        profiles={repair.profiles}
        activeRepair={repair.activeRepair}
        bridgeAvailable={repair.bridgeAvailable ?? false}
        bridgeLoading={repair.bridgeLoading ?? false}
        bridgeReason={repair.bridgeReason ?? null}
        outerUsed={repair.outerUsed ?? 0}
        outerMax={repair.outerMax ?? 10}
        error={repair.error}
        pending={repair.pending}
        sourceBranchDefault={repair.sourceBranchDefault}
        baseDefault={repair.baseDefault}
        hintSource={repair.hintSource}
        onStart={repair.onStart}
        onStop={repair.onStop}
        onResume={repair.onResume}
        onSaveProfile={repair.onSaveProfile}
      />
    </article>
  );
}
