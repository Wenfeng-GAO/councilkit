/**
 * review prompt templates (DESIGN §3, plan §"模板契约"). Pure functions — the
 * runner is template-agnostic, so a future `design` template is just new data.
 *
 * Soft contract (P1-4, 中文契约): each Attempt is asked to emit exactly three
 * Markdown sections (`## 发现` / `## 验证` / `## 结论`). The verdict stays a
 * single-line ENGLISH token (`approve | changes-requested | comment`) so it
 * remains machine-greppable. Non-compliance is not a failure — the output goes
 * verbatim into the report appendix and the Aggregator is instructed to read it
 * as written (including English-titled sections, by semantics).
 *
 * The Aggregator prompt receives the task plus each *successful* Attempt's name
 * + output (truncated per-attempt to stay under ARG_MAX). Failed Attempts are
 * named only as absent — they must never be cited as a consensus source. No
 * workspace paths are injected (aggregation is over deliverables, not folders).
 */

import { Buffer } from "node:buffer";
import { parseAntCodePrUrl } from "@shared/runtime/pr-url";

export { parseAntCodePrUrl };

/** Upper bound on a single Attempt's output embedded in the aggregate prompt.
 * Keeps the whole prompt well under ARG_MAX even with many Attempts. */
export const MAX_ATTEMPT_OUTPUT_IN_PROMPT = 100 * 1024;

/** Total byte budget for the assembled aggregate prompt. kimi delivers the
 * prompt as an argv element, so the whole prompt must stay under ARG_MAX; this
 * budget is enforced by proportional truncation then oldest-output omission. */
export const AGGREGATE_PROMPT_BUDGET = 200 * 1024;

/** Below this per-output allowance we drop an output instead of shrinking it to
 * uselessness. */
const MIN_PER_OUTPUT_BYTES = 512;

export interface ReviewTask {
  /** One of these is set by the command layer (mutually exclusive, enforced there). */
  pr?: string;
  task?: string;
  focus?: string;
  /** Injected only under `--council` when the Council has a non-empty topic. */
  councilTopic?: string;
  /** Prior run id whose findings.json this review classifies against. */
  against?: string;
  /** `parentSha...candidateSha` when the prior run has a landing. */
  againstRange?: string;
  /** Prompt-only ledger dump; not persisted on the transcript. */
  againstLedger?: string;
}

export interface AttemptPromptInput {
  agentName: string;
  personaPrompt: string;
  /** PR reviews with a local clone use a detached worktree; otherwise empty cwd. */
  workspaceMode?: "empty" | "worktree";
  task: ReviewTask;
}

const ATTEMPT_CONTRACT = `## 发现
List every issue you found, one per line:
- [critical|major|minor|nit] file:location — description → suggested fix

## 验证
The commands you actually ran and their results. If you did not verify, write "未验证".

## 结论
A single line: approve | changes-requested | comment`;

const AGGREGATE_STRUCTURE = `## 概览
## 共识发现
## 独有发现
## 分歧
## 结论`;

/** 代理规则原文（P1-2）:内部工具只在命令级清代理;模型 API 调用绝不动代理。 */
const PROXY_RULE =
  "代理规则：调用 antcode 等内部工具时，只在该条命令前加 " +
  "`NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY=''`；模型 API 调用不要改代理设置。";

/** Hosts for which a copy-pasteable access hint exists (P1-2). */
const GITHUB_HOST = "github.com";
const ANTCODE_HOST = "code.alipay.com";

/** Build the「访问提示」block for a `--pr` value (P1-2), or null when the host
 * is unknown / the value is not a URL / the URL is unsafe to echo as a shell
 * command. Injected into the Attempt prompt only — the Aggregator synthesizes
 * deliverables and never fetches. */
