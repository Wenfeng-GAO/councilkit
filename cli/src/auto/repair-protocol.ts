import type { GateAcceptanceView } from "@shared/runtime/repair-adjudication";
import type { VerificationAsset } from "@shared/runtime/repair-contract";
import {
  type RepairGateInput,
  type RepairGateReview,
  type RepairGateSquadCandidate,
  assembleRepairGateInput,
} from "@shared/runtime/repair-gate";
import {
  type RepairIdentityFacts,
  baseUnchangedFact,
  prOpenFact,
  publishedShaFact,
  remoteHeadFact,
  sourceShaFact,
} from "@shared/runtime/repair-identity";
import type { CheckedOutPr } from "./checkout-pr";

export function frozenPolicyOrUnknown(value: string | null | undefined): string | "unknown" {
  return value && /^[a-f0-9]{64}$/.test(value) ? value : "unknown";
}

export function identityFromRemote(input: {
  candidateSha: string;
  publishedSha?: string | null;
  remote: CheckedOutPr;
  frozenBaseSha?: string | null;
  expectedBaseBranch: string;
  adoptedExistingRemote?: boolean;
  unpublished?: boolean;
}): RepairIdentityFacts {
  return {
    sourceSha: sourceShaFact(input.candidateSha),
    candidateSha: input.candidateSha.toLowerCase(),
    publishedSha: publishedShaFact(input.unpublished ? null : (input.publishedSha ?? null), {
      missingMeans: input.unpublished ? "unpublished" : "unknown",
    }),
    remoteHead: remoteHeadFact(input.remote.headSha ?? null),
    baseUnchanged: baseUnchangedFact({
      frozenBaseSha: input.frozenBaseSha,
      observedBaseSha: input.remote.baseSha ?? null,
      expectedBaseBranch: input.expectedBaseBranch,
      observedBaseBranch: input.remote.baseBranch,
    }),
    prOpen: prOpenFact(input.remote.prOpen),
    adoptedExistingRemote: input.adoptedExistingRemote === true,
  };
}

export function assembleProductionGate(input: {
  frozenPolicyHash: string | null | undefined;
  candidateSha: string;
  publishedSha?: string | null;
  remote: CheckedOutPr;
  frozenBaseSha?: string | null;
  expectedBaseBranch: string;
  source: { runId: string; prUrl: string };
  squad: RepairGateSquadCandidate | null;
  review: RepairGateReview;
  checkedAt: string;
  unpublished?: boolean;
  adoptedExistingRemote?: boolean;
  acceptance?: GateAcceptanceView;
  verificationAssets?: VerificationAsset[];
  requiredAssertionIds?: string[];
}): RepairGateInput {
  return assembleRepairGateInput({
    frozenPolicyHash: input.frozenPolicyHash,
    identity: identityFromRemote({
      candidateSha: input.candidateSha,
      publishedSha: input.publishedSha,
      remote: input.remote,
      frozenBaseSha: input.frozenBaseSha,
      expectedBaseBranch: input.expectedBaseBranch,
      adoptedExistingRemote: input.adoptedExistingRemote,
      unpublished: input.unpublished,
    }),
    source: input.source,
    squad: input.squad,
    review: input.review,
    checkedAt: input.checkedAt,
    stage: input.unpublished ? "local_candidate" : "published_pr",
    acceptance: input.acceptance,
    verificationAssets: input.verificationAssets,
    requiredAssertionIds: input.requiredAssertionIds,
  });
}

export function isV2Protocol(value: string | null | undefined): boolean {
  return value === "v2";
}
