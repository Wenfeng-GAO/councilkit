/**
 * ideate prompt templates and UTF-8 budgets. Construction failures return a
 * structured error instead of throwing past completed artifacts.
 */

export const IDEATE_PROMPT_BUDGET = 128 * 1024;
export const IDEATE_INPUT_BUDGET = 16 * 1024;
export const MIN_SHARE_BYTES = 512;

export const IDEATE_REPORT_HEADINGS = [
  "## 背景与问题",
  "## 目标用户与场景",
  "## 方案对比",
  "## 辩论要点与分歧",
  "## 决策与范围",
  "## 产品形态与关键流程",
  "## 技术方案与约束",
  "## 里程碑",
  "## 验证计划",
  "## 风险与未决问题",
] as const;

export interface IdeateTask {
  idea: string;
  background: string;
}

export interface BudgetedText {
  text: string;
  truncated: boolean;
  bytes: number;
}

export interface PromptBuild {
  prompt: string;
  truncated: boolean;
}

export interface PromptBuildFailure {
  code: "PROMPT_BUDGET";
  message: string;
}

export function clipUtf8(text: string, maxBytes: number, label = "truncated"): BudgetedText {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false, bytes };
  const marker = `\n\n[… ${label}: UTF-8 clipped to ${maxBytes} bytes …]\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= budget) lo = mid;
    else hi = mid - 1;
  }
  const clipped = `${text.slice(0, lo)}${marker}`;
  return { text: clipped, truncated: true, bytes: Buffer.byteLength(clipped, "utf8") };
}

export function clipUserInput(task: IdeateTask): { idea: string; background: string; truncated: boolean } {
  const combined = `IDEA\n${task.idea}\nBACKGROUND\n${task.background}`;
  if (Buffer.byteLength(combined, "utf8") <= IDEATE_INPUT_BUDGET) {
    return { idea: task.idea, background: task.background, truncated: false };
  }
  const half = Math.floor(IDEATE_INPUT_BUDGET / 2);
  const idea = clipUtf8(task.idea, half, "idea");
  const background = clipUtf8(task.background, IDEATE_INPUT_BUDGET - idea.bytes, "background");
  return { idea: idea.text, background: background.text, truncated: true };
}

export function shareBudget(
  pieces: ReadonlyArray<{ id: string; text: string }>,
  totalBytes: number,
): { blocks: string; truncated: boolean } {
  if (pieces.length === 0) return { blocks: "", truncated: false };
  const share = Math.max(MIN_SHARE_BYTES, Math.floor(totalBytes / pieces.length));
  const parts: string[] = [];
  let truncated = false;
  for (const piece of pieces) {
    const clipped = clipUtf8(piece.text, share, piece.id);
    truncated = truncated || clipped.truncated;
    parts.push(`### ${piece.id}\n${clipped.text}`);
  }
  return { blocks: parts.join("\n\n"), truncated };
}

function remainingBudget(prefix: string): number {
  return Math.max(MIN_SHARE_BYTES, IDEATE_PROMPT_BUDGET - Buffer.byteLength(prefix, "utf8"));
}

export function buildProposalPrompt(input: {
  agentName: string;
  personaPrompt: string;
  task: IdeateTask;
  proposalRef: string;
}): PromptBuild {
  const user = clipUserInput(input.task);
  const prompt = [
    `你是「${input.agentName}」，正在独立提出产品方案。你看不到其他席位的提案。`,
    input.personaPrompt.trim(),
    `方案引用（必须在正文使用）：${input.proposalRef}`,
    "用户输入：",
    `创意：${user.idea}`,
    `背景（目标用户、问题、时间/预算、非目标；缺项视为假设，勿伪造）：${user.background || "（未提供，当作待确认假设）"}`,
    "独立提出至少一个方案。不要求与他人不同。统一覆盖：目标用户/问题、用户价值、MVP 与非目标、实现成本、验证成本、关键假设、风险与停止条件。",
    "估算必须标明假设。市场判断不能包装成已验证事实。先给不超过 8 行的短摘要，再写正文。正文控制在约 4000 字以内。",
    "只输出 Markdown 正文。不要修改仓库、提交、推送或发布。",
  ].join("\n");
  const clipped = clipUtf8(prompt, IDEATE_PROMPT_BUDGET, "proposal-prompt");
  return { prompt: clipped.text, truncated: user.truncated || clipped.truncated };
}

