import { readCliRun } from "@shared/runtime/cli-runs-index";
import { canExportRepairPackage } from "@shared/runtime/review-case";
import {
  SQUAD_BRIDGE_CONTRACT_VERSION,
  assertSquadBridgeVersion,
} from "@shared/runtime/squad-bridge-contract";
import { type CheckedOutPr, requirePrHeadIdentity } from "./checkout-pr";
import type { RepairProfile } from "./repair-profile";
import { assertRepairWorkspace } from "./repair-workspace";

export interface RepairPreflightOk {
  ok: true;
  pr: CheckedOutPr;
  sourceSha: string;
  openFindingIds: string[];
  needsSupplement: boolean;
  supplementReason: "incomplete" | "sha_drift" | null;
}

export interface RepairPreflightFail {
  ok: false;
  reasonCode: string;
  message: string;
}

export type RepairPreflightResult = RepairPreflightOk | RepairPreflightFail;

export { assertRepairWorkspace };

export function sourceNeedsSupplementReview(
  source: NonNullable<ReturnType<typeof readCliRun>>,
): boolean {
  const evidence = source.reviewEvidence;
  if (evidence?.complete !== true) return true;
  if (evidence.evidenceComplete !== true) return true;
  if ((evidence.uncoveredIds?.length ?? 0) > 0) return true;
  const failed = source.progress?.attempts.some(
    (attempt) => attempt.status === "failure" || attempt.status === "cancelled",
  );
  return Boolean(failed);
}

export function runRepairPreflight(input: {
  sourceRunId: string;
  profile: RepairProfile;
  pr: CheckedOutPr;
  bridgeVersion: string | null;
  historyCount?: number | null;
  parentOuterUsed?: number;
  workspaceCwd: string;
  expectedHeadSha?: string | null;
  allowSupplement?: boolean;
}): RepairPreflightResult {
  const version = assertSquadBridgeVersion({
    requested: SQUAD_BRIDGE_CONTRACT_VERSION,
    actual: input.bridgeVersion,
  });
  if (!version.ok) {
    return {
      ok: false,
      reasonCode: version.code,
      message:
        version.code === "BRIDGE_VERSION_MISSING"
          ? "squad bridge version missing"
          : "squad bridge version is incompatible",
    };
  }
  try {
    requirePrHeadIdentity(input.pr);
  } catch (error) {
    return {
      ok: false,
      reasonCode: "identity_mismatch",
      message: error instanceof Error ? error.message : "missing headSha",
    };
  }
  try {
    assertRepairWorkspace(input.workspaceCwd);
  } catch (error) {
    return {
      ok: false,
      reasonCode: "pr_drift",
      message: error instanceof Error ? error.message : "workspace rejected",
    };
  }
  if (
    input.pr.branch !== input.profile.sourceBranch ||
    input.pr.baseBranch !== input.profile.base
  ) {
    return { ok: false, reasonCode: "pr_drift", message: "profile identity drifted" };
  }
  const source = readCliRun(input.sourceRunId);
  if (source === null || source.kind !== "review") {
    return { ok: false, reasonCode: "councilkit_incomplete", message: "source review not found" };
  }
  const sourceSha = source.reviewEvidence?.sha ?? "";
  const expected = (input.expectedHeadSha ?? sourceSha).toLowerCase();
  const remote = (input.pr.headSha ?? "").toLowerCase();
  const shaDrift = expected.length === 40 && remote !== expected;
  const allowSupplement = input.allowSupplement !== false;
  if (shaDrift && !allowSupplement) {
    return {
      ok: false,
      reasonCode: "pr_drift",
      message: "remote HEAD does not match the expected SHA for this repair stage",
    };
  }
  const incomplete = sourceNeedsSupplementReview(source);
  const openFindingIds = source.findings
    .filter((row) => row.status !== "accepted")
    .map((row) => row.id);
  if (openFindingIds.length === 0 && !canExportRepairPackage(source) && !incomplete && !shaDrift) {
    return {
      ok: false,
      reasonCode: "coverage_incomplete",
      message: "zero open findings without a complete same-SHA review",
    };
  }
  if (
    input.historyCount !== undefined &&
    input.historyCount !== null &&
    input.parentOuterUsed !== undefined &&
    input.historyCount !== input.parentOuterUsed
  ) {
    return {
      ok: false,
      reasonCode: "verdict_contradiction",
      message: `repair history ${input.historyCount} conflicts with parent outerUsed ${input.parentOuterUsed}`,
    };
  }
  return {
    ok: true,
    pr: input.pr,
    sourceSha,
    openFindingIds,
    needsSupplement: incomplete || shaDrift,
    supplementReason: shaDrift ? "sha_drift" : incomplete ? "incomplete" : null,
  };
}
