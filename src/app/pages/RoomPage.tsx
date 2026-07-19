import { installPrimaryShortcut } from "@/app/shortcuts";
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
import { useCallback, useEffect, useRef, useState } from "react";
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

// R5 中断确认的「本轮正在生成」判定口径：live execution 真实态。与
// deriveParticipantRoundStatus 的 generating 同源（RoomHeader.tsx
// LIVE_EXECUTION_STATES）——activeRound.activeExecutionId 非空且对应 execution
// state ∈ prepared/running/succeeded_uncommitted。区分于 round phase：dispatch
// 间隙（activeExecutionId===null 的合法窗口）不假报「将中断当前生成」。
const ROUND_LIVE_EXECUTION_STATES: ReadonlySet<ModelExecutionState> = new Set([
  "prepared",
  "running",
  "succeeded_uncommitted",
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

// ---------------------------------------------------------------------------
// S8 tab-hidden 通知（纯函数 — unit-tested as exports；effect 在段 2 接线）。
// 三种语义事件：round-completed / round-paused / report-ready。prev/next 签名
// 比对沿用 useRoomAnnouncer 的 prevRef 模式；roundId 变化只重置签名不报；同帧
// 多事件优先级 report-ready > round-paused > round-completed。
// ---------------------------------------------------------------------------

export type RoomNotifyEvent =
  | { kind: "round-completed"; roundNumber: number }
  | { kind: "round-paused"; roundNumber: number }
  | { kind: "report-ready" };

export interface RoomNotifySignature {
  roundId: string | null;
  phase: string | null;
  roundNumber: number | null;
  hasReport: boolean;
}

/** Compare two signatures and return the single semantic event to surface
 * (null = no event). roundId 切换 → null（新轮次首帧只重置签名）；同签名 →
 * null；同帧多事件优先级 report-ready > round-paused > round-completed。 */
export function detectRoomNotifyEvent(
  prev: RoomNotifySignature,
  next: RoomNotifySignature,
): RoomNotifyEvent | null {
  if (prev.roundId !== next.roundId) return null;

  const events: RoomNotifyEvent[] = [];
  if (!prev.hasReport && next.hasReport) {
    events.push({ kind: "report-ready" });
  }
  if (prev.phase !== "paused" && next.phase === "paused" && next.roundNumber != null) {
    events.push({ kind: "round-paused", roundNumber: next.roundNumber });
  }
  if (prev.phase !== "completed" && next.phase === "completed" && next.roundNumber != null) {
    events.push({ kind: "round-completed", roundNumber: next.roundNumber });
  }
  if (events.length === 0) return null;

  const priority: ReadonlyArray<RoomNotifyEvent["kind"]> = [
    "report-ready",
    "round-paused",
    "round-completed",
  ];
  for (const kind of priority) {
    const found = events.find((event) => event.kind === kind);
    if (found) return found;
  }
  return null;
}

/** Armed document.title for a hidden tab (S8). 前缀符号 ⚠/✓ 提示性质，baseTitle
 * （"CouncilKit"）作为后缀保留。 */
export function notifyTitle(event: RoomNotifyEvent, baseTitle: string): string {
  switch (event.kind) {
    case "round-paused":
      return `⚠ 第 ${event.roundNumber} 轮已暂停 · ${baseTitle}`;
    case "round-completed":
      return `✓ 第 ${event.roundNumber} 轮已完成 · ${baseTitle}`;
    case "report-ready":
      return `✓ 决策报告已生成 · ${baseTitle}`;
  }
}

/** favicon 状态点取色口径：paused → warn，completed/report → success。 */
export function notifyTone(event: RoomNotifyEvent): "warn" | "success" {
  return event.kind === "round-paused" ? "warn" : "success";
}

// ---------------------------------------------------------------------------
// S8 favicon 状态点（canvas dataURL，不预置图标文件——现状 index.html 无 icon
// link，预置文件需动 index.html/public 且无法表达双态）。模块级辅助仅在
// RoomPage effect 调用时读 DOM，模块加载无副作用（shortcuts.ts 先例）。token
// 取 --color-warn/--color-success（globals.css:14-15），fallback 常量。canvas
// 不可用在 try/catch 内降级为不动 favicon（title 已独立武装）。
// ---------------------------------------------------------------------------

const FAVICON_LINK_ATTR = "data-councilkit-status-icon";

function resolveDotColor(tone: "warn" | "success"): string {
  const token = tone === "warn" ? "--color-warn" : "--color-success";
  const fromCss = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return fromCss || (tone === "warn" ? "#d97706" : "#16a34a");
}

function setFaviconDot(tone: "warn" | "success"): void {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = resolveDotColor(tone);
    context.beginPath();
    context.arc(16, 16, 12, 0, Math.PI * 2);
    context.fill();
    const dataUrl = canvas.toDataURL();
    let link = document.querySelector<HTMLLinkElement>(`link[${FAVICON_LINK_ATTR}]`);
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      link.setAttribute(FAVICON_LINK_ATTR, "");
      document.head.appendChild(link);
    }
    link.href = dataUrl;
  } catch {
    // canvas 不可用：降级为仅 title 提示，favicon 不动。
  }
}

