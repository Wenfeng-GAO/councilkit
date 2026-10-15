/**
 * 「需要处理」 / 阻塞 counts — the ONE function the run list, the report page and
 * `councilkit runs list` read (#289, #288, QA-PR295-OBS2).
 *
 * - needsAttention: deduped problems that are still unresolved AND are either
 *   blocking or critical/major. Counted after dedupe, so it matches the
 *   「N 个问题」 headline. It does not depend on a PR, a SHA or a spec contract:
 *   a task-mode run with open majors still needs a person.
 * - blocking: the aggregator's blockingCount is the source of truth. Falls
 *   back to the ledger's deduped blocking problems when no aggregator result
 *   exists (older runs, demo sample).
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
  blockingSource: "aggregator" | "ledger";
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
  const fromAggregator = aggregatorBlockingCount(input.progress);
  return {
    problems: projection.displayCount,
    findings: projection.originalCount,
    needsAttention,
    blocking: fromAggregator ?? projection.blockingCount,
    blockingSource: fromAggregator === null ? "ledger" : "aggregator",
  };
}
