import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./digest";
import { isFrozenPolicyHash } from "./repair-policy";

const text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "blank");

export const VERDICT_ROLES = ["controller", "independent_adjudicator", "builder"] as const;

export const acceptanceMethodSchema = z
  .object({
    assertionId: text.max(160),
    precondition: text.max(4000),
    trigger: text.max(4000),
    allowedStimuli: z.array(text.max(400)).max(32),
    observation: text.max(4000),
    environment: text.max(4000),
    evidenceKind: z.enum(["regression_test", "code_trace", "command_receipt"]),
  })
  .strict();
export type AcceptanceMethod = z.infer<typeof acceptanceMethodSchema>;

export const goalContractSchema = z
  .object({
    version: z.number().int().positive(),
    goalId: text.max(80),
    sourceRunId: text.max(80),
    originalRequest: text.max(8000),
    goal: text.max(4000),
    nonGoals: z.array(text.max(4000)).max(32),
    invariants: z.array(text.max(8000)).max(200),
    allowedScope: z.array(text.max(400)).max(200),
    authorizedExceptions: z.array(text.max(2000)).max(32),
    acceptance: z.array(acceptanceMethodSchema).max(200),
    frozenPolicyHash: z.string().regex(/^[a-f0-9]{64}$/),
    chainId: text.max(80),
    createdAt: text.max(40),
  })
  .strict();
export type GoalContract = z.infer<typeof goalContractSchema>;

export const EXECUTION_SOURCES = [
  "squadctl-host-run",
  "squadctl-evidence",
  "ck-isolated-run",
  "independent-reviewer-trace",
] as const;

export const testRunReceiptSchema = z
  .object({
    command: z.string().max(2000).optional(),
    cwd: z.string().max(4096).optional(),
    exitCode: z.number().int().optional(),
    logPath: z.string().max(4096).optional(),
    snapshotSha: z.string().regex(/^[0-9a-f]{40}$/i),
    testAssetVersion: text.max(80),
    dirtyTree: z.boolean(),
    skipped: z.boolean(),
    ranZeroTests: z.boolean(),
    role: z.enum(VERDICT_ROLES),
    executionSource: z.enum(EXECUTION_SOURCES).optional(),
    locations: z.array(text.max(400)).max(32).optional(),
    stdoutHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    cacheKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type TestRunReceipt = z.infer<typeof testRunReceiptSchema>;

export const verificationAssetSchema = z
  .object({
    assertionId: text.max(160),
    snapshotSha: z.string().regex(/^[0-9a-f]{40}$/i),
    testAssetVersion: text.max(80),
    extraProbesDeclared: z.boolean(),
    extraProbeManifestVersion: text.max(80).optional(),
    kind: z.enum(["regression_test", "code_trace", "command_receipt"]).optional(),
    receipts: z.array(testRunReceiptSchema).max(16),
  })
  .strict();
export type VerificationAsset = z.infer<typeof verificationAssetSchema>;

export interface TaskCard {
  contractVersion: number;
  goal: string;
  candidateSha: string | null;
  responsibleAssertions: string[];
  originalCounterexamples: string[];
  rejectedApproaches: string[];
  missingEvidence: string[];
  remainingBudget: string;
}

export function contractFingerprint(contract: GoalContract): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        originalRequest: contract.originalRequest,
        goal: contract.goal,
        nonGoals: contract.nonGoals,
        invariants: contract.invariants,
        allowedScope: contract.allowedScope,
      }),
    )
    .digest("hex");
}

/** Stable chain identity: original request only. Finding titles must not mint a new chain. */
export function goalIdentityFingerprint(originalRequest: string): string {
  return createHash("sha256")
    .update(canonicalJson({ originalRequest: originalRequest.trim() }))
    .digest("hex");
}

