import { type LedgerFinding, isFindingVerifiedClosed } from "./cli-ledger";
import {
  type AdjudicationProjection,
  type GateAcceptanceView,
  gateAcceptanceView,
} from "./repair-adjudication";
import { type RepairIdentityFacts, identityUnknownReasons, isKnown } from "./repair-identity";
import { expectedGatePolicyHash, policyHashMatches } from "./repair-policy";

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
  | "pr_drift"
  | "policy_unknown"
  | "identity_unknown";

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

export type RepairGateStage = "local_candidate" | "published_pr";

export interface RepairGateInput {
  source: { runId: string; prUrl: string; sha: string | "unknown" };
  candidateSha: string;
  publishedSha: string | null | "unknown";
  remoteHead: string | null | "unknown";
  baseUnchanged: boolean | "unknown";
  prOpen: boolean | "unknown";
  squad: RepairGateSquadCandidate | null;
  review: RepairGateReview;
  policyHash: string | "unknown";
  checkedAt: string;
  adoptedExistingRemote?: boolean;
  stage?: RepairGateStage;
  acceptance?: GateAcceptanceView;
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
  stage: RepairGateStage;
}

export function extractAggregatorVerdict(
  markdown: string | null | undefined,
): RepairGateReview["aggregatorVerdict"] {
  if (!markdown) return null;
  const match = /\b(approve|changes-requested|comment)\b/.exec(markdown);
  if (match?.[1] === "approve" || match?.[1] === "changes-requested" || match?.[1] === "comment") {
    return match[1];
  }
  return null;
}

function sha40(value: string | null | undefined): boolean {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function acceptedWithReason(row: LedgerFinding): boolean {
  return row.status === "accepted" && Boolean(row.acceptedReason?.trim());
}

export function assembleRepairGateInput(input: {
  frozenPolicyHash: string | null | undefined;
  identity: RepairIdentityFacts;
  source: { runId: string; prUrl: string };
  squad: RepairGateSquadCandidate | null;
  review: RepairGateReview;
  checkedAt: string;
  stage?: RepairGateStage;
  acceptance?: GateAcceptanceView;
  projection?: AdjudicationProjection;
}): RepairGateInput {
  const expected = expectedGatePolicyHash(input.frozenPolicyHash);
  const sourceSha = isKnown(input.identity.sourceSha) ? input.identity.sourceSha.value : "unknown";
  const publishedSha = isKnown(input.identity.publishedSha)
    ? input.identity.publishedSha.value
    : "unknown";
  const remoteHead = isKnown(input.identity.remoteHead)
    ? input.identity.remoteHead.value
    : "unknown";
  const baseUnchanged = isKnown(input.identity.baseUnchanged)
    ? input.identity.baseUnchanged.value
    : "unknown";
  const prOpen = isKnown(input.identity.prOpen) ? input.identity.prOpen.value : "unknown";
  return {
    source: { runId: input.source.runId, prUrl: input.source.prUrl, sha: sourceSha },
    candidateSha: input.identity.candidateSha,
    publishedSha,
    remoteHead,
    baseUnchanged,
    prOpen,
    squad: input.squad,
    review: input.review,
    policyHash: expected,
    checkedAt: input.checkedAt,
    adoptedExistingRemote: input.identity.adoptedExistingRemote,
    stage: input.stage ?? "published_pr",
    acceptance:
      input.acceptance ?? (input.projection ? gateAcceptanceView(input.projection) : undefined),
  };
}

export function evaluateRepairGate(input: RepairGateInput): RepairGateResult {
  const reasons: RepairGateReason[] = [];
  const candidate = input.candidateSha.toLowerCase();
  const stage = input.stage ?? "published_pr";
  const policyHash = input.policyHash === "unknown" ? "unknown" : input.policyHash;

  if (input.policyHash === "unknown") {
    reasons.push({
      code: "policy_unknown",
      evidence: "frozen gate policy hash is unknown; refusing to use candidate-claimed hash",
    });
  }

  if (
    !sha40(candidate) ||
    input.source.sha === "unknown" ||
    input.source.sha.toLowerCase() !== candidate ||
    input.review.sha.toLowerCase() !== candidate ||
    (typeof input.publishedSha === "string" &&
      input.publishedSha !== "unknown" &&
      input.publishedSha.toLowerCase() !== candidate) ||
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
    !policyHashMatches(input.policyHash, squad.gatePolicyHash)
  ) {
    reasons.push({
      code: "squad_candidate_invalid",
      evidence:
        squad === null
          ? "missing squad candidate"
          : `task=${squad.taskId} sha=${squad.sha} expectedPolicy=${input.policyHash} observedPolicy=${squad.gatePolicyHash}`,
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

  const acceptance = input.acceptance;
  const uncovered = [
    ...(acceptance?.coverageGaps ?? []),
    ...(!acceptance && input.review.uncoveredIds.length > 0 ? input.review.uncoveredIds : []),
  ];
  if (input.review.evidenceComplete !== true || uncovered.length > 0) {
    reasons.push({
      code: "coverage_incomplete",
      evidence:
        input.review.evidenceComplete === undefined
          ? "evidenceComplete omitted"
          : `uncovered=${uncovered.join(",")}`,
    });
  }

  let open: string[];
  if (acceptance) {
    open = [...acceptance.openIds, ...acceptance.blockingOutOfScope];
  } else {
    open = input.review.findings
      .filter((row) => !acceptedWithReason(row) && !isFindingVerifiedClosed(row, candidate))
      .map((row) => row.id);
  }
  if (open.length > 0) {
    reasons.push({
      code: "findings_open",
      evidence: open.join(","),
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

  if (stage === "published_pr") {
    const publishedUnknown = input.publishedSha === "unknown";
    const remoteUnknown = input.remoteHead === "unknown" || input.remoteHead === null;
    const remoteMismatch =
      typeof input.remoteHead === "string" &&
      input.remoteHead !== "unknown" &&
      input.remoteHead.toLowerCase() !== candidate;
    const publishedMismatch =
      typeof input.publishedSha === "string" &&
      input.publishedSha !== "unknown" &&
      input.publishedSha.toLowerCase() !== candidate;
    const adopted =
      input.adoptedExistingRemote === true &&
      typeof input.remoteHead === "string" &&
      input.remoteHead !== "unknown" &&
      input.remoteHead.toLowerCase() === candidate;
    if (
      input.baseUnchanged === "unknown" ||
      input.prOpen === "unknown" ||
      (publishedUnknown && !adopted) ||
      remoteUnknown ||
      remoteMismatch ||
      publishedMismatch ||
      input.baseUnchanged !== true ||
      input.prOpen !== true
    ) {
      reasons.push({
        code:
          input.baseUnchanged === "unknown" || input.prOpen === "unknown" || publishedUnknown
            ? "identity_unknown"
            : "pr_drift",
        evidence: `head=${input.remoteHead} baseUnchanged=${input.baseUnchanged} open=${input.prOpen} published=${input.publishedSha} adopted=${adopted}`,
      });
    }
  }

  return {
    passed: reasons.length === 0,
    candidateSha: candidate,
    checkedAt: input.checkedAt,
    policyHash: policyHash === "unknown" ? "unknown" : policyHash,
    sourceReviewRunId: input.source.runId,
    finalReviewRunId: input.review.runId,
    squadTaskId: squad?.taskId ?? null,
    reasons,
    stage,
  };
}

export function identityAssemblyNotes(facts: RepairIdentityFacts): string[] {
  return identityUnknownReasons(facts);
}
