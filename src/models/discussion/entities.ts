/**
 * Target discussion domain models (U4): the recoverable, idempotently
 * committed single source of truth, decoupled from ephemeral CLI sessions.
 *
 * These shapes supersede the legacy `src/models/*` records (kept untouched
 * until U7 removal). Domain language: CONTEXT.md; invariants: plan U4 and
 * docs/runtime-host-design.md "目标 Dexie 模型".
 */

// ---------------------------------------------------------------------------
// Agent: globally reusable entity = persona + executionProfileId + modelId.
// Same persona bound to a different Profile or model IS a different Agent.
// ---------------------------------------------------------------------------

export interface DiscussionAgent {
  id: string;
  name: string;
  personaPrompt: string;
  executionProfileId: string;
  modelId: string;
  color: string;
  /** Incremented on every edit; Participants snapshot it at join time. */
  revision: number;
  /** Disabled Agents are hidden from new-room pickers (S7); joined Participants keep their snapshots. */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Participant: one Agent's participation in one Room. Immutable once it has
// spoken; a config change after first speech ends it and a new active
// Participant is created from the next Round.
// ---------------------------------------------------------------------------

export type ParticipantState = "active" | "ended";

export interface Participant {
  id: string;
  roomId: string;
  agentId: string;
  /** Join-time snapshots (persona / safe Profile fields / model). */
  personaPrompt: string;
  executionProfileId: string;
  profileRevision: number;
  profileDigest: string;
  modelId: string;
  /** Deterministic digest over the full snapshot above. */
  participantSnapshotDigest: string;
  state: ParticipantState;
  createdAt: string;
  endedAt: string | null;
}

// ---------------------------------------------------------------------------
// Room: explicit facilitator + runState gate + monotonic context revision.
// Relationship facts live in table indexes, never in id arrays.
// ---------------------------------------------------------------------------

export type RoomRunState = "idle" | "running" | "paused";

/** Discussion mode; carried solely by instruction template families (ADR-0010), zero orchestration branches. */
export type DiscussionMode = "brainstorm" | "planning" | "review";

/** Persisted lifecycle only; "concluding" is an orchestration transient and is never stored. */
export type RoomStatus = "open" | "concluded";

export interface DiscussionRoom {
  id: string;
  topic: string;
  background: string;
  facilitatorParticipantId: string;
  /** User scheduling gate; independent of the active Round's phase. */
  runState: RoomRunState;
  /** CAS'd at Round creation: at most one unfinalized Round per Room. */
  activeRoundId: string | null;
  /** Bumped exactly once per atomic change to the shared persisted projection. */
  contextRevision: number;
  /** Deterministic digest of the normalized shared discussion projection. */
  contextDigest: string;
  /** Backfilled to "brainstorm" by the Dexie v2 upgrade. */
  mode: DiscussionMode;
  /** Free-text desired output; "" = unspecified. */
  targetOutput: string;
  /** Hard round cap; null = unlimited. */
  maxRounds: number | null;
  status: RoomStatus;
  createdAt: string;
  lastActiveAt: string;
}

// ---------------------------------------------------------------------------
// Round: recoverable state machine (see design doc state diagram).
// ---------------------------------------------------------------------------

export type RoundPhase =
  | "pending"
  | "prewarming"
  | "running"
  | "summarizing"
  | "paused"
  | "completed"
  | "aborted";

export type RoundPausedFrom = "prewarming" | "running" | "summarizing";

/** Structured pause reason; the UI renders repair affordances from it. */
export interface RoundPauseReason {
  code:
    | "prewarm_failed"
    | "facilitator_unavailable"
    | "model_mismatch"
    | "tool_state_unknown"
    | "stale_context"
    | "empty_output"
    | "needs_rebase"
    | "execution_failed"
    | "user_cancelled";
  participantId?: string;
  executionId?: string;
  detail?: string;
}

export interface DiscussionRound {
  id: string;
  roomId: string;
  roundNumber: number;
  /** Participant id order snapshot taken at Round start. */
  participantOrder: string[];
  phase: RoundPhase;
  pausedFrom: RoundPausedFrom | null;
  pauseReason: RoundPauseReason | null;
  /** Cursor into participantOrder: the next Participant to speak. */
  nextParticipantIndex: number;
  /** Persisted BEFORE dispatching to the Host; cleared atomically on commit. */
  activeExecutionId: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Message: user or participant speech. Model messages carry a unique
// sourceExecutionId; user messages leave it null.
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "participant";

export interface DiscussionMessage {
  id: string;
  roomId: string;
  roundId: string;
  role: MessageRole;
  /** Null exactly when role === "user". */
  participantId: string | null;
  content: string;
  /** Non-null (and unique) for model-produced messages, null for user ones. */
  sourceExecutionId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Summary: independent Model Execution by the Room's facilitator; committed
// Summary is required for a Round to reach completed.
// ---------------------------------------------------------------------------

export interface DiscussionSummary {
  id: string;
  roomId: string;
  roundId: string;
  content: string;
  /** Always non-null: summaries only exist as committed model output. */
  sourceExecutionId: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// DecisionReport (ADR-0009): one committed decision report per Room, produced
// by a dedicated facilitator Model Execution via the same idempotent
// persist→ACK pipeline. Same discipline as Summary: only ever created by a
// commit; sourceExecutionId is unique.
// ---------------------------------------------------------------------------

export interface DecisionReport {
  id: string;
  roomId: string;
  content: string;
  /** Always non-null and unique: reports only exist as committed model output. */
  sourceExecutionId: string;
  createdAt: string;
}
