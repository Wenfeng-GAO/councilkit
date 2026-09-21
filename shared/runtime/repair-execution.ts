import { z } from "zod";

export const EXECUTION_KINDS = [
  "source_fix",
  "verify",
  "format",
  "diagnose",
  "plan",
  "publish",
  "final_review",
] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

export const EXECUTION_STATES = [
  "intent",
  "reserved",
  "started",
  "running",
  "completed",
  "failed",
  "cancelled",
  "deadline_enforced",
  "unknown_writer",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const repairExecutionSchema = z
  .object({
    executionId: z.string().min(1).max(80),
    kind: z.enum(EXECUTION_KINDS),
    state: z.enum(EXECUTION_STATES),
    chainId: z.string().min(1).max(80),
    parentRunId: z.string().min(1).max(80),
    inputSha: z.string().min(1).max(64).nullable(),
    contractVersion: z.number().int().positive(),
    deadlineAtMs: z.number().int().nonnegative(),
    pids: z.array(z.number().int().positive()).max(16),
    startedAtMs: z.number().int().nonnegative().nullable(),
    endedAtMs: z.number().int().nonnegative().nullable(),
    consumedSourceFix: z.boolean(),
    result: z.enum(["ok", "failed", "no_commit", "cancelled"]).nullable(),
  })
  .strict();
export type RepairExecution = z.infer<typeof repairExecutionSchema>;

export function createExecutionIntent(input: {
  executionId: string;
  kind: ExecutionKind;
  chainId: string;
  parentRunId: string;
  inputSha: string | null;
  contractVersion: number;
  deadlineAtMs: number;
}): RepairExecution {
  return repairExecutionSchema.parse({
    executionId: input.executionId,
    kind: input.kind,
    state: "intent",
    chainId: input.chainId,
    parentRunId: input.parentRunId,
    inputSha: input.inputSha,
    contractVersion: input.contractVersion,
    deadlineAtMs: input.deadlineAtMs,
    pids: [],
    startedAtMs: null,
    endedAtMs: null,
    consumedSourceFix: input.kind === "source_fix",
    result: null,
  });
}

export function replayExecution(
  existing: RepairExecution | null,
  requested: RepairExecution,
): { ok: true; execution: RepairExecution } | { ok: false; reason: string } {
  if (existing === null) return { ok: true, execution: requested };
  if (existing.executionId !== requested.executionId) {
    return { ok: false, reason: "execution id mismatch" };
  }
  if (
    existing.kind !== requested.kind ||
    existing.chainId !== requested.chainId ||
    existing.parentRunId !== requested.parentRunId ||
    existing.inputSha !== requested.inputSha ||
    existing.contractVersion !== requested.contractVersion
  ) {
    return { ok: false, reason: "idempotent replay payload drifted" };
  }
  return { ok: true, execution: existing };
}

export function canStartWriter(input: {
  existing: RepairExecution | null;
  writerKnown: boolean;
  writerAlive: boolean;
}): { ok: true } | { ok: false; reason: "unknown_writer" | "writer_alive" | "already_terminal" } {
  if (input.existing === null) return { ok: true };
  if (
    input.existing.state === "completed" ||
    input.existing.state === "failed" ||
    input.existing.state === "cancelled" ||
    input.existing.state === "deadline_enforced"
  ) {
    return { ok: false, reason: "already_terminal" };
  }
  if (input.existing.pids.length === 0) return { ok: true };
  if (!input.writerKnown) return { ok: false, reason: "unknown_writer" };
  if (
    input.writerAlive &&
    (input.existing.state === "running" || input.existing.state === "started")
  ) {
    return { ok: false, reason: "writer_alive" };
  }
  return { ok: true };
}

export function takeOverExecution(
  existing: RepairExecution,
  pids: number[],
  nowMs: number,
): RepairExecution {
  return {
    ...existing,
    state: "running",
    pids,
    startedAtMs: existing.startedAtMs ?? nowMs,
  };
}

export function markExecutionStarted(
  execution: RepairExecution,
  pids: number[],
  nowMs: number,
): RepairExecution {
  return { ...execution, state: "started", pids, startedAtMs: nowMs };
}

export function markExecutionRunning(execution: RepairExecution): RepairExecution {
  return { ...execution, state: "running" };
}

export function finishExecution(
  execution: RepairExecution,
  result: NonNullable<RepairExecution["result"]>,
  nowMs: number,
): RepairExecution {
  const state = result === "ok" ? "completed" : result === "cancelled" ? "cancelled" : "failed";
  return { ...execution, state, result, endedAtMs: nowMs };
}

export function enforceDeadline(
  execution: RepairExecution,
  nowMs: number,
): { due: boolean; execution: RepairExecution } {
  if (nowMs < execution.deadlineAtMs) return { due: false, execution };
  if (
    execution.state === "completed" ||
    execution.state === "failed" ||
    execution.state === "cancelled" ||
    execution.state === "deadline_enforced"
  ) {
    return { due: false, execution };
  }
  return {
    due: true,
    execution: {
      ...execution,
      state: "deadline_enforced",
      result: "cancelled",
      endedAtMs: nowMs,
    },
  };
}

export function countsAsSourceFixDispatch(execution: RepairExecution): boolean {
  if (!execution.consumedSourceFix) return false;
  if (execution.state === "intent" || execution.state === "reserved") return true;
  return (
    execution.result === "failed" ||
    execution.result === "no_commit" ||
    execution.result === "cancelled" ||
    execution.result === "ok" ||
    execution.state === "deadline_enforced"
  );
}

export function isInfrastructureRecovery(input: {
  hadValidSourceFailure: boolean;
  isRestartSameExecutionId: boolean;
}): boolean {
  if (input.hadValidSourceFailure) return false;
  return input.isRestartSameExecutionId;
}
