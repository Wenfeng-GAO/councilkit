import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isPidAlive } from "@shared/runtime/cli-run-progress";
import {
  type WriterLease,
  parseWriterLease,
  writerLeaseKey,
  writerLeasePath,
} from "@shared/runtime/repair-lease";
import { errors } from "../errors";
import { atomicWriteJson, readFileText } from "../store/atomic-write";
import { ensureHome, resolvePaths } from "../store/paths";

export interface AcquireWriterLeaseInput {
  repo: string;
  sourceBranch: string;
  holderKind: WriterLease["holderKind"];
  holderRunId: string;
  pid: number;
  writerPids?: number[];
  reclaim?: { journalChecked: boolean; remoteChecked: boolean };
  isPidAlive?: (pid: number) => boolean;
}

export function acquireWriterLease(input: AcquireWriterLeaseInput): WriterLease {
  const alive = input.isPidAlive ?? isPidAlive;
  const key = writerLeaseKey({ repo: input.repo, sourceBranch: input.sourceBranch });
  const path = writerLeasePath(ensureHome(), key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const next: WriterLease = {
    version: 1,
    key,
    holderKind: input.holderKind,
    holderRunId: input.holderRunId,
    pid: input.pid,
    ...(input.writerPids && input.writerPids.length > 0 ? { writerPids: input.writerPids } : {}),
    epoch: 1,
    grantedAt: now,
  };

  const existingText = readFileText(path);
  if (existingText === null) {
    try {
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return next;
    } catch {
      const raced = parseWriterLease(readFileText(path) ?? "");
      if (raced === null) throw errors.io("cannot create writer lease");
      return takeExisting(raced, next, alive, input.reclaim, path);
    }
  }
  const existing = parseWriterLease(existingText);
  if (existing === null) throw errors.io("writer lease file is invalid");
  return takeExisting(existing, next, alive, input.reclaim, path);
}

export function releaseWriterLease(input: {
  repo: string;
  sourceBranch: string;
  holderRunId: string;
  isPidAlive?: (pid: number) => boolean;
}): void {
  const alive = input.isPidAlive ?? isPidAlive;
  const key = writerLeaseKey({ repo: input.repo, sourceBranch: input.sourceBranch });
  const path = writerLeasePath(resolvePaths().home, key);
  const text = readFileText(path);
  if (text === null) return;
  const existing = parseWriterLease(text);
  if (existing === null) throw errors.io("writer lease file is invalid");
  if (existing.holderRunId !== input.holderRunId) {
    throw errors.runFailed("cannot release a writer lease owned by another run");
  }
  const extras = existing.writerPids ?? [];
  const liveExtra = extras.find((pid) => alive(pid));
  if (liveExtra !== undefined) {
    throw errors.runFailed("cannot release writer lease while a writer pid is still alive");
  }
  try {
    unlinkSync(path);
  } catch {
    throw errors.io("cannot remove writer lease");
  }
}

function takeExisting(
  existing: WriterLease,
  next: WriterLease,
  alive: (pid: number) => boolean,
  reclaim: AcquireWriterLeaseInput["reclaim"],
  path: string,
): WriterLease {
  if (existing.holderRunId === next.holderRunId) {
    const refreshed: WriterLease = {
      ...existing,
      pid: next.pid,
      ...(next.writerPids ? { writerPids: next.writerPids } : {}),
    };
    atomicWriteJson(path, refreshed);
    return refreshed;
  }
  const extras = existing.writerPids ?? [];
  if (alive(existing.pid) || extras.some((pid) => alive(pid))) {
    throw errors.runFailed(
      `a writer already holds this branch (${existing.holderKind} ${existing.holderRunId})`,
      { existingRunId: existing.holderRunId, key: existing.key },
    );
  }
  if (!reclaim?.journalChecked || !reclaim.remoteChecked) {
    throw errors.runFailed(
      "cannot reclaim a stale writer lease without journal and remote checks",
      { existingRunId: existing.holderRunId, key: existing.key },
    );
  }
  const stolen: WriterLease = { ...next, epoch: existing.epoch + 1 };
  atomicWriteJson(path, stolen);
  return stolen;
}
