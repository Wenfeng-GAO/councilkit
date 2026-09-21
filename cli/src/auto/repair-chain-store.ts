import { closeSync, mkdirSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  type RepairBudget,
  type RepairChain,
  authorizeBudgetAppend,
  bootstrapChain,
  canOpenSourceFix,
  consumeRetry,
  consumeSourceFix,
  inheritChain,
  repairChainSchema,
} from "@shared/runtime/repair-chain";
import { errors } from "../errors";
import { atomicWriteJson, readFileText } from "../store/atomic-write";
import { ensureHome, resolvePaths } from "../store/paths";

export function chainPath(chainId: string): string {
  ensureHome();
  const dir = join(resolvePaths().home, "repair-chains");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${chainId}.json`);
}

export function readRepairChain(chainId: string): RepairChain | null {
  const text = readFileText(chainPath(chainId));
  if (text === null) return null;
  const parsed = repairChainSchema.safeParse(jsonParse(text));
  return parsed.success ? parsed.data : null;
}

export function writeRepairChain(chain: RepairChain): void {
  atomicWriteJson(chainPath(chain.chainId), chain);
}

export function findChainForRepoPr(repo: string, prUrl: string): RepairChain | null {
  const dir = join(resolvePaths().home, "repair-chains");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const wantRepo = repo.trim().toLowerCase();
  const wantPr = prUrl.trim();
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".lock")) continue;
    const parsed = readRepairChain(name.replace(/\.json$/, ""));
    if (!parsed || parsed.supersededBy) continue;
    if (parsed.repo === wantRepo && parsed.prUrl === wantPr) return parsed;
  }
  return null;
}

export function loadOrCreateChain(input: {
  repo: string;
  prUrl: string;
  goalFingerprint: string;
  parentRunId: string;
  budget?: RepairBudget;
  nowMs?: number;
  forceNewGoal?: boolean;
}): { chain: RepairChain; inherited: boolean } {
  if (!input.forceNewGoal) {
    const existingForPr = findChainForRepoPr(input.repo, input.prUrl);
    if (existingForPr) {
      const inherited = inheritChain(existingForPr, input.parentRunId);
      writeRepairChain(inherited);
      return { chain: inherited, inherited: true };
    }
  }
  const created = bootstrapChain(input);
  const existing = readRepairChain(created.chainId);
  if (existing === null) {
    writeRepairChain(created);
    return { chain: created, inherited: false };
  }
  if (existing.goalFingerprint !== input.goalFingerprint) {
    throw errors.usage("existing repair chain belongs to a different goal fingerprint");
  }
  const inherited = inheritChain(existing, input.parentRunId);
  writeRepairChain(inherited);
  return { chain: inherited, inherited: true };
}

export function withChainLock<T>(chainId: string, fn: () => T): T {
  const lockPath = `${chainPath(chainId)}.lock`;
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch {
    throw errors.runFailed("repair chain is locked by another controller");
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // lock fd
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // lock file
    }
  }
}

export function consumeLockedSourceFix(
  chainId: string,
  nowMs: number,
): { ok: true; budget: RepairBudget } | { ok: false; reason: string } {
  return withChainLock(chainId, () => {
    const current = readRepairChain(chainId);
    if (!current) return { ok: false as const, reason: "repair chain missing" };
    const allowed = canOpenSourceFix(current.budget, nowMs);
    if (!allowed.ok) return { ok: false as const, reason: allowed.reason };
    const budget = consumeSourceFix(current.budget);
    writeRepairChain({ ...current, budget, casVersion: current.casVersion + 1 });
    return { ok: true as const, budget };
  });
}

export function consumeLockedRetry(
  chainId: string,
  kind: "plan" | "verify" | "format" | "diagnose",
): { ok: true; budget: RepairBudget } | { ok: false; reason: string } {
  return withChainLock(chainId, () => {
    const current = readRepairChain(chainId);
    if (!current) return { ok: false as const, reason: "repair chain missing" };
    const consumed = consumeRetry(current.budget, kind);
    if (!consumed.ok) return consumed;
    writeRepairChain({ ...current, budget: consumed.budget, casVersion: current.casVersion + 1 });
    return { ok: true as const, budget: consumed.budget };
  });
}

export function appendAuthorizedBudget(
  chainId: string,
  extra: Parameters<typeof authorizeBudgetAppend>[1],
  parentRunId: string,
): RepairChain {
  return withChainLock(chainId, () => {
    const current = readRepairChain(chainId);
    if (!current) throw errors.runFailed("repair chain missing");
    const budget = authorizeBudgetAppend(current.budget, extra);
    const next = {
      ...current,
      budget,
      parentRunIds: current.parentRunIds.includes(parentRunId)
        ? current.parentRunIds
        : [...current.parentRunIds, parentRunId],
      casVersion: current.casVersion + 1,
    };
    writeRepairChain(next);
    return next;
  });
}

export function casWriteChain(expectedCas: number, next: RepairChain): RepairChain {
  const current = readRepairChain(next.chainId);
  if (current && current.casVersion !== expectedCas) {
    throw errors.runFailed("repair chain CAS conflict");
  }
  const written = { ...next, casVersion: expectedCas + 1 };
  writeRepairChain(written);
  return written;
}

function jsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
