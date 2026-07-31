import { assertNonEmptyMarkdown, writeCanonicalReport, writeReportCopy } from "../report/render";
import { formatDurationMs } from "./duration";
/**
 * review report rendering (DESIGN §4, plan §"文件清单"/§"ReviewOutcome"). The
 * canonical `runs/<run-id>/report.md` is a deterministic header (with an
 * Attempts summary table) → aggregation body (five chapters) → `## 过程对比`
 * → `## 附录:各审查者交付物` (fence-aware heading demotion). Failed Attempts
 * appear in the appendix as `failed: <reason>` and are never cited in the
 * aggregation body.
 *
 * Reuses `report/render.ts` write/assert helpers (unchanged) for the canonical
 * write + `--out` copy, so durability semantics match the `run` command.
 */
import type { AttemptResult } from "./runner";
import type { ReviewTask } from "./templates/review";

/** Render the no-synthesis banner by the REAL reason synthesis is absent, so
 * the body never contradicts the header. The header already labels the run
 * (interrupted / failed / complete); the banner must agree: an interrupted run
 * was never finished, an all-attempts-failed run never started an Aggregator,
 * and only an aggregation-failed run actually had the Aggregator fail (reviewer
 * finding: the banner always said "Aggregator failed" even when SIGINT fired
 * during Attempts or every Attempt failed and no Aggregator ever ran). */
function incompleteBanner(input: ReviewReportInput): string {
  if (input.status === "interrupted") {
    return (
      "> INCOMPLETE — the run was interrupted before a synthesis could be " +
      "produced. What follows is the deterministic header plus each Attempt's " +
      "raw deliverable in the appendix; no consensus is fabricated."
    );
  }
  // status === "failed": first distinguish "stopped before the Aggregator
  // could start" (run-level cause, e.g. transcript IO) — this must come BEFORE
  // the every-Attempt-failed check, because a mid-run failure can leave some
  // Attempts never started and none succeeded, without the cause being
  // "every Attempt failed" (reviewer finding: banner misreported coverage).
  if (
    input.aggregation === null &&
    input.failurePhase !== "aggregation" &&
    input.failurePhase !== "attempts"
  ) {
    return `> INCOMPLETE — the run stopped before the Aggregator could start (${
      input.reason?.trim() || "see transcript"
    }). What follows is the deterministic header plus each Attempt's raw deliverable in the appendix; no consensus is fabricated.`;
  }
  // Distinguish every-Attempt-failed (no Aggregator ran) from an Aggregator
  // that ran but produced no usable output.
  const anySuccess = input.attempts.some((a) => a.status === "success");
  if (!anySuccess) {
    return (
      "> INCOMPLETE — every Attempt failed, so no Aggregator was run. What " +
      "follows is the deterministic header plus each Attempt's failure in the " +
      "appendix; no consensus is fabricated."
    );
  }
  return (
    "> INCOMPLETE — the Aggregator failed to produce a synthesis. What follows " +
    "is the deterministic header plus each Attempt's raw deliverable in the " +
    "appendix; no consensus is fabricated."
  );
}

export interface ReviewReportMeta {
  attemptId: string;
  agentId: string;
  agentName: string;
  driverId: string;
  modelId: string;
}

export interface ReviewReportInput {
  runId: string;
  startedAt: string;
  endedAt: string;
  task: ReviewTask;
  /** All Attempt results, in order. */
  attempts: ReadonlyArray<AttemptResult>;
  aggregator: ReviewReportMeta;
  /** The Aggregator spawn's result (null if aggregation was skipped). */
  aggregation: AttemptResult | null;
  /** Run status — drives the report's Status line (completed/partial/failed/interrupted). */
  status: "completed" | "failed" | "interrupted";
  incomplete: boolean;
  /** Why the run is interrupted/failed (printed as a Reason line in the header). */
  reason?: string;
  /** The failure phase (attempts / aggregation / transcript / …) — lets the
   * banner distinguish "Aggregator ran and failed" from "never started". */
  failurePhase?: string;
}

