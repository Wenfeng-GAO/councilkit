/**
 * Live review progress derived from transcript records or runs/<id>/status.json.
 * The Host only reads this; the CLI writes the sidecar so the browser can poll
 * without parsing Attempt output payloads.
 */
import { type CliRunHandoffDto, cliRunHandoffSchema } from "./schemas";

export const CLI_RUN_STATUS_FILE = "status.json";

export const CLI_RUN_PROGRESS_PHASES = [
  "attempts",
  "aggregating",
  "done",
  "planning",
  "plan-review",
  "plan-aggregating",
  "applying",
  "re-reviewing",
  "briefing",
  "implementing",
  "reviewing",
  "auditing",
  "snapshotting",
  "fixing",
  "integrating",
] as const;

export type CliRunProgressPhase = (typeof CLI_RUN_PROGRESS_PHASES)[number];

const PROGRESS_PHASE_SET = new Set<string>(CLI_RUN_PROGRESS_PHASES);

export type CliRunPipelinePhase =
  | "planning"
  | "plan-review"
  | "plan-aggregating"
  | "applying"
  | "re-reviewing"
  | "done";

export type CliRunPlanVerdict = "approve" | "changes-requested" | "comment";

export type CliRunApplyStatus = "pending" | "running" | "success" | "failure" | "skipped";

export interface CliRunPipeline {
  phase: CliRunPipelinePhase;
  round: number;
  maxRounds: number;
  planVerdict: CliRunPlanVerdict | null;
  applyStatus: CliRunApplyStatus | null;
  followUpRunId: string | null;
  summary: string | null;
  updatedAt: string;
}
export type CliRunAttemptLiveStatus =
  | "pending"
  | "queued"
  | "running"
  | "success"
  | "failure"
  | "cancelled";

export interface CliRunAttemptProgress {
  attemptId: string;
  agentName: string;
  driverId: string;
  modelId: string;
  role: "attempt" | "aggregator";
  status: CliRunAttemptLiveStatus;
  durationMs: number | null;
  /** Last observed tool/command while the attempt is running; null otherwise. */
  lastActivity: string | null;
}

/** Mid-run overlay written on heartbeat / stream activity. */
export interface CliRunLiveHeartbeat {
  attemptId: string;
  elapsedMs?: number;
  lastActivity?: string | null;
  /** Promote a queued seat to running when the worker actually claims it. */
  started?: boolean;
}

const LAST_ACTIVITY_MAX = 240;

export interface CliRunProgress {
  phase: CliRunProgressPhase;
  attempts: CliRunAttemptProgress[];
  updatedAt: string | null;
}

export type CliRunLiveStatus =
  | "completed"
  | "failed"
  | "interrupted"
  | "running"
  | "unknown"
  | "awaiting_orchestrator"
  | "closed";

export interface CliRunLiveState {
  version: 1;
  status: CliRunLiveStatus;
  progress: CliRunProgress;
  pipeline?: CliRunPipeline | null;
  handoff?: CliRunHandoffDto | null;
}

const LIVE_STATUS_SET = new Set<string>([
  "completed",
  "failed",
  "interrupted",
  "running",
  "unknown",
  "awaiting_orchestrator",
  "closed",
]);

const ATTEMPT_TERMINAL = new Set(["success", "failure", "cancelled"]);
const ATTEMPT_LIVE = new Set(["running", "queued", "pending"]);

/** Old squad sidecars used interrupted + final.md as a close signal. Map at read. */
export function mapSquadObserveStatus(input: {
  kind: string;
  status: CliRunLiveStatus;
  progress: CliRunProgress | null;
}): CliRunLiveStatus {
  if (input.kind !== "squad") return input.status;
  if (input.status !== "interrupted") return input.status;
  const progress = input.progress;
  if (progress === null || progress.phase === "done") return input.status;
  const attempts = progress.attempts;
  if (attempts.length === 0) return input.status;
  if (attempts.some((row) => ATTEMPT_LIVE.has(row.status))) return "running";
  if (attempts.every((row) => ATTEMPT_TERMINAL.has(row.status))) {
    return "awaiting_orchestrator";
  }
  return input.status;
}

