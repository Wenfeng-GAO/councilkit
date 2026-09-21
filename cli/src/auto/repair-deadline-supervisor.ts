import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type RepairExecution,
  certifyDeadlineEnforced,
  enforceDeadline,
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

export function writeExecutionRecord(path: string, execution: RepairExecution): void {
  atomicWriteJson(path, execution);
}

export function superviseDeadlineOnce(input: {
  execution: RepairExecution;
  nowMs: number;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isPidAlive?: (pid: number) => boolean;
}): RepairExecution {
  const result = enforceDeadline(input.execution, input.nowMs);
  if (!result.due) return result.execution;
  const alive = input.isPidAlive ?? defaultAlive;
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
    writeFileSync(input.logPath, `supervisor pid=${child.pid}\n`, { encoding: "utf8", flag: "a" });
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
}): Promise<RepairExecution> {
  const sleep = input.sleep ?? defaultSleep;
  const nowMs = input.nowMs ?? (() => Date.now());
  const kill = input.kill ?? ((pid, signal) => process.kill(pid, signal));
  for (;;) {
    const execution = readExecutionRecord(input.executionPath);
    if (execution === null) throw errors.io("execution record missing");
    const next = superviseDeadlineOnce({ execution, nowMs: nowMs(), kill });
    if (next !== execution) writeExecutionRecord(input.executionPath, next);
    if (
      next.state === "completed" ||
      next.state === "failed" ||
      next.state === "cancelled" ||
      next.state === "deadline_enforced"
    ) {
      return next;
    }
    const remaining = Math.max(20, next.deadlineAtMs - nowMs());
    await sleep(Math.min(remaining, 1_000));
  }
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
