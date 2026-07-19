import type { ModelExecution, ModelExecutionUsage } from "@/models/discussion/model-execution";

/**
 * UsageBadge (S7): the first UI consumer of persisted `ModelExecution.usage`.
 * Zero new collection — only already-persisted rows are displayed.
 *
 * Aggregation ruling (#6): every persisted execution counts, INCLUDING
 * discarded/failed rows (the tokens were burned; cost transparency first —
 * the copy therefore reads 「累计用量」, never 「已采纳用量」). Null fields
 * count as 0 but are tracked via hasTokens/hasCost, and an all-null aggregate
 * renders NOTHING (no "$0" mirage for drivers that never report cost).
 *
 * The pure functions are exported for unit tests (the parseMaxRoundsInput /
 * deriveReleaseGate precedent); Session 2 wires the component into RoomHeader
 * and DiscussionStream.
 */

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** True once any execution reported input/output tokens. */
  hasTokens: boolean;
  /** True once any execution reported a cost. */
  hasCost: boolean;
}

export function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, hasTokens: false, hasCost: false };
}

export function addUsage(
  totals: UsageTotals,
  usage: ModelExecutionUsage | null | undefined,
): UsageTotals {
  if (!usage) return totals;
  const input = usage.inputTokens ?? null;
  const output = usage.outputTokens ?? null;
  const cost = usage.costUsd ?? null;
  return {
    inputTokens: totals.inputTokens + (input ?? 0),
    outputTokens: totals.outputTokens + (output ?? 0),
    costUsd: totals.costUsd + (cost ?? 0),
    hasTokens: totals.hasTokens || input !== null || output !== null,
    hasCost: totals.hasCost || cost !== null,
  };
}

/** All persisted executions, no state filter (ruling #6). */
export function aggregateUsage(executions: readonly ModelExecution[]): UsageTotals {
  return executions.reduce(
    (totals, execution) => addUsage(totals, execution.usage),
    emptyUsageTotals(),
  );
}

export function aggregateUsageByRound(
  executions: readonly ModelExecution[],
): Map<string, UsageTotals> {
  const byRound = new Map<string, UsageTotals>();
  for (const execution of executions) {
    byRound.set(
      execution.roundId,
      addUsage(byRound.get(execution.roundId) ?? emptyUsageTotals(), execution.usage),
    );
  }
  return byRound;
}

function formatTokenCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function formatCost(costUsd: number): string {
  return `$${costUsd >= 1 ? costUsd.toFixed(2) : costUsd.toFixed(4)}`;
}

/** The numeric part only; an all-null aggregate formats to "" (component
 * renders nothing). */
export function formatUsageTotals(totals: UsageTotals): string {
  const parts: string[] = [];
  if (totals.hasTokens) {
    parts.push(
      `↑${formatTokenCount(totals.inputTokens)} ↓${formatTokenCount(totals.outputTokens)}`,
    );
  }
  if (totals.hasCost) parts.push(formatCost(totals.costUsd));
  return parts.join(" · ");
}

export function UsageBadge({
  totals,
  className = "",
}: {
  totals: UsageTotals;
  className?: string;
}) {
  const text = formatUsageTotals(totals);
  if (!text) return null;
  return (
    <span
      className={`inline-flex items-center rounded border border-edge bg-surface-2 px-2 py-0.5 text-xs leading-snug text-muted ${className}`}
      title="累计用量：全部已落库执行（含未采纳与失败）的 token 与成本合计"
    >
      累计用量 {text}
    </span>
  );
}
