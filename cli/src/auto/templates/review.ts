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

/** Distinctive marker so spawn fakes and classify() can detect a correction. */
export const CORRECTION_PROMPT_MARKER = "有界 assessment 格式纠错";

/** Total byte budget for the assembled aggregate prompt. kimi delivers the
 * prompt as an argv element, so the whole prompt must stay under ARG_MAX; this
 * budget is enforced by proportional truncation then oldest-output omission. */
export const AGGREGATE_PROMPT_BUDGET = 200 * 1024;

/**
 * Bytes reserved within {@link AGGREGATE_PROMPT_BUDGET} for non-spec content:
 * aggregator intro, task framing, requirements, failure/omitted notices, and
 * room for Attempt deliverables. Without this reserve, a near-budget `--spec`
 * body would force {@link buildAggregatePrompt} to drop every Attempt output
 * while still over budget (empty `kept`). Spec bodies embedded in prompts are
 * capped to `AGGREGATE_PROMPT_BUDGET - AGGREGATE_PROMPT_RESERVED_OVERHEAD`.
 */
export const AGGREGATE_PROMPT_RESERVED_OVERHEAD = 48 * 1024;

/** Max UTF-8 bytes of bound spec body allowed in Attempt/Aggregate prompts. */
export const MAX_SPEC_TEXT_IN_PROMPT =
  AGGREGATE_PROMPT_BUDGET - AGGREGATE_PROMPT_RESERVED_OVERHEAD;

/** Below this per-output allowance we drop an output instead of shrinking it to
 * uselessness. */
const MIN_PER_OUTPUT_BYTES = 512;

export interface ReviewTask {
  /** One of these is set by the command layer (mutually exclusive, enforced there). */
  pr?: string;
  task?: string;
  focus?: string;
  /**
   * Bound spec-contract source for subtractive review (path or label).
   * Auto-detected from conventional sources, or set via `--spec`.
   * When missing: soft-start still enters the run; the review-stage gate
   * (`requireSpec`, default true) refuses mid-stage unless `--no-require-spec`.
   * PR body alone is never the contract.
   */
  specSource?: string;
  /** Prompt-only body of the bound spec (from `--spec` / auto-detect file). */
  specText?: string;
  /** Named acceptance / agentverify points scheduled for verify after contract review. */
  acceptanceIds?: string[];
  /** Prompt-only verify schedule note derived from the bound spec. */
  verifyScheduleNote?: string;
  /**
   * When true (default), unbound contract refuses in the review stage.
   * When false (`--no-require-spec`), run continues in non-contract / legacy mode.
   */
  requireSpec?: boolean;
  /** Injected only under `--council` when the Council has a non-empty topic. */
  councilTopic?: string;
  /** Prior run id whose findings.json this review classifies against. */
  against?: string;
  /** `parentSha...candidateSha` when the prior run has a landing. */
  againstRange?: string;
  /** Prompt-only ledger dump; not persisted on the transcript. */
  againstLedger?: string;
  /** Current PR authority, rendered separately from historical verification. */
  skipList?: string;
  /** Immutable selected repair task; PR-wide observations remain separate. */
  repairAcceptance?: string;
  repairPackageHash?: string;
}

export interface FrozenAttemptContext {
  headSha: string;
  mergeBaseSha: string | null;
  diffHash: string;
  verifiedCli: string;
}

export interface AttemptPromptInput {
  agentName: string;
  personaPrompt: string;
  /** PR reviews with a local clone use a detached worktree; otherwise empty cwd. */
  workspaceMode?: "empty" | "worktree";
  task: ReviewTask;
  frozenContext?: FrozenAttemptContext;
}

