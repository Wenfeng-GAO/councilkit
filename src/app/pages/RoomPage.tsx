import { ControlBanner } from "@/components/room/ControlBanner";
import { DiscussionStream } from "@/components/room/DiscussionStream";
import { ErrorBanner } from "@/components/room/ErrorBanner";
import { PausedPanel } from "@/components/room/PausedPanel";
import { RoomHeader } from "@/components/room/RoomHeader";
import { UserInputBar } from "@/components/room/UserInputBar";
import { isFailedExecution } from "@/components/room/round-timeline";
import { useObserverPreview } from "@/components/room/useObserverPreview";
import { useRoomAnnouncer } from "@/components/room/useRoomAnnouncer";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/Button";
import type { ControlState } from "@/orchestrator/discussion-orchestrator";
import { getAppRuntime } from "@/runtime/bootstrap";
import { useRuntimeDiscussionStore } from "@/stores/runtime-discussion";
import { useControlState, useRoomIntents } from "@/stores/runtime-intents";
import {
  useAgents,
  useExecutionProfiles,
  useParticipants,
  useRoundExecutions,
  useRoundMessages,
  useRuntimeRoom,
  useRuntimeRounds,
} from "@/stores/runtime-queries";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

/**
 * Room page (U6): committed state comes exclusively from the Runtime Dexie
 * DB via runtime-queries; every mutation goes through the Orchestrator (via
 * useRoomIntents) and only while this page is the Scope Controller. Observer
 * pages are strictly read-only: live queries plus the read-only event-stream
 * preview.
 */