export function liveStateFromRecords(
  records: readonly unknown[],
  updatedAt: string | null = null,
): CliRunLiveState | null {
  let started: {
    attempts: Array<{
      attemptId: string;
      agentName: string;
      driverId: string;
      modelId: string;
    }>;
    aggregator: {
      attemptId: string;
      agentName: string;
      driverId: string;
      modelId: string;
    };
  } | null = null;
  const finished = new Map<string, { status: "success" | "failure"; durationMs: number }>();
  let aggregation: { status: "success" | "failure"; durationMs: number } | null = null;
  let runStatus: CliRunLiveState["status"] = "running";
  let sawFinished = false;

  for (const rec of records) {
    if (rec === null || typeof rec !== "object") continue;
    const row = rec as Record<string, unknown>;
    const kind = typeof row.kind === "string" ? row.kind : "";
    if (kind === "review.started") {
      const attempts = Array.isArray(row.attempts) ? row.attempts : [];
      const aggregator = row.aggregator;
      if (aggregator === null || typeof aggregator !== "object") continue;
      started = {
        attempts: attempts.flatMap((item) => {
          const parsed = asMeta(item);
          return parsed ? [parsed] : [];
        }),
        aggregator: asMeta(aggregator) ?? {
          attemptId: "aggregator",
          agentName: "aggregator",
          driverId: "unknown",
          modelId: "",
        },
      };
    } else if (kind === "attempt.finished") {
      const attemptId = typeof row.attemptId === "string" ? row.attemptId : "";
      const status = row.status === "success" || row.status === "failure" ? row.status : null;
      if (attemptId.length === 0 || status === null) continue;
      const durationMs = typeof row.durationMs === "number" ? row.durationMs : 0;
      finished.set(attemptId, { status, durationMs });
    } else if (kind === "review.resumed") {
      const rerun = Array.isArray(row.rerunAttemptIds) ? row.rerunAttemptIds : [];
      for (const id of rerun) {
        if (typeof id === "string") finished.delete(id);
      }
      aggregation = null;
      sawFinished = false;
      runStatus = "running";
    } else if (kind === "aggregation.finished") {
      const status = row.status === "success" || row.status === "failure" ? row.status : null;
      if (status === null) continue;
      aggregation = {
        status,
        durationMs: typeof row.durationMs === "number" ? row.durationMs : 0,
      };
    } else if (kind === "review.finished") {
      sawFinished = true;
      const st = row.status;
      if (st === "completed" || st === "failed" || st === "interrupted") runStatus = st;
    }
  }

  if (started === null) return null;

  const attemptRows: CliRunAttemptProgress[] = started.attempts.map((meta) => {
    const done = finished.get(meta.attemptId);
    return {
      ...meta,
      role: "attempt",
      status: done?.status ?? "queued",
      durationMs: done?.durationMs ?? null,
      lastActivity: null,
    };
  });
  const attemptTerminal = attemptRows.every(
    (row) => row.status === "success" || row.status === "failure",
  );
  const anyAttemptSuccess = attemptRows.some((row) => row.status === "success");
  let aggregatorStatus: CliRunAttemptLiveStatus = "pending";
  let aggregatorDuration: number | null = null;
  let phase: CliRunProgressPhase = "attempts";
  if (aggregation) {
    aggregatorStatus = aggregation.status;
    aggregatorDuration = aggregation.durationMs;
    phase = sawFinished ? "done" : "aggregating";
  } else if (attemptTerminal && anyAttemptSuccess && !sawFinished) {
    aggregatorStatus = "running";
    phase = "aggregating";
  } else if (sawFinished) {
    phase = "done";
  }

  attemptRows.push({
    ...started.aggregator,
    role: "aggregator",
    status: aggregatorStatus,
    durationMs: aggregatorDuration,
    lastActivity: null,
  });

  if (!sawFinished) runStatus = "running";

  return {
    version: 1,
    status: runStatus,
    progress: { phase, attempts: attemptRows, updatedAt },
    pipeline: null,
  };
}

/** Prefer status.json; if a pipeline wiped attempts, refill from transcript. */
export function mergeLiveProgress(
  live: CliRunProgress | null,
  fromTranscript: CliRunProgress | null,
): CliRunProgress | null {
  if (live === null) return fromTranscript;
  if (live.attempts.length > 0) return live;
  if (fromTranscript && fromTranscript.attempts.length > 0) {
    return { ...live, attempts: fromTranscript.attempts };
  }
  return live;
}

