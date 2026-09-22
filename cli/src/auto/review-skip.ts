import type { DecisionItem } from "@shared/runtime/review-explainer/contracts";
import type { ReviewTask } from "./templates/review";

type SkipItem = Pick<DecisionItem, "decision" | "originalAssertion" | "aliases"> & {
  id?: string;
  findingId?: string;
};

export function formatSkipListForPrompt(input: {
  prUrl: string;
  items: readonly SkipItem[];
}): string {
  const items = input.items.filter((row) => row.decision === "wont_fix");
  if (items.length === 0) return "";
  return [
    "## PR 已决定不修复的评审点",
    `以下选择仅属于 ${input.prUrl}。跳过这些稳定身份及其冻结原断言，不要求模型再次验证，也不要重新列为阻塞。`,
    "这表示用户接受该风险，不表示假阳性或已修复。相同文件、相似标题或复用 ID 的新失败机制仍须作为独立发现报告。只有列出的明确别名可延续同一身份。",
    ...items.map((row) =>
      [
        `- ${row.findingId ?? row.id}: [wont_fix]`,
        `  原断言：${row.originalAssertion ?? "（缺少原断言，不得据此屏蔽新的问题）"}`,
        ...(row.aliases?.length
          ? [`  明确别名：${row.aliases.map((alias) => alias.id).join(", ")}`]
          : []),
      ].join("\n"),
    ),
  ].join("\n");
}

export function applySkipListToReviewTask(
  task: ReviewTask,
  input: { prUrl: string; items: readonly SkipItem[] },
): ReviewTask {
  return { ...task, skipList: formatSkipListForPrompt(input) };
}
