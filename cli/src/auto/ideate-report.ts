import { assertNonEmptyMarkdown, writeCanonicalReport, writeReportCopy } from "../report/render";
import { formatDurationMs } from "./duration";
import type { AttemptResult } from "./runner";
import type { IdeateIntegrity } from "./transcript";
import { IDEATE_REPORT_HEADINGS } from "./templates/ideate";

export interface IdeateReportSeat {
  attemptId: string;
  agentName: string;
  driverId: string;
  modelId: string;
  stage: "proposal" | "debate" | "aggregate";
  result: AttemptResult | null;
}

export interface IdeateReportInput {
  runId: string;
  startedAt: string;
  endedAt: string;
  idea: string;
  background: string;
  debateRounds: number;
  status: "completed" | "failed" | "interrupted";
  integrity: IdeateIntegrity;
  aggregator: { agentName: string; driverId: string; modelId: string };
  aggregation: AttemptResult | null;
  proposals: IdeateReportSeat[];
  debates: IdeateReportSeat[];
  failure?: { phase: string; code: string; message: string };
}

export function renderIdeateReport(input: IdeateReportInput): string {
  const reasons = input.integrity.degradedReasons;
  const banner =
    input.status === "interrupted"
      ? "> INCOMPLETE — 运行被取消或在后续阶段启动前停止。以下是确定性页眉和已完成原文；没有编造共识。"
      : input.status === "failed"
        ? `> FAILED — ${oneLine(input.failure?.message ?? "决策未完成")}。以下保留已有原文，不把失败写成支持票。`
        : input.integrity.incomplete
          ? `> 降级建议 — ${reasons.join("；") || "部分席位失败"}。建议仍只依据成功提案和成功辩论。`
          : "";
  const lines = [
    "# Product Ideate Report",
    "",
    `- Run: ${input.runId}`,
    `- Status: ${input.status}${input.integrity.incomplete ? " (incomplete)" : ""}`,
    `- Started: ${input.startedAt}`,
    `- Ended: ${input.endedAt}`,
    `- Idea: ${oneLine(input.idea)}`,
    `- Background: ${oneLine(input.background) || "（未提供）"}`,
    `- Debate rounds: ${input.debateRounds}${input.debateRounds === 0 ? "（未安排辩论）" : ""}`,
    `- Aggregator: ${input.aggregator.agentName} (${input.aggregator.driverId}/${input.aggregator.modelId})`,
    `- Proposals: ${input.integrity.successfulProposals}/${input.integrity.plannedProposals} succeeded`,
    `- Debate turns: ${input.integrity.successfulDebates}/${input.integrity.plannedDebates} succeeded`,
    `- Model configs: ${input.integrity.successfulModels}/${input.integrity.configuredModels} succeeded`,
    `- Context truncated: ${input.integrity.contextTruncated ? "yes" : "no"}`,
    ...reasons.map((reason) => `- Degradation: ${reason}`),
    "",
  ];
  if (banner.length > 0) lines.push(banner, "");
  lines.push("## 决策正文", "");
  if (input.aggregation?.status === "success" && input.aggregation.output.trim().length > 0) {
    lines.push(input.aggregation.output.trim(), "");
    const missing = IDEATE_REPORT_HEADINGS.filter((heading) => !input.aggregation?.output.includes(heading));
    if (missing.length > 0) {
      lines.push(`> 关键章节缺失：${missing.join("、")}`, "");
    }
  } else {
    lines.push("_无合格决策正文。_", "");
  }
  lines.push("## 附录：各席独立提案", "");
  for (const seat of input.proposals) {
    lines.push(`### ${seat.attemptId} — ${seat.agentName} (${seat.driverId}/${seat.modelId})`, "");
    lines.push(appendixBody(seat.result), "");
  }
  lines.push("## 附录：辩论原文", "");
  if (input.debates.length === 0) {
    lines.push(input.debateRounds === 0 ? "_未安排辩论。_" : "_没有辩论发言。_", "");
  } else {
    for (const seat of input.debates) {
      lines.push(`### ${seat.attemptId} — ${seat.agentName} (${seat.driverId}/${seat.modelId})`, "");
      lines.push(appendixBody(seat.result), "");
    }
  }
  if (input.aggregation) {
    lines.push(
      `## 附录：汇总过程`,
      "",
      `- Duration: ${formatDurationMs(input.aggregation.durationMs)}`,
      `- Exit: ${String(input.aggregation.exitCode)}`,
      "",
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

export function writeIdeateReport(path: string, markdown: string): void {
  assertNonEmptyMarkdown(markdown);
  writeCanonicalReport(path, markdown);
}

export function writeIdeateReportCopy(path: string, markdown: string): void {
  writeReportCopy(path, markdown);
}

function appendixBody(result: AttemptResult | null): string {
  if (result === null) return "_未执行。_";
  if (result.status !== "success") {
    return `failed: ${result.failure?.code ?? "UNKNOWN"} — ${oneLine(result.failure?.message ?? "no output")}`;
  }
  const text = result.output.trim();
  return text.length > 0 ? text : "_空输出。_";
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
