import { type TimelineBlock, foldLiveEvents, foldLiveEventsAppend } from "@/lib/live-transcript";
import { getAppRuntime } from "@/runtime/bootstrap";
import type { AttemptLiveEvent } from "@shared/runtime/attempt-live-events";
import { useEffect, useRef, useState } from "react";
import {
  PROCESS_CACHE_BUDGET_BYTES,
  PROCESS_POLL_MS,
  PROCESS_WINDOW_LINES,
  newActivityCount as countNewActivities,
  isCursorReset,
  nextPollDelayMs,
} from "./seatDetailModel";
import type { WorkbenchAttempt } from "./selection";

/** 滚离底部阈值：超过即暂停跟随（INTERACTION-SPEC §4.1）。 */
const PIN_THRESHOLD_PX = 48;

const TERMINAL = new Set(["success", "failure", "cancelled"]);

function approxBytes(event: AttemptLiveEvent): number {
  // 原始 JSON 字节预算的近似（字段长度 + 固定开销；偏低估计，淘汰行为保守）。
  let size = 64;
  if (event.type === "text.delta" || event.type === "thinking.delta") size += event.text.length;
  if (event.type === "tool.started" || event.type === "tool.completed") {
    size += event.name.length + event.summary.length;
  }
  return size;
}

export interface WorkbenchProcessState {
  ready: boolean;
  done: boolean;
  readError: boolean;
  hasEvents: boolean;
  pinned: boolean;
  newCount: number;
  /** 折叠后的全部活动行（窗口化前的总数）。 */
  totalLines: number;
  /** 窗口内活动行：默认最近 PROCESS_WINDOW_LINES 行。 */
  windowBlocks: TimelineBlock[];
  hiddenCount: number;
  expanded: boolean;
  expand: () => void;
  /** 席位已到终态（来自 progress），过程 Tab 显示「报告已就绪 · 查看报告」。 */
  reportReady: boolean;
  truncated: boolean;
  retry: () => void;
}

/**
 * 席位过程轮询（DELIVERY-PLAN §3.1 硬约束全部落在此处）：
 * - GET live?afterSeq=N，常规 2s；同一席位同时最多一个 in-flight（响应未返回不启动第二次）。
 * - 切席/关闭：effect cleanup 置 cancelled 并丢弃迟到响应（组件随席位选择卸载/重建）。
 * - 错误退避 2s→4s→8s→16s→30s（nextPollDelayMs），成功回退 2s。
 * - document.hidden 暂停排程，恢复可见时从当前游标立即续读（不重置）。
 * - done=true 停常规轮询；retry() 手动重读仍可用。
 * - 游标重置（nextSeq 回退）→ 清缓存重建。
 * - 容量：原始事件按席位 ≤2.5 MiB（PROCESS_CACHE_BUDGET_BYTES），超出淘汰最旧事件
 *   并整体重折叠（可从磁盘重读）；渲染端再按 PROCESS_WINDOW_LINES=200 行窗口化。
 */