export function buildDebatePrompt(input: {
  agentName: string;
  personaPrompt: string;
  task: IdeateTask;
  proposalRef: string;
  proposals: ReadonlyArray<{ id: string; text: string }>;
  priorDebates: ReadonlyArray<{ id: string; text: string }>;
  round: number;
  totalRounds: number;
}): PromptBuild | PromptBuildFailure {
  const user = clipUserInput(input.task);
  const head = [
    `你是「${input.agentName}」，正在第 ${input.round}/${input.totalRounds} 轮串行辩论。`,
    input.personaPrompt.trim(),
    `你的方案引用：${input.proposalRef}`,
    `创意：${user.idea}`,
    `背景：${user.background || "（未提供）"}`,
    "每次发言必须说明：支持或反对哪个方案/主张、理由或证据、建议怎样修改、什么条件会改变判断。",
    "允许明确写「没有新增异议」。不要为了反驳而编造问题。约 2000 字以内。只输出 Markdown 正文。",
    "已有成功提案：",
  ].join("\n");
  const remain = remainingBudget(head);
  const proposalShare = input.priorDebates.length > 0 ? Math.floor(remain * 0.7) : remain;
  const proposals = shareBudget(input.proposals, proposalShare);
  const debates =
    input.priorDebates.length === 0
      ? { blocks: "（尚无成功辩论）", truncated: false }
      : shareBudget(input.priorDebates, remain - Buffer.byteLength(proposals.blocks, "utf8"));
  const prompt = `${head}\n${proposals.blocks}\n\n此前成功辩论：\n${debates.blocks}`;
  if (Buffer.byteLength(prompt, "utf8") > IDEATE_PROMPT_BUDGET) {
    const clipped = clipUtf8(prompt, IDEATE_PROMPT_BUDGET, "debate-prompt");
    return { prompt: clipped.text, truncated: true };
  }
  return {
    prompt,
    truncated: user.truncated || proposals.truncated || debates.truncated,
  };
}

export function buildAggregatePrompt(input: {
  task: IdeateTask;
  proposals: ReadonlyArray<{ id: string; agentName: string; text: string }>;
  debates: ReadonlyArray<{ id: string; agentName: string; text: string }>;
  singleProposal: boolean;
  singleModel: boolean;
  debateScheduled: boolean;
  debateSucceeded: number;
}): PromptBuild {
  const user = clipUserInput(input.task);
  const notes = [
    input.singleProposal ? "实际只有一份成功提案，必须写明无法完成多方案比较，不得写成多模型共识。" : "",
    input.singleModel ? "成功来源只有一种模型配置，必须写明单模型来源。" : "",
    !input.debateScheduled ? "用户主动选择未安排辩论。" : "",
    input.debateScheduled && input.debateSucceeded === 0 ? "已安排辩论但交叉讨论未完成。" : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  const head = [
    "你是中立决策 Aggregator，不是辩论席。不要沿用任何席位的对抗或推销立场，不增加一票，不按席位数投票，不强行抹平分歧。",
    "只依据用户输入、成功提案和成功辩论。失败或缺席不是支持票。区分事实、假设、推断和待验证项。",
    `创意：${user.idea}`,
    `背景：${user.background || "（未提供）"}`,
    notes,
    "核心输出必须覆盖：1) 推荐行动（做 / 先验证 / 不做）及理由；2) 方案对比（统一维度，解释弃选；仅一份方案时声明无法比较）；3) 做什么与不做什么、产品形态与关键流程；4) 关键分歧、依据和未决问题；5) MVP 技术方案和里程碑（不做时可写不适用）；6) 第一步验证：动作、观察/指标、成功条件和停止或调整条件。数字若是建议阈值必须标明。",
    `固定正文章节（必须原样使用这些二级标题）：\n${IDEATE_REPORT_HEADINGS.join("\n")}`,
    "只输出这十章正文。不要复述附录。",
    "成功提案：",
  ].join("\n");
  const remain = remainingBudget(head);
  const proposalShare = input.debates.length > 0 ? Math.floor(remain * 0.65) : remain;
  const proposals = shareBudget(
    input.proposals.map((row) => ({ id: `${row.id} (${row.agentName})`, text: row.text })),
    proposalShare,
  );
  const debates =
    input.debates.length === 0
      ? { blocks: "（无成功辩论）", truncated: false }
      : shareBudget(
          input.debates.map((row) => ({ id: `${row.id} (${row.agentName})`, text: row.text })),
          remain - Buffer.byteLength(proposals.blocks, "utf8"),
        );
  const prompt = `${head}\n${proposals.blocks}\n\n成功辩论：\n${debates.blocks}`;
  const clipped = clipUtf8(prompt, IDEATE_PROMPT_BUDGET, "aggregate-prompt");
  return {
    prompt: clipped.text,
    truncated: user.truncated || proposals.truncated || debates.truncated || clipped.truncated,
  };
}

export function extractSuccessfulProposal(
  output: string,
  proposalRef: string,
): { proposalRef: string; summary: string; body: string } | null {
  const body = output.replace(/\r\n/g, "\n").trim();
  if (body.length === 0) return null;
  const firstParagraph = body.split(/\n\s*\n/)[0]?.trim() ?? body;
  const summary = firstParagraph.split("\n").slice(0, 8).join("\n").slice(0, 600);
  if (summary.trim().length === 0) return null;
  return { proposalRef, summary, body };
}

export function missingReportHeadings(markdown: string): string[] {
  return IDEATE_REPORT_HEADINGS.filter((heading) => !markdown.includes(heading));
}
