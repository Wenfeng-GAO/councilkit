import { cliRunNeedsPoll } from "@/lib/cli-run-status";
import { extractPrUrl } from "@/lib/fix-prompt";
import type { ParsedReviewReport } from "@/lib/review-report";
import { parseAntCodePrUrl, parseApplyPrUrl, parseGitHubPrUrl } from "@shared/runtime/pr-url";
import { normalizeReviewPr, summarizePrCase } from "@shared/runtime/review-case";
import type { CliRunSummaryDto } from "@shared/runtime/schemas";

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
  return run.kind === "review" || run.kind === "squad";
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
