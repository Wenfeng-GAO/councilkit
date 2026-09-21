import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./digest";

export const V2_TRIAL_DEFAULTS = {
  sourceFixMax: 3,
  deadlineMs: 2 * 60 * 60 * 1000,
  diagnoseMs: 15 * 60 * 1000,
  planRetryMax: 3,
  verifyRetryMax: 5,
  formatRetryMax: 3,
  diagnoseRetryMax: 2,
  reservedFinalMs: 40 * 60 * 1000,
  sameRootCauseFailLimit: 2,
} as const;

export const repairBudgetSchema = z
  .object({
    sourceFixUsed: z.number().int().nonnegative(),
    sourceFixMax: z.number().int().positive(),
    planRetryUsed: z.number().int().nonnegative(),
    planRetryMax: z.number().int().positive(),
    verifyRetryUsed: z.number().int().nonnegative(),
    verifyRetryMax: z.number().int().positive(),
    formatRetryUsed: z.number().int().nonnegative(),
    formatRetryMax: z.number().int().positive(),
    diagnoseRetryUsed: z.number().int().nonnegative(),
    diagnoseRetryMax: z.number().int().positive(),
    diagnoseMs: z.number().int().positive(),
    deadlineMs: z.number().int().positive(),
    reservedFinalMs: z.number().int().nonnegative(),
    startedAtMs: z.number().int().nonnegative(),
    tokenUsed: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type RepairBudget = z.infer<typeof repairBudgetSchema>;

export const repairChainSchema = z
  .object({
    version: z.literal(1),
    chainId: z.string().min(1).max(80),
    repo: z.string().min(1).max(400),
    prUrl: z.string().min(1).max(500),
    goalFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    parentRunIds: z.array(z.string().min(1).max(80)).max(64),
    budget: repairBudgetSchema,
    casVersion: z.number().int().nonnegative(),
    supersededBy: z.string().min(1).max(80).nullable(),
  })
  .strict();
export type RepairChain = z.infer<typeof repairChainSchema>;

export function chainKey(input: { repo: string; prUrl: string; goalFingerprint: string }): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        repo: input.repo.trim().toLowerCase(),
        prUrl: input.prUrl.trim(),
        goalFingerprint: input.goalFingerprint,
      }),
    )
    .digest("hex");
}

export function newRepairBudget(overrides: Partial<RepairBudget> = {}, nowMs = 0): RepairBudget {
  return repairBudgetSchema.parse({
    sourceFixUsed: 0,
    sourceFixMax: V2_TRIAL_DEFAULTS.sourceFixMax,
    planRetryUsed: 0,
    planRetryMax: V2_TRIAL_DEFAULTS.planRetryMax,
    verifyRetryUsed: 0,
    verifyRetryMax: V2_TRIAL_DEFAULTS.verifyRetryMax,
    formatRetryUsed: 0,
    formatRetryMax: V2_TRIAL_DEFAULTS.formatRetryMax,
    diagnoseRetryUsed: 0,
    diagnoseRetryMax: V2_TRIAL_DEFAULTS.diagnoseRetryMax,
    diagnoseMs: V2_TRIAL_DEFAULTS.diagnoseMs,
    deadlineMs: V2_TRIAL_DEFAULTS.deadlineMs,
    reservedFinalMs: V2_TRIAL_DEFAULTS.reservedFinalMs,
    startedAtMs: nowMs,
    tokenUsed: null,
    ...overrides,
  });
}

export function writeCutoffMs(budget: RepairBudget): number {
  return budget.startedAtMs + budget.deadlineMs - budget.reservedFinalMs;
}

export function canOpenSourceFix(
  budget: RepairBudget,
  nowMs: number,
): { ok: true } | { ok: false; reason: "source_fix_exhausted" | "write_cutoff" | "deadline" } {
  if (nowMs >= budget.startedAtMs + budget.deadlineMs) return { ok: false, reason: "deadline" };
  if (nowMs >= writeCutoffMs(budget)) return { ok: false, reason: "write_cutoff" };
  if (budget.sourceFixUsed >= budget.sourceFixMax)
    return { ok: false, reason: "source_fix_exhausted" };
  return { ok: true };
}

export function consumeSourceFix(budget: RepairBudget): RepairBudget {
  return { ...budget, sourceFixUsed: budget.sourceFixUsed + 1 };
}

export function canConsumeRetry(
  budget: RepairBudget,
  kind: "plan" | "verify" | "format" | "diagnose",
): { ok: true } | { ok: false; reason: string } {
  const usedKey = `${kind}RetryUsed` as const;
  const maxKey = `${kind}RetryMax` as const;
  if (budget[usedKey] >= budget[maxKey]) {
    return { ok: false, reason: `${kind} retry budget exhausted` };
  }
  return { ok: true };
}

export function consumeRetry(
  budget: RepairBudget,
  kind: "plan" | "verify" | "format" | "diagnose",
): { ok: true; budget: RepairBudget } | { ok: false; reason: string } {
  const allowed = canConsumeRetry(budget, kind);
  if (!allowed.ok) return allowed;
  const usedKey = `${kind}RetryUsed` as const;
  return { ok: true, budget: { ...budget, [usedKey]: budget[usedKey] + 1 } };
}

/** Explicit same-chain append: raises caps, never zeroes used counts. */
export function authorizeBudgetAppend(
  budget: RepairBudget,
  extra: {
    sourceFixMax?: number;
    deadlineMs?: number;
    planRetryMax?: number;
    verifyRetryMax?: number;
    formatRetryMax?: number;
    diagnoseRetryMax?: number;
  },
): RepairBudget {
  return {
    ...budget,
    sourceFixMax: Math.max(budget.sourceFixMax, extra.sourceFixMax ?? budget.sourceFixMax),
    deadlineMs: Math.max(budget.deadlineMs, extra.deadlineMs ?? budget.deadlineMs),
    planRetryMax: Math.max(budget.planRetryMax, extra.planRetryMax ?? budget.planRetryMax),
    verifyRetryMax: Math.max(budget.verifyRetryMax, extra.verifyRetryMax ?? budget.verifyRetryMax),
    formatRetryMax: Math.max(budget.formatRetryMax, extra.formatRetryMax ?? budget.formatRetryMax),
    diagnoseRetryMax: Math.max(
      budget.diagnoseRetryMax,
      extra.diagnoseRetryMax ?? budget.diagnoseRetryMax,
    ),
  };
}

export function inheritChain(existing: RepairChain, parentRunId: string): RepairChain {
  if (existing.parentRunIds.includes(parentRunId)) return existing;
  return {
    ...existing,
    parentRunIds: [...existing.parentRunIds, parentRunId],
    casVersion: existing.casVersion + 1,
  };
}

export function bootstrapChain(input: {
  repo: string;
  prUrl: string;
  goalFingerprint: string;
  parentRunId: string;
  budget?: RepairBudget;
  nowMs?: number;
}): RepairChain {
  const chainId = `ck-chain-${chainKey(input).slice(0, 32)}`;
  return repairChainSchema.parse({
    version: 1,
    chainId,
    repo: input.repo.trim().toLowerCase(),
    prUrl: input.prUrl.trim(),
    goalFingerprint: input.goalFingerprint,
    parentRunIds: [input.parentRunId],
    budget: input.budget ?? newRepairBudget({}, input.nowMs ?? 0),
    casVersion: 0,
    supersededBy: null,
  });
}
