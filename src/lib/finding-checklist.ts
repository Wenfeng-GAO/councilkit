/**
 * Generate a short fix-agent checklist from findings, aligned with the visible
 * FindingLedger display.
 */
import type { FindingListFilter, FindingListProblem } from "@/lib/finding-list";
import {
  filterFindingProblems,
  projectFindingList,
  severityLabel,
} from "@/lib/finding-list";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";

export interface FindingChecklistOptions {
  /** Current filter selection; defaults to "pending" when omitted. */
  filter?: FindingListFilter;
  /** Include a header describing the run context. */
  includeHeader?: boolean;
}

/**
 * Build a short markdown checklist for fix agents from run findings.
 * Includes: id, severity, title, location, status tags, optional suggestion.
 * Excludes: long evidence prose, attempts table, 过程对比, per-reviewer appendices.
 */
export function buildFindingChecklist(
  run: CliRunDetailResponse,
  options: FindingChecklistOptions = {},
): string {
  const filter = options.filter ?? "pending";
  const includeHeader = options.includeHeader ?? true;

  const projection = projectFindingList(run.findings, {
    sha: run.reviewEvidence?.sha ?? null,
    groups: run.findingGroups,
  });

  const visible = filterFindingProblems(projection.problems, filter);

  if (visible.length === 0) {
    return includeHeader
      ? `# 问题清单 (${filterLabel(filter)})\n\n当前筛选无问题。\n`
      : "当前筛选无问题。";
  }

  const lines: string[] = [];

  if (includeHeader) {
    lines.push(`# 问题清单 (${filterLabel(filter)})`);
    lines.push("");
    lines.push(
      `共 ${visible.length} 个问题 · ${projection.blockingCount} 阻塞 · Run: ${run.runId}`,
    );
    if (run.reviewEvidence?.sha) {
      lines.push(`Commit: ${run.reviewEvidence.sha.slice(0, 12)}`);
    }
    lines.push("");
  }

  for (let i = 0; i < visible.length; i++) {
    const problem = visible[i];
    const number = projection.problems.indexOf(problem) + 1;
    lines.push(formatProblemChecklist(problem, number));
    if (i < visible.length - 1) lines.push("");
  }

  return lines.join("\n");
}

function formatProblemChecklist(problem: FindingListProblem, number: number): string {
  const lines: string[] = [];

  // Header: ## #01 致命 · 标题
  const header = `## #${String(number).padStart(2, "0")} ${severityLabel(problem.severity)} · ${problem.title}`;
  lines.push(header);

  // Location
  if (problem.location) {
    lines.push(`**位置**: \`${problem.location}\``);
  }

  // Status tags
  const tags: string[] = [problem.statusLabel];
  if (problem.blocking) tags.push("账本阻塞");
  if (problem.sourceTags.length > 0) tags.push(...problem.sourceTags);
  if (problem.members.length > 1) tags.push(`合并 ${problem.members.length} 条`);
  lines.push(`**状态**: ${tags.join(" · ")}`);

  // Basis (root cause from groups)
  if (problem.basis && problem.basis.trim().length > 0) {
    lines.push(`**根因**: ${problem.basis.trim()}`);
  }

  // Extract actionable suggestion from first member
  const suggestion = extractActionableSuggestion(problem);
  if (suggestion) {
    lines.push(`**建议**: ${suggestion}`);
  }

  return lines.join("\n");
}

/**
 * Extract a one-line actionable suggestion from the first member's text.
 * Looks for 建议 section; returns null if no clear suggestion found or too long.
 */
function extractActionableSuggestion(problem: FindingListProblem): string | null {
  const first = problem.members[0];
  if (!first) return null;

  const suggestionMatch = first.text.match(/^\s*建议\s*[:：]\s*(.+)$/m);
  if (!suggestionMatch) return null;

  const suggestion = suggestionMatch[1].trim();
  // Keep it short: limit to ~200 chars for a one-line trigger
  if (suggestion.length > 200) {
    return suggestion.slice(0, 197) + "...";
  }
  return suggestion;
}

function filterLabel(filter: FindingListFilter): string {
  const labels: Record<FindingListFilter, string> = {
    blocking: "阻塞",
    pending: "待处理",
    resolved: "已解决",
    all: "全部",
  };
  return labels[filter];
}
