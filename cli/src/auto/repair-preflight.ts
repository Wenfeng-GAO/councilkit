import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCliRun } from "@shared/runtime/cli-runs-index";
import { canExportRepairPackage } from "@shared/runtime/review-case";
import {
  SQUAD_BRIDGE_CONTRACT_VERSION,
  assertSquadBridgeVersion,
} from "@shared/runtime/squad-bridge-contract";
import { errors } from "../errors";
import { type CheckedOutPr, requirePrHeadIdentity } from "./checkout-pr";
import type { RepairProfile } from "./repair-profile";

export interface RepairPreflightOk {
  ok: true;
  pr: CheckedOutPr;
  sourceSha: string;
  openFindingIds: string[];
}

export interface RepairPreflightFail {
  ok: false;
  reasonCode: string;
  message: string;
}

export type RepairPreflightResult = RepairPreflightOk | RepairPreflightFail;

export function assertRepairWorkspace(cwd: string): void {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown };
    if (pkg.name === "councilkit" && existsSync(join(cwd, "cli", "src", "commands", "repair.ts"))) {
      throw errors.usage("repair workspace must not be the CouncilKit checkout");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "CliError") throw error;
  }
}

export function runRepairPreflight(input: {
  sourceRunId: string;
  profile: RepairProfile;
  pr: CheckedOutPr;
  bridgeVersion: string | null;
  historyCount?: number | null;
  parentOuterUsed?: number;
  workspaceCwd?: string;
}): RepairPreflightResult {
  try {
    assertSquadBridgeVersion({
      requested: SQUAD_BRIDGE_CONTRACT_VERSION,
      actual: input.bridgeVersion,
    });
  } catch {
    return {
      ok: false,
      reasonCode: "BRIDGE_VERSION_MISSING",
      message: "squad bridge version missing",
    };
  }
  const version = assertSquadBridgeVersion({
    requested: SQUAD_BRIDGE_CONTRACT_VERSION,
    actual: input.bridgeVersion,
  });
  if (!version.ok) {
    return { ok: false, reasonCode: version.code, message: "squad bridge version is incompatible" };
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
    assertRepairWorkspace(input.workspaceCwd ?? process.cwd());
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
  if (sourceSha.toLowerCase() !== input.pr.headSha?.toLowerCase()) {
    return {
      ok: false,
      reasonCode: "identity_mismatch",
      message: "remote HEAD does not match the source review SHA",
    };
  }
  const openFindingIds = source.findings
    .filter((row) => row.status !== "accepted")
    .map((row) => row.id);
  if (openFindingIds.length === 0 && !canExportRepairPackage(source)) {
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
  };
}
