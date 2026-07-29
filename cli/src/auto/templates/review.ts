/**
 * review prompt templates (DESIGN §3, plan §"模板契约"). Pure functions — the
 * runner is template-agnostic, so a future `design` template is just new data.
 *
 * Soft contract: each Attempt is asked to emit exactly three Markdown sections
 * (`## Findings` / `## Verification` / `## Verdict`). Non-compliance is not a
 * failure — the output goes verbatim into the report appendix and the Aggregator
 * is instructed to read it as written.
 *
 * The Aggregator prompt receives the task plus each *successful* Attempt's name
 * + output (truncated per-attempt to stay under ARG_MAX). Failed Attempts are
 * named only as absent — they must never be cited as a consensus source. No
 * workspace paths are injected (aggregation is over deliverables, not folders).
 */

/** Upper bound on a single Attempt's output embedded in the aggregate prompt.
 * Keeps the whole prompt well under ARG_MAX even with many Attempts. */
export const MAX_ATTEMPT_OUTPUT_IN_PROMPT = 100 * 1024;

export interface ReviewTask {
  /** One of these is set by the command layer (mutually exclusive, enforced there). */
  pr?: string;
  task?: string;
  focus?: string;
  /** Injected only under `--council` when the Council has a non-empty topic. */
  councilTopic?: string;
}

export interface AttemptPromptInput {
  agentName: string;
  personaPrompt: string;
  task: ReviewTask;
}

const ATTEMPT_CONTRACT = `## Findings
List every issue you found, one per line:
- [critical|major|minor|nit] file:location — description → suggested fix

## Verification
The commands you actually ran and their results. If you did not verify, write "未验证".

## Verdict
A single line: approve | changes-requested | comment`;

const AGGREGATE_STRUCTURE = `## Overview
## Consensus findings
## Unique findings
## Disagreements
## Verdict`;

/** Build the prompt handed to each Attempt. */
export function buildAttemptPrompt(input: AttemptPromptInput): string {
  const lines: string[] = [];
  lines.push(`你是 ${input.agentName}，一位独立代码审查者。`);
  if (input.personaPrompt.trim().length > 0) {
    lines.push("", input.personaPrompt.trim());
  }
  lines.push("", "## 任务", "", taskStatement(input.task));
  const focus = input.task.focus?.trim();
  if (focus && focus.length > 0) {
    lines.push("", "审查重点：", focus);
  }
  if (input.task.councilTopic && input.task.councilTopic.trim().length > 0) {
    lines.push("", "上下文议题：", input.task.councilTopic.trim());
  }
  lines.push(
    "",
    "## 工作方式",
    "",
    "你在空目录中完全自主工作：自行 fetch/clone/checkout 代码，自行跑测试、lint、构建或任何你认为必要的验证。没有人为你准备环境，一切由你自己完成。",
    "不可信 PR 等同于 PR 代码会被执行（与 CI 同级风险）。",
  );
  lines.push("", "## 输出契约（最终消息即交付物，过程输出不算）", "", ATTEMPT_CONTRACT);
  lines.push("", "只输出上面的 Markdown，不要输出多余寒暄或过程日志。");
  return lines.join("\n");
}

export interface AttemptSummaryForAggregate {
  attemptId: string;
  name: string;
  status: "success" | "failure";
  output: string;
}

export interface AggregatePromptInput {
  aggregatorName: string;
  aggregatorPersona?: string;
  task: ReviewTask;
  /** All Attempts (success + failure). Failures are named as absent only. */
  attempts: AttemptSummaryForAggregate[];
}

/** Build the prompt handed to the Aggregator subprocess. */
export function buildAggregatePrompt(input: AggregatePromptInput): string {
  const successes = input.attempts.filter((a) => a.status === "success");
  const failures = input.attempts.filter((a) => a.status === "failure");

  const lines: string[] = [];
  lines.push(`你是 ${input.aggregatorName}，负责对比汇总多位独立审查者的结论。`);
  if (input.aggregatorPersona && input.aggregatorPersona.trim().length > 0) {
    lines.push("", input.aggregatorPersona.trim());
  }
  lines.push("", "## 原始任务", "", taskStatement(input.task));
  const focus = input.task.focus?.trim();
  if (focus && focus.length > 0) {
    lines.push("", "审查重点：", focus);
  }

  lines.push("", "## 各审查者的交付物");
  if (successes.length === 0) {
    lines.push("", "（无成功的审查者交付物可供对比。）");
  }
  for (const a of successes) {
    lines.push("", `### ${a.name}`, "", truncateForPrompt(a.output));
  }

  if (failures.length > 0) {
    lines.push(
      "",
      "## 缺席的审查者",
      "",
      `以下审查者未能产出交付物，不可作为共识来源，也不要引用其结论：${failures
        .map((a) => a.name)
        .join("、")}`,
    );
  }

  lines.push(
    "",
    "## 聚合要求",
    "",
    "点名引用每位成功的审查者。对比他们的 Findings 与 Verification，区分共识、独有发现、分歧。",
    "不要包含任何 workspace 路径。失败缺席的审查者不得被引用为共识来源。",
    "最终消息即交付物，只输出下面的 Markdown 五章节结构：",
    "",
    AGGREGATE_STRUCTURE,
  );
  return lines.join("\n");
}

function taskStatement(task: ReviewTask): string {
  if (task.pr && task.pr.trim().length > 0) {
    return `审查这个 PR：${task.pr.trim()}`;
  }
  if (task.task && task.task.trim().length > 0) {
    return task.task.trim();
  }
  return "（任务未指定。）";
}

/** Truncate a single Attempt's output for embedding in the aggregate prompt,
 * marking the truncation point so the Aggregator knows it is partial. */
export function truncateForPrompt(text: string): string {
  if (text.length <= MAX_ATTEMPT_OUTPUT_IN_PROMPT) return text;
  return `${text.slice(0, MAX_ATTEMPT_OUTPUT_IN_PROMPT)}\n[truncated at ${MAX_ATTEMPT_OUTPUT_IN_PROMPT} bytes]`;
}
