import { PAUSE_REASON_COPY } from "@/components/room/pause-reasons";
import type {
  DiscussionAgent,
  DiscussionRound,
  Participant,
  RoomRunState,
  RoundPauseReason,
  RoundPhase,
} from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";
import type { RuntimeBinding } from "@/models/discussion/runtime-binding";

/**
 * Round-timeline display helpers (U6): pure functions shared by RoomHeader,
 * DiscussionStream and the failure records. Unit tested in
 * tests/unit/round-timeline.test.ts.
 */

export interface Speaker {
  name: string;
  color: string;
}

export const USER_SPEAKER: Speaker = { name: "你", color: "#8b919a" };

const UNKNOWN_SPEAKER: Speaker = { name: "未知参与者", color: "#8b919a" };

/** Resolve a Participant id to its display name/color via the Agent snapshot. */
export function resolveSpeaker(
  participantId: string | null | undefined,
  participantsById: ReadonlyMap<string, Participant>,
  agentsById: ReadonlyMap<string, DiscussionAgent>,
): Speaker {
  if (!participantId) return UNKNOWN_SPEAKER;
  const participant = participantsById.get(participantId);
  if (!participant) return UNKNOWN_SPEAKER;
  const agent = agentsById.get(participant.agentId);
  if (!agent) return { name: participant.modelId, color: "#8b919a" };
  return { name: agent.name, color: agent.color };
}

/** Executions shown as collapsed failure records: intentionally discarded or
 * terminally failed/interrupted (never committed/in-flight). */
export function isFailedExecution(execution: ModelExecution): boolean {
  return (
    execution.state === "discarded" ||
    execution.state === "failed" ||
    execution.state === "interrupted"
  );
}

export const ROUND_PHASE_LABELS: Record<RoundPhase, string> = {
  pending: "待开始",
  prewarming: "预热中",
  running: "进行中",
  summarizing: "总结中",
  paused: "已暂停",
  completed: "已完成",
  aborted: "已终止",
};

export function roundPhaseLabel(phase: RoundPhase): string {
  return ROUND_PHASE_LABELS[phase];
}

export function roundPhaseTone(phase: RoundPhase): "muted" | "info" | "success" | "error" | "warn" {
  switch (phase) {
    case "running":
    case "summarizing":
    case "prewarming":
      return "info";
    case "paused":
      return "warn";
    case "completed":
      return "success";
    case "aborted":
      return "error";
    default:
      return "muted";
  }
}

export const ROOM_RUN_STATE_LABELS: Record<RoomRunState, string> = {
  idle: "空闲",
  running: "运行中",
  paused: "已暂停",
};

export function roomRunStateLabel(runState: RoomRunState): string {
  return ROOM_RUN_STATE_LABELS[runState];
}

export function roomRunStateTone(
  runState: RoomRunState,
): "muted" | "info" | "success" | "error" | "warn" {
  switch (runState) {
    case "running":
      return "info";
    case "paused":
      return "warn";
    default:
      return "muted";
  }
}

export interface FailureRecordDisplay {
  /** Structured code line (mapped outcome title or the raw error code). */
  codeLabel: string;
  /** 已丢弃 / 执行失败 / 已中断. */
  stateLabel: string;
  tone: "error" | "warn";
  /** Untrusted detail (rendered as a plain text node, never markdown HTML). */
  detail: string | null;
}

/** What a collapsed failure record shows: code + state + detail, NO body text. */
export function failureRecordDisplay(execution: ModelExecution): FailureRecordDisplay {
  const stateLabel =
    execution.state === "discarded"
      ? "已丢弃"
      : execution.state === "failed"
        ? "执行失败"
        : "已中断";
  const codeLabel = execution.runtimeOutcome
    ? PAUSE_REASON_COPY[execution.runtimeOutcome].title
    : (execution.error?.code ?? "执行失败");
  return {
    codeLabel,
    stateLabel,
    tone: execution.state === "discarded" ? "warn" : "error",
    detail: execution.error?.message ?? null,
  };
}

// ---------------------------------------------------------------------------
// S3 recovery display: pure derivation for the PausedPanel branches, the
// retry-count badge, the rotation timeline entry, and the skipped marker.
// All four are zero-new-field: they derive from persisted facts the queries
// already load (executions, bindings, rounds).
// ---------------------------------------------------------------------------

export type PausedPanelBranch = "rotate" | "recoverable" | "facilitator" | "default";

/** The needs_rebase family: the persisted code is normalized to
 * execution_failed by failExecution, so the family is recognized by either the
 * (legacy/edge) code OR the reconciliation detail prefix. */
export function isNeedsRebasePause(reason: RoundPauseReason): boolean {
  return (
    reason.code === "needs_rebase" || (reason.detail ?? "").includes("session reconciliation:")
  );
}

const DEFAULT_BRANCH_CODES: ReadonlySet<RoundPauseReason["code"]> = new Set([
  "prewarm_failed",
  "user_cancelled",
  "facilitator_unavailable",
]);

const RECOVERABLE_CODES: ReadonlySet<RoundPauseReason["code"]> = new Set([
  "model_mismatch",
  "tool_state_unknown",
  "stale_context",
  "empty_output",
  "execution_failed",
]);

