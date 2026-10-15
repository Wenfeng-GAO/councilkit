/**
 * 「需要处理」 / 阻塞 counts — the ONE function the run list, the report page and
 * `councilkit runs list` read (#289, #288, QA-PR295-OBS2).
 *
 * - needsAttention: deduped problems that are still unresolved AND are either
 *   blocking or critical/major. Counted after dedupe, so it matches the
 *   「N 个问题」 headline. It does not depend on a PR, a SHA or a spec contract:
 *   a task-mode run with open majors still needs a person.
 * - blocking: deduped ledger problems that are blocking (isFindingBlocking:
 *   critical/major, open, not 规格外 / out_of_spec). QA-PR295-OBS3: the
 *   aggregator's progress blockingCount is a regex over its raw markdown and
 *   counted severities quoted in prose (## 分歧), so it is kept only as a
 *   diagnostic (aggregatorBlocking), never shown as 阻塞.
 */
import type { LedgerFinding } from "./cli-ledger";
import type { CliRunProgress } from "./cli-run-progress";
import type { FindingGroupsFile } from "./finding-groups";
import { projectFindingList } from "./finding-list";

export interface RunAttentionCounts {
  /** Deduped problems (the 「N 个问题」 headline). */
  problems: number;
  /** Raw findings before dedupe. */
  findings: number;
  needsAttention: number;
  blocking: number;
  /** Diagnostic only: what the aggregator's progress result claimed. */
  aggregatorBlocking: number | null;
}

export function aggregatorBlockingCount(
  progress: Pick<CliRunProgress, "attempts"> | null | undefined,
): number | null {
  const aggregator = progress?.attempts.find((attempt) => attempt.role === "aggregator");
  const count = aggregator?.result?.blockingCount;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}

export function computeRunAttention(input: {
  findings: readonly LedgerFinding[];
  sha?: string | null;
  groups?: FindingGroupsFile | null;
  progress?: Pick<CliRunProgress, "attempts"> | null;
}): RunAttentionCounts {
  const projection = projectFindingList(input.findings, {
    sha: input.sha ?? null,
    groups: input.groups ?? null,
  });
  const needsAttention = projection.problems.filter(
    (problem) =>
      !problem.resolved &&
      (problem.blocking || problem.severity === "critical" || problem.severity === "major"),
  ).length;
  return {
    problems: projection.displayCount,
    findings: projection.originalCount,
    needsAttention,
    blocking: projection.blockingCount,
    aggregatorBlocking: aggregatorBlockingCount(input.progress),
  };
}

/** 「N 需要处理 · M 阻塞」 — the one label the report page and run-list cards show (#304). */
export function formatAttentionLabel(
  counts: Pick<RunAttentionCounts, "needsAttention" | "blocking">,
): string {
  return `${counts.needsAttention} 需要处理 · ${counts.blocking} 阻塞`;
}