/** Render the full Markdown report. */
export function renderReviewReport(input: ReviewReportInput): string {
  const head = renderHeader(input);
  const body =
    input.aggregation?.status === "success" && input.aggregation.output.trim().length > 0
      ? input.aggregation.output.trim()
      : "";
  const sections: string[] = [head];
  if (body.length > 0) {
    sections.push("---", "", body, "");
  } else {
    sections.push(incompleteBanner(input), "");
  }
  sections.push(renderProcessComparison(input.attempts));
  sections.push(renderAppendix(input.attempts));
  return sections.join("\n");
}

function renderHeader(input: ReviewReportInput): string {
  const lines: string[] = [];
  lines.push("# Autonomous Review Report", "");
  lines.push(`- Run: ${input.runId}`);
  lines.push(`- Task: ${taskLine(input.task)}`);
  const focus = input.task.focus?.trim();
  if (focus && focus.length > 0) lines.push(`- Focus: ${focus}`);
  lines.push(
    `- Aggregator: ${input.aggregator.agentName} (${input.aggregator.driverId}/${input.aggregator.modelId})`,
  );
  lines.push("", renderAttemptsTable(input.attempts));
  lines.push(`- Status: ${statusLabel(input)}`);
  if (input.reason && input.reason.trim().length > 0) {
    lines.push(`- Reason: ${input.reason.trim()}`);
  }
  lines.push(`- Started: ${input.startedAt}`);
  lines.push(`- Ended: ${input.endedAt}`);
  lines.push("");
  return lines.join("\n");
}

/** Fixed five-column attempts summary table (plan §"报告重排"). `|` and newlines
 * in a cell are escaped so a driver's output never breaks the table grid; an
 * Attempt without captured activity shows 「无过程数据」 in the 工具调用 column. */
function renderAttemptsTable(attempts: ReadonlyArray<AttemptResult>): string {
  const lines: string[] = [
    "| Attempt | Driver/Model | 结果 | 耗时 | 工具调用 |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const a of attempts) {
    const result = a.status === "success" ? "ok" : `failed:${a.failure?.code ?? "unknown"}`;
    const toolCalls = a.activity === undefined ? "无过程数据" : `${a.activity.toolCalls}`;
    lines.push(
      `| ${cell(a.agentName)} | ${cell(`${a.driverId}/${a.modelId}`)} | ${cell(result)} | ${cell(formatDurationMs(a.durationMs))} | ${cell(toolCalls)} |`,
    );
  }
  return lines.join("\n");
}

/** Escape pipe and newline so a cell value can never split the table row. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Distinguish completed / partial (incomplete success) / failed / interrupted
 * in the report header — an interrupted run must not read as merely "incomplete". */
function statusLabel(input: ReviewReportInput): string {
  if (input.status === "interrupted") return "interrupted";
  if (input.status === "failed") return "failed";
  return input.incomplete ? "partial" : "complete";
}

/** `## 过程对比` (plan §"报告重排"): ONE line per final Attempt — name, formatted
 * duration, tool-call count and the deduplicated commands joined by `; `. The
 * command list is omitted when empty (no commands captured). Rendering-time
 * dedup strips a leading proxy env prefix (noted once at the section top) and
 * run-length encodes ADJACENT identical commands as `×N` (non-adjacent repeats
 * are kept). Attempts without captured activity show 无过程数据. The multi-line
 * per-Attempt command list is gone — each Attempt is a single bullet (reviewer
 * finding: the plan asked for one line per final Attempt). */
function renderProcessComparison(attempts: ReadonlyArray<AttemptResult>): string {
  const lines: string[] = ["## 过程对比", ""];
  let strippedProxy = false;
  for (const a of attempts) {
    const reusedMark = a.reused === true ? " [reused]" : "";
    const head = `- ${a.agentName} (${a.driverId}/${a.modelId})${reusedMark} — ${formatDurationMs(a.durationMs)}`;
    if (a.activity === undefined) {
      lines.push(`${head} — 无过程数据`);
      continue;
    }
    const rendered = dedupCommands(a.activity.commands);
    if (rendered.some((c) => c.strippedProxy)) strippedProxy = true;
    // No commands → omit the trailing command segment entirely.
    const commandSeg =
      rendered.length > 0 ? ` — ${rendered.map((c) => codeSpan(c.text)).join("; ")}` : "";
    lines.push(`${head} — 工具调用 ${a.activity.toolCalls} 次${commandSeg}`);
  }
  if (strippedProxy) {
    // One note at the section top: the proxy env prefix was omitted from the
    // commands below (it is identical on every internal-tool invocation).
    lines.splice(1, 0, "> 已省略命令前的 NO_PROXY/HTTPS_PROXY/HTTP_PROXY 等代理前缀。", "");
  }
  lines.push("");
  return lines.join("\n");
}

