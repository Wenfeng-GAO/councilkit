import type { ControlState } from "@/orchestrator/discussion-orchestrator";
import { getAppRuntime } from "@/runtime/bootstrap";
import { useRuntimeDiscussionStore } from "@/stores/runtime-discussion";
import { runtimeKeys } from "@/stores/runtime-queries";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * Room intents (U6): the write-side counterpart of runtime-queries. Every
 * intent wraps the app-wide Orchestrator singleton in a useMutation (local
 * pending/error state via isPending/error) and refetches all runtime queries
 * on settle (runtimeKeys.all, same as the display bridge); the bridge already
 * invalidates on every committed change, so this only covers mutation-local
 * failures.
 */

export function useRoomIntents(roomId: string) {
  const queryClient = useQueryClient();
  const onSettled = () => queryClient.invalidateQueries({ queryKey: runtimeKeys.all });

  const startRound = useMutation({
    mutationFn: () => getAppRuntime().orchestrator.startRound(roomId),
    onSettled,
  });
  const pauseRoom = useMutation({
    mutationFn: () => getAppRuntime().orchestrator.pauseRoom(roomId),
    onSettled,
  });
  const resumeRoom = useMutation({
    mutationFn: () => getAppRuntime().orchestrator.resumeRoom(roomId),
    onSettled,
  });
  const cancelActiveExecution = useMutation({
    mutationFn: () => getAppRuntime().orchestrator.cancelActiveExecution(roomId),
    onSettled,
  });
  const abortPausedRound = useMutation({
    mutationFn: () => getAppRuntime().orchestrator.abortPausedRound(roomId),
    onSettled,
  });
  const retryFailedParticipant = useMutation({
    mutationFn: () => getAppRuntime().orchestrator.retryFailedParticipant(roomId),
    onSettled,
  });
  const skipFailedParticipant = useMutation({
    mutationFn: () => getAppRuntime().orchestrator.skipFailedParticipant(roomId),
    onSettled,
  });
  const rotateScope = useMutation({
    mutationFn: () => getAppRuntime().orchestrator.rotateScope(roomId),
    onSettled,
  });
  const releaseRuntime = useMutation({
    mutationFn: () => getAppRuntime().orchestrator.releaseRuntime(roomId),
    onSettled,
  });
  const sendUserMessage = useMutation({
    mutationFn: (content: string) => getAppRuntime().orchestrator.sendUserMessage(roomId, content),
    onSettled,
  });
  const concludeRoom = useMutation({
    mutationFn: () => getAppRuntime().orchestrator.concludeRoom(roomId),
    onSettled,
  });

  return {
    startRound,
    pauseRoom,
    resumeRoom,
    cancelActiveExecution,
    abortPausedRound,
    retryFailedParticipant,
    skipFailedParticipant,
    rotateScope,
    releaseRuntime,
    sendUserMessage,
    concludeRoom,
  };
}

/** The page's Scope Controller display state for one Room (undefined until
 * the Orchestrator first reports). */
export function useControlState(roomId: string): ControlState | undefined {
  return useRuntimeDiscussionStore((state) => state.controlByRoom[roomId]);
}
