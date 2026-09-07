import { z } from "zod";
import { type FindingsFile, isFindingBlocking, isFindingVerifiedClosed } from "./cli-ledger";
import { parseAntCodePrUrl, parseApplyPrUrl, parseGitHubPrUrl } from "./pr-url";

/** Compact evidence only: list responses never carry entire ledgers/reports. */
export const reviewEvidenceSchema = z
  .object({
    complete: z.boolean(),
    sha: z.string().nullable(),
    prUrl: z.string().nullable(),
    againstRunId: z.string().nullable(),
    blockingIds: z.array(z.string()).max(200),
    unverifiedFixIds: z.array(z.string()).max(200),
    openIds: z.array(z.string()).max(200),
  })
  .strict();
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;

export function normalizeReviewPr(pr: string | null): string | null {
  if (!pr) return null;
  const parsed = parseApplyPrUrl(pr);
  if (!parsed || !["http:", "https:"].includes(parsed.url.protocol)) return null;
  if (parsed.kind === "github") {
    const ref = parseGitHubPrUrl(parsed.url);
    return ref
      ? `https://github.com/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}/pull/${ref.number}`
      : null;
  }
  const ref = parseAntCodePrUrl(parsed.url);
  return ref ? `https://code.alipay.com/${ref.project}/pull_requests/${ref.iid}` : null;
}

export function summarizeReviewEvidence(input: {
  runId: string;
  complete: boolean;
  prUrl: string | null;
  againstRunId: string | null;
  ledger: FindingsFile | null;
}): ReviewEvidence {
  const ledger = input.ledger?.runId === input.runId ? input.ledger : null;
  const sha = /^[0-9a-f]{40}$/i.test(ledger?.sha ?? "") ? (ledger?.sha ?? null) : null;
  const rows = ledger?.findings ?? [];
  const unresolved = rows.filter((row) => !isFindingVerifiedClosed(row, sha));
  return {
    complete: input.complete && ledger !== null && sha !== null,
    sha,
    prUrl: normalizeReviewPr(input.prUrl),
    againstRunId: ledger?.againstRunId ?? input.againstRunId,
    blockingIds: rows.filter((row) => isFindingBlocking(row, sha)).map((row) => row.id),
    unverifiedFixIds: unresolved
      .filter((row) => row.repairClaim || row.status === "closed")
      .map((row) => row.id),
    openIds: unresolved
      .filter((row) => row.status !== "accepted" || isFindingBlocking(row, sha))
      .map((row) => row.id),
  };
}

export interface ReviewCaseRun {
  runId: string;
  kind: string;
  status: string;
  startedAt: string | null;
  reviewEvidence?: ReviewEvidence | null;
}

export function isCompleteReviewRun(run: ReviewCaseRun | null | undefined): boolean {
  return (
    run?.kind === "review" && run.status === "completed" && run.reviewEvidence?.complete === true
  );
}

/** Each run contributes once, and only through the selected baseline's against chain. */
export function summarizePrCase(runs: readonly ReviewCaseRun[]) {
  const reviews = runs
    .filter((run) => run.kind === "review" && run.reviewEvidence?.prUrl)
    .slice()
    .sort(
      (a, b) =>
        (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.runId.localeCompare(a.runId),
    );
  const latest = reviews[0] ?? null;
  const prUrl = latest?.reviewEvidence?.prUrl ?? null;
  const samePr = reviews.filter((run) => run.reviewEvidence?.prUrl === prUrl);
  const baseline = samePr.find(isCompleteReviewRun) ?? null;
  const byId = new Map(samePr.map((run) => [run.runId, run]));
  const seen = new Set<string>();
  const repeated = new Map<string, number>();
  let cursor = baseline;
  while (cursor && isCompleteReviewRun(cursor) && !seen.has(cursor.runId)) {
    seen.add(cursor.runId);
    if (cursor.reviewEvidence?.complete) {
      for (const id of new Set(cursor.reviewEvidence.openIds))
        repeated.set(id, (repeated.get(id) ?? 0) + 1);
    }
    cursor = byId.get(cursor.reviewEvidence?.againstRunId ?? "") ?? null;
  }
  const previous = byId.get(baseline?.reviewEvidence?.againstRunId ?? "") ?? null;
  const needsRecovery = Boolean(latest && !isCompleteReviewRun(latest));
  const evidence = baseline?.reviewEvidence;
  const repeatedIds = (evidence?.openIds ?? []).filter((id) => (repeated.get(id) ?? 0) >= 2);
  return {
    prUrl,
    baseline,
    latest,
    needsRecovery,
    comparison:
      baseline && previous && isCompleteReviewRun(previous)
        ? { current: baseline.runId, previous: previous.runId }
        : null,
    blockingCount: evidence?.blockingIds.length ?? null,
    unverifiedFixCount: evidence?.unverifiedFixIds.length ?? null,
    repeatedIds,
    nextAction: !baseline
      ? "等待完整审查证据"
      : needsRecovery
        ? "恢复最新审查，确认当前 PR SHA"
        : (evidence?.unverifiedFixIds.length ?? 0) > 0
          ? "复审候选，核实修复声明"
          : repeatedIds.length > 0
            ? "同一问题再次出现，先检查根因与验收条件"
            : (evidence?.blockingIds.length ?? 0) > 0
              ? "导出修复任务，处理未决重大项"
              : "核对验收和当前 PR SHA 后决定下一步",
  };
}