/** One proxy env prefix to strip (case-insensitive). A command may carry several
 * consecutive prefixes (`NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY='' <cmd>`); all
 * leading prefixes are removed. The value MUST be quoted — an unquoted value
 * containing escaped spaces or command substitution would be partially stripped
 * and leave command fragments behind (reviewer finding); those commands are
 * left untouched instead. */
const PROXY_ENV_RE =
  /^(?:NO_PROXY|no_proxy|HTTPS_PROXY|https_proxy|HTTP_PROXY|http_proxy)=(?:'[^']*'|"[^"]*")\s+/;

interface RenderedCommand {
  text: string;
  /** True when a proxy env prefix was stripped from this command. */
  strippedProxy: boolean;
}

/** Strip the leading proxy env prefix from a single captured command. Returns
 * the remainder and whether a prefix was removed. */
function stripProxyPrefix(cmd: string): { text: string; stripped: boolean } {
  let stripped = false;
  let cur = cmd;
  // Loop: there may be multiple consecutive proxy env assignments.
  for (;;) {
    const next = cur.replace(PROXY_ENV_RE, "");
    // A STANDALONE assignment (`NO_PROXY='*'` with nothing after it) is a shell
    // statement of its own, not a prefix — stripping it would erase the command
    // entirely (reviewer finding). Only strip when a real command follows.
    if (next === cur || next.trim().length === 0) break;
    cur = next;
    stripped = true;
  }
  return { text: cur, stripped };
}

/** Run-length encode ADJACENT identical (post-proxy-strip) commands as `×N`.
 * Non-adjacent repeats are NOT merged — a global set would drop ordering and
 * falsely merge separated repeats (plan §risks). The 80-char truncation from
 * the collection phase is preserved as-is. */
function dedupCommands(commands: ReadonlyArray<string>): RenderedCommand[] {
  interface Acc {
    stripedText: string;
    text: string;
    strippedProxy: boolean;
    count: number;
  }
  const out: Acc[] = [];
  for (const raw of commands) {
    const { text, stripped } = stripProxyPrefix(raw);
    const last = out[out.length - 1];
    if (last !== undefined && last.stripedText === text) {
      last.count++;
      // Fold the proxy-stripped flag across every merged member: if ANY of the
      // adjacent identical commands had a proxy prefix stripped, the group is
      // treated as stripped so the「已省略」note still fires. Otherwise a group
      // whose FIRST member lacked the prefix (e.g. `foo` then `NO_PROXY='*' foo`)
      // would lose the flag and the note would silently disappear (reviewer
      // finding).
      last.strippedProxy = last.strippedProxy || stripped;
      continue;
    }
    out.push({ stripedText: text, text, strippedProxy: stripped, count: 1 });
  }
  return out.map((c) => ({
    text: c.count > 1 ? `${c.text} ×${c.count}` : c.text,
    strippedProxy: c.strippedProxy,
  }));
}

/** `## 附录:各审查者交付物` (plan §"报告重排"): per-attempt `### <name>` with the
 * deliverable's ATX headings demoted two levels OUTSIDE code fences, so no H1/H2
 * from a deliverable can pollute the report outline. A retried Attempt is marked
 * 「第 1 次尝试（失败，已重试）」 from the retry chain carried on the result. */
