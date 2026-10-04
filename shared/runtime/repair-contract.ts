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
    failed: z.boolean().optional(),
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
    if (receipt.failed) {
      return { ok: false, reason: "failing tests cannot prove pass" };
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
  failed: boolean;
} {
  const text = `${stdout}\n${stderr}`;
  const scanned = textWithoutGoPackagesThatLackTestFiles(text);
  ANSI_COLOR.lastIndex = 0;
  const todoText = scanned.replace(ANSI_COLOR, "");
  const todo =
    /#\s*TODO\b/.test(todoText) ||
    /^[ \t]*(?:#[ \t]*|\u2139[ \t]*|<!--[ \t]*)todo[ \t]+[1-9]\d*\b/im.test(todoText) ||
    /^[ \t]*Tests:?[ \t].*\b[1-9]\d*[ \t]+todo\b/im.test(todoText);
  const cargoIgnored =
    /^test[ \t]+\S+[ \t]+\.\.\.[ \t]+ignored\b/m.test(scanned) ||
    /^test result:.*\b[1-9]\d* ignored\b/m.test(scanned);
  const denoIgnored =
    /^[ \t]*(?:ok|FAILED)[ \t]*\|[^\n]*\|[ \t]*(?:[1-9]\d*[ \t]+ignored\b|0[ \t]+ignored[ \t]+\([1-9]\d*[ \t]+steps?\))/im.test(
      todoText,
    );
  const denoRanNothing =
    /^[ \t]*ok[ \t]*\|[ \t]*0[ \t]+passed\b(?![^\n]*\|[ \t]*(?:[1-9]\d*[ \t]+ignored\b|0[ \t]+ignored[ \t]+\())[^\n]*\|[ \t]*0[ \t]+failed\b/im.test(
      todoText,
    );
  const mochaPending = /^[ \t]*[1-9]\d*[ \t]+pending[ \t]*$/im.test(todoText);
  const mochaZeroPassing = /^[ \t]*0[ \t]+passing[ \t]+\(\d+(?:ms|s|m|h|d)\)[ \t]*$/im.test(
    todoText,
  );
  const pytestXfailOnly = todoText.split("\n").some((line) => {
    const summary = line
      .replace(/^=+[ \t]*/, "")
      .replace(/[ \t]*=+[ \t]*$/, "")
      .trim();
    if (
      !/^(?:[1-9]\d*[ \t]+[A-Za-z]+)(?:,[ \t]*[1-9]\d*[ \t]+[A-Za-z]+)*[ \t]+in[ \t]+\d+(?:\.\d+)?s$/.test(
        summary,
      )
    ) {
      return false;
    }
    return (
      /\b[1-9]\d*[ \t]+xfailed\b/.test(summary) &&
      !/\b[1-9]\d*[ \t]+(?:xpassed|passed)\b/.test(summary)
    );
  });
  const summarySkipOrTodo = /^[ \t]*[1-9]\d*[ \t]+(?:skip|todo)[ \t]*$/im.test(todoText);
  const ctestNotRun =
    /\*{3}Skipped[ \t]+\d+(?:\.\d+)?[ \t]+sec\b/.test(scanned) ||
    /\*{3}Not Run[ \t]+\(/.test(scanned);
  const skipped =
    (/\b[1-9]\d*[^\S\n]+skipped\b/i.test(scanned) ||
      /\bskipped\b[^\S\n]*[:=]?[^\S\n]*[1-9]\d*\b/i.test(scanned) ||
      /^---[ \t]+SKIP\b/m.test(scanned) ||
      /#[ \t]+SKIP\b/.test(scanned) ||
      /(?<!\\)"Action"\s*:\s*"skip"/.test(scanned) ||
      cargoIgnored ||
      denoIgnored ||
      todo ||
      mochaPending ||
      pytestXfailOnly ||
      summarySkipOrTodo ||
      ctestNotRun) &&
    exitCode === 0;
  const failed = logShowsFailures(text);
  const lines = scanned.split("\n");
  const ranSomeHarness = lines.some((line) => /^running[ \t]+[1-9]\d*[ \t]+tests?\b/i.test(line));
  const zeroCountText = ranSomeHarness
    ? lines.filter((line) => !/^running[ \t]+0[ \t]+tests?\b/i.test(line)).join("\n")
    : scanned;
  const ranZeroTests =
    /\b0\s+tests?\b(?![^\S\n]+failed\b)/i.test(zeroCountText) ||
    /\bno tests?\b/i.test(scanned) ||
    /\bTest Files\s+0\b/i.test(scanned) ||
    /\btests\s+0\b/i.test(scanned) ||
    mochaZeroPassing ||
    denoRanNothing ||
    (scanned !== text &&
      !failed &&
      !/^ok\s+\S/m.test(scanned) &&
      !/(?<!\\)"Action"\s*:\s*"pass"/.test(scanned) &&
      !/\btests\s+[1-9]\d*\b/i.test(scanned) &&
      !/\b[1-9]\d*\s+passed\b/i.test(scanned));
  return { skipped, ranZeroTests, failed };
}

function textWithoutGoPackagesThatLackTestFiles(text: string): string {
  if (!/\[no test files\]/i.test(text)) return text;
  const kept = text.split("\n").filter((line) => {
    const packageSkip = /"Action"\s*:\s*"skip"/.test(line) && !/"Test"\s*:/.test(line);
    return !packageSkip;
  });
  return kept.join("\n").replace(/\[no test files\]/gi, "");
}

const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function logShowsFailures(text: string): boolean {
  ANSI_COLOR.lastIndex = 0;
  const plain = text.replace(ANSI_COLOR, "");
  if (/^[ \t]*[#ℹ][ \t]+(?:fail|cancelled)[ \t]+[1-9]\d*\b/im.test(plain)) return true;
  if (/^[ \t]*<!--[ \t]+(?:fail|cancelled)[ \t]+[1-9]\d*\b/im.test(plain)) return true;
  if (/^Failed tests:$/m.test(plain)) return true;
  if (/^test result: FAILED\b/m.test(plain)) return true;
  if (/^[ \t]*Test Suites:?[ \t].*\b[1-9]\d*[ \t]+failed\b/im.test(plain)) return true;
  if (/^[ \t]*Test Files[ \t].*\b[1-9]\d*[ \t]+failed\b/im.test(plain)) return true;
  if (/^[ \t]*Tests:?[ \t].*\b[1-9]\d*[ \t]+failed\b/im.test(plain)) return true;
  if (/^[ \t]*[1-9]\d*[ \t]+fail(?:ed|ing)?[ \t]*$/im.test(plain)) return true;
  if (/^[ \t]*[1-9]\d*[ \t]+errors?[ \t]*$/im.test(plain)) return true;
  if (/^[ \t]*[1-9]\d*[ \t]+flaky[ \t]*$/im.test(plain)) return true;
  if (/^--- FAIL:/m.test(plain)) return true;
  if (/^FAIL(?:\r?$|\t)/m.test(plain)) return true;
  if (/^[ \t]*FAILED[ \t]+\S/m.test(plain)) return true;
  if (/^[ \t]*ERROR[ \t]+\S+::\S/m.test(plain)) return true;
  if (/^=+[ \t][^\n]*\b[1-9]\d*[ \t]+(?:failed|errors?)\b/m.test(plain)) return true;
  if (/^[ \t]*[1-9]\d*[ \t]+errors?[ \t]+in[ \t]/im.test(plain)) return true;
  if (/^[ \t]*!+[ \t]*Interrupted:[^\n]*\b[1-9]\d*[ \t]+errors?\b/im.test(plain)) return true;
  if (/\*{3}Failed[ \t]+\d+(?:\.\d+)?[ \t]+sec\b/.test(plain)) return true;
  if (/^The following tests FAILED:[ \t]*$/m.test(plain)) return true;
  if (/^[^\n]*\b[1-9]\d*[ \t]+tests[ \t]+failed[ \t]+out[ \t]+of[ \t]+[1-9]\d*\b/m.test(plain))
    return true;
  if (/(?<!\\)"Action"\s*:\s*"fail"/.test(plain)) return true;
  return false;
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