export function buildGoalContract(input: {
  sourceRunId: string;
  originalRequest: string;
  goal: string;
  nonGoals?: string[];
  invariants: string[];
  allowedScope: string[];
  authorizedExceptions?: string[];
  acceptance: AcceptanceMethod[];
  chainId: string;
  frozenPolicyHash: string;
  createdAt?: string;
  version?: number;
  goalId?: string;
}): GoalContract {
  const frozen = input.frozenPolicyHash;
  if (!isFrozenPolicyHash(frozen)) {
    throw new Error("goal contract requires a frozen 64-char policy hash");
  }
  return goalContractSchema.parse({
    version: input.version ?? 1,
    goalId: input.goalId ?? `goal-${input.sourceRunId}`,
    sourceRunId: input.sourceRunId,
    originalRequest: input.originalRequest,
    goal: input.goal,
    nonGoals: input.nonGoals ?? [],
    invariants: input.invariants,
    allowedScope: input.allowedScope,
    authorizedExceptions: input.authorizedExceptions ?? [],
    acceptance: input.acceptance,
    frozenPolicyHash: frozen,
    chainId: input.chainId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

export function evaluateVerificationAsset(
  asset: VerificationAsset,
  assertionId: string,
): { ok: boolean; reason: string } {
  if (asset.assertionId !== assertionId) {
    return { ok: false, reason: "asset is bound to a different assertion" };
  }
  if (asset.receipts.length === 0) {
    return { ok: false, reason: "no test receipts" };
  }
  const kind = asset.kind ?? inferAssetKind(asset);
  for (const receipt of asset.receipts) {
    if (receipt.role === "builder") {
      return { ok: false, reason: "builder cannot certify verification" };
    }
    if (receipt.dirtyTree) {
      return { ok: false, reason: "dirty tree is not the same verification object" };
    }
    if (receipt.snapshotSha.toLowerCase() !== asset.snapshotSha.toLowerCase()) {
      return { ok: false, reason: "receipt snapshot drifted from asset" };
    }
    if (receipt.testAssetVersion !== asset.testAssetVersion) {
      return { ok: false, reason: "test asset version mismatch" };
    }
    if (kind === "code_trace") {
      if (receipt.executionSource !== "independent-reviewer-trace") {
        return { ok: false, reason: "code_trace requires an independent reviewer trace" };
      }
      if (!receipt.locations || receipt.locations.length === 0) {
        return { ok: false, reason: "code_trace missing locations" };
      }
      continue;
    }
    if (!receipt.command?.trim()) {
      return { ok: false, reason: "command receipt missing command" };
    }
    if (!receipt.cwd?.trim()) {
      return { ok: false, reason: "command receipt missing cwd" };
    }
    if (receipt.exitCode === undefined) {
      return { ok: false, reason: "command receipt missing exit code" };
    }
    if (!receipt.executionSource) {
      return { ok: false, reason: "command receipt missing execution source" };
    }
    if (receipt.skipped || receipt.ranZeroTests) {
      return { ok: false, reason: "zero tests or skipped tests cannot prove pass" };
    }
    if (receipt.exitCode !== 0) {
      return { ok: false, reason: `command exited ${receipt.exitCode}` };
    }
  }
  return { ok: true, reason: "verified" };
}

function inferAssetKind(asset: VerificationAsset): NonNullable<VerificationAsset["kind"]> {
  if (asset.receipts.every((row) => row.executionSource === "independent-reviewer-trace")) {
    return "code_trace";
  }
  return "command_receipt";
}

export function interpretTestLog(
  stdout: string,
  stderr: string,
  exitCode: number,
): {
  skipped: boolean;
  ranZeroTests: boolean;
} {
  const text = `${stdout}\n${stderr}`;
  const skipped = /\bSKIP(?:PED)?\b/i.test(text) || /\b\d+\s+skipped\b/i.test(text);
  const ranZeroTests =
    stdout.trim().length === 0 ||
    /\b0\s+tests?\b/i.test(text) ||
    /\bno tests?\b/i.test(text) ||
    /\bTest Files\s+0\b/i.test(text);
  return { skipped: skipped && exitCode === 0, ranZeroTests };
}

export function generateTaskCard(input: {
  contract: GoalContract;
  candidateSha: string | null;
  responsibleAssertions: string[];
  originalCounterexamples: string[];
  rejectedApproaches: string[];
  missingEvidence: string[];
  remainingBudget: string;
}): TaskCard {
  return {
    contractVersion: input.contract.version,
    goal: input.contract.goal,
    candidateSha: input.candidateSha,
    responsibleAssertions: input.responsibleAssertions,
    originalCounterexamples: input.originalCounterexamples,
    rejectedApproaches: input.rejectedApproaches,
    missingEvidence: input.missingEvidence,
    remainingBudget: input.remainingBudget,
  };
}