const FINDING_FORMAT = `审查是**规格合同减法**：只对「绑定规格」里的具名不变量 / 验收项作 Act On；规格外重大问题可指出，但必须显式标为建议修订规格，且默认不阻塞合并。
每条发现使用一个顶层列表项。首行：严重程度 + 合同类别标签 + 16–32 字中文短标题。
合同类别标签二选一：
- \`[act-on]\`：合同内，违反绑定规格中的具名不变量 / 验收 ID / agentverify 场景；**必须**写不变量与可复现反例，否则不得进入 Act On。
- \`[suggest-amend-spec]\`：规格外 / 合同未覆盖的重大问题；建议修订规格，**不得**与合同内 Act On 混写，默认不阻塞合并。
标题概括「关键条件 + 实际后果」；不要以文件路径、函数名、Finding ID 或“本次新增”开头。
后续正文缩进两个空格。格式如下（替换占位内容）：
- [critical|major|minor|nit][act-on] 关键条件 + 实际后果
  位置：\`file:location\`
  不变量：\`<INV|AC|agentverify:scenario 等绑定规格中的 ID>\`
  反例：可复现的输入 / 时序 / 状态，说明该不变量如何被违反。
  触发与后果：完整描述触发条件、函数调用链和实际影响。
  证据：已有验证及其结果；没有验证就写未验证。
  建议：具体改法。
- [major][suggest-amend-spec] 规格未覆盖的重大风险短标题
  位置：\`file:location\`
  触发与后果：……
  建议：应如何修订规格（新增哪条不变量 / 验收）。
nit / 纯风格 / 仅注释行号意见可写，但**不得**据此给出 changes-requested，也不阻塞合并。
引用已有 Finding 账本项时，在该项缩进正文另写 原 Finding ID：\`<原 ID>\`，逐字保留账本中的原 ID；新问题不要虚构原 ID。`;

const ATTEMPT_CONTRACT = `## 发现
${FINDING_FORMAT}

## 验证
The commands you actually ran and their results. If you did not verify, write "未验证".

## 结论
A single line: approve | changes-requested | comment`;

const ATTEMPT_LEDGER_CONTRACT = `## 逐项验证
有 Finding 账本时，针对你检查的原 finding ID 追加一个 councilkit-findings fenced JSON 数组。
候选 SHA 必须是本工作区 git rev-parse HEAD 的完整 40 位值，不能猜测或使用短 SHA。
每项字段：findingId、candidateSha、outcome（verified_closed / still_open / not_evaluated）、
method（regression_test / code_trace / not_evaluated）、reason、evidence。
regression_test 另填 command（实际执行的命令）；code_trace 另填 locations（文件:行号或行号区间，如 src/a.ts:12 或 src/a.ts:12-20）。
verified_closed 必须独立检查原反例；regression_test 的 evidence 写实际命令、结果和反例为何不再触发；
code_trace 的 evidence 写调用链及原反例已被消除的具体证据。没有检查就用 not_evaluated。
验证时保持候选的已跟踪文件不变；定向反例可放在未跟踪文件。不要 checkout 其他提交。
只写代码作者声称已修复、泛称测试绿、未在 diff 看见，均不能 verified_closed。
示例（必须替换占位值，不能照抄）：
\`\`\`councilkit-findings
[{"findingId":"<原ID>","candidateSha":"<git rev-parse HEAD>","outcome":"not_evaluated","method":"not_evaluated","reason":"本席未检查这个反例","evidence":"无验证证据"}]
\`\`\``;

