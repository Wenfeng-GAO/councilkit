import { ControlBanner } from "@/components/room/ControlBanner";
import { DiscussionStream } from "@/components/room/DiscussionStream";
import { ErrorBanner } from "@/components/room/ErrorBanner";
import { PausedPanel } from "@/components/room/PausedPanel";
import { ReportFailureBanner, ReportProgress, ReportView } from "@/components/room/ReportView";
import { RoomHeader } from "@/components/room/RoomHeader";
import { UserInputBar } from "@/components/room/UserInputBar";
import { isFailedExecution, resolveSpeaker } from "@/components/room/round-timeline";
import { useObserverPreview } from "@/components/room/useObserverPreview";
import { useRoomAnnouncer } from "@/components/room/useRoomAnnouncer";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { DiscussionRoom, RoomStatus } from "@/models/discussion/entities";
import type { ModelExecution, ModelExecutionState } from "@/models/discussion/model-execution";
import type { ControlState } from "@/orchestrator/discussion-orchestrator";
import { getAppRuntime } from "@/runtime/bootstrap";
import { useRuntimeDiscussionStore } from "@/stores/runtime-discussion";
import { useControlState, useRoomIntents } from "@/stores/runtime-intents";
import {
  useAgents,
  useExecutionProfiles,
  useParticipants,
  useRoomRecoveryFacts,
  useRoomReport,
  useRoundExecutions,
  useRoundMessages,
  useRuntimeRoom,
  useRuntimeRounds,
} from "@/stores/runtime-queries";
import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";

/**
 * Room page (U6): committed state comes exclusively from the Runtime Dexie
 * DB via runtime-queries; every mutation goes through the Orchestrator (via
 * useRoomIntents) and only while this page is the Scope Controller. Observer
 * pages are strictly read-only: live queries plus the read-only event-stream
 * preview.
 */

// ---------------------------------------------------------------------------
// Room-conclusion phase derivation (S4, pure — unit-tested as exports).
// Mirrors the S2 concluding口径 exactly: a room is "concluding" when it is
// open AND a report execution is in one of the live states the report
// transaction treats as live (discussion-transactions.ts liveReport set).
// "concluded" (persisted) wins over any in-flight report.
// ---------------------------------------------------------------------------

export type RoomPagePhase = "discussing" | "concluding" | "concluded";

const LIVE_REPORT_STATES: ReadonlySet<ModelExecutionState> = new Set([
  "prepared",
  "running",
  "succeeded_uncommitted",
]);

const FAILED_REPORT_STATES: ReadonlySet<ModelExecutionState> = new Set([
  "failed",
  "interrupted",
  "discarded",
]);

export function deriveRoomPhase(
  room: Pick<DiscussionRoom, "status">,
  executions: readonly ModelExecution[],
): RoomPagePhase {
  if (room.status === "concluded") return "concluded";
  if (findLiveReportExecution(executions)) return "concluding";
  return "discussing";
}

/** The newest report execution in a live state (prepared/running/
 * succeeded_uncommitted), or undefined. Same set the report transaction's
 * liveReport check uses, so a "concluding" UI never lies about a live report. */
export function findLiveReportExecution(
  executions: readonly ModelExecution[],
): ModelExecution | undefined {
  return executions
    .filter(
      (execution) => execution.resultKind === "report" && LIVE_REPORT_STATES.has(execution.state),
    )
    .reduce<ModelExecution | undefined>((latest, execution) => {
      if (!latest || execution.createdAt > latest.createdAt) return execution;
      return latest;
    }, undefined);
}

/** The newest report execution in a terminal-failure state
 * (failed/interrupted/discarded), or undefined. Drives the retry banner. */
export function findFailedReportExecution(
  executions: readonly ModelExecution[],
): ModelExecution | undefined {
  return executions
    .filter(
      (execution) => execution.resultKind === "report" && FAILED_REPORT_STATES.has(execution.state),
    )
    .reduce<ModelExecution | undefined>((latest, execution) => {
      if (!latest || execution.createdAt > latest.createdAt) return execution;
      return latest;
    }, undefined);
}