export function buildAccessHint(pr: string | undefined): string | null {
  if (pr === undefined) return null;
  let url: URL;
  try {
    url = new URL(pr);
  } catch {
    return null;
  }
  // A single quote in the URL would break the quoted shell commands below.
  if (pr.includes("'")) return null;
  if (url.host === GITHUB_HOST) {
    return [
      "## 访问提示",
      "",
      `用 \`gh pr diff '${pr}'\` 查看 diff，\`gh pr view '${pr}'\` 查看描述与评论。`,
      "建议先用 `gh pr diff` 把 diff 落盘到文件，再分段读取，避免盲目目录探索。",
      "",
      PROXY_RULE,
    ].join("\n");
  }
  if (url.host === ANTCODE_HOST) {
    const parsed = parseAntCodePrUrl(url);
    if (parsed === null) return null;
    return [
      "## 访问提示",
      "",
      `用 \`antcode pr diff ${parsed.iid} -P ${parsed.project} --no-pager\` 查看 diff。`,
      "建议先用 `antcode pr diff` 把 diff 落盘到文件，再分段读取，避免盲目目录探索。",
      "",
      PROXY_RULE,
    ].join("\n");
  }
  return null;
}

/** Build the prompt handed to each Attempt. */
export function buildAttemptPrompt(input: AttemptPromptInput): string {
  const lines: string[] = [];
  lines.push(`你是 ${input.agentName}，一位独立代码审查者。`);
  if (input.personaPrompt.trim().length > 0) {
    lines.push("", input.personaPrompt.trim());
  }
  lines.push("", "## 任务", "", taskStatement(input.task));
  const accessHint = buildAccessHint(input.task.pr);
  if (accessHint !== null) {
    lines.push("", accessHint);
  }
  const focus = input.task.focus?.trim();
  if (focus && focus.length > 0) {
    lines.push("", "审查重点：", focus);
  }
  if (input.task.againstLedger && input.task.againstLedger.trim().length > 0) {
    lines.push("", "## Finding 账本", "", input.task.againstLedger.trim());
  }
  if (input.task.councilTopic && input.task.councilTopic.trim().length > 0) {
    lines.push("", "上下文议题：", input.task.councilTopic.trim());
  }
  lines.push("", "## 工作方式", "");
  if (input.workspaceMode === "worktree") {
    lines.push(
      "当前目录已经是该 PR 源分支的隔离 git worktree（与本地仓库同一 commit）。不要再 clone，不要改源仓库主工作区。",
      "在本目录阅读代码并跑你认为必要的测试、lint 或构建。",
      "不可信 PR 等同于 PR 代码会被执行（与 CI 同级风险）。",
      "全量 build 前先评估时长，优先定向测试。",
    );
  } else {
    lines.push(
      "你在空目录中完全自主工作：自行 fetch/clone/checkout 代码，自行跑测试、lint、构建或任何你认为必要的验证。没有人为你准备环境，一切由你自己完成。",
      "不可信 PR 等同于 PR 代码会被执行（与 CI 同级风险）。",
      "全量 build 前先评估时长，优先定向测试。",
    );
  }
  // The diff-to-file guidance is PR-specific (gh pr diff / antcode pr diff):
  // under `--task` there is no PR target, so asking the reviewer to land a PR
  // diff first is meaningless noise (reviewer finding: it was injected
  // unconditionally, even in --task mode).
  if (input.task.pr && input.task.pr.trim().length > 0) {
    lines.push("先用 gh pr diff / antcode pr diff 落盘到文件再分段读取，避免盲目目录探索。");
  }
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

/** Build the prompt handed to the Aggregator subprocess. Enforces a total byte
 * budget: each output is first capped per-attempt, then (if the whole prompt is
 * still over budget) every retained output is proportionally truncated, and only
 * if that still cannot fit do we drop the OLDEST outputs — naming them as
 * omitted so the Aggregator knows they are absent and must not cite them. */
export function buildAggregatePrompt(input: AggregatePromptInput): string {
  const successes = input.attempts.filter((a) => a.status === "success");
  const failures = input.attempts.filter((a) => a.status === "failure");

  const introLines: string[] = [`你是 ${input.aggregatorName}，负责对比汇总多位独立审查者的结论。`];
  if (input.aggregatorPersona && input.aggregatorPersona.trim().length > 0) {
    introLines.push("", input.aggregatorPersona.trim());
  }
  const intro = introLines.join("\n");

  const taskLines: string[] = ["", "## 原始任务", "", taskStatement(input.task)];
  const focus = input.task.focus?.trim();
  if (focus && focus.length > 0) taskLines.push("", "审查重点：", focus);
  if (input.task.againstLedger && input.task.againstLedger.trim().length > 0) {
    taskLines.push("", "## Finding 账本", "", input.task.againstLedger.trim());
  }
  if (input.task.councilTopic && input.task.councilTopic.trim().length > 0) {
    taskLines.push("", "上下文议题：", input.task.councilTopic.trim());
  }
  const taskBlock = taskLines.join("\n");

  const failuresBlock =
    failures.length > 0
      ? [
          "",
          "## 缺席的审查者",
          "",
          `以下审查者未能产出交付物，不可作为共识来源，也不要引用其结论：${failures
            .map((a) => a.name)
            .join("、")}`,
        ].join("\n")
      : "";

  const requirementBlock = [
    "",
    "## 聚合要求",
    "",
    "点名引用每位被保留的成功的审查者。对比他们的发现与验证过程，区分共识、独有发现、分歧。",
    "reviewer 可能使用 Findings/Verification/Verdict 等英文标题，请按语义理解，不要当作格式错误。",
    "不要包含任何 workspace 路径。失败缺席或因预算省略的审查者不得被引用为共识来源。",
    "结论章节给出单行英文 verdict token：approve | changes-requested | comment。",
    input.task.against
      ? "若有 Finding 账本：在「共识发现」里用原 id 标注仍成立或回归的项；新洞另起条目；不要把账本已关闭且本区间未再出现的项再写一遍。"
      : "",
    "最终消息即交付物，只输出下面的 Markdown 五章节结构：",
    "",
    AGGREGATE_STRUCTURE,
  ].join("\n");

  // Start with each output individually capped at the per-attempt limit.
  let kept = successes.map((a) => ({ name: a.name, body: truncateForPrompt(a.output) }));
  const omittedNames: string[] = [];

  const assemble = (): string => {
    const bodiesLines: string[] = ["", "## 各审查者的交付物"];
    if (kept.length === 0) {
      bodiesLines.push("", "（无成功的审查者交付物可供对比。）");
    }
    for (const k of kept) bodiesLines.push("", `### ${k.name}`, "", k.body);
    const bodiesBlock = bodiesLines.join("\n");
    const omittedBlock =
      omittedNames.length > 0
        ? [
            "",
            "## 因聚合预算省略的审查者",
            "",
            `以下成功审查者的交付物因聚合 prompt 总字节预算不足被省略，不可作为共识来源：${omittedNames.join("、")}`,
          ].join("\n")
        : "";
    return [intro, taskBlock, bodiesBlock, failuresBlock, omittedBlock, requirementBlock]
      .filter((s) => s.length > 0)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  };

  let assembled = assemble();
  let proportionalApplied = false;
  while (kept.length > 0 && byteLength(assembled) > AGGREGATE_PROMPT_BUDGET) {
    const bodyBytes = kept.reduce((n, k) => n + byteLength(k.body), 0);
    const nonBodyBytes = byteLength(assembled) - bodyBytes;
    const perCap = Math.max(0, Math.floor((AGGREGATE_PROMPT_BUDGET - nonBodyBytes) / kept.length));
    if (!proportionalApplied && perCap >= MIN_PER_OUTPUT_BYTES) {
      kept = kept.map((k) => ({ name: k.name, body: truncateBytes(k.body, perCap) }));
      proportionalApplied = true;
    } else {
      // Drop the OLDEST retained output (front of the list) and declare it omitted.
      omittedNames.push(kept.shift()?.name ?? "");
      proportionalApplied = false;
    }
    assembled = assemble();
  }
  return assembled;
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
  return truncateBytes(text, MAX_ATTEMPT_OUTPUT_IN_PROMPT);
}

/** Byte-accurate truncation: cuts the UTF-8 encoding at `cap` bytes and appends
 * a marker. Bytes (not chars) are what ARG_MAX measures. */
export function truncateBytes(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  return `${buf.subarray(0, cap).toString("utf8")}\n[truncated at ${cap} bytes]`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
