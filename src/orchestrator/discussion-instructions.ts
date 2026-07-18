import type { DiscussionMode } from "@/models/discussion/entities";
import type { ResultKind } from "@/models/discussion/model-execution";

/**
 * Discussion instruction templates (S2, ADR-0010): the THREE discussion modes
 * (brainstorm / planning / review) × FOUR execution kinds (message / summary /
 * focus / report) are encoded ENTIRELY in instruction text. The orchestrator
 * holds zero mode/category branches — every difference between modes and
 * kinds is borne here, so a different mode ⇒ a different instruction ⇒ a
 * different `instructionDigest` (the digest's sole inputs are wire kind + text).
 *
 * The shared wire `instruction.kind` stays `message` | `summary` (focus→message,
 * report→summary); mode/category never escape into the shared runtime schema.
 */

/** Marker line a summary MUST end with to vote on convergence.
 * `parseConvergenceSuggestion` matches the trimmed last line against it. */
export const CONVERGENCE_MARKER = "收敛建议：" as const;

const FOCUS_TEMPLATES: Record<DiscussionMode, string> = {
  brainstorm:
    "你是本轮的主持人（facilitator）。请先给出本轮探索方向与发散轴：明确本轮要探索什么、可以从哪些角度发散。" +
    "只输出方向说明正文，不要展开他人观点。本轮方向要具体可执行。",
  planning:
    "你是本轮的主持人（facilitator）。请先明确本轮规划的目标、约束与待确认项：本轮要规划什么、有哪些已知约束、哪些前提需要大家确认。" +
    "只输出方向说明正文，不要展开他人观点。约束确认要清晰列出。",
  review:
    "你是本轮的主持人（facilitator）。请先明确本轮评审维度：从正确性、安全、性能、可维护性等维度逐项给出待审查重点。" +
    "只输出方向说明正文，不要展开他人观点。评审维度要可被证据逐维审查。",
};

const MESSAGE_TEMPLATES: Record<DiscussionMode, string> = {
  brainstorm:
    "请阅读以上讨论上下文与本轮方向，以你的角色立场产生独立选项与新角度，不要简单附和。只输出你的发言正文，保持简短以控成本。",
  planning:
    "请阅读以上讨论上下文与本轮方向，以你的角色立场给出步骤、依赖和风险，并标注你认定的约束与缺口。只输出你的发言正文，保持简短以控成本。约束确认要落到具体步骤。",
  review:
    "请阅读以上讨论上下文与本轮方向，基于证据逐维审查（正确性、安全、性能、可维护性等），指出问题与依据。只输出你的发言正文，保持简短以控成本。",
};

const SUMMARY_TEMPLATES: Record<DiscussionMode, string> = {
  brainstorm:
    "请总结本轮讨论：聚类创意、保留分歧，提炼本轮主要方向与未决问题。只输出总结正文。" +
    "最后一行单独输出「收敛建议：是」或「收敛建议：否」（是=已可收敛进入决策，否=还需继续讨论）。",
  planning:
    "请总结本轮讨论：确认约束、缺口与步骤顺序，提炼本轮达成的共识与待确认项。只输出总结正文。" +
    "最后一行单独输出「收敛建议：是」或「收敛建议：否」（是=已可收敛进入决策，否=还需继续讨论）。",
  review:
    "请总结本轮讨论：按维度汇总严重度、共识与争议，提炼本轮主要结论与阻塞项。只输出总结正文。" +
    "最后一行单独输出「收敛建议：是」或「收敛建议：否」（是=已可收敛进入决策，否=还需继续讨论）。",
};

/** Report instruction headers for the nine required Markdown sections
 * (product.md §5.5): Background / Discussion goal / Participating agents /
 * Discussion summary / Key consensus / Remaining disagreements / Recommendation
 * / Risks and objections / Next actions. A model MUST produce every section as
 * a level-2 Markdown heading (## …) so ReportView can render them. The mode
 * prefix only rotates each section's flavor, never the section set. */
const REPORT_SECTION_HEADINGS = [
  "## Background（背景）",
  "## Discussion goal（讨论目标）",
  "## Participating agents（参与角色）",
  "## Discussion summary（讨论摘要）",
  "## Key consensus（关键共识）",
  "## Remaining disagreements（未决分歧）",
  "## Recommendation（推荐）",
  "## Risks and objections（风险与异议）",
  "## Next actions（下一步行动）",
].join("\n");

const REPORT_TEMPLATES: Record<DiscussionMode, string> = {
  brainstorm: `请基于以上全部讨论生成决策报告：汇总候选方案与推荐方向，给出推荐理由与下一步。报告必须严格包含以下九段（每段以 Markdown 二级标题起头）：\n${REPORT_SECTION_HEADINGS}\n只输出报告正文。`,
  planning: `请基于以上全部讨论生成决策报告：输出可执行计划，包含目标、步骤、依赖与待确认项。报告必须严格包含以下九段（每段以 Markdown 二级标题起头）：\n${REPORT_SECTION_HEADINGS}\n只输出报告正文。`,
  review: `请基于以上全部讨论生成决策报告：输出结论、阻塞项与整改建议，按评审维度汇总。报告必须严格包含以下九段（每段以 Markdown 二级标题起头）：\n${REPORT_SECTION_HEADINGS}\n只输出报告正文。`,
};

/**
 * The instruction text for a mode × kind. report text appends a target-output
 * hint when targetOutput is non-empty (it is not part of the shared projection,
 * so it rides inside the instruction — the report's only injection point).
 */
export function instructionText(mode: DiscussionMode, kind: ResultKind, targetOutput = ""): string {
  let base: string;
  switch (kind) {
    case "focus":
      base = FOCUS_TEMPLATES[mode];
      break;
    case "message":
      base = MESSAGE_TEMPLATES[mode];
      break;
    case "summary":
      base = SUMMARY_TEMPLATES[mode];
      break;
    case "report":
      base = REPORT_TEMPLATES[mode];
      break;
  }
  if (kind === "report" && targetOutput.trim().length > 0) {
    return `${base}\n目标输出：${targetOutput.trim()}`;
  }
  return base;
}

/**
 * The shared wire instruction kind: focus maps to "message" (a focus commits a
 * Message), report maps to "summary" (same persist→ACK lineage as a summary).
 * message/summary are identity. The shared runtime schema never sees focus/report.
 */
export function wireKindOf(kind: ResultKind): "message" | "summary" {
  return kind === "focus" ? "message" : kind === "report" ? "summary" : kind;
}

/**
 * Parse a summary's convergence vote from its trimmed last line. The vote is
 * ONLY recognized on a full last-line match of `收敛建议：是` / `收敛建议：否`;
 * any deviation (missing, mid-text, extra wording) reads as `false` — parsing
 * failure never blocks the summary commit (the orchestrator calls this AFTER
 * the commit lands). Whitespace around the value is tolerated.
 */
export function parseConvergenceSuggestion(summary: string): boolean {
  const trimmed = summary.trimEnd();
  if (trimmed.length === 0) return false;
  const newlineIndex = trimmed.lastIndexOf("\n");
  const lastLine = (newlineIndex === -1 ? trimmed : trimmed.slice(newlineIndex + 1)).trim();
  const match = /^收敛建议：\s*(是|否)\s*$/.exec(lastLine);
  return match?.[1] === "是";
}
