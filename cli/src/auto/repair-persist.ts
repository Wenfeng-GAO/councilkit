import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_RUN_PIPELINE_PID_FILE,
  CLI_RUN_STATUS_FILE,
  type CliRunLiveState,
  type CliRunLiveStatus,
  type CliRunProgressPhase,
} from "@shared/runtime/cli-run-progress";
import { isCliRunId } from "@shared/runtime/cli-runs-index";
import { z } from "zod";
import { errors } from "../errors";
import { atomicWriteFile, atomicWriteJson, readFileText } from "../store/atomic-write";
import { ensureRunDir, resolvePaths } from "../store/paths";

export const REPAIR_STATE_FILE = "repair.json";
export const REPAIR_JOURNAL_FILE = "journal.jsonl";
export const DEFAULT_REPAIR_OUTER_MAX = 10;

const repairCycleSchema = z
  .object({
    n: z.number().int().positive(),
    phase: z.enum(["reserved", "active", "published", "reviewed", "gated", "closed"]),
    childReviewId: z.string().min(1).max(80).nullable().optional(),
    squadTaskId: z.string().min(1).max(80).nullable().optional(),
  })
  .strict();

const repairStateSchema = z
  .object({
    version: z.literal(1),
    casVersion: z.number().int().nonnegative(),
    sourceRunId: z.string().min(1).max(80),
    profileName: z.string().min(1).max(64),
    outerUsed: z.number().int().nonnegative(),
    outerMax: z.number().int().positive().max(DEFAULT_REPAIR_OUTER_MAX),
    timeoutMs: z.number().int().positive().nullable(),
    businessResult: z.enum(["approved", "needs_attention", "stopped"]).nullable(),
    reasonCode: z.string().min(1).max(80).nullable(),
    prUrl: z.string().min(1).max(500).nullable().optional(),
    priorCompleteReviewId: z.string().min(1).max(80).nullable().optional(),
    latestReviewId: z.string().min(1).max(80).nullable().optional(),
    currentSquadTaskId: z.string().min(1).max(80).nullable().optional(),
    candidateSha: z.string().min(1).max(64).nullable().optional(),
    publishedSha: z.string().min(1).max(64).nullable().optional(),
    lastRemoteHead: z.string().min(1).max(64).nullable().optional(),
    grantId: z.string().min(1).max(80).nullable().optional(),
    grantHash: z.string().min(1).max(80).nullable().optional(),
    profileHash: z.string().min(1).max(80).nullable().optional(),
    publishLadder: z.enum(["none", "intent", "receipt", "head", "published"]).optional(),
    historyCount: z.number().int().nonnegative().nullable().optional(),
    writerPids: z.array(z.number().int().positive()).max(16).optional(),
    cycles: z.array(repairCycleSchema).optional(),
    lastError: z.string().min(1).max(2000).nullable().optional(),
    workspaceCwd: z.string().min(1).max(4096).nullable().optional(),
    packageSourceRunId: z.string().min(1).max(80).nullable().optional(),
    frozenBaseSha: z.string().min(1).max(64).nullable().optional(),
    supplementReviewId: z.string().min(1).max(80).nullable().optional(),
  })
  .strict();
export type RepairState = z.infer<typeof repairStateSchema>;
export type RepairCycle = z.infer<typeof repairCycleSchema>;

export function isRepairRunId(runId: string): boolean {
  return isCliRunId(runId) && runId.startsWith("ck-repair-");
}

export function isReviewRunId(runId: string): boolean {
  return isCliRunId(runId) && runId.startsWith("ck-review-");
}

export function bootstrapRepairRun(input: {
  runId: string;
  sourceRunId: string;
  profileName: string;
  outerMax: number;
  timeoutMs: number | null;
  pid: number;
}): { runDir: string; reused: boolean; state: RepairState } {
  if (!isRepairRunId(input.runId)) {
    throw errors.usage(`--run-id must be a ck-repair-<uuid> run id, got "${input.runId}"`);
  }
  if (!isReviewRunId(input.sourceRunId)) {
    throw errors.usage("--from must identify a review run");
  }
  const runDir = ensureRunDir(input.runId);
  const existing = readRepairState(runDir);
  let state: RepairState;
  let reused = false;
  if (existing) {
    if (existing.sourceRunId !== input.sourceRunId) {
      throw errors.usage(`--run-id ${input.runId} belongs to a different source review`);
    }
    reused = true;
    state = existing;
  } else {
    state = {
      version: 1,
      casVersion: 0,
      sourceRunId: input.sourceRunId,
      profileName: input.profileName,
      outerUsed: 0,
      outerMax: input.outerMax,
      timeoutMs: input.timeoutMs,
      businessResult: null,
      reasonCode: null,
    };
    writeRepairState(runDir, state);
  }
  ensureEmptyJournal(runDir);
  writeRepairPid(runDir, input.pid);
  writeRepairLive(runDir, {
    status: "running",
    phase: "repair-preparing",
  });
  return { runDir, reused, state };
}

export function readRepairState(runDir: string): RepairState | null {
  const text = readFileText(join(runDir, REPAIR_STATE_FILE));
  if (text === null) return null;
  const parsed = repairStateSchema.safeParse(jsonParse(text));
  return parsed.success ? parsed.data : null;
}

export function writeRepairState(runDir: string, state: RepairState): void {
  atomicWriteJson(join(runDir, REPAIR_STATE_FILE), state);
}

export function writeRepairPid(runDir: string, pid: number): void {
  atomicWriteFile(join(runDir, CLI_RUN_PIPELINE_PID_FILE), `${String(pid)}\n`);
}

export function readRepairPid(runDir: string): number | null {
  const text = readFileText(join(runDir, CLI_RUN_PIPELINE_PID_FILE));
  if (text === null) return null;
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function writeRepairLive(
  runDir: string,
  input: { status: CliRunLiveStatus; phase: CliRunProgressPhase },
): void {
  const live: CliRunLiveState = {
    version: 1,
    status: input.status,
    progress: {
      phase: input.phase,
      attempts: [],
      updatedAt: new Date().toISOString(),
    },
    pipeline: null,
  };
  atomicWriteFile(join(runDir, CLI_RUN_STATUS_FILE), `${JSON.stringify(live)}\n`);
}

export function sourceReviewDir(sourceRunId: string): string {
  return resolvePaths().runDir(sourceRunId);
}

export function sourceReviewExists(sourceRunId: string): boolean {
  return existsSync(sourceReviewDir(sourceRunId));
}

function ensureEmptyJournal(runDir: string): void {
  const path = join(runDir, REPAIR_JOURNAL_FILE);
  if (existsSync(path)) return;
  try {
    writeFileSync(path, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw errors.io("cannot create repair journal");
  }
}

export function appendRepairJournal(runDir: string, record: Record<string, unknown>): void {
  const path = join(runDir, REPAIR_JOURNAL_FILE);
  ensureEmptyJournal(runDir);
  writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
}

export function readRepairJournal(runDir: string): Array<Record<string, unknown>> {
  const text = readFileText(join(runDir, REPAIR_JOURNAL_FILE));
  if (text === null || text.trim().length === 0) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = jsonParse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      rows.push(parsed as Record<string, unknown>);
    }
  }
  return rows;
}

function jsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
