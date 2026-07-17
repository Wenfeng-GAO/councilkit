/**
 * ModelExecution (U4): the global commit anchor for one model call.
 *
 * Stores execution bookkeeping only — never deltas, instructions, or
 * duplicate body text. The normalized output lives exactly once in the
 * committed Message/Summary; this record holds its digest for idempotent
 * replay checks.
 */

export type ModelExecutionState =
  /** Persisted locally, not yet dispatched to the Host. */
  | "prepared"
  /** Dispatched; events streaming. */
  | "running"
  /** Host completed; output not yet persisted by an Orchestrator transaction. */
  | "succeeded_uncommitted"
  /** Persisted (Message or Summary) with ackState pending. */
  | "committed"
  /** Persisted as intentionally dropped (mismatch/stale/empty/tool-unknown). */
  | "discarded"
  /** No ACKable Host terminal exists (retryable analysis recorded). */
  | "failed"
  | "interrupted";

export type DispatchState = "not_dispatched" | "unknown" | "accepted";
export type ToolState = "none" | "active" | "completed" | "unknown";
export type AckState = "pending" | "acknowledged" | "expired";
export type ResultKind = "message" | "summary";

/** Structured runtime outcome kept for discarded executions. */
export type RuntimeOutcome =
  | "model_mismatch"
  | "tool_state_unknown"
  | "stale_context"
  | "empty_output"
  | "needs_rebase"
  | "user_cancelled";

export interface ModelExecutionError {
  code: string;
  phase: string;
  message: string;
  retryable: boolean;
}

export interface ModelExecutionUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
}

export interface ModelExecution {
  /** Globally unique commit anchor (PK). Retries reconnect, never re-dispatch. */
  executionId: string;
  roomId: string;
  roundId: string;
  participantId: string;
  /** Fixed BEFORE dispatch; commit only materializes this kind of entity. */
  resultKind: ResultKind;
  state: ModelExecutionState;

  /** Host identity at dispatch time (ACK re-send after restart uses these). */
  hostInstanceId: string | null;
  executionScopeId: string | null;

  requestedModel: string;
  effectiveModel: string | null;
  dispatchState: DispatchState;
  toolState: ToolState;

  /** Expected facts at dispatch: staleness checks at commit time. */
  contextRevision: number;
  expectedRoomDigest: string;
  participantSnapshotDigest: string;
  instructionDigest: string;

  /** Set at commit/discard. */
  contentDigest: string | null;
  committedEntityType: ResultKind | null;
  committedEntityId: string | null;
  runtimeOutcome: RuntimeOutcome | null;

  usage: ModelExecutionUsage | null;
  error: ModelExecutionError | null;
  finalEventSeq: number | null;
  /** ACK lifecycle; null until a terminal has been persisted. */
  ackState: AckState | null;

  /** At most one automatic retry, linked back to the original attempt. */
  retryOfExecutionId: string | null;

  createdAt: string;
  updatedAt: string;
}

/** Round invariants (plan U4), enforced by the commit transactions:
 * - completed  ⇒ committed Summary, cursor at end, no activeExecutionId
 * - aborted    ⇒ no activeExecutionId; Summary not required
 * - paused     ⇒ pauseReason + pausedFrom present
 * - committed execution ⇒ committed entity; discarded ⇒ none
 * - failed/interrupted never become committed/discarded
 */
