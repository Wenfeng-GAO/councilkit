import { cliRunNeedsPoll } from "@/lib/cli-run-status";
import { extractPrUrl } from "@/lib/fix-prompt";
import type { ParsedReviewReport } from "@/lib/review-report";
import { parseAntCodePrUrl, parseApplyPrUrl, parseGitHubPrUrl } from "@shared/runtime/pr-url";
import { normalizeReviewPr, summarizePrCase } from "@shared/runtime/review-case";
import type { CliRunSummaryDto } from "@shared/runtime/schemas";

export type CaseStatusFilter = "attention" | "active" | "done" | "all";
export type CaseKindFilter = "all" | "review" | "squad";

export const OTHER_SQUADS_KEY = "__other-squads__";

export interface RunGroup {
  key: string;
  label: string;
  runs: CliRunSummaryDto[];
}

type RunLike = Pick<CliRunSummaryDto, "kind" | "title" | "status" | "pipeline"> & {
  reviewEvidence?: CliRunSummaryDto["reviewEvidence"];
  startedAt?: string | null;
  runId?: string;
};

export function isWorkspaceRun(run: Pick<CliRunSummaryDto, "kind">): boolean {
  return run.kind === "review" || run.kind === "squad" || run.kind === "repair";
}

export function explicitPrKey(
  run: Pick<CliRunSummaryDto, "title" | "reviewEvidence">,
): string | null {
  return normalizeReviewPr(run.reviewEvidence?.prUrl ?? extractPrUrl(run.title));
}

export function squadPrNumber(title: string): string | null {
  const match = /(?:^|[-_./\s])pr(\d+)(?=[-_]|$)/i.exec(title);
  return match?.[1] ?? null;
}

export function groupCliRuns(runs: readonly CliRunSummaryDto[]): RunGroup[] {
  const groups = new Map<string, CliRunSummaryDto[]>();
  const order: string[] = [];
  const pending: CliRunSummaryDto[] = [];
  const add = (key: string, run: CliRunSummaryDto) => {
    if (!groups.has(key)) {
      order.push(key);
      groups.set(key, []);
    }
    groups.get(key)?.push(run);
  };

  for (const run of runs) {
    const pr = explicitPrKey(run);
    if (pr) add(pr, run);
    else pending.push(run);
  }

  const numberToKeys = new Map<string, string[]>();
  for (const key of order) {
    const number = prNumberFromKey(key);
    if (!number) continue;
    const list = numberToKeys.get(number) ?? [];
    list.push(key);
    numberToKeys.set(number, list);
  }

  for (const run of pending) {
    const hint = run.kind === "squad" ? squadPrNumber(run.title) : null;
    const matches = hint ? (numberToKeys.get(hint) ?? []) : [];
    const key =
      matches.length === 1
        ? matches[0]
        : hint
          ? `pr:${hint}`
          : run.kind === "squad" && !runNeedsAttention(run)
            ? OTHER_SQUADS_KEY
            : run.title;
    add(key, run);
  }

  return order.map((key) => ({
    key,
    label: groupLabel(key),
    runs: sortRuns(groups.get(key) ?? []),
  }));
}

export function latestRun(runs: readonly CliRunSummaryDto[]): CliRunSummaryDto | undefined {
  return sortRuns(runs)[0];
}

/**
 * 案件类型范围：审查 = review 记录；工程班 = squad + repair 记录——
 * 纯 repair 案件永远归工程班，不会凭空出现在审查清单里。
 */
export function runInKindScope(run: Pick<CliRunSummaryDto, "kind">, kind: CaseKindFilter): boolean {
  if (kind === "all") return true;
  if (kind === "review") return run.kind === "review";
  return run.kind === "squad" || run.kind === "repair";
}

/** Repair 双轴：执行状态 completed 不等于业务过关，业务否决的 run 永远不算“已完成”。 */
export function runBusinessNeedsAttention(
  run: Pick<CliRunSummaryDto, "kind" | "status" | "businessResult">,
): boolean {
  return (
    run.kind === "repair" &&
    run.status !== "running" &&
    (run.businessResult === "needs_attention" || run.businessResult === "stopped")
  );
}

export interface CaseStatusAxis {
  /** 代表 run 仍在执行（进行中/等待编排）。 */
  active: boolean;
  /** 执行轴：代表 run 干净收尾（含 repair 业务通过）。 */
  done: boolean;
  /** 业务轴：仍需人接手（进行中、失败/中断、repair 业务否决、blocking、需恢复）。 */
  attention: boolean;
}

/**
 * 案件状态以最新代表 run 判定：同一个 PR 的旧失败记录不污染新完成记录，
 * 而已完成的 review 若仍有 blocking，会同时落在“已完成”与“需要处理”两条筛告里。
 */
