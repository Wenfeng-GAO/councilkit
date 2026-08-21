/**
 * Fix-plan templates: draft a consensus repair plan from a review report,
 * then have the same jury review the *plan* (not the PR) until they agree.
 *
 * The point is to lock the *approach* (delete / fail-closed / gate) before
 * any agent is allowed to add retries, WaitGroups, or new locks.
 */
import { buildAccessHint } from "./review";

export const PLAN_RUN_FILE = "plan.md";
export const PLAN_WORKSPACE_FILE = "COUNCILKIT-PLAN.md";
export const PLAN_REVIEW_FILE = "COUNCILKIT-REVIEW.md";

export const PLAN_STRUCTURE = `# 修复方案

- Source-run: <ck-review-id>
- Round: <n>
- Planner: <agent>

## 不变量
1. …

## 落地顺序

### 集群 1: <kebab-id>
- id: <kebab-id>
- closes: <finding-id>, <finding-id>
- files: path/a.go, path/b.go
- gates: go test ./path -run TestName
- 不变量:
- 对应发现: 账本 id 或报告原文
- 方针: 删除 | fail-closed | 在已有锁上补门 | （仅当 1–3 不够）新机制
- 禁止:
- 测试: 必须能在补丁父 SHA 上失败、补丁上通过
- 范围文件:

## 本轮不落地
- <发现>: 原因（产品合同 / API 面过大 / 既有 flake）

## 合并门槛
- 阻塞不变量全部有测试
- 禁止用非幂等 I/O 重试、新 WaitGroup、新全局锁，除非某集群方针显式要求`;

const PROXY_AND_DIFF = (prUrl: string): string => {
  const hint = buildAccessHint(prUrl);
  return hint ?? "用该仓库惯用 CLI 查看 diff。";
};

export function buildPlanDraftPrompt(input: {
  agentName: string;
  prUrl: string;
  reportFile: string;
  previousPlanFile?: string;
  juryFeedback?: string;
  round: number;
}): string {
  const lines: string[] = [
    `你是 ${input.agentName}，负责根据陪审团审查报告起草（或修订）一份修复方案。`,
    "先读报告，再对照工作区里的实现，写出可以交给实现 agent 逐集群落地的方案。",
    "现在不要改业务代码，不要 git commit，不要 push。最终消息就是方案全文。",
    "",
    "## 报告与方案文件",
    "",
    `审查报告：\`${input.reportFile}\`（相对当前工作区）。`,
  ];
  if (input.previousPlanFile) {
    lines.push(`上一轮方案：\`${input.previousPlanFile}\`。按陪审团意见修订，不要推倒重来。`);
  }
  if (input.juryFeedback && input.juryFeedback.trim().length > 0) {
    lines.push("", "## 陪审团对上一轮方案的意见", "", input.juryFeedback.trim());
  }
  lines.push(
    "",
    "## 方针优先级（必须遵守）",
    "",
    "1. **删**错误机制（错误重试、错误转换、错误兜底）。",
    "2. **失败即停 / fail-closed**（短写不要推进 seq；不可逆 close 失败要把对象打成明确不可服务）。",
    "3. **在已有锁/临界区补一个布尔门**。",
    "4. **最后才**加新锁、新 WaitGroup、新重试循环——而且必须写明为什么 1–3 不够，并为该机制本身准备测试。",
    "禁止：为了「把报告条目打勾」而堆机制。一次修 1 引入 2 的方案不合格。",
    "每个集群必须小到能一句话说清、能单独对应一个 git commit；不要把无关子系统塞进同一集群。",
    "closes / files / gates 必须是机器可读的：closes 用审查报告账本 id（path--slug），files 用仓库相对路径，gates 用可在父 SHA 上失败的命令。",
    "产品合同已经写进设计文档的选择（例如 lastSeq > head 的 fail-open）标进「本轮不落地」，不要改回相反合同。",
    "",
    "## 输出",
    "",
    `第 ${String(input.round)} 轮。最终消息必须是完整 Markdown 方案，结构如下：`,
    "",
    PLAN_STRUCTURE,
    "",
    "## PR",
    "",
    input.prUrl,
    "",
    PROXY_AND_DIFF(input.prUrl),
  );
  return lines.join("\n");
}