/** Pause-code branching (plan-a §1.6 / ruling #1): the needs_rebase family →
 * rotate; a recoverable failure on the facilitator → facilitator (retry +
 * repair + terminate, NO skip); a recoverable failure on someone else →
 * recoverable (retry / skip / terminate); prewarm_failed / user_cancelled /
 * facilitator_unavailable keep the default affordances. A missing participantId
 * reads as non-facilitator. */
export function pausedPanelBranch(
  reason: RoundPauseReason,
  facilitatorParticipantId: string | undefined,
): PausedPanelBranch {
  if (isNeedsRebasePause(reason)) return "rotate";
  if (DEFAULT_BRANCH_CODES.has(reason.code)) return "default";
  if (RECOVERABLE_CODES.has(reason.code)) {
    return reason.participantId && reason.participantId === facilitatorParticipantId
      ? "facilitator"
      : "recoverable";
  }
  return "default";
}

/** Already-retried count for the paused slot (plan-a §1.5): the number of
 * executions on the SAME (round, participant, resultKind) slot whose
 * retryOfExecutionId is set — the chain length minus one, including the auto
 * retry (the data is isomorphic to "manual" retries, so the UI copy says
 * "已重试" not "已手动重试"). Zero when the pause carries no executionId. */
export function retryCountForPause(
  executions: readonly ModelExecution[],
  reason: RoundPauseReason,
): number {
  if (!reason.executionId) return 0;
  const anchor = executions.find((execution) => execution.executionId === reason.executionId);
  if (!anchor) return 0;
  return executions.filter(
    (execution) =>
      execution.roundId === anchor.roundId &&
      execution.participantId === anchor.participantId &&
      execution.resultKind === anchor.resultKind &&
      execution.retryOfExecutionId !== null,
  ).length;
}

export interface RotationDisplay {
  /** 1-based ordinal of this failure among the room's NEEDS_REBASE failures. */
  n: number;
  /** True when a binding newer than this failure has its scope built. */
  rebuilt: boolean;
}

/** Rotation timeline entry (plan-a §1.5 / §2.4): only NEEDS_REBASE failure
 * records carry it; N is the failure's 1-based ordinal among the room's
 * NEEDS_REBASE failures (sorted by createdAt then executionId), and rebuilt is
 * proven by a binding whose createdAt is later than the failure's AND that has
 * a non-null executionScopeId (R2: a binding stuck in `creating` proves no
 * rebuild). Returns null for a non-NEEDS_REBASE execution so the timeline
 * renders nothing. */
export function rotationDisplayFor(
  execution: ModelExecution,
  roomExecutions: readonly ModelExecution[],
  bindings: readonly RuntimeBinding[],
): RotationDisplay | null {
  if (execution.error?.code !== "NEEDS_REBASE") return null;
  const needsRebase = roomExecutions
    .filter((candidate) => candidate.error?.code === "NEEDS_REBASE")
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.executionId < b.executionId
          ? -1
          : 1
        : a.createdAt < b.createdAt
          ? -1
          : 1,
    );
  const index = needsRebase.findIndex(
    (candidate) => candidate.executionId === execution.executionId,
  );
  const n = index + 1;
  // R2: a binding only proves a rebuild when it (a) appeared after this failure
  // AND (b) actually obtained an executionScopeId from the Host. A newer binding
  // still in `creating` (Host create failed, scopeId empty) has no live Scope to
  // spring back from — it must NOT read as rebuilt, or the timeline lies.
  const rebuilt = bindings.some(
    (binding) => binding.createdAt > execution.createdAt && binding.executionScopeId !== null,
  );
  return { n, rebuilt };
}

/** Already-skipped marker (plan-a §1.5 / §1.7): a message-kind terminal
 * failure whose order slot the cursor has passed AND that has no committed
 * message execution — i.e. exactly the slots deriveSkipAnnotations annotates.
 *
 * R1 — 跳过事实必须永久：permanence is independent of `round.phase`, INCLUDING
 * aborted. A round the user aborted AFTER a skip must keep rendering its
 * 「· 已跳过」 marker, mirroring deriveSkipAnnotations (the annotation); the
 * timeline 「跳过记录折叠区保留并呈现」 brief demands the marker survives an
 * abort. Keep this lock-step with deriveSkipAnnotations. */
export function isSkippedFailure(
  execution: ModelExecution,
  rounds: readonly DiscussionRound[],
  roomExecutions: readonly ModelExecution[],
): boolean {
  if (execution.resultKind !== "message") return false;
  if (
    execution.state !== "failed" &&
    execution.state !== "discarded" &&
    execution.state !== "interrupted"
  ) {
    return false;
  }
  const round = rounds.find((candidate) => candidate.id === execution.roundId);
  if (!round) return false;
  const slotIndex = round.participantOrder.indexOf(execution.participantId);
  if (slotIndex < 0 || slotIndex >= round.nextParticipantIndex) return false;
  const slotHasCommitted = roomExecutions.some(
    (candidate) =>
      candidate.roundId === execution.roundId &&
      candidate.participantId === execution.participantId &&
      candidate.resultKind === "message" &&
      candidate.state === "committed",
  );
  return !slotHasCommitted;
}
