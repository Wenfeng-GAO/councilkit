import type { LedgerFinding } from "./cli-ledger";

export type FailureClass =
  | "source_fix_failed"
  | "coverage_gap"
  | "fact_conflict"
  | "format_fault"
  | "environment_fault"
  | "diagnose";

export interface RootCauseFailure {
  rootCauseId: string;
  validSourceFixFailures: number;
  lastEvidence: string;
}

export function classifyFailure(input: {
  formatFault?: boolean;
  environmentFault?: boolean;
  coverageGap?: boolean;
  factConflict?: boolean;
  sourceFixFailed?: boolean;
}): FailureClass {
  if (input.formatFault) return "format_fault";
  if (input.environmentFault) return "environment_fault";
  if (input.coverageGap) return "coverage_gap";
  if (input.factConflict) return "fact_conflict";
  if (input.sourceFixFailed) return "source_fix_failed";
  return "source_fix_failed";
}

export function countsAsRootCauseFailure(kind: FailureClass): boolean {
  return kind === "source_fix_failed";
}

export function shouldEnterDiagnosis(
  failures: RootCauseFailure[],
  rootCauseId: string,
  limit = 2,
): boolean {
  const row = failures.find((item) => item.rootCauseId === rootCauseId);
  return (row?.validSourceFixFailures ?? 0) >= limit;
}

export function recordRootCauseFailure(
  failures: RootCauseFailure[],
  rootCauseId: string,
  evidence: string,
): RootCauseFailure[] {
  const existing = failures.find((item) => item.rootCauseId === rootCauseId);
  if (!existing) {
    return [...failures, { rootCauseId, validSourceFixFailures: 1, lastEvidence: evidence }];
  }
  return failures.map((item) =>
    item.rootCauseId === rootCauseId
      ? {
          ...item,
          validSourceFixFailures: item.validSourceFixFailures + 1,
          lastEvidence: evidence,
        }
      : item,
  );
}

export function stillOpenRootCauses(
  findings: LedgerFinding[],
  rootCauseOf: (id: string) => string,
): string[] {
  const open = new Set<string>();
  for (const row of findings) {
    if (row.status === "accepted") continue;
    if (row.verification?.outcome === "verified_closed") continue;
    open.add(rootCauseOf(row.id));
  }
  return [...open];
}

export function recoveryActionFor(reasonCode: string): string {
  switch (reasonCode) {
    case "coverage_incomplete":
    case "coverage_gap":
      return "补证：回到缺失的原阶段，不新开源码修复";
    case "findings_open":
    case "source_fix_failed":
      return "源码修复：在剩余派工预算内针对仍开放的根因";
    case "verdict_contradiction":
    case "fact_conflict":
      return "事实裁决：保留原断言，登记新反例";
    case "pr_drift":
      return "发布核验：读回远端，不盲目重发";
    case "squad_candidate_invalid":
    case "identity_mismatch":
      return "身份补证：冻结策略与 SHA 对齐后再准出";
    case "write_cutoff":
    case "deadline":
      return "终验或需要处理：不足写入预算时不再开写";
    case "same_root_cause":
      return "只读诊断：两次有效源码失败后先诊断";
    default:
      return "需要处理：查看原因后选择恢复入口";
  }
}
