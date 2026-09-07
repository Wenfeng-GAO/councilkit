import type { CliRunDetailResponse } from "@shared/runtime/schemas";

export type SquadWorkspaceRun = Pick<
  CliRunDetailResponse,
  "title" | "status" | "progress" | "handoff" | "documents"
>;

export function squadBriefGoal(run: SquadWorkspaceRun): string {
  const brief = run.documents?.find((doc) => doc.id === "brief")?.markdown ?? "";
  const goal = brief.match(/^\s*[-*]?\s*(?:goal|目标)\s*[:：]\s*(.+)$/im)?.[1];
  return goal?.replace(/[`*]/g, "").trim() ?? "查看当前执行、独立验收与交付记录。";
}

export function squadWorkspaceTitle(run: SquadWorkspaceRun): string {
  const pr = squadBriefGoal(run).match(/\bPR\s*#\s*(\d+)\b/i)?.[1];
  return pr ? `PR #${pr} · 修复工作台` : "工程任务工作台";
}

export function squadDecision(run: SquadWorkspaceRun): {
  label: string;
  detail: string;
  tone: "info" | "warn" | "success" | "muted";
} {
  const h = run.handoff;
  if (h?.candidateStatus === "invalidated")
    return {
      label: "候选已失效",
      detail: h.invalidatedReason || "等待新的候选提交与独立验收。",
      tone: "warn",
    };
  if (h?.remainingBlockers?.length)
    return {
      label: `${h.remainingBlockers.length} 项仍需处理`,
      detail: "查看阻塞依据，修复后重新验收候选。",
      tone: "warn",
    };
  if (run.status === "failed" || run.status === "interrupted")
    return {
      label: "执行需要处理",
      detail: "查看异常席位的过程记录，由编排者决定恢复方式。",
      tone: "warn",
    };
  if (h?.approved === true)
    return {
      label: "验收已通过",
      detail:
        run.progress?.phase === "done"
          ? "流程已结束，交付内容以最终记录为准。"
          : "等待编排者核对目标分支并完成集成。",
      tone: "success",
    };
  if (run.status === "closed" || run.status === "completed" || run.progress?.phase === "done")
    return {
      label: "已收工 · 验收待核实",
      detail: "收工不代表验收通过，请查看最终说明与门禁记录。",
      tone: "muted",
    };
  if (run.status === "awaiting_orchestrator")
    return {
      label: "等待编排者接续",
      detail: "席位执行与整体验收分别记录；请核对结果后继续流程。",
      tone: "warn",
    };
  if (h?.candidateSha)
    return {
      label: "等待独立验收",
      detail: "评审与验证检查同一候选；结果齐备后再判断能否集成。",
      tone: "info",
    };
  return { label: "准备候选中", detail: "完成规划、实现与审计后，进入独立验收。", tone: "muted" };
}

export function squadGateLabel(verdict: string | undefined): { text: string; passed: boolean } {
  if (!verdict) return { text: "暂无同步信息", passed: false };
  if (verdict === "pending") return { text: "尚未通过", passed: false };
  if (/^(pass|lgtm|approve)$/i.test(verdict)) return { text: "通过", passed: true };
  if (/^(fail|block|blocked|changes[-_ ]requested)$/i.test(verdict))
    return { text: "需处理", passed: false };
  return { text: verdict, passed: false };
}

export const SQUAD_STAGES = ["需求与规划", "代码实现", "候选审计", "独立验收", "集成交付"] as const;
export function squadStageIndex(phase: string | undefined): number {
  if (phase === "briefing" || phase === "planning") return 0;
  if (phase === "implementing") return 1;
  if (phase === "auditing" || phase === "snapshotting") return 2;
  if (phase === "reviewing" || phase === "fixing") return 3;
  if (phase === "integrating" || phase === "done") return 4;
  return -1;
}

export function squadRoleName(name: string): string {
  return (
    (
      {
        planner_a: "方案规划",
        planner_b: "独立规划",
        coder: "代码实现",
        reviewer: "评审席位",
        verifier: "验证席位",
      } as Record<string, string>
    )[name] ?? name
  );
}
