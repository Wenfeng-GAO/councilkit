import type { CliRunStatusDto, CliRunSummaryDto } from "@shared/runtime/schemas";

const PHASE_LABEL = {
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
