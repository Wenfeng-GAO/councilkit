import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isPidAlive } from "@shared/runtime/cli-run-progress";
import { appendPrivateFile, mkdirPrivate, readPrivateText } from "@shared/runtime/durable-write";
import { jsonParse } from "@shared/runtime/json-parse";
import {
  type RepairExecution,
  certifyDeadlineEnforced,
  enforceDeadline,
  isTerminalRepairExecution,
  markUnknownWriter,
  repairExecutionSchema,
} from "@shared/runtime/repair-execution";
import { errors } from "../errors";
import { atomicWriteJson, readFileText } from "../store/atomic-write";

export function executionRecordPath(runDir: string, executionId: string): string {
  return join(runDir, "executions", `${executionId}.json`);
}

export function readExecutionRecord(path: string): RepairExecution | null {
  const text = readFileText(path);
  if (text === null) return null;
  const parsed = repairExecutionSchema.safeParse(jsonParse(text));
  return parsed.success ? parsed.data : null;
}

// The repair process and the detached supervisor both replace this file.
// The callback runs under the record lock, after the terminal check and before the rename.
let commitGate: (() => void) | null = null;

export function setExecutionRecordCommitGate(gate: (() => void) | null): void {
  commitGate = gate;
}

export interface ExecutionRecordDecision {
  wrote: boolean;
  execution: RepairExecution | null;
}

// Re-reads under the record lock. A terminal file is left unchanged.
// `decide` runs only for a missing or non-terminal record, still holding the lock.
export function decideExecutionRecord(
  path: string,
  decide: (existing: RepairExecution | null) => RepairExecution | null,
): ExecutionRecordDecision {
  const release = acquireRecordLock(`${path}.lock`);
  try {
    const existing = readExecutionRecord(path);
    if (existing !== null && isTerminalRepairExecution(existing.state)) {
      return { wrote: false, execution: existing };
    }
    const next = decide(existing);
    if (next === null) return { wrote: false, execution: existing };
    commitGate?.();
    atomicWriteJson(path, next);
    return { wrote: true, execution: next };
  } finally {
    release();
  }
}

export function writeExecutionRecord(path: string, execution: RepairExecution): void {
  decideExecutionRecord(path, () => execution);
}

// Certify from the on-disk record. The kill and the write share the lock so a
// pid bound after the unlocked deadline read is the pid that is stopped.
export function commitDeadlineIfDue(input: {
  executionPath: string;
  nowMs: number;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isPidAlive?: (pid: number) => boolean;
}): RepairExecution | null {
  const decision = decideExecutionRecord(input.executionPath, (existing) => {
    if (existing === null) return null;
    const next = superviseDeadlineOnce({
      execution: existing,
      nowMs: input.nowMs,
      kill: input.kill,
      isPidAlive: input.isPidAlive,
    });
    return next === existing ? null : next;
  });
  return decision.execution;
}

export function superviseDeadlineOnce(input: {
  execution: RepairExecution;
  nowMs: number;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isPidAlive?: (pid: number) => boolean;
}): RepairExecution {
  const result = enforceDeadline(input.execution, input.nowMs);
  if (!result.due) return result.execution;
  const alive = input.isPidAlive ?? isPidAlive;
  if (input.execution.pids.length === 0) {
    return markUnknownWriter(input.execution);
  }
  const stopWith = (signal: NodeJS.Signals): boolean => {
    let failed = false;
    for (const pid of input.execution.pids) {
      if (!alive(pid)) continue;
      try {
        input.kill(pid, signal);
      } catch {
        failed = true;
      }
    }
    return failed;
  };
  stopWith("SIGTERM");
  if (input.execution.pids.every((pid) => !alive(pid))) {
    return certifyDeadlineEnforced(input.execution, input.nowMs);
  }
  const killFailed = stopWith("SIGKILL");
  if (!killFailed && input.execution.pids.every((pid) => !alive(pid))) {
    return certifyDeadlineEnforced(input.execution, input.nowMs);
  }
  return markUnknownWriter(input.execution);
}