export function caseStatusAxis(scopedRuns: readonly CliRunSummaryDto[]): CaseStatusAxis | null {
  const representative = latestRun(scopedRuns);
  if (!representative) return null;
  const active = cliRunNeedsPoll(
    representative.status,
    representative.pipeline,
    representative.kind,
  );
  const done =
    !active &&
    (representative.status === "completed" || representative.status === "closed") &&
    representative.pipeline?.applyStatus !== "failure" &&
    !runBusinessNeedsAttention(representative);
  const summary = summarizePrCase(scopedRuns);
  // 旧 review 的失败只在它仍是当前代表时才算需要恢复：更晚完成的
  // squad/repair 已经接手并收尾，历史失败本身不能把案件拖回待处理。
  const recoveryOnRepresentative =
    summary.needsRecovery && summary.latest?.runId === representative.runId;
  const attention = active || !done || (summary.blockingCount ?? 0) > 0 || recoveryOnRepresentative;
  return { active, done, attention };
}

export function caseMatchesStatusFilter(
  status: CaseStatusAxis | null,
  filter: CaseStatusFilter,
): boolean {
  if (!status) return false;
  if (filter === "all") return true;
  if (filter === "active") return status.active;
  if (filter === "done") return status.done;
  return status.attention;
}

export interface CaseView {
  key: string;
  /** 原始分组标签（PR URL 或标题）。 */
  label: string;
  /** 案件全部记录（最新在前），用于历史展开。 */
  runs: CliRunSummaryDto[];
  /** 当前类型范围内的记录（最新在前）。 */
  scopedRuns: CliRunSummaryDto[];
  /** 类型范围内最新的代表记录，卡片标题、状态、跳转都以它为准。 */
  representative: CliRunSummaryDto;
  /** 范围内出现的类型标签（“审查”/“工程班”/…）。 */
  kindLabels: string[];
  /** 全量记录的搜索文本（搜索不因类型筛选而漏掉另一半记录）。 */
  searchBlob: string;
  status: CaseStatusAxis;
}

export function caseViewOf(group: RunGroup, kind: CaseKindFilter): CaseView | null {
  const scopedRuns = group.runs.filter((run) => runInKindScope(run, kind));
  const representative = latestRun(scopedRuns);
  const status = caseStatusAxis(scopedRuns);
  if (!representative || !status) return null;
  const kindLabels = [
    scopedRuns.some((run) => run.kind === "review") ? "审查" : null,
    scopedRuns.some((run) => run.kind === "squad" || run.kind === "repair") ? "工程班" : null,
    scopedRuns.some((run) => run.kind === "ideate") ? "创意" : null,
    scopedRuns.some((run) => run.kind === "discuss") ? "讨论" : null,
  ].filter((item): item is string => item !== null);
  const searchBlob = `${readableCaseTitle(group.label)} ${group.label} ${group.runs
    .map((run) => `${run.title} ${run.runId} ${run.reviewEvidence?.prUrl ?? ""}`)
    .join(" ")}`;
  return {
    key: group.key,
    label: group.label,
    runs: group.runs,
    scopedRuns,
    representative,
    kindLabels,
    searchBlob: searchBlob.toLowerCase(),
    status,
  };
}

export function caseNeedsAttention(runs: readonly CliRunSummaryDto[]): boolean {
  if (runs.some(runNeedsAttention)) return true;
  const summary = summarizePrCase(runs);
  return (summary.blockingCount ?? 0) > 0 || summary.needsRecovery;
}

export function runNeedsAttention(run: RunLike): boolean {
  return (
    cliRunNeedsPoll(run.status, run.pipeline) ||
    run.status === "failed" ||
    run.pipeline?.applyStatus === "failure"
  );
}

export function readableCaseTitle(label: string): string {
  if (label === "其他工程班" || label.startsWith("PR #")) return label;
  try {
    const url = new URL(label);
    const parsed = parseApplyPrUrl(url.toString());
    if (parsed?.kind === "github") {
      const ref = parseGitHubPrUrl(parsed.url);
      if (ref) return `${ref.owner}/${ref.repo} #${ref.number}`;
    }
    if (parsed?.kind === "antcode") {
      const ref = parseAntCodePrUrl(parsed.url);
      if (ref) return `${ref.project} #${ref.iid}`;
    }
    const match = /^(.*)\/(?:pull|pull_requests)\/(\d+)\/?$/.exec(url.pathname);
    if (match) return `${match[1]?.replace(/^\//, "")}  #${match[2]}`;
  } catch {
    /* Non-URL labels stay as supplied. */
  }
  return label;
}