const AGGREGATE_STRUCTURE = `## 概览
## 共识发现
## 建议修订规格
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
export function buildAccessHint(
  pr: string | undefined,
  opts: { frozen?: boolean } = {},
): string | null {
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
    if (opts.frozen) {
      return [
        "## 访问提示",
        "",
        `描述与评论可用 \`gh pr view '${pr}'\`。diff 已冻结为 review-context.diff，不要再 gh pr diff。`,
        "",
        PROXY_RULE,
      ].join("\n");
    }
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
    if (opts.frozen) {
      return [
        "## 访问提示",
        "",
        "diff 已冻结为 review-context.diff，不要再 antcode pr diff。",
        "",
        PROXY_RULE,
      ].join("\n");
    }
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
  const accessHint = buildAccessHint(input.task.pr, { frozen: Boolean(input.frozenContext) });
  if (accessHint !== null) {
    lines.push("", accessHint);
  }
  const focus = input.task.focus?.trim();
  if (focus && focus.length > 0) {
    lines.push("", "审查重点：", focus);
  }
  lines.push("", renderSpecBinding(input.task));
  if (input.task.againstLedger && input.task.againstLedger.trim().length > 0) {
    lines.push("", "## Finding 账本", "", input.task.againstLedger.trim());
  }
  if (input.task.skipList) lines.push("", input.task.skipList);
  if (input.task.repairAcceptance) lines.push("", input.task.repairAcceptance);
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
  // The diff-to-file guidance is PR-specific. A frozen snapshot replaces
  // per-seat `gh pr diff` / `antcode pr diff` so every Attempt sees the same
  // colorless bytes. `--task` has no PR target, so neither hint is injected.
  if (input.frozenContext) {
    const merge = input.frozenContext.mergeBaseSha ?? "unknown";
    lines.push(
      `冻结审查上下文已写入本工作区 review-context.md / review-context.diff（head ${input.frozenContext.headSha}，merge-base ${merge}，diff sha256 ${input.frozenContext.diffHash}）。`,
      `已验证 CLI：${input.frozenContext.verifiedCli}。不要再自行 gh pr diff / antcode pr diff。`,
    );
  } else if (input.task.pr && input.task.pr.trim().length > 0) {
    lines.push("先用 gh pr diff / antcode pr diff 落盘到文件再分段读取，避免盲目目录探索。");
  }
  lines.push("", "## 输出契约（最终消息即交付物，过程输出不算）", "", ATTEMPT_CONTRACT);
  if (input.task.againstLedger && input.task.againstLedger.trim().length > 0) {
    lines.push("", ATTEMPT_LEDGER_CONTRACT);
  }
  lines.push("", "只输出上面的 Markdown，不要输出多余寒暄或过程日志。");
  return lines.join("\n");
}