export function spawnDeadlineSupervisor(input: {
  cliBin: string;
  executionPath: string;
  logPath: string;
  spawnImpl?: typeof spawn;
}): { pid: number } | { skipped: true; reason: string } {
  try {
    const child = (input.spawnImpl ?? spawn)(
      process.execPath,
      [input.cliBin, "repair", "supervise-deadline", "--execution", input.executionPath],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env,
      },
    );
    child.unref();
    if (typeof child.pid !== "number" || child.pid <= 0) {
      return { skipped: true, reason: "deadline supervisor pid missing" };
    }
    try {
      appendPrivateFile(input.logPath, `supervisor pid=${child.pid}\n`);
    } catch {
      // A symlink or unwritable log must not follow the link or hide the pid.
    }
    return { pid: child.pid };
  } catch (error) {
    return {
      skipped: true,
      reason: error instanceof Error ? error.message : "deadline supervisor spawn failed",
    };
  }
}

export async function runDeadlineSupervisorLoop(input: {
  executionPath: string;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isPidAlive?: (pid: number) => boolean;
  beforeCertify?: () => void;
}): Promise<RepairExecution> {
  const sleep = input.sleep ?? defaultSleep;
  const nowMs = input.nowMs ?? (() => Date.now());
  const kill = input.kill ?? ((pid, signal) => process.kill(pid, signal));
  for (;;) {
    const execution = readExecutionRecord(input.executionPath);
    if (execution === null) throw errors.io("execution record missing");
    if (isTerminalRepairExecution(execution.state)) return execution;
    const now = nowMs();
    if (now < execution.deadlineAtMs) {
      const remaining = Math.max(20, execution.deadlineAtMs - now);
      await sleep(Math.min(remaining, 1_000));
      continue;
    }
    input.beforeCertify?.();
    const persisted = commitDeadlineIfDue({
      executionPath: input.executionPath,
      nowMs: now,
      kill,
      isPidAlive: input.isPidAlive,
    });
    if (persisted === null) throw errors.io("execution record missing");
    if (isTerminalRepairExecution(persisted.state)) return persisted;
    const remaining = Math.max(20, persisted.deadlineAtMs - nowMs());
    await sleep(Math.min(remaining, 1_000));
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RECORD_LOCK_WAIT_MS = 5_000;
const lockPause = new Int32Array(new SharedArrayBuffer(4));

function acquireRecordLock(lockPath: string): () => void {
  mkdirPrivate(dirname(lockPath));
  const token = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
  const deadline = Date.now() + RECORD_LOCK_WAIT_MS;
  for (;;) {
    if (tryCreateRecordLock(lockPath, token)) return () => releaseRecordLock(lockPath, token);
    reclaimDeadRecordLock(lockPath);
    if (Date.now() >= deadline) {
      if (tryCreateRecordLock(lockPath, token)) return () => releaseRecordLock(lockPath, token);
      throw errors.io(`execution record lock busy: ${lockPath}`);
    }
    Atomics.wait(lockPause, 0, 0, 5);
  }
}

function tryCreateRecordLock(lockPath: string, token: string): boolean {
  const tmp = `${lockPath}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let linked = false;
  try {
    writeSync(fd, token);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // The tmp name is unique. A close failure must not hide the write error.
    }
    try {
      unlinkSync(tmp);
    } catch {
      // Same as close. The next attempt uses a new tmp name.
    }
    throw error;
  }
  try {
    closeSync(fd);
  } catch {
    // The bytes are already fsynced. Publishing the name is the remaining step.
  }
  try {
    linkSync(tmp, lockPath);
    linked = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      try {
        unlinkSync(tmp);
      } catch {
        // The unique tmp is unreferenced once this attempt ends.
      }
      throw error;
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    // The lock name already points at the inode when link succeeded.
  }
  return linked;
}

function releaseRecordLock(lockPath: string, token: string): void {
  if (readLockText(lockPath) !== token) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // A dead holder is reclaimed by the next writer.
  }
}

function reclaimDeadRecordLock(lockPath: string): void {
  const text = readLockText(lockPath);
  if (text === null || holderAlive(text)) return;
  const grave = `${lockPath}.${randomBytes(4).toString("hex")}.stale`;
  try {
    renameSync(lockPath, grave);
  } catch {
    return;
  }
  try {
    unlinkSync(grave);
  } catch {
    // The lock path is free even when the grave file remains.
  }
}

function holderAlive(text: string): boolean {
  const space = text.indexOf(" ");
  const pid = Number(space === -1 ? text : text.slice(0, space));
  return Number.isInteger(pid) && pid > 0 && isPidAlive(pid);
}

function readLockText(lockPath: string): string | null {
  try {
    return readPrivateText(lockPath);
  } catch {
    return null;
  }
}
