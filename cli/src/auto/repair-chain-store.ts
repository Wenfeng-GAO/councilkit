import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  type RepairBudget,
  type RepairChain,
  bootstrapChain,
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

export function loadOrCreateChain(input: {
  repo: string;
  prUrl: string;
  goalFingerprint: string;
  parentRunId: string;
  budget?: RepairBudget;
  nowMs?: number;
}): { chain: RepairChain; inherited: boolean } {
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