export function buildCorrectionPrompt(input: {
  agentName: string;
  requestedFindingIds: readonly string[];
  errorPaths: readonly string[];
  candidateSha: string;
  originalAssessment?: string;
  originalArtifactPath?: string;
}): string {
  const ids = input.requestedFindingIds.map((id) => `- ${id}`).join("\n");
  const paths = input.errorPaths.map((path) => `- ${path}`).join("\n");
  const lines = [
    `你是 ${input.agentName}，正在做${CORRECTION_PROMPT_MARKER}。`,
    "",
    "只重发 requested finding ID 的 councilkit-findings fenced JSON 数组。",
    "禁止改 outcome、method、reason、evidence；禁止新增 ID；禁止 verifiedAt 或其它额外键。",
    `候选 SHA 必须仍是 ${input.candidateSha}。`,
    "",
    "Requested IDs:",
    ids || "- (none)",
    "",
    "Diagnosed error paths:",
    paths || "- (none)",
  ];
  if (input.originalArtifactPath) {
    lines.push(
      "",
      `Original assessment artifact: ${input.originalArtifactPath}`,
      "Read that file and keep every evidence field byte-identical except dropping unknown keys.",
    );
  }
  if (input.originalAssessment && input.originalAssessment.trim().length > 0) {
    lines.push("", "Original assessment fence:", input.originalAssessment.trimEnd());
  }
  lines.push("", "只输出一个 ```councilkit-findings 代码块。");
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
  taskLines.push("", renderSpecBinding(input.task));
  if (input.task.againstLedger && input.task.againstLedger.trim().length > 0) {
    taskLines.push("", "## Finding 账本", "", input.task.againstLedger.trim());
  }
  if (input.task.skipList) taskLines.push("", input.task.skipList);
  if (input.task.repairAcceptance) taskLines.push("", input.task.repairAcceptance);
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
    "去重：同一不变量 ID + 同一根因只保留一条最强证据；不要把 nit / 风格 / 仅注释行号意见升为阻塞。",
    "必须保留有具体证据的严重独有发现；少数意见不能因无人重复而删除。逐项验证 JSON 来自独立 Attempt，你不能补造关闭证据。",
    "把发现分成两类，不得混写：",
    "- 「共识发现」/「独有发现」：仅合同内 Act On（标签 [act-on]，且含不变量 ID + 可复现反例）。",
    "- 「建议修订规格」：规格外重大问题（标签 [suggest-amend-spec]），默认不阻塞合并。",
    "每条发现遵守以下标题与正文格式：",
    FINDING_FORMAT,
    "不要包含任何 workspace 路径。失败缺席或因预算省略的审查者不得被引用为共识来源。",
    "结论章节给出单行英文 verdict token：approve | changes-requested | comment。",
    "仅当仍存在合同内 Act On（critical/major + 不变量 + 反例）时用 changes-requested；只有 nit / 规格外建议时用 comment，不得因规格外或 nit 阻塞合并。",
    input.task.against
      ? "若有 Finding 账本：在「共识发现」里用原 id 标注仍成立或回归的项；新洞另起条目。历史 closed 无验证不等于解决；未报告/未覆盖不等于关闭。已验证关闭另述证据，不混入仍成立的发现列表。"
      : "",
    "最终消息即交付物，只输出下面的 Markdown 结构：",
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

function renderSpecBinding(task: ReviewTask): string {
  const source = task.specSource?.trim();
  const body = task.specText?.trim();
  const requireSpec = task.requireSpec !== false;
  const lines = [
    "## 绑定规格（审查合同）",
    "",
  ];
  if (source) {
    lines.push(
      "本审查为规格合同减法：Act On 默认只接受「违反下列绑定规格中具名不变量 / 验收 ID」且带可复现反例的发现。",
      "规格未覆盖的重大问题必须使用 [suggest-amend-spec]，写入「建议修订规格」，默认不阻塞合并。",
      "不得把 PR 描述单独当作合同做加法对抗审查。",
      "",
      `规格来源：${source}`,
    );
  } else if (requireSpec) {
    lines.push(
      "本审查要求绑定规格合同（强制按 spec review）。",
      "无绑定规格时审查阶段会拒绝继续；不得把 PR 描述单独当作合同。",
      "",
      "规格来源：（缺失 — 审查阶段将拒绝）",
    );
  } else {
    lines.push(
      "未绑定规格合同（`--no-require-spec` / 取消「强制按 spec review」）。",
      "本审查以**非合同 / 遗留加法**模式运行：可做一般代码审查，但不得假装已有合同减法；",
      "重大发现仍建议标注 [suggest-amend-spec] 若明显超出任何隐含需求；blocking 回退为严重度门禁（无 contractClass 时）。",
      "PR 描述本身仍不是合同。",
      "",
      "规格来源：（未绑定 — 非强制模式）",
    );
  }
  if (body) {
    // Cap so a near-AGGREGATE_PROMPT_BUDGET spec cannot starve Attempt outputs.
    lines.push("", "规格正文：", "", truncateBytes(body, MAX_SPEC_TEXT_IN_PROMPT));
  }
  const ids = task.acceptanceIds?.filter((id) => id.trim().length > 0) ?? [];
  if (ids.length > 0) {
    lines.push(
      "",
      "## 验收点（verify）",
      "",
      "合同审查之后 / 同时，必须对照下列具名验收点 / agentverify 场景做验证（写入「验证」）；不得无落脚点地自由狩猎：",
      ...ids.map((id) => `- \`${id}\``),
    );
  }
  if (task.verifyScheduleNote?.trim()) {
    lines.push("", task.verifyScheduleNote.trim());
  }
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
  return truncateBytes(text, MAX_ATTEMPT_OUTPUT_IN_PROMPT);
}

/** Byte-accurate truncation: cuts the UTF-8 encoding at `cap` bytes and appends
 * a marker. Bytes (not chars) are what ARG_MAX measures. */
export function truncateBytes(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  let end = cap;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString("utf8")}\n[truncated at ${cap} bytes]`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
