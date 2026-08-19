/**
 * Prompt for `councilkit apply`: implement the review report in an already
 * checked-out PR branch. The CLI pushes; the agent must not open a new PR
 * or post PR comments.
 */
import { buildAccessHint } from "./review";

export const APPLY_REPORT_FILENAME = "COUNCILKIT-REVIEW.md";

export function buildApplyPrompt(input: {
  agentName: string;
  prUrl: string;
  branch: string;
  reportFile: string;
}): string {
  const lines: string[] = [
    `你是 ${input.agentName}，这个仓库的实现 agent。`,
    "下面这份 CouncilKit 多模型陪审团报告已经检出到当前 git 工作区。按报告落实修改，并提交到当前分支。",
    "",
    "## 工作区",
    "",
    `当前目录已经是 PR 源分支 \`${input.branch}\` 的隔离 checkout。不要另开分支，不要另开 PR。`,
    `完整审查报告在文件 \`${input.reportFile}\`（相对当前工作区）。先读完整报告，再改代码。`,
    "不要把报告文件拷进仓库，也不要把它加入 commit。",
    "",
    "## 你要做的事",
    "",
    "1. 优先落实 critical / major；minor 一并修；nit 只在不扩大无关 diff 时处理。",
    "2. 不要改报告未覆盖的文件，不要顺手重构。",
    "3. 对每条采纳的 finding：改实现，并补能钉住该缺陷的最小回归测试（仓库已有同类测试时跟它的风格）。",
    "4. 跑与改动相关的既有测试；全量套件过重就跑定向测试。",
    "5. 把改动 `git commit` 到当前分支。commit message 用英文 conventional commits。不要 `git push`（外层命令会推）。不要 force-push。",
    "6. 不要在 PR 上发评论，不要调用 gh/antcode 的 comment，不要创建新 PR。",
    "7. 报告与代码冲突时，以代码和可复现事实为准；无法落地的 finding 跳过，不要为了交差改无关代码。",
    "",
    "## PR",
    "",
    input.prUrl,
  ];
  const hint = buildAccessHint(input.prUrl);
  if (hint !== null) {
    lines.push("", hint);
  }
  lines.push(
    "",
    "最终消息用中文简短说明：改了什么、对应哪些 finding、哪些未采纳及原因、跑了哪些验证。不要输出过程日志。",
  );
  return lines.join("\n");
}