export function runHistoryLabel(run: CliRunSummaryDto, groupKey: string): string {
  if (groupKey === OTHER_SQUADS_KEY || groupKey.startsWith("pr:")) return run.title;
  if (run.kind === "squad") return run.title;
  if (run.kind === "review") {
    if (run.pipeline && run.pipeline.phase !== "done") return "修复";
    if (run.reviewEvidence?.againstRunId) return "对照复审";
    return "审查";
  }
  return run.title;
}

export function seatProgress(run: CliRunSummaryDto): string | null {
  const attempts = run.progress?.attempts;
  if (!attempts || attempts.length === 0) return null;
  if (run.status !== "running" && run.status !== "awaiting_orchestrator") return null;
  const done = attempts.filter(
    (row) => row.status === "success" || row.status === "failure" || row.status === "cancelled",
  ).length;
  return `${done}/${attempts.length}`;
}

function groupLabel(key: string): string {
  if (key === OTHER_SQUADS_KEY) return "其他工程班";
  if (key.startsWith("pr:")) return `PR #${key.slice(3)}`;
  return key;
}

function prNumberFromKey(key: string): string | null {
  try {
    const parsed = parseApplyPrUrl(key);
    if (parsed?.kind === "github") return parseGitHubPrUrl(parsed.url)?.number ?? null;
    if (parsed?.kind === "antcode") return parseAntCodePrUrl(parsed.url)?.iid ?? null;
  } catch {
    /* Keys that are not PR URLs have no number. */
  }
  return null;
}

function sortRuns(runs: readonly CliRunSummaryDto[]): CliRunSummaryDto[] {
  return [...runs].sort(
    (a, b) =>
      (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.runId.localeCompare(a.runId),
  );
}

export interface FindingFingerprint {
  id: string;
  severity: string;
  qualifier: string;
  text: string;
  section: string;
}

export function flattenFindings(report: ParsedReviewReport): FindingFingerprint[] {
  const out: FindingFingerprint[] = [];
  for (const section of report.sections) {
    if (!section.findings) continue;
    if (section.title !== "共识发现" && section.title !== "独有发现") continue;
    for (const finding of section.findings) {
      const text = finding.text.replace(/`/g, "").replace(/\s+/g, " ").trim();
      const head = text.split(/[。.\n]/)[0]?.slice(0, 120) ?? text.slice(0, 120);
      out.push({
        id: `${section.title}|${finding.severity ?? ""}|${head}`,
        severity: finding.severity ?? "",
        qualifier: finding.qualifier ?? "",
        text: finding.text,
        section: section.title,
      });
    }
  }
  return out;
}

export interface FindingDiff {
  onlyA: FindingFingerprint[];
  onlyB: FindingFingerprint[];
  both: Array<{ a: FindingFingerprint; b: FindingFingerprint }>;
}

export function diffFindings(a: FindingFingerprint[], b: FindingFingerprint[]): FindingDiff {
  const bById = new Map(b.map((item) => [item.id, item]));
  const used = new Set<string>();
  const onlyA: FindingFingerprint[] = [];
  const both: Array<{ a: FindingFingerprint; b: FindingFingerprint }> = [];
  for (const item of a) {
    const match = bById.get(item.id);
    if (match) {
      both.push({ a: item, b: match });
      used.add(item.id);
    } else {
      onlyA.push(item);
    }
  }
  const onlyB = b.filter((item) => !used.has(item.id));
  return { onlyA, onlyB, both };
}

export function buildPrComment(title: string, report: ParsedReviewReport): string {
  const findings = flattenFindings(report).filter((item) => item.section === "共识发现");
  const lines = [`CouncilKit Jury：${report.verdict ?? "comment"}`, "", title, "", "## 共识发现"];
  if (findings.length === 0) {
    lines.push("（报告里没有解析出共识发现条目。）");
  } else {
    for (const finding of findings) {
      const head = finding.text.split("\n")[0] ?? finding.text;
      const sev = finding.severity ? `[${finding.severity}]` : "";
      const qual = finding.qualifier ? `[${finding.qualifier}]` : "";
      lines.push(`- ${sev}${qual} ${head}`.trim());
    }
  }
  lines.push("", "请按 critical/major 优先修复，并在评论里说明验证命令。");
  return `${lines.join("\n")}\n`;
}

export function siblingRuns(
  runs: readonly CliRunSummaryDto[],
  current: CliRunSummaryDto,
): CliRunSummaryDto[] {
  const group = groupCliRuns(runs).find((item) =>
    item.runs.some((run) => run.runId === current.runId),
  );
  return group?.runs.filter((run) => run.runId !== current.runId) ?? [];
}