/** Overlay elapsed time / last tool onto still-running seats. Mutates `live`. */
export function applyLiveHeartbeat(live: CliRunLiveState, beat: CliRunLiveHeartbeat): void {
  for (const row of live.progress.attempts) {
    if (row.attemptId !== beat.attemptId) continue;
    if (beat.started && (row.status === "queued" || row.status === "pending")) {
      row.status = "running";
    }
    if (row.status !== "running") continue;
    if (beat.elapsedMs !== undefined) row.durationMs = Math.max(0, beat.elapsedMs);
    if (beat.lastActivity !== undefined) {
      row.lastActivity = clipActivity(beat.lastActivity);
    }
  }
}

export function withLiveHeartbeats(
  live: CliRunLiveState,
  beats: Iterable<CliRunLiveHeartbeat>,
): CliRunLiveState {
  const next: CliRunLiveState = {
    version: live.version,
    status: live.status,
    progress: {
      phase: live.progress.phase,
      updatedAt: live.progress.updatedAt,
      attempts: live.progress.attempts.map((row) => ({ ...row })),
    },
    pipeline: live.pipeline ? { ...live.pipeline } : live.pipeline,
    handoff: live.handoff ?? null,
  };
  for (const beat of beats) applyLiveHeartbeat(next, beat);
  return next;
}

function clipActivity(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const chars = Array.from(trimmed);
  return chars.length > LAST_ACTIVITY_MAX ? chars.slice(0, LAST_ACTIVITY_MAX).join("") : trimmed;
}

export function parseLiveStateJson(text: string): CliRunLiveState | null {
  let rec: unknown;
  try {
    rec = JSON.parse(text);
  } catch {
    return null;
  }
  if (rec === null || typeof rec !== "object") return null;
  const row = rec as Record<string, unknown>;
  if (row.version !== 1) return null;
  const status = row.status;
  if (typeof status !== "string" || !LIVE_STATUS_SET.has(status)) {
    return null;
  }
  const progress = parseProgress(row.progress);
  if (progress === null) return null;
  const pipeline = parsePipeline(row.pipeline);
  const handoff = parseHandoff(row.handoff);
  return { version: 1, status: status as CliRunLiveStatus, progress, pipeline, handoff };
}

function parseHandoff(value: unknown): CliRunHandoffDto | null {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const currentFixRaw = row.currentFix ?? row.current_fix;
  let currentFix: unknown;
  if (typeof currentFixRaw === "string") {
    currentFix = currentFixRaw;
  } else if (
    currentFixRaw !== null &&
    typeof currentFixRaw === "object" &&
    !Array.isArray(currentFixRaw)
  ) {
    const cf = currentFixRaw as Record<string, unknown>;
    currentFix = {
      round: cf.round,
      operationId: cf.operationId ?? cf.operation_id,
    };
  }
  const seatNotesRaw = row.seatNotes ?? row.seat_notes;
  const seatNotes = Array.isArray(seatNotesRaw)
    ? seatNotesRaw.map((item) => {
        if (item === null || typeof item !== "object") return item;
        const seat = item as Record<string, unknown>;
        return {
          attemptId: seat.attemptId ?? seat.attempt_id,
          purpose: seat.purpose,
          note: seat.note,
        };
      })
    : undefined;
  const parsed = cliRunHandoffSchema.safeParse({
    epoch: row.epoch,
    candidateSha: row.candidateSha ?? row.candidate_sha,
    candidateStatus: row.candidateStatus ?? row.candidate_status,
    invalidatedReason: row.invalidatedReason ?? row.invalidated_reason,
    taskBaseSha: row.taskBaseSha ?? row.task_base_sha,
    parentCandidateSha: row.parentCandidateSha ?? row.parent_candidate_sha,
    currentFix,
    next: row.next,
    approved: row.approved,
    reviewerVerdict: row.reviewerVerdict ?? row.reviewer_verdict,
    verifierVerdict: row.verifierVerdict ?? row.verifier_verdict,
    remainingBlockers: row.remainingBlockers ?? row.remaining_blockers,
    reviewRunId: row.reviewRunId ?? row.review_run_id,
    seatNotes,
  });
  if (!parsed.success) return null;
  const data = parsed.data;
  const current =
    data.currentFix &&
    typeof data.currentFix === "object" &&
    data.currentFix.round === undefined &&
    data.currentFix.operationId === undefined
      ? undefined
      : data.currentFix;
  const cleaned: CliRunHandoffDto = { ...data, currentFix: current };
  if (!handoffHasContent(cleaned)) return null;
  return cleaned;
}

