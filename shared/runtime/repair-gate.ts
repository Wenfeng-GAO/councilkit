import { type LedgerFinding, isFindingVerifiedClosed } from "./cli-ledger";

export const REPAIR_PROGRESS_PHASES = [
  "repair-preparing",
  "repair-squad-repair",
  "repair-squad-verify",
  "repair-publishing",
  "repair-reviewing",
  "repair-diagnosing",
  "repair-finalizing",
] as const;
export type RepairProgressPhase = (typeof REPAIR_PROGRESS_PHASES)[number];

export const REPAIR_BUSINESS_RESULTS = ["approved", "needs_attention", "stopped"] as const;
export type RepairBusinessResult = (typeof REPAIR_BUSINESS_RESULTS)[number];

export type RepairGateReasonCode =
  | "identity_mismatch"
  | "squad_candidate_invalid"
  | "councilkit_incomplete"
  | "coverage_incomplete"
  | "findings_open"
  | "verdict_contradiction"
  | "exception_untraceable"
  | "pr_drift";

export interface RepairGateSquadCandidate {
  taskId: string;
  invalidated: boolean;
  independentReview: boolean;
  independentVerify: boolean;
  requiredGatesPassed: boolean;
  sha: string;
  gatePolicyHash: string;
}

export interface RepairGateReview {
  runId: string;
  incomplete: boolean;
  seatsAllSuccess: boolean;
  aggregatorComplete: boolean;
  artifactsOk: boolean;
  sha: string;
  evidenceComplete: boolean | undefined;
  uncoveredIds: string[];
  aggregatorVerdict: "approve" | "changes-requested" | "comment" | null;
  findings: LedgerFinding[];
}

export interface RepairGateInput {
  source: { runId: string; prUrl: string; sha: string };
  candidateSha: string;
  publishedSha: string | null;
  remoteHead: string | null;
  baseUnchanged: boolean;
  prOpen: boolean;
  squad: RepairGateSquadCandidate | null;
  review: RepairGateReview;
  policyHash: string;
  checkedAt: string;
}

export interface RepairGateReason {
  code: RepairGateReasonCode;
  evidence: string;
}

export interface RepairGateResult {
  passed: boolean;
  candidateSha: string;
  checkedAt: string;
  policyHash: string;
  sourceReviewRunId: string;
  finalReviewRunId: string;
  squadTaskId: string | null;
  reasons: RepairGateReason[];
}

function sha40(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function acceptedWithReason(row: LedgerFinding): boolean {
  return row.status === "accepted" && Boolean(row.acceptedReason?.trim());
}

export function evaluateRepairGate(input: RepairGateInput): RepairGateResult {
  const reasons: RepairGateReason[] = [];
  const candidate = input.candidateSha.toLowerCase();

  if (
    !sha40(candidate) ||
    input.source.sha.toLowerCase() !== candidate ||
    input.review.sha.toLowerCase() !== candidate ||
    (input.publishedSha !== null && input.publishedSha.toLowerCase() !== candidate) ||
    !input.source.prUrl ||
    !input.source.runId
  ) {
    reasons.push({
      code: "identity_mismatch",
      evidence: `source=${input.source.sha} review=${input.review.sha} published=${input.publishedSha}`,
    });
  }

  const squad = input.squad;
  if (
    squad === null ||
    squad.invalidated ||
    !squad.independentReview ||
    !squad.independentVerify ||
    !squad.requiredGatesPassed ||
    squad.sha.toLowerCase() !== candidate ||
    squad.gatePolicyHash !== input.policyHash
  ) {
    reasons.push({
      code: "squad_candidate_invalid",
      evidence:
        squad === null ? "missing squad candidate" : `task=${squad.taskId} sha=${squad.sha}`,
    });
  }

  if (
    input.review.incomplete ||
    !input.review.seatsAllSuccess ||
    !input.review.aggregatorComplete ||
    !input.review.artifactsOk
  ) {
    reasons.push({
      code: "councilkit_incomplete",
      evidence: `incomplete=${input.review.incomplete} seats=${input.review.seatsAllSuccess} aggregator=${input.review.aggregatorComplete}`,
    });
  }

  if (input.review.evidenceComplete !== true || input.review.uncoveredIds.length > 0) {
    reasons.push({
      code: "coverage_incomplete",
      evidence:
        input.review.evidenceComplete === undefined
          ? "evidenceComplete omitted"
          : `uncovered=${input.review.uncoveredIds.join(",")}`,
    });
  }

  const open = input.review.findings.filter(
    (row) => !acceptedWithReason(row) && !isFindingVerifiedClosed(row, candidate),
  );
  if (open.length > 0) {
    reasons.push({
      code: "findings_open",
      evidence: open.map((row) => row.id).join(","),
    });
  }

  const untraceable = input.review.findings.filter(
    (row) => row.status === "accepted" && !row.acceptedReason?.trim(),
  );
  if (untraceable.length > 0) {
    reasons.push({
      code: "exception_untraceable",
      evidence: untraceable.map((row) => row.id).join(","),
    });
  }

  if (input.review.aggregatorVerdict === "changes-requested" && open.length === 0) {
    reasons.push({
      code: "verdict_contradiction",
      evidence: "aggregator=changes-requested with no open findings",
    });
  }

  if (
    input.remoteHead === null ||
    input.remoteHead.toLowerCase() !== candidate ||
    !input.baseUnchanged ||
    !input.prOpen
  ) {
    reasons.push({
      code: "pr_drift",
      evidence: `head=${input.remoteHead} baseUnchanged=${input.baseUnchanged} open=${input.prOpen}`,
    });
  }

  return {
    passed: reasons.length === 0,
    candidateSha: candidate,
    checkedAt: input.checkedAt,
    policyHash: input.policyHash,
    sourceReviewRunId: input.source.runId,
    finalReviewRunId: input.review.runId,
    squadTaskId: squad?.taskId ?? null,
    reasons,
  };
}