export interface CanConcludeNowInput {
  controlling: boolean;
  roomStatus: RoomStatus;
  /** True when the current round has an active execution (round.activeExecutionId). */
  hasActiveExecution: boolean;
  /** True when a live report execution exists (concluding transient). */
  hasLiveReport: boolean;
  /** True when at least one completed round exists. */
  hasCompletedRound: boolean;
}

/** Whether the "总结并结束" button is clickable. Client-side only — the
 * orchestrator still guards on its side; this just avoids dispatching an
 * intent that would immediately throw. */
export function canConcludeNow(input: CanConcludeNowInput): boolean {
  if (!input.controlling) return false;
  if (input.roomStatus === "concluded") return false;
  if (input.hasActiveExecution) return false;
  if (input.hasLiveReport) return false;
  if (!input.hasCompletedRound) return false;
  return true;
}

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

  // S4 report/conclusion wiring. The report query and recovery facts are
  // existing read-only hooks; the phase derivation is the pure function above
  // (unit-tested). concluding is a client-only transient never persisted.
  // Computed here (ahead of useObserverPreview) so the observer stream can
  // re-key onto a live report execution as soon as one appears.
  const { data: report } = useRoomReport(roomId, tick);
  const { data: recovery } = useRoomRecoveryFacts(roomId, tick);
  const roomExecutions = recovery?.executions ?? [];
  const liveReportExecution = findLiveReportExecution(roomExecutions);
  const failedReportExecution =
    !report && !liveReportExecution ? findFailedReportExecution(roomExecutions) : undefined;
  const hasCompletedRound = (rounds ?? []).some((round) => round.phase === "completed");
  // room may be undefined before the empty-guard; default to "open" so the
  // derivation stays a pure expression read after the guard narrows room.
  const phase = deriveRoomPhase({ status: room?.status ?? "open" }, roomExecutions);
  // F1a: treat `concludeRoom.isPending` as concluding too. The deriveRoomPhase
  // picks up a live report execution only after beginReportExecution commits to
  // Dexie + the recovery query refetches; the mutation flips isPending the
  // instant the user clicks, so OR-ing it in closes the full click→persist
  // window. Locks out start-round + user input for the whole transient.
  const concludePending = intents.concludeRoom.isPending;
  const concluding = phase === "concluding" || concludePending;

  // Report-execution preview: same store mechanism as round previews, but the
  // report execution never owns round.activeExecutionId, so RoomPage reads it
  // directly (DiscussionStream's ActivePreview can't see it).
  const reportPreviewText = useRuntimeDiscussionStore((state) =>
    liveReportExecution ? state.previewByExecution[liveReportExecution.executionId] : undefined,
  );

  // Observer pages follow the active execution over the read-only stream. A
  // report execution never owns round.activeExecutionId (it anchors on the
  // completed round), so during the concluding transient the observer must
  // subscribe to the live report execution's stream instead — otherwise the
  // observer watches nothing while the controlling page concludes. The
  // cleanup path is unchanged: useObserverPreview's effect re-keys on
  // executionId and aborts the previous follow, and the store's
  // previewByExecution is keyed by executionId, so a report preview is
  // cleared the same way a round preview is when the controlling page loses
  // control or the room switches.
  useObserverPreview({
    roomId: roomId ?? "",
    enabled: controlState === "observing",
    executionId: liveReportExecution?.executionId ?? activeExecutionId,
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
  const facilitatorSpeaker =
    participants && agents
      ? resolveSpeaker(
          room?.facilitatorParticipantId,
          new Map(participants.map((participant) => [participant.id, participant])),
          new Map(agents.map((agent) => [agent.id, agent])),
        )
      : null;

  const concludeDisabledReason = !controlling
    ? controlHint
    : liveReportExecution
      ? "报告生成进行中…"
      : hasActiveRound
        ? "有执行进行中,无法结束"
        : !hasCompletedRound
          ? "需先完成至少一轮讨论"
          : undefined;
  const canConclude = canConcludeNow({
    controlling,
    roomStatus: room?.status ?? "open",
    hasActiveExecution: activeExecutionId !== null || liveReportExecution !== undefined,
    hasLiveReport: liveReportExecution !== undefined,
    hasCompletedRound,
  });

  const [confirmConclude, setConfirmConclude] = useState(false);
  const triggerConclude = () => {
    setConfirmConclude(false);
    intents.concludeRoom.mutate();
  };

  const mutationError =
    intents.startRound.error ??
    intents.pauseRoom.error ??
    intents.resumeRoom.error ??
    intents.cancelActiveExecution.error ??
    intents.abortPausedRound.error ??
    intents.concludeRoom.error;
  const dismissMutationError = () => {
    intents.startRound.reset();
    intents.pauseRoom.reset();
    intents.resumeRoom.reset();
    intents.cancelActiveExecution.reset();
    intents.abortPausedRound.reset();
    intents.concludeRoom.reset();
  };

  // #report anchor scroll: React Router client nav does not scroll to hash.
  // Re-run when the report lands (its id changes) so the element exists.
  const location = useLocation();
  useEffect(() => {
    if (location.hash !== "#report" || !report) return;
    const node = document.getElementById("report");
    if (node) node.scrollIntoView({ behavior: "smooth" });
  }, [report, location.hash]);

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
      {phase !== "concluded" ? (
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-6 py-3">
          {concluding ? (
            <ReportProgress
              previewText={reportPreviewText ?? ""}
              speakerName={facilitatorSpeaker?.name ?? "主持人"}
              speakerColor={facilitatorSpeaker?.color ?? "#8b919a"}
            />
          ) : (
            <>
              {!hasActiveRound ? (
                <Button
                  onClick={() => intents.startRound.mutate()}
                  disabled={!controlling || concluding || intents.startRound.isPending}
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
              {/* R9: appended at the operation-row tail so existing button
                  name/order is untouched. */}
              <Button
                variant="ghost"
                onClick={() => setConfirmConclude(true)}
                disabled={!canConclude || intents.concludeRoom.isPending}
                title={concludeDisabledReason}
              >
                {intents.concludeRoom.isPending ? "正在总结…" : "总结并结束"}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {phase === "discussing" && failedReportExecution ? (
        <div className="mx-auto w-full max-w-3xl px-6 pb-2">
          <ReportFailureBanner
            execution={failedReportExecution}
            onRetry={() => intents.concludeRoom.mutate()}
            retryPending={intents.concludeRoom.isPending}
            retryDisabled={!canConclude}
            disabledHint={concludeDisabledReason}
          />
        </div>
      ) : null}
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
      {phase !== "concluded" ? (
        <UserInputBar
          controlState={controlState}
          hasActiveRound={hasActiveRound}
          concluding={concluding}
          sendUserMessage={intents.sendUserMessage}
        />
      ) : null}
      {phase === "concluded" ? (
        report ? (
          <ReportView report={report} topic={room.topic} />
        ) : (
          <p className="mx-auto w-full max-w-3xl px-6 py-4 text-sm text-muted">报告加载中…</p>
        )
      ) : null}
      <Modal open={confirmConclude} onClose={() => setConfirmConclude(false)} title="总结并结束">
        <p className="text-sm text-fg">
          将基于已完成轮次生成决策报告,结束后房间只读,无法再发起新一轮讨论。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmConclude(false)}>
            取消
          </Button>
          <Button onClick={triggerConclude} disabled={intents.concludeRoom.isPending}>
            确认总结
          </Button>
        </div>
      </Modal>
      <output aria-live="polite" className="sr-only block">
        {announcement}
      </output>
    </div>
  );
}
