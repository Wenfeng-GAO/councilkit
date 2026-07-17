import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/runtime/digest";
import type { ContextSnapshot, SnapshotItem } from "@shared/runtime/schemas";
import { renderTurn } from "./snapshot-render";

/**
 * Host-owned Session Reconciler.
 *
 * A Participant's Execution Session is reused only for a STRICT append-only
 * Context Snapshot: same digestVersion, non-decreasing revision, unchanged
 * participant snapshot digest, and an exact id+content prefix of previously
 * applied items. Anything else is `needs_rebase` — V1 never auto-rebases an
 * active Scope; the Orchestrator persists a pause and closes the Scope.
 *
 * Independent of CouncilKit digests, a Session also becomes unusable when the
 * runtime signals compaction/truncation (driver invalidates the epoch) or it
 * reaches the plan's safety thresholds: 32 executions, or cumulative
 * estimated input ≥ 50% of the reported context window (64k when unknown).
 */

export const SESSION_MAX_EXECUTIONS = 32;
export const CONTEXT_WINDOW_THRESHOLD_RATIO = 0.5;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 65_536;

export interface SessionRecord {
  sessionEpoch: number;
  digestVersion: number;
  contextRevision: number;
  contextDigest: string;
  participantSnapshotDigest: string;
  appliedItemCount: number;
  itemDigests: string[];
  executionCount: number;
  cumulativeInputTokens: number;
  executionIds: string[];
}

export type ReconcileOutcome =
  | {
      kind: "ok";
      basis: "full" | "incremental";
      prompt: string;
      appliedItemCount: number;
    }
  | {
      kind: "needs_rebase";
      reason:
        | "digest_version_changed"
        | "history_replaced"
        | "participant_changed"
        | "revision_regressed"
        | "session_execution_limit"
        | "context_window_threshold";
    };

export interface SessionReconciler {
  reconcile(
    participantId: string,
    snapshot: ContextSnapshot,
    driverSessionEpoch: number,
    contextWindowTokens: number | null,
  ): ReconcileOutcome;
  recordApplied(
    participantId: string,
    snapshot: ContextSnapshot,
    executionId: string,
    driverSessionEpoch: number,
    usage: { inputTokens?: number | null } | null,
  ): void;
  /** Session lost or compacted: next reconcile starts cold on the new epoch. */
  invalidate(participantId: string): void;
  record(participantId: string): SessionRecord | null;
  reset(): void;
}

function hashItem(item: SnapshotItem): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        id: item.id,
        role: item.role,
        participantId: item.participantId,
        content: item.content,
        sourceExecutionId: item.sourceExecutionId,
      }),
    )
    .digest("hex");
}

export function createSessionReconciler(): SessionReconciler {
  const records = new Map<string, SessionRecord>();

  return {
    reconcile(participantId, snapshot, driverSessionEpoch, contextWindowTokens) {
      const record = records.get(participantId);
      const items = snapshot.roomContext.items;

      if (!record || record.sessionEpoch !== driverSessionEpoch) {
        // Cold session: full snapshot is always acceptable.
        const { prompt, itemCount } = renderTurn(snapshot, 0);
        return { kind: "ok", basis: "full", prompt, appliedItemCount: itemCount };
      }

      if (record.executionCount >= SESSION_MAX_EXECUTIONS) {
        return { kind: "needs_rebase", reason: "session_execution_limit" };
      }
      const window = contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
      if (record.cumulativeInputTokens >= window * CONTEXT_WINDOW_THRESHOLD_RATIO) {
        return { kind: "needs_rebase", reason: "context_window_threshold" };
      }

      if (snapshot.digestVersion !== record.digestVersion) {
        return { kind: "needs_rebase", reason: "digest_version_changed" };
      }
      if (snapshot.roomContext.contextRevision < record.contextRevision) {
        return { kind: "needs_rebase", reason: "revision_regressed" };
      }
      if (snapshot.participant.participantSnapshotDigest !== record.participantSnapshotDigest) {
        return { kind: "needs_rebase", reason: "participant_changed" };
      }
      if (items.length < record.appliedItemCount) {
        return { kind: "needs_rebase", reason: "history_replaced" };
      }
      for (let i = 0; i < record.appliedItemCount; i += 1) {
        if (hashItem(items[i] as SnapshotItem) !== record.itemDigests[i]) {
          return { kind: "needs_rebase", reason: "history_replaced" };
        }
      }
      const { prompt, itemCount } = renderTurn(snapshot, record.appliedItemCount);
      return { kind: "ok", basis: "incremental", prompt, appliedItemCount: itemCount };
    },

    recordApplied(participantId, snapshot, executionId, driverSessionEpoch, usage) {
      const existing = records.get(participantId);
      const base: SessionRecord =
        existing && existing.sessionEpoch === driverSessionEpoch
          ? existing
          : {
              sessionEpoch: driverSessionEpoch,
              digestVersion: snapshot.digestVersion,
              contextRevision: 0,
              contextDigest: "",
              participantSnapshotDigest: snapshot.participant.participantSnapshotDigest,
              appliedItemCount: 0,
              itemDigests: [],
              executionCount: 0,
              cumulativeInputTokens: 0,
              executionIds: [],
            };
      base.digestVersion = snapshot.digestVersion;
      base.contextRevision = snapshot.roomContext.contextRevision;
      base.contextDigest = snapshot.roomContext.contextDigest;
      base.participantSnapshotDigest = snapshot.participant.participantSnapshotDigest;
      base.appliedItemCount = snapshot.roomContext.items.length;
      base.itemDigests = snapshot.roomContext.items.map(hashItem);
      base.executionCount += 1;
      base.cumulativeInputTokens += usage?.inputTokens ?? 0;
      base.executionIds.push(executionId);
      records.set(participantId, base);
    },

    invalidate(participantId) {
      records.delete(participantId);
    },

    record(participantId) {
      return records.get(participantId) ?? null;
    },

    reset() {
      records.clear();
    },
  };
}
