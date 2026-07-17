import { PAUSE_REASON_COPY } from "@/components/room/pause-reasons";
import type {
  DiscussionAgent,
  Participant,
  RoomRunState,
  RoundPhase,
} from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";

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
