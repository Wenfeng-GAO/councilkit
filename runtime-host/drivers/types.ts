import type {
  DispatchState,
  DriverCapabilityState,
  DriverId,
  ToolState,
} from "@shared/runtime/contracts";
import type { RuntimeEvent } from "@shared/runtime/events";
import type { ParticipantSpec } from "@shared/runtime/schemas";
import type { InstallationRecord } from "../installations/registry";
import type { Logger } from "../logging";
import type { ProcessSupervisor } from "../process/process-supervisor";

/**
 * The Host Driver contract both V1 drivers implement. One driver instance
 * belongs to exactly one Participant; Participants never share processes or
 * Execution Sessions, and a Participant runs at most one Model Execution at
 * a time (enforced by the scope manager).
 */

/** Distributes Omit over a union so per-variant fields survive. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Event payload as produced by a driver: the registry stamps ids/seq/time. */
export type DriverEvent = DistributiveOmit<RuntimeEvent, "executionId" | "seq" | "at">;

export type Emit = (event: DriverEvent) => void;

export interface DriverTimeouts {
  handshakeMs: number;
  dispatchAckMs: number;
  streamIdleMs: number;
  turnMs: number;
  interruptGraceMs: number;
  shutdownGraceMs: number;
}

export interface DriverDeps {
  supervisor: ProcessSupervisor;
  logger: Logger;
  timeouts: DriverTimeouts;
  /** Participant-dedicated working directory root (already prepared). */
  workRoot: string;
}

export interface PrewarmInput {
  participantId: string;
  spec: ParticipantSpec;
  installation: InstallationRecord;
}

export interface PrewarmResult {
  /** Canonical model reported by the live handshake (never guessed). */
  canonicalModelId: string;
  /** Aliases the driver explicitly declares equivalent to the canonical id. */
  modelAliases: string[];
  /** Digest input describing the capability surface for binding digests. */
  capability: Record<string, unknown>;
  /** Full model catalog when the driver exposes one (codex model/list). */
  catalog: string[];
}

export interface ExecuteInput {
  executionId: string;
  /** Deterministically rendered turn text (full snapshot or incremental). */
  prompt: string;
  /** Canonical requested model id. */
  modelId: string;
  /** True when this is the first turn of a fresh Execution Session. */
  coldStart: boolean;
}

export interface DriverFailure {
  code: string;
  message: string;
  retryable: boolean;
  dispatchState: DispatchState;
  toolState: ToolState;
}

export interface ParticipantDriver {
  readonly participantId: string;
  readonly driverId: DriverId;
  /**
   * Monotonic Execution Session generation: increments whenever the CLI
   * session/thread is rebuilt. The reconciler treats a generation change as
   * a cold session requiring a full snapshot.
   */
  readonly sessionEpoch: number;
  prewarm(input: PrewarmInput): Promise<PrewarmResult>;
  /**
   * Runs one turn to a terminal event (emitted via `emit`). Implementations
   * apply the driver's own safe-retry policy: claude-stream-json may retry
   * once when dispatch provably never happened; codex-app-server never
   * retries in place (`accepted`/`unknown` must surface for a paused Round).
   */
  execute(input: ExecuteInput, emit: Emit): Promise<void>;
  cancel(executionId: string): Promise<void>;
  close(): Promise<void>;
  /** Live readiness via the same parser/handshake used for execute. */
  capabilityState(): DriverCapabilityState;
  /**
   * Context window reported by the runtime (codex tokenUsage), or null when
   * the driver cannot report one — callers then assume 64k tokens (plan U3).
   */
  contextWindowTokens(): number | null;
}

export type DriverFactory = (deps: DriverDeps) => (participantId: string) => ParticipantDriver;