export function buildPlanReviewPrompt(input: {
  agentName: string;
  personaPrompt: string;
  prUrl: string;
  reportFile: string;
  planFile: string;
}): string {
  const persona = input.personaPrompt.trim();
  const lines: string[] = [`你是 ${input.agentName}，一位独立的修复方案审查者。`];
  if (persona.length > 0) {
    lines.push("", persona);
  }
  lines.push(
    "",
    "## 任务",
    "",
    "审查这份修复方案本身，而不是重新审查整个 PR。",
    "问：方针是否恢复了对应不变量？是否用更复杂的机制掩盖症状？测试是否能钉住？范围是否过大？",
    `审查报告：\`${input.reportFile}\`。方案：\`${input.planFile}\`。`,
    "需要核对实现时可以读工作区源码，但不要 git commit，不要改业务代码。",
    "",
    "## 你要找的问题",
    "",
    "- 用非幂等 I/O 重试、新 WaitGroup、新全局锁去「覆盖」症状，而不是删/fail-closed/补门。",
    "- 一个集群改了多个无关不变量，无法单独证伪。",
    "- 测试钉不住反例（内存 fake 代替短写、没有父 SHA 红灯）。",
    "- 把已写入设计文档的产品合同当成缺陷来改。",
    "- 漏掉报告里的共识 critical/major，又没有写进「本轮不落地」。",
    "",
    "## 输出契约（最终消息即交付物）",
    "",
    "## 发现",
    "- [critical|major|minor|nit] 集群或段落 — 方案哪里错了 → 建议怎么改方案（不是怎么改代码）",
    "",
    "## 验证",
    "对照了报告哪些发现、读了哪些实现。未核对写「未验证」。",
    "",
    "## 结论",
    "一行：approve | changes-requested | comment",
    "",
    "approve = 可以按此方案落地。changes-requested = 方案必须先改。不要因为 PR 里还有 nit 就否决一份正确的最小方案。",
    "",
    "## PR",
    "",
    input.prUrl,
    "",
    PROXY_AND_DIFF(input.prUrl),
  );
  return lines.join("\n");
}

export function buildPlanAggregatePrompt(input: {
  aggregatorName: string;
  aggregatorPersona?: string;
  prUrl: string;
  draftPlan: string;
  attempts: Array<{ name: string; status: "success" | "failure"; output: string }>;
}): string {
  const persona = input.aggregatorPersona?.trim();
  const lines: string[] = [
    `你是 ${input.aggregatorName}，负责对比各审查者对修复方案的意见，产出一份他们能接受的共识方案。`,
  ];
  if (persona && persona.length > 0) {
    lines.push("", persona);
  }
  lines.push(
    "",
    "## 原始任务",
    "",
    `为 PR ${input.prUrl} 锁定修复方案。你审查的是方案，不是再审一遍代码。`,
    "你起草过方案的话，现在必须对抗自己的草案：有证据的否决意见要吸收，没有反例的风格偏好不要扩大范围。",
    "",
    "## 当前草案",
    "",
    input.draftPlan.trim(),
    "",
    "## 各审查者的交付物",
  );
  const successes = input.attempts.filter((a) => a.status === "success");
  const failures = input.attempts.filter((a) => a.status === "failure");
  if (successes.length === 0) {
    lines.push("", "（无成功的审查者交付物可供对比。）");
  }
  for (const a of successes) {
    lines.push("", `### ${a.name}`, "", a.output.trim());
  }
  if (failures.length > 0) {
    lines.push(
      "",
      "## 缺席的审查者",
      "",
      `以下审查者未能产出交付物，不可作为共识来源：${failures.map((a) => a.name).join("、")}`,
    );
  }
  lines.push(
    "",
    "## 聚合要求",
    "",
    "点名引用每位成功的审查者。区分共识、独有、分歧。",
    "产出完整可落地的共识方案（结构与草案相同），不要只写「同意」或「再改改」。",
    "结论一行英文 token：approve | changes-requested | comment。",
    "approve = 共识方案可以交给实现 agent。changes-requested = 仍有阻塞级方案缺陷，需要再改一稿。",
    "最终消息只输出：",
    "",
    "## 概览",
    "## 共识计划",
    "## 分歧",
    "## 结论",
  );
  return lines.join("\n");
}

export function extractVerdictToken(
  markdown: string,
): "approve" | "changes-requested" | "comment" | null {
  const match = /^## 结论\s*\n+([a-z-]+)\s*$/m.exec(markdown);
  const token = match?.[1];
  if (token === "approve" || token === "changes-requested" || token === "comment") return token;
  return null;
}

/** Pull the consensus plan section out of an aggregator deliverable. */
export function extractConsensusPlan(markdown: string): string | null {
  const start = markdown.search(/^## 共识计划\s*$/m);
  if (start < 0) return null;
  const afterHeading = markdown.slice(start).replace(/^## 共识计划\s*\n*/, "");
  const end = afterHeading.search(/^## (?:分歧|结论|概览|独有发现|共识发现)\s*$/m);
  const body = (end < 0 ? afterHeading : afterHeading.slice(0, end)).trim();
  return body.length > 0 ? body : null;
}

export function looksLikePlanDocument(markdown: string): boolean {
  const text = markdown.trim();
  if (text.length < 40) return false;
  return (
    /^# 修复方案\b/m.test(text) ||
    /^# Fix Plan\b/m.test(text) ||
    /^## 不变量\s*$/m.test(text) ||
    /^## 落地顺序\s*$/m.test(text)
  );
}
