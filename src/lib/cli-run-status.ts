import type { CliRunStatusDto, CliRunSummaryDto } from "@shared/runtime/schemas";

const PHASE_LABEL = {
  preflight: "预检中",
  attempts: "席位审查中",
  aggregating: "正在汇总",
  done: "已结束",
  planning: "正在起草修复方案",
  "plan-review": "方案陪审中",
  "plan-aggregating": "正在汇总方案",
  applying: "正在按方案落地",
  "re-reviewing": "正在复审",
  briefing: "简报中",
  implementing: "实现中",
  reviewing: "评审中",
  auditing: "审计中",
  snapshotting: "快照中",
  fixing: "修复轮",
  integrating: "集成中",
  proposing: "独立提案中",
  debating: "交叉辩论中",
} as const;

const SQUAD_PHASE_LABEL = {
  ...PHASE_LABEL,
  planning: "规划中",
  attempts: "席位进行中",
} as const;

export function cliRunNeedsPoll(
  status: CliRunStatusDto,
  pipeline: { phase: string } | null | undefined,
): boolean {
  if (status === "running" || status === "awaiting_orchestrator") return true;
  return pipeline != null && pipeline.phase !== "done";
}

export function cliRunStatusPill(
  kind: CliRunSummaryDto["kind"],
  status: CliRunStatusDto,
): { tone: "muted" | "info" | "success" | "error" | "warn"; text: string } {
  if (kind === "squad") {
    if (status === "awaiting_orchestrator" || status === "interrupted") {
      return { tone: "warn", text: "等待编排" };
    }
    if (status === "closed" || status === "completed") {
      return { tone: "success", text: "已收工" };
    }
  }
  switch (status) {
    case "completed":
      return { tone: "success", text: "已完成" };
    case "failed":
      return { tone: "error", text: "失败" };
    case "interrupted":
      return { tone: "warn", text: "中断" };
    case "running":
      return { tone: "info", text: "进行中" };
    case "unknown":
      return { tone: "muted", text: "未知" };
    case "awaiting_orchestrator":
      return { tone: "warn", text: "等待编排" };
    case "closed":
      return { tone: "success", text: "已收工" };
  }
}

export function primaryRunStatus(run: {
  kind: CliRunSummaryDto["kind"];
  status: CliRunStatusDto;
  progress?: { phase: keyof typeof PHASE_LABEL } | null;
  pipeline?: {
    phase: string;
    applyStatus?: string | null;
    planVerdict?: string | null;
    followUpRunId?: string | null;
  } | null;
  ideateIntegrity?: { incomplete: boolean } | null;
}): { tone: "muted" | "info" | "success" | "error" | "warn"; text: string } {
  if (run.pipeline?.applyStatus === "failure") {
    const reReviewFailed =
      (run.pipeline.planVerdict ?? null) === null && (run.pipeline.followUpRunId ?? null) !== null;
    return { tone: "error", text: reReviewFailed ? "复审失败" : "修复失败" };
  }
  if (run.pipeline && run.pipeline.phase !== "done") {
    return {
      tone: "info",
      text: cliRunPhaseHeading(
        run.kind,
        run.status,
        run.pipeline.phase as keyof typeof PHASE_LABEL,
      ),
    };
  }
  if (run.status === "running" || run.status === "awaiting_orchestrator") {
    if (run.status === "awaiting_orchestrator") return { tone: "warn", text: "等待编排" };
    const phase = run.progress?.phase;
    if (phase && phase !== "done") {
      return { tone: "info", text: cliRunPhaseHeading(run.kind, run.status, phase) };
    }
    return { tone: "info", text: "进行中" };
  }
  if (run.kind === "ideate" && run.ideateIntegrity?.incomplete && run.status === "completed") {
    return { tone: "warn", text: "降级" };
  }
  return cliRunStatusPill(run.kind, run.status);
}

export function cliRunPhaseHeading(
  kind: CliRunSummaryDto["kind"] | undefined,
  status: CliRunStatusDto,
  phase: keyof typeof PHASE_LABEL,
): string {
  if (kind === "squad") {
    if (status === "awaiting_orchestrator" || status === "interrupted") return "等待编排";
    if (status === "closed" || status === "completed") return "已收工";
  } else {
    if (status === "completed") return "已结束";
    if (status === "interrupted") return "已中断";
    if (status === "awaiting_orchestrator") return "等待编排";
    if (status === "closed") return "已收工";
  }
  if (status === "failed") return "失败";
  const table = kind === "squad" ? SQUAD_PHASE_LABEL : PHASE_LABEL;
  return table[phase];
}
