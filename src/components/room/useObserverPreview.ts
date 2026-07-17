import { runtimeDb } from "@/lib/runtime-db";
import { getAppRuntime } from "@/runtime/bootstrap";
import { followExecutionEvents } from "@/runtime/event-stream";
import { useRuntimeDiscussionStore } from "@/stores/runtime-discussion";
import { useEffect } from "react";

/**
 * Observer read-only preview (U6): a page in `observing` control state
 * follows the current Round's active execution over the Host's read-only
 * event stream and feeds the same coalesced preview store the Orchestrator's
 * display bridge uses on controlling pages. Strictly read-only — no
 * mutations, no re-dispatch.
 *
 * The follow aborts and restarts whenever the active executionId changes. A
 * stream that ends without a terminal is retried exactly once after 1s (from
 * the last received seq, so deltas never duplicate), and only while the
 * execution is still active.
 */
export function useObserverPreview(input: {
  roomId: string;
  /** True exactly when controlState === "observing". */
  enabled: boolean;
  /** The current Round's activeExecutionId (null when nothing is running). */
  executionId: string | null;
}): void {
  const { roomId, enabled, executionId } = input;

  useEffect(() => {
    if (!enabled || !executionId) return;
    const abort = new AbortController();
    let stopped = false;

    const followOnce = async (
      afterSeq: number,
    ): Promise<{ terminal: boolean; lastSeq: number }> => {
      const binding = await runtimeDb.runtimeBindings
        .where("roomId")
        .equals(roomId)
        .filter((candidate) => candidate.state === "active")
        .first();
      const scopeId = binding?.executionScopeId;
      if (!scopeId) return { terminal: true, lastSeq: afterSeq };
      let lastSeq = afterSeq;
      const outcome = await followExecutionEvents({
        fetchInput: getAppRuntime().client.eventStreamFetch({
          scopeId,
          executionId,
          afterSeq,
        }),
        onEvent: (event) => {
          lastSeq = Math.max(lastSeq, event.seq);
          useRuntimeDiscussionStore.getState().applyPreview(roomId, event);
        },
        signal: abort.signal,
      });
      return { terminal: outcome.kind === "terminal", lastSeq };
    };

    const stillActive = async (): Promise<boolean> => {
      const execution = await runtimeDb.modelExecutions.get(executionId);
      return (
        execution?.state === "prepared" ||
        execution?.state === "running" ||
        execution?.state === "succeeded_uncommitted"
      );
    };

    void (async () => {
      try {
        const first = await followOnce(0);
        if (stopped || first.terminal) return;
        // Tolerate a dropped stream: retry once after 1s if still active.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (stopped || !(await stillActive())) return;
        await followOnce(first.lastSeq);
      } catch {
        // Read-only preview: any stream failure simply ends the preview; the
        // committed state keeps arriving via the Dexie queries.
      }
    })();

    return () => {
      stopped = true;
      abort.abort();
    };
  }, [roomId, enabled, executionId]);
}