function handoffHasContent(value: CliRunHandoffDto): boolean {
  return Object.values(value).some((item) => item !== undefined);
}

export function parsePipeline(value: unknown): CliRunPipeline | null {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const phase = row.phase;
  if (
    phase !== "planning" &&
    phase !== "plan-review" &&
    phase !== "plan-aggregating" &&
    phase !== "applying" &&
    phase !== "re-reviewing" &&
    phase !== "done"
  ) {
    return null;
  }
  const round = typeof row.round === "number" && Number.isInteger(row.round) ? row.round : null;
  const maxRounds =
    typeof row.maxRounds === "number" && Number.isInteger(row.maxRounds) ? row.maxRounds : null;
  if (round === null || round < 0 || maxRounds === null || maxRounds < 1) return null;
  const planVerdict =
    row.planVerdict === "approve" ||
    row.planVerdict === "changes-requested" ||
    row.planVerdict === "comment"
      ? row.planVerdict
      : row.planVerdict === null
        ? null
        : undefined;
  if (planVerdict === undefined) return null;
  const applyStatus =
    row.applyStatus === "pending" ||
    row.applyStatus === "running" ||
    row.applyStatus === "success" ||
    row.applyStatus === "failure" ||
    row.applyStatus === "skipped"
      ? row.applyStatus
      : row.applyStatus === null
        ? null
        : undefined;
  if (applyStatus === undefined) return null;
  const followUpRunId =
    typeof row.followUpRunId === "string"
      ? row.followUpRunId
      : row.followUpRunId === null
        ? null
        : undefined;
  if (followUpRunId === undefined) return null;
  const summary =
    typeof row.summary === "string" ? row.summary : row.summary === null ? null : undefined;
  if (summary === undefined) return null;
  if (typeof row.updatedAt !== "string" || row.updatedAt.length === 0) return null;
  return {
    phase,
    round,
    maxRounds,
    planVerdict,
    applyStatus,
    followUpRunId,
    summary,
    updatedAt: row.updatedAt,
  };
}

function parseProgress(value: unknown): CliRunProgress | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const phase = row.phase;
  if (typeof phase !== "string" || !PROGRESS_PHASE_SET.has(phase)) {
    return null;
  }
  if (!Array.isArray(row.attempts)) return null;
  const attempts: CliRunAttemptProgress[] = [];
  for (const item of row.attempts) {
    const parsed = parseAttempt(item);
    if (parsed === null) return null;
    attempts.push(parsed);
  }
  const updatedAt = typeof row.updatedAt === "string" ? row.updatedAt : null;
  return { phase: phase as CliRunProgressPhase, attempts, updatedAt };
}

function parseAttempt(value: unknown): CliRunAttemptProgress | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const role = row.role === "aggregator" ? "aggregator" : row.role === "attempt" ? "attempt" : null;
  const status =
    row.status === "pending" ||
    row.status === "queued" ||
    row.status === "running" ||
    row.status === "success" ||
    row.status === "failure" ||
    row.status === "cancelled"
      ? row.status
      : null;
  if (role === null || status === null) return null;
  if (typeof row.attemptId !== "string" || typeof row.agentName !== "string") return null;
  if (typeof row.driverId !== "string" || typeof row.modelId !== "string") return null;
  const durationMs =
    row.durationMs === null ? null : typeof row.durationMs === "number" ? row.durationMs : null;
  const lastActivity =
    row.lastActivity === undefined || row.lastActivity === null
      ? null
      : typeof row.lastActivity === "string"
        ? clipActivity(row.lastActivity)
        : null;
  return {
    attemptId: row.attemptId,
    agentName: row.agentName,
    driverId: row.driverId,
    modelId: row.modelId,
    role,
    status,
    durationMs,
    lastActivity,
  };
}

function asMeta(value: unknown): {
  attemptId: string;
  agentName: string;
  driverId: string;
  modelId: string;
} | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.attemptId !== "string" || typeof row.agentName !== "string") return null;
  if (typeof row.driverId !== "string" || typeof row.modelId !== "string") return null;
  return {
    attemptId: row.attemptId,
    agentName: row.agentName,
    driverId: row.driverId,
    modelId: row.modelId,
  };
}