export function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const tick = useRuntimeDiscussionStore((state) =>
    roomId ? (state.changeTickByRoom[roomId] ?? 0) : 0,
  );
  const { data: room, isLoading: roomLoading } = useRuntimeRoom(roomId, tick);
  const { data: rounds } = useRuntimeRounds(roomId, tick);
  const { data: participants } = useParticipants(roomId, tick);
  const { data: agents } = useAgents();
  const { data: profiles } = useExecutionProfiles();

  const controlState = useControlState(roomId ?? "");
  const intents = useRoomIntents(roomId ?? "");

  const currentRound = room?.activeRoundId
    ? ((rounds ?? []).find((round) => round.id === room.activeRoundId) ?? null)
    : null;
  const activeExecutionId = currentRound?.activeExecutionId ?? null;
  const { data: currentMessages } = useRoundMessages(currentRound?.id, tick);
  const { data: currentExecutions } = useRoundExecutions(currentRound?.id, tick);
  const failedCount = (currentExecutions ?? []).filter(isFailedExecution).length;

  // Mount → fire-and-forget controlRoom. The observer path is handled by
  // lock unavailability; takeover errors surface as takeover_failed through
  // the display bridge. On unmount the acquire is aborted and any held lock
  // released so a navigated-away page never keeps control.
  const roomExists = !!room;
  useEffect(() => {
    if (!roomId || !roomExists) return;
    const abort = new AbortController();
    let handle: { release(): void } | null = null;
    void getAppRuntime()
      .orchestrator.controlRoom(roomId, abort.signal)
      .then((acquired) => {
        handle = acquired;
        if (abort.signal.aborted) acquired?.release();
      })
      .catch(() => undefined);
    return () => {
      abort.abort();
      handle?.release();
    };
  }, [roomId, roomExists]);

  // Control transitions: announce takeovers; on losing control drop the local
  // preview immediately and stay read-only.
  const [notice, setNotice] = useState<string | null>(null);
  const prevControlRef = useRef<ControlState | undefined>(undefined);
  useEffect(() => {
    const prev = prevControlRef.current;
    prevControlRef.current = controlState;
    if (prev === controlState) return;
    if (prev === "observing" && controlState === "controlling") {
      setNotice("已取得控制权");
    } else if (
      prev === "controlling" &&
      (controlState === "observing" || controlState === "lost-control")
    ) {
      if (activeExecutionId) {
        useRuntimeDiscussionStore.getState().clearPreview(activeExecutionId);
      }
      setNotice("已转为只读观察");
    }
  }, [controlState, activeExecutionId]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Observer pages follow the active execution over the read-only stream.
  useObserverPreview({
    roomId: roomId ?? "",
    enabled: controlState === "observing",
    executionId: activeExecutionId,
  });

  // Observer freshness (plan §547): the invalidation tick only bumps on the
  // controlling page, so while observing we poll — bumping the local tick on
  // an interval re-keys the runtime queries above. V1 uses polling; a Dexie
  // liveQuery / BroadcastChannel channel is follow-up work.
  useEffect(() => {
    if (!roomId || controlState !== "observing") return;
    const timer = setInterval(() => {
      useRuntimeDiscussionStore.getState().bumpChanged(roomId);
    }, 2000);
    return () => clearInterval(timer);
  }, [roomId, controlState]);

  const announcement = useRoomAnnouncer({
    currentRound,
    messages: currentMessages,
    failedCount,
    participants: participants ?? [],
    agents: agents ?? [],
  });

  const controlling = controlState === "controlling";
  const hasActiveRound = !!currentRound;
  const roundGenerating =
    !!currentRound && (currentRound.phase === "running" || currentRound.phase === "summarizing");
  const controlHint = controlling ? undefined : "当前页面没有控制权，无法操作";

  const mutationError =
    intents.startRound.error ??
    intents.pauseRoom.error ??
    intents.resumeRoom.error ??
    intents.cancelActiveExecution.error ??
    intents.abortPausedRound.error;
  const dismissMutationError = () => {
    intents.startRound.reset();
    intents.pauseRoom.reset();
    intents.resumeRoom.reset();
    intents.cancelActiveExecution.reset();
    intents.abortPausedRound.reset();
  };

  if (!roomId) return <EmptyState title="缺少房间 ID" />;
  if (roomLoading) return <EmptyState title="加载中…" />;
  if (!room) {
    return <EmptyState title="未找到房间" hint="它可能已被删除，或尚未在此设备上创建。" />;
  }

  return (
    <div className="flex flex-col">
      <RoomHeader room={room} participants={participants ?? []} agents={agents ?? []} />
      <ControlBanner state={controlState} notice={notice} />
      <ErrorBanner
        message={mutationError ? mutationError.message : null}
        onDismiss={dismissMutationError}
      />
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-6 py-3">
        {!hasActiveRound ? (
          <Button
            onClick={() => intents.startRound.mutate()}
            disabled={!controlling || intents.startRound.isPending}
            title={controlHint}
          >
            {intents.startRound.isPending
              ? "正在开始…"
              : (rounds ?? []).length === 0
                ? "发起讨论"
                : "开始新一轮"}
          </Button>
        ) : null}
        {roundGenerating ? (
          <Button
            variant="ghost"
            onClick={() => intents.cancelActiveExecution.mutate()}
            disabled={!controlling || intents.cancelActiveExecution.isPending}
            title={controlHint}
          >
            {intents.cancelActiveExecution.isPending ? "正在停止…" : "停止生成"}
          </Button>
        ) : null}
        {room.runState === "running" && hasActiveRound ? (
          <Button
            variant="ghost"
            onClick={() => intents.pauseRoom.mutate()}
            disabled={!controlling || intents.pauseRoom.isPending}
            title={controlHint}
          >
            {intents.pauseRoom.isPending ? "正在暂停…" : "暂停"}
          </Button>
        ) : null}
        {room.runState === "paused" ? (
          <Button
            onClick={() => intents.resumeRoom.mutate()}
            disabled={!controlling || intents.resumeRoom.isPending}
            title={controlHint}
          >
            {intents.resumeRoom.isPending ? "正在继续…" : "继续"}
          </Button>
        ) : null}
      </div>
      <DiscussionStream
        roomId={roomId}
        rounds={rounds ?? []}
        participants={participants ?? []}
        agents={agents ?? []}
        activeRoundId={room.activeRoundId}
        tick={tick}
      />
      {currentRound?.phase === "paused" ? (
        <div className="px-6 pb-2">
          <PausedPanel
            round={currentRound}
            participants={participants ?? []}
            agents={agents ?? []}
            profiles={profiles ?? []}
            controlling={controlling}
            onAbort={() => intents.abortPausedRound.mutate()}
            abortPending={intents.abortPausedRound.isPending}
          />
        </div>
      ) : null}
      <UserInputBar
        controlState={controlState}
        hasActiveRound={hasActiveRound}
        sendUserMessage={intents.sendUserMessage}
      />
      <output aria-live="polite" className="sr-only block">
        {announcement}
      </output>
    </div>
  );
}
