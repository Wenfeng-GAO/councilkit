/**
 * Run orchestration types (plan-a §5/§6). The orchestrator drives a fixed-N-
 * round council outside the browser: it owns the Scope lifecycle (create →
 * activate → N ordered ordinary turns → one Reporter turn → close), the
 * transcript persistence (persist-before-ACK), and the deterministic report.
 *
 * Failure semantics (brief §2d, plan-a §6): any non-completed turn stops the
 * Run, retains the transcript, writes an INCOMPLETE partial report, and exits
 * non-zero. SIGINT runs a bounded cleanup then exits 130.
 */
import type { ExitCode } from "../errors";
import type { TurnResult } from "../host/execute-turn";
import type { AgentSnapshot, CouncilRecord, ResolvedProfile } from "../store/schemas";

/** A council snapshot captured at run start (self-describing transcript). */
export interface CouncilSnapshot {
  id: string;
  name: string;
  topic: string;
  background: string;
  targetOutput: string;
  rounds: number;
  reporterAgentId: string;
  agentIds: string[];
}

/** A resolved agent ready to participate: snapshot + its per-run profile +
 * resolved installation + stable participant id. */
export interface ResolvedAgent {
  snapshot: AgentSnapshot;
  /** The shared ExecutionProfileDto built from Driver Selection + dynamic
   * installationId. Carries no secret. */
  profile: ResolvedProfile;
  installationId: string;
  /** Stable participant id for this run (one per agent, used in every snapshot
   * and scope participant spec). */
  participantId: string;
  /** Stable per-agent digest over the persona (reconciler requires it never
   * changes across turns for the same participant). */
  participantSnapshotDigest: string;
}

/** A completed ordinary turn's persisted signature, for snapshot items. */
export interface CompletedTurn {
  agentId: string;
  agentName: string;
  participantId: string;
  executionId: string;
  output: string;
  round: number;
  turnIndex: number;
}

export type RunStatus = "completed" | "failed" | "interrupted";

export interface RunFailure {
  phase: string;
  code: string;
  message: string;
}

export interface TurnSummary {
  role: "message" | "report";
  round: number;
  turnIndex: number;
  agentId: string;
  agentName: string;
  verdict: string;
  effectiveModel: string | null;
  durationMs: number;
}

export interface RunOutcome {
  status: RunStatus;
  exitCode: ExitCode;
  runId: string;
  reportPath: string;
  transcriptPath: string;
  startedAt: string;
  endedAt: string;
  turns: TurnSummary[];
  /** Per-agent resolved installationId (agentId → installationId). */
  installations: Record<string, string>;
  failure: RunFailure | null;
  /** G4: any local store/report artifact IO failure that drove the exit code
   * to 5 (canonical report write, --out copy, final transcript rewrite,
   * INCOMPLETE reconciliation). Present alongside `failure` so both the
   * primary turn/reporter failure and the artifact IO failure are visible. */
  artifactIoFailure: RunFailure | null;
  incomplete: boolean;
}

/** Progress event emitted to stderr (JSON mode) / stdout (human mode). */
export type RunProgressEvent =
  | { type: "run.starting"; runId: string; council: string }
  | { type: "round.start"; round: number; totalRounds: number }
  | {
      type: "turn.start";
      round: number;
      turnIndex: number;
      agent: string;
      role: "message" | "report";
    }
  | {
      type: "turn.done";
      round: number;
      turnIndex: number;
      agent: string;
      verdict: string;
      durationMs: number;
    }
  | { type: "report.writing"; runId: string }
  | { type: "run.finishing"; status: RunStatus };

/** Input assembled by the command layer and handed to the orchestrator. */
export interface RunInput {
  runId: string;
  council: CouncilSnapshot;
  /** Ordered participants (agentIds order from the council). */
  agents: ResolvedAgent[];
  reporter: ResolvedAgent;
  rounds: number;
  /** Optional user --out path for a report copy. */
  outPath?: string;
}

/** Re-export so the orchestrator's turn driver can shape results uniformly. */
export type { TurnResult, CouncilRecord };
