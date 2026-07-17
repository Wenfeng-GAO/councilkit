import type { ControlState, OrchestratorDisplay } from "@/orchestrator/discussion-orchestrator";
import type { RuntimeEvent } from "@shared/runtime/events";
import { create } from "zustand";

/**
 * Runtime discussion display store (U5): Zustand holds ONLY disposable
 * display state — control status, streaming previews, and an invalidation
 * tick. Every durable fact (Round phase/cursor, active execution, pause
 * reason, ACK progress) lives in Dexie; recreating this store loses nothing.
 */

interface RuntimeDiscussionState {
  /** roomId -> Web Lock / Host fencing display state. */
  controlByRoom: Record<string, ControlState>;
  /** executionId -> coalesced preview text (deltas/snapshots, never committed). */
  previewByExecution: Record<string, string>;
  /** roomId -> monotonically increasing invalidation tick for query layers. */
  changeTickByRoom: Record<string, number>;

  setControlState: (roomId: string, state: ControlState) => void;
  applyPreview: (roomId: string, event: RuntimeEvent) => void;
  bumpChanged: (roomId: string) => void;
  clearPreview: (executionId: string) => void;
  resetRoom: (roomId: string) => void;
}

export const useRuntimeDiscussionStore = create<RuntimeDiscussionState>((set) => ({
  controlByRoom: {},
  previewByExecution: {},
  changeTickByRoom: {},

  setControlState: (roomId, state) =>
    set((s) => ({ controlByRoom: { ...s.controlByRoom, [roomId]: state } })),
  applyPreview: (_roomId, event) =>
    set((s) => {
      if (event.type === "output.delta") {
        return {
          previewByExecution: {
            ...s.previewByExecution,
            [event.executionId]: (s.previewByExecution[event.executionId] ?? "") + event.text,
          },
        };
      }
      if (event.type === "output.snapshot") {
        return {
          previewByExecution: { ...s.previewByExecution, [event.executionId]: event.text },
        };
      }
      if (event.type === "completed" || event.type === "failed" || event.type === "interrupted") {
        const previewByExecution = { ...s.previewByExecution };
        delete previewByExecution[event.executionId];
        return { previewByExecution };
      }
      return s;
    }),
  bumpChanged: (roomId) =>
    set((s) => ({
      changeTickByRoom: { ...s.changeTickByRoom, [roomId]: (s.changeTickByRoom[roomId] ?? 0) + 1 },
    })),
  clearPreview: (executionId) =>
    set((s) => {
      const previewByExecution = { ...s.previewByExecution };
      delete previewByExecution[executionId];
      return { previewByExecution };
    }),
  resetRoom: (roomId) =>
    set((s) => {
      const controlByRoom = { ...s.controlByRoom };
      const changeTickByRoom = { ...s.changeTickByRoom };
      delete controlByRoom[roomId];
      delete changeTickByRoom[roomId];
      return { controlByRoom, changeTickByRoom };
    }),
}));

/** Bridge: plug the Orchestrator's display sink into the store and a query
 * invalidator (wired by the UI layer; tests pass a noop). */
export function createDisplayBridge(onChanged?: (roomId: string) => void): OrchestratorDisplay {
  const store = useRuntimeDiscussionStore.getState();
  return {
    onControlState: (roomId, state) => store.setControlState(roomId, state),
    onPreview: (roomId, event) => store.applyPreview(roomId, event),
    onRoundChanged: (roomId) => {
      store.bumpChanged(roomId);
      onChanged?.(roomId);
    },
  };
}