function renderAppendix(attempts: ReadonlyArray<AttemptResult>): string {
  const lines: string[] = ["## 附录:各审查者交付物", ""];
  if (attempts.length === 0) {
    lines.push("_(no attempts ran.)_", "");
    return lines.join("\n");
  }
  for (const a of attempts) {
    const reusedMark = a.reused === true ? " [reused]" : "";
    lines.push(`### ${a.agentName} (${a.driverId}/${a.modelId})${reusedMark}`, "");
    // A retried Attempt keeps only its final result here; the failed first try
    // is noted once so the appendix never silently drops it.
    if (a.retryOf !== undefined) {
      lines.push("> 第 1 次尝试（失败，已重试）", "");
    }
    if (a.status === "success" && a.output.trim().length > 0) {
      lines.push(downgradeHeadingsOutsideFences(a.output.trim()), "");
    } else {
      lines.push(
        `failed: ${a.failure?.code ?? "unknown"} — ${a.failure?.message ?? "no output"}`,
        "",
      );
    }
  }
  return lines.join("\n");
}

/** Demote ATX headings by two levels outside fenced code blocks. Fences are
 * recognized by up to 3 leading spaces followed by ``` or ~~~ (≥3 repeats); a
 * fence closes only on a line of the SAME character with length ≥ the opening
 * fence. Setext headings are deliberately NOT processed: the output contract is
 * ATX, and `---` may also be a thematic break (plan §risks). */
function downgradeHeadingsOutsideFences(text: string): string {
  const lines = text.split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  const out: string[] = [];
  for (const line of lines) {
    if (inFence) {
      out.push(line);
      // A CLOSING fence is the fence run alone on its line (up to 3 leading
      // spaces, then only whitespace after) — a same-character run WITH trailing
      // info/text (e.g. ```js inside a fenced block) must NOT close the fence
      // (reviewer finding: the unanchored regex treated any line starting with
      // ```/~~~ as a close, mistakenly re-enabling heading demotion mid-fence).
      const closeMatch = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (
        closeMatch !== null &&
        closeMatch[2][0] === fenceChar &&
        closeMatch[2].length >= fenceLen
      ) {
        inFence = false;
      }
      continue;
    }
    const openMatch = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (openMatch !== null) {
      const fenceCh = openMatch[2][0];
      // CommonMark: a BACKTICK fence's info string must not contain a backtick
      // — a line like ``` `inline` ``` is not a fence opening (it is paragraph
      // text), so the H1/H2 that follow must still be demoted. A tilde fence's
      // info string has no such restriction. Without this rule a backtick fence
      // whose info carried a backtick swallowed the rest of the deliverable,
      // disabling heading demotion (reviewer finding).
      if (fenceCh === "`" && openMatch[3].includes("`")) {
        // Not a fence opening (backtick fence info must not contain a backtick);
        // the line is paragraph text, kept verbatim, and heading demotion stays
        // active for the lines that follow.
        out.push(line);
        continue;
      }
      inFence = true;
      fenceChar = fenceCh;
      fenceLen = openMatch[2].length;
      out.push(line);
      continue;
    }
    const heading = /^( {0,3})(#{1,6})(?=[ \t]|$)(.*)$/.exec(line);
    if (heading !== null) {
      // Add two `#` to the marker: H1→H3, H2→H4 (under the `### <name>` heading);
      // H5/H6 grow to 7/8 and naturally fall out of the outline.
      out.push(`${heading[1]}##${heading[2]}${heading[3]}`);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

function taskLine(task: ReviewTask): string {
  if (task.pr && task.pr.trim().length > 0) return `review PR ${task.pr.trim()}`;
  if (task.task && task.task.trim().length > 0) return task.task.trim();
  return "(unspecified)";
}

/** Validate + write the canonical report.md. */
export function writeCanonicalReviewReport(path: string, markdown: string): void {
  assertNonEmptyMarkdown(markdown);
  writeCanonicalReport(path, markdown);
}

/** Atomic copy to `--out`; the canonical artifact is already preserved. */
export function writeReviewReportCopy(outPath: string, markdown: string): void {
  writeReportCopy(outPath, markdown);
}

/** Markdown inline-code span for a command: use a backtick fence one longer
 * than the longest backtick run in the text (CommonMark rule) — a command
 * containing `` ` `` or `` `` `` would otherwise close the span early
 * (reviewer finding). */
function codeSpan(text: string): string {
  const runs = text.match(/`+/g);
  const max = runs === null ? 0 : Math.max(...runs.map((r) => r.length));
  if (max === 0) return "`" + text + "`";
  const fence = "`".repeat(max + 1);
  return `${fence} ${text} ${fence}`;
}
