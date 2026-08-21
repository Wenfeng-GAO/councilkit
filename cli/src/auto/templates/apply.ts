/**
 * Prompt for `councilkit apply`: implement the review report in an already
 * checked-out PR branch. The CLI pushes; the agent must not open a new PR
 * or post PR comments.
 */
import { PLAN_WORKSPACE_FILE } from "./plan";
import { buildAccessHint } from "./review";

export const APPLY_REPORT_FILENAME = "COUNCILKIT-REVIEW.md";
export const APPLY_PLAN_FILENAME = PLAN_WORKSPACE_FILE;

export function buildApplyPrompt(input: {
  agentName: string;
  prUrl: string;
  branch: string;
  reportFile: string;
  planFile?: string;
  cluster?: {
    id: string;
    files: string[];
    closes: string[];
    gates: string[];
  };
}): string {
  const hasPlan = Boolean(input.planFile);
  const cluster = input.cluster;
  const lines: string[] = [
    `你是 ${input.agentName}，这个仓库的实现 agent。`,
    cluster
      ? `陪审团已锁定方案。本轮只落地集群 \`${cluster.id}\`，做成一个 git commit。不要做其它集群。`
      : hasPlan
        ? "陪审团已经对修复方案达成一致。按方案落地，审查报告只作对照，不要自行加方案里没有的机制。"
        : "下面这份 CouncilKit 多模型陪审团报告已经检出到当前 git 工作区。按报告落实修改，并提交到当前分支。",
    "",
    "## 工作区",
    "",
    `当前目录已经是 PR 源分支 \`${input.branch}\` 的隔离 checkout。不要另开分支，不要另开 PR。`,
    cluster
      ? `本集群方案在 \`${input.planFile}\`。审查报告在 \`${input.reportFile}\`。先读本集群，再改代码。`
      : hasPlan
        ? `共识方案在 \`${input.planFile}\`。审查报告在 \`${input.reportFile}\`。先读方案，再改代码。`
        : `完整审查报告在文件 \`${input.reportFile}\`（相对当前工作区）。先读完整报告，再改代码。`,
    "不要把报告或方案文件拷进仓库，也不要把它加入 commit。",
    "",
    "## 你要做的事",
    "",
  ];
  if (cluster) {
    lines.push(
      `1. 只改集群 \`${cluster.id}\`。方案写「本轮不落地」的项跳过。`,
      cluster.files.length > 0
        ? `2. 范围文件：${cluster.files.join("、")}。不要改这份名单以外的业务代码（测试文件除外）。`
        : "2. 只改本集群正文列出的文件。不要顺手重构。",
      cluster.closes.length > 0
        ? `3. 本集群声称关闭：${cluster.closes.join("、")}。不要为了打勾去加方案没写的机制。`
        : "3. 不要加方案没要求的重试、WaitGroup、新锁或重构。",
      "4. 优先级：删 > fail-closed > 已有锁上补门 > 新机制。",
      cluster.gates.length > 0
        ? `5. 落地后跑：${cluster.gates.join("；")}。测试必须能在补丁父 SHA 上失败。`
        : "5. 每个落地的集群补能在补丁父 SHA 上失败的最小回归测试。",
      "6. 把改动 `git commit` 到当前分支（一个集群一次提交）。commit message 用英文 conventional commits。不要 `git push`（外层命令会推）。不要 force-push。",
      "7. 不要在 PR 上发评论，不要调用 gh/antcode 的 comment，不要创建新 PR。",
      "8. 方案与代码冲突时，以代码和可复现事实为准，跳过无法落地的部分并在最终消息说明。",
    );
  } else if (hasPlan) {
    lines.push(
      "1. 只按方案的「落地顺序」做。方案写「本轮不落地」的项跳过。",
      "2. 每个集群遵守其「方针」和「禁止」。优先级：删 > fail-closed > 已有锁上补门 > 新机制。",
      "3. 不要加方案没要求的重试、WaitGroup、新锁或重构。",
      "4. 每个落地的集群补能在补丁父 SHA 上失败的最小回归测试。",
      "5. 跑与改动相关的既有测试；全量套件过重就跑定向测试。",
      "6. 把改动 `git commit` 到当前分支。commit message 用英文 conventional commits。不要 `git push`（外层命令会推）。不要 force-push。",
      "7. 不要在 PR 上发评论，不要调用 gh/antcode 的 comment，不要创建新 PR。",
      "8. 方案与代码冲突时，以代码和可复现事实为准，跳过无法落地的集群并在最终消息说明。",
    );
  } else {
    lines.push(
      "1. 优先落实 critical / major；minor 一并修；nit 只在不扩大无关 diff 时处理。",
      "2. 不要改报告未覆盖的文件，不要顺手重构。",
      "3. 对每条采纳的 finding：改实现，并补能钉住该缺陷的最小回归测试（仓库已有同类测试时跟它的风格）。",
      "4. 跑与改动相关的既有测试；全量套件过重就跑定向测试。",
      "5. 把改动 `git commit` 到当前分支。commit message 用英文 conventional commits。不要 `git push`（外层命令会推）。不要 force-push。",
      "6. 不要在 PR 上发评论，不要调用 gh/antcode 的 comment，不要创建新 PR。",
      "7. 报告与代码冲突时，以代码和可复现事实为准；无法落地的 finding 跳过，不要为了交差改无关代码。",
    );
  }
  lines.push("", "## PR", "", input.prUrl);
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