export function useWorkbenchProcess(input: {
  runId: string;
  attempt: WorkbenchAttempt;
  /** 返回共享阅读容器（.ck-wb-reader）；父组件用 useCallback 保持稳定引用。 */
  getScroller: () => HTMLElement | null;
}): WorkbenchProcessState {
  const { runId, attempt, getScroller } = input;

  const [ready, setReady] = useState(false);
  const [done, setDone] = useState(false);
  const [readError, setReadError] = useState(false);
  const [pinned, setPinned] = useState(() => !TERMINAL.has(attempt.status));
  const [newCount, setNewCount] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [, setTick] = useState(0);

  const eventsRef = useRef<AttemptLiveEvent[]>([]);
  const blocksRef = useRef<TimelineBlock[]>([]);
  const bytesRef = useRef(0);
  const lastSeqRef = useRef(-1);
  const afterSeqRef = useRef(0);
  const failuresRef = useRef(0);
  const inFlightRef = useRef(false);
  const cancelledRef = useRef(false);
  const pinnedRef = useRef(!TERMINAL.has(attempt.status));
  const baselineRef = useRef(0);
  const retryRef = useRef<() => void>(() => {});

  const attemptId = attempt.attemptId;
  const reportReady = TERMINAL.has(attempt.status);
  /** 席位完成不重建轮询循环（否则会移动阅读锚点，违反 INTERACTION-SPEC §4.4）；
   *  effect 只读此 ref，渲染期随席位更新。 */
  const pinInitialRef = useRef(!TERMINAL.has(attempt.status));
  pinInitialRef.current = !TERMINAL.has(attempt.status);

  useEffect(() => {
    const client = getAppRuntime().client;
    cancelledRef.current = false;
    eventsRef.current = [];
    blocksRef.current = [];
    bytesRef.current = 0;
    lastSeqRef.current = -1;
    afterSeqRef.current = 0;
    failuresRef.current = 0;
    inFlightRef.current = false;
    pinnedRef.current = pinInitialRef.current;
    baselineRef.current = 0;
    setReady(false);
    setDone(false);
    setReadError(false);
    setPinned(pinnedRef.current);
    setNewCount(0);
    setExpanded(false);

    const bump = () => setTick((tick) => tick + 1);

    const stickToBottom = () => {
      window.requestAnimationFrame(() => {
        if (cancelledRef.current || !pinnedRef.current) return;
        const el = getScroller();
        if (el) el.scrollTop = el.scrollHeight;
      });
    };

    let timer: number | undefined;
    const schedule = (delay: number) => {
      if (cancelledRef.current) return;
      timer = window.setTimeout(() => {
        void pull();
      }, delay);
    };

    const appendEvents = (fresh: readonly AttemptLiveEvent[]) => {
      for (const event of fresh) bytesRef.current += approxBytes(event);
      eventsRef.current.push(...fresh);
      lastSeqRef.current = fresh.reduce(
        (max, event) => Math.max(max, event.seq),
        lastSeqRef.current,
      );

      // 容量预算：超出时淘汰最旧事件并整体重折叠（淘汰后可从磁盘重读，不静默丢失）。
      let evicted = false;
      while (bytesRef.current > PROCESS_CACHE_BUDGET_BYTES && eventsRef.current.length > 1) {
        const removed = eventsRef.current.shift();
        if (!removed) break;
        bytesRef.current -= approxBytes(removed);
        evicted = true;
      }
      blocksRef.current = evicted
        ? foldLiveEvents(eventsRef.current)
        : foldLiveEventsAppend(blocksRef.current, fresh);

      if (!pinnedRef.current) {
        setNewCount(countNewActivities(baselineRef.current, blocksRef.current.length));
      }
      bump();
      stickToBottom();
    };

    const pull = async (): Promise<void> => {
      if (cancelledRef.current || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await client.getCliRunAttemptLive(runId, attemptId, afterSeqRef.current);
        if (cancelledRef.current) return;
        if (isCursorReset(afterSeqRef.current, res.nextSeq)) {
          // 服务端事件序号重置：沿用旧游标会永久漏数据，重建该席缓存从头重读。
          eventsRef.current = [];
          blocksRef.current = [];
          bytesRef.current = 0;
          lastSeqRef.current = -1;
        }
        const fresh = res.events.filter((event) => event.seq > lastSeqRef.current);
        if (fresh.length > 0) appendEvents(fresh);
        afterSeqRef.current = res.nextSeq;
        failuresRef.current = 0;
        setReadError(false);
        setReady(true);
        if (res.done) {
          setDone(true);
          return;
        }
        schedule(PROCESS_POLL_MS);
      } catch {
        if (cancelledRef.current) return;
        failuresRef.current += 1;
        setReadError(true);
        setReady(true);
        schedule(nextPollDelayMs(failuresRef.current));
      } finally {
        inFlightRef.current = false;
      }
    };

    retryRef.current = () => {
      failuresRef.current = 0;
      if (!inFlightRef.current) void pull();
    };

    // document.hidden：暂停排程；恢复可见时从当前游标立即续读（游标不回退）。
    const onVisibility = () => {
      if (cancelledRef.current) return;
      if (document.hidden) {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        return;
      }
      if (!inFlightRef.current) void pull();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onScroll = () => {
      const el = getScroller();
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
      if (nearBottom) {
        if (!pinnedRef.current) {
          pinnedRef.current = true;
          baselineRef.current = blocksRef.current.length;
          setPinned(true);
          setNewCount(0);
        }
      } else if (pinnedRef.current) {
        pinnedRef.current = false;
        baselineRef.current = blocksRef.current.length;
        setPinned(false);
      }
    };
    const scroller = getScroller();
    scroller?.addEventListener("scroll", onScroll, { passive: true });

    void pull();
    stickToBottom();

    return () => {
      cancelledRef.current = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      scroller?.removeEventListener("scroll", onScroll);
    };
    // attempt.status 变化刻意不重建循环：终态信号经 reportReady 渲染层表达，
    // 轮询只认服务端 done（重建会移动阅读锚点，违反 INTERACTION-SPEC §4.4）。
  }, [runId, attemptId, getScroller]);

  const blocks = blocksRef.current;
  const hiddenCount = expanded ? 0 : Math.max(0, blocks.length - PROCESS_WINDOW_LINES);
  const windowBlocks = expanded ? blocks : blocks.slice(-PROCESS_WINDOW_LINES);
  const truncated = blocks.some((block) => block.kind === "truncated");

  return {
    ready,
    done,
    readError,
    hasEvents: blocks.length > 0,
    pinned,
    newCount,
    totalLines: blocks.length,
    windowBlocks,
    hiddenCount,
    expanded,
    expand: () => setExpanded(true),
    reportReady,
    truncated,
    retry: () => retryRef.current(),
  };
}