function clearFaviconDot(): void {
  const link = document.querySelector<HTMLLinkElement>(`link[${FAVICON_LINK_ATTR}]`);
  if (link) link.remove();
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
  //
  // S8 controlRef 重构（R8）：cleanup 读 controlRef.current 而非闭包 slot——
  // handleTakeover 重跑 controlRoom 会写入新 slot，旧闭包会漏释放 takeover 产生
  // 的新锁。ref 让 cleanup 始终拿到最新 slot。
  //
  // R1 竞态守卫：切房时旧 effect 的 controlRoom 异步仍在排队——房间 A 的
  // takeoverScope 等待期间切到 B，A 迟到完成若无条件写入共享 ref 会把 A 的 handle
  // 覆盖成 B 当前的 slot，B 的真 handle 丢失 → B 卸载无法释放其锁。修复：effect
  // 局部 cancelled 标志 + handle 归属守卫——异步完成时先判未取消且当前 room 仍是
  // 本 effect 的 room 才允许写共享 ref；cleanup 置 cancelled 并 abort。释放只释放
  // 本 effect 自己登记的 handle（以闭包 slot 自身为准，不读可能被后续 effect 覆写
  // 的共享 ref）。
  const roomExists = !!room;
  // Control slot carries its roomId so cleanup can tell "a slot for THIS room"
  // (mount slot or a takeover slot that replaced it) from another room's slot.
  interface ControlSlot {
    abort: AbortController;
    handle: { release(): void } | null;
    roomId: string;
  }
  const controlRef = useRef<ControlSlot | null>(null);
  useEffect(() => {
    if (!roomId || !roomExists) return;
    const slot: ControlSlot = { abort: new AbortController(), handle: null, roomId };
    controlRef.current = slot;
    void getAppRuntime()
      .orchestrator.controlRoom(roomId, slot.abort.signal)
      .then((acquired) => {
        // Ownership guard (R1 + takeover-slot leak): register only when THIS slot
        // is still the live one and un-aborted; otherwise release immediately —
        // a late completion must never write into another room's slot.
        if (controlRef.current !== slot || slot.abort.signal.aborted) {
          acquired?.release();
          return;
        }
        slot.handle = acquired ?? null;
      })
      .catch(() => undefined);
    return () => {
      // Release whatever slot belongs to THIS room (mount slot, or a takeover
      // slot that replaced it — they share this roomId), and abort its controller
      // so a late completion releases instead of registering. Never touch another
      // room's slot.
      slot.abort.abort();
      const current = controlRef.current;
      if (current && current.roomId === roomId) {
        current.abort.abort();
        current.handle?.release();
        controlRef.current = null;
      }
    };
  }, [roomId, roomExists]);

  // S8 强制接管（observing → controlling）：steal 抢锁即放，再重跑 controlRoom
  // 走既有 takeover 路径（takeoverScope + 更高 leaseEpoch）。计划 §1.3 / R3。
  // 锁名字面量 `councilkit-room-${roomId}` 与 discussion-orchestrator.ts:144
  // 同源——两侧注释互引防漂移。navigator.locks 不可用退化为直接重跑
  // controlRoom（self-healing 排队）。
  const [takeoverPending, setTakeoverPending] = useState(false);
  const handleTakeover = useCallback(() => {
    if (!roomId) return;
    // 先终结当前房间的旧 control session（挂载 effect 的排队 acquire 或先前的
    // takeover slot）：abort 其 controller 并释放其 handle——新 slot 取而代之，
    // 旧 session 迟到的完成会被归属守卫拦下（只释放、不写入）。
    const prev = controlRef.current;
    if (prev && prev.roomId === roomId) {
      prev.abort.abort();
      prev.handle?.release();
    }
    const slot: ControlSlot = { abort: new AbortController(), handle: null, roomId };
    controlRef.current = slot;
    setTakeoverPending(true);
    const releaseSteal =
      typeof navigator !== "undefined" && navigator.locks
        ? new Promise<void>((resolve) => {
            // steal: 抢到即放，仅为打破对方锁——本体控制权靠下面的 controlRoom。
            void navigator.locks
              .request(`councilkit-room-${roomId}`, { steal: true }, () => undefined)
              .finally(() => resolve());
          })
        : Promise.resolve();
    void releaseSteal.finally(() => {
      void getAppRuntime()
        .orchestrator.controlRoom(roomId, slot.abort.signal)
        .then((acquired) => {
          // Ownership guard（与挂载 effect 同款）：takeover 完成后若 slot 已被
          // cleanup 或新一轮 takeover 替换/abort，立即释放，绝不写入他人 slot。
          if (controlRef.current !== slot || slot.abort.signal.aborted) {
            acquired?.release();
            return;
          }
          slot.handle = acquired ?? null;
        })
        .catch(() => undefined)
        .finally(() => setTakeoverPending(false));
    });
  }, [roomId]);

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

  // S8 tab-hidden 通知接线（计划 §1.1，R4：headless Chromium 不可测，仅手验）。
  // 仅当 document.visibilityState === "hidden" 时武装 title + favicon 状态点；
  // 可见时转换不武装（用户看得见）。visibilitychange 变 visible → 恢复 baseTitle
  // + 摘除状态 favicon；变 hidden → 不追溯补发。卸载/切房间恢复初值。
  const baseTitleRef = useRef<string>("CouncilKit");
  const prevNotifySignatureRef = useRef<RoomNotifySignature>({
    roundId: null,
    phase: null,
    roundNumber: null,
    hasReport: false,
  });
  const reportAvailable = !!report;
  // R2 通知签名源必须不随 activeRoundId 清空而断裂：commitSummary 原子置轮 completed
  // + 清 room.activeRoundId → currentRound 立即变 null → 签名从 r1/summarizing 变
  // null/null，roundId 变化触发 detectRoomNotifyEvent 返回 null → 通知漏报。签名
  // round 来源改取 recovery.rounds 中 roundNumber 最大的最新轮（轮完成后仍留在
  // rounds 列表），签名 transfer 变为 r1/summarizing → r1/completed（roundId 不
  // 变），纯函数判定不变；currentRound 缺席时它仍能给出已完成轮的稳定 roundId。
  const recoveryRounds = recovery?.rounds ?? rounds ?? [];
  const latestRound = recoveryRounds.length
    ? recoveryRounds.reduce<(typeof recoveryRounds)[number] | null>(
        (latest, round) => (!latest || round.roundNumber > latest.roundNumber ? round : latest),
        null,
      )
    : null;
  const nextRoundId = latestRound?.id ?? null;
  const nextPhase = latestRound?.phase ?? null;
  const nextRoundNumber = latestRound?.roundNumber ?? null;
  useEffect(() => {
    baseTitleRef.current = document.title || "CouncilKit";
  }, []);
  useEffect(() => {
    const next: RoomNotifySignature = {
      roundId: nextRoundId,
      phase: nextPhase,
      roundNumber: nextRoundNumber,
      hasReport: reportAvailable,
    };
    const prev = prevNotifySignatureRef.current;
    prevNotifySignatureRef.current = next;
    // 可见时转换不武装：用户已经在看本页，title/favicon 无需提示。
    if (document.visibilityState !== "hidden") return;
    const event = detectRoomNotifyEvent(prev, next);
    if (!event) return;
    document.title = notifyTitle(event, baseTitleRef.current);
    setFaviconDot(notifyTone(event));
  }, [nextRoundId, nextPhase, nextRoundNumber, reportAvailable]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: R4 roomId 刻意驱动切房时 cleanup 旧房间 title/favicon 武装
  useEffect(() => {
    function onVisibilityChange(): void {
      if (document.visibilityState === "visible") {
        document.title = baseTitleRef.current;
        clearFaviconDot();
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // 卸载/切房间：恢复初值避免脏 title/状态 favicon 留在他页。
      document.title = baseTitleRef.current;
      clearFaviconDot();
    };
    // R4：依赖加 roomId——React Router 复用 RoomPage 实例时切房不触发 cleanup，旧
    // 房间武装的 title/favicon 会残留到他页。加 roomId 使切房时先 cleanup 旧房间，
    // 新房间重新评估并重新读取 baseTitle。
  }, [roomId]);

  const announcement = useRoomAnnouncer({
    currentRound,
    messages: currentMessages,
    failedCount,
    participants: participants ?? [],
    agents: agents ?? [],
  });

  const controlling = controlState === "controlling";
  const hasActiveRound = !!currentRound;
  // R5：按真实 live execution 判定，而非 round phase——dispatch 间隙
  // （activeExecutionId===null 的合法窗口）不会被 round phase 误判为「正在生成」，
  // 避免对空隙发送时误弹「将中断当前生成」。口径与 deriveParticipantRoundStatus
  // 的 generating 同源（见 RoomHeader.tsx LIVE_EXECUTION_STATES）。
  const roundGenerating =
    !!currentRound &&
    activeExecutionId !== null &&
    (currentExecutions ?? []).some(
      (execution) =>
        execution.executionId === activeExecutionId &&
        ROUND_LIVE_EXECUTION_STATES.has(execution.state),
    );
  const controlHint = controlling ? undefined : "当前页面没有控制权，无法操作";
  // S8 controllerId 数据源：复刻 RoomHeader.tsx latestNonClosed 选择，从
  // recovery.bindings 取最新非 closed 的 controllerId，传 ControlBanner 显示
  // 「控制者 #<前8位>」——observing 辨识对方 tab，controlling 辨识自己（R1）。
  const roomBindings = (recovery?.bindings ?? []).filter((binding) => binding.roomId === roomId);
  const latestBindingForController = roomBindings.length
    ? roomBindings.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
    : undefined;
  const controllerId = latestBindingForController?.controllerId ?? null;
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
  // S8 a11y：reduced-motion 下改 "auto"（globals.css 的媒体查询管不到 JS 动画）。
  const location = useLocation();
  useEffect(() => {
    if (location.hash !== "#report" || !report) return;
    const node = document.getElementById("report");
    if (!node) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  }, [report, location.hash]);

  // S8 主快捷键 ⌘/Ctrl+Enter：焦点在发言框→发送（走 UserInputBar 表单既有
  // trim/disabled 校验，零逻辑复制）；否则可开始新一轮→start-round。Modal 打
  // 开时 shortcuts.ts 自身静默。canStartRound 与「开始新一轮」按钮 disabled 条件
  // 同源（§1.7）。onSend 通过 activeElement.form.requestSubmit 复用表单校验。
  useEffect(() => {
    return installPrimaryShortcut({
      onSend: () => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
          active.form?.requestSubmit();
        }
      },
      onStartRound: () => intents.startRound.mutate(),
      canStartRound: () =>
        controlling &&
        !concluding &&
        !hasActiveRound &&
        phase !== "concluded" &&
        !intents.startRound.isPending,
    });
  }, [controlling, concluding, hasActiveRound, phase, intents.startRound]);

  if (!roomId) return <EmptyState title="缺少房间 ID" />;
  if (roomLoading) return <EmptyState title="加载中…" />;
  if (!room) {
    return <EmptyState title="未找到房间" hint="它可能已被删除，或尚未在此设备上创建。" />;
  }

  return (
    <div className="flex flex-col">
      <RoomHeader room={room} participants={participants ?? []} agents={agents ?? []} />
      <ControlBanner
        state={controlState}
        notice={notice}
        controllerId={controllerId}
        onTakeover={handleTakeover}
        takeoverPending={takeoverPending}
      />
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
                  {intents.pauseRoom.isPending ? "正在暂停调度…" : "暂停调度"}
                </Button>
              ) : null}
              {room.runState === "paused" ? (
                <Button
                  onClick={() => intents.resumeRoom.mutate()}
                  disabled={!controlling || intents.resumeRoom.isPending}
                  title={controlHint}
                >
                  {intents.resumeRoom.isPending ? "正在恢复调度…" : "恢复调度"}
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
          roundGenerating={roundGenerating}
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
