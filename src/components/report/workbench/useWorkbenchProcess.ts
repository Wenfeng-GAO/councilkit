import { type TimelineBlock, foldLiveEvents, foldLiveEventsAppend } from "@/lib/live-transcript";
import { getAppRuntime } from "@/runtime/bootstrap";
import type { AttemptLiveEvent } from "@shared/runtime/attempt-live-events";
import { useEffect, useRef, useState } from "react";
import {
  PROCESS_CACHE_BUDGET_BYTES,
  PROCESS_POLL_MS,
  PROCESS_WINDOW_LINES,
  PROCESS_WINDOW_STEP,
  chunkedWindow,
  newActivityCount as countNewActivities,
  isCursorReset,
  isStaleResponse,
  nextPollDelayMs,
} from "./seatDetailModel";
import type { WorkbenchAttempt } from "./selection";

/** 滚离底部阈值：超过即暂停跟随（INTERACTION-SPEC §4.1）。 */
const PIN_THRESHOLD_PX = 48;

export { PROCESS_WINDOW_STEP };

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
  /** 当前渲染窗口：最近 visibleCount 行（分段扩展，DOM 有界）。 */
  windowBlocks: TimelineBlock[];
  /** 窗口外尚未渲染的较早行数。 */
  hiddenCount: number;
  /** 每次调用多渲染 PROCESS_WINDOW_STEP 行。 */
  showEarlier: () => void;
  /** 席位已到终态（来自 progress），过程 Tab 显示「报告已就绪 · 查看报告」。 */
  reportReady: boolean;
  truncated: boolean;
  retry: () => void;
}

/**
 * 席位过程轮询（DELIVERY-PLAN §3.1 硬约束）：
 * - GET live?afterSeq=N，常规 2s；同一席位同时最多一个 in-flight。
 * - AC-03 切席/关闭防护：单调递增 requestSeq。每轮 effect capture 当前 seq，cleanup 只
 *   做 seqRef++（绝不把任何共享布尔复位成允许旧写）；所有迟到回调（成功/失败/finally）
 *   先比对 seq 才允许写 state/refs。
 * - AC-09 单一排程链：schedule(delay) 是唯一定时器入口，排程前先 clearTimeout 旧 timer；
 *   排程前检查 document.hidden（hidden 不排程，交给 visibilitychange 恢复路径）；
 *   手动重读先清 timer 再走同一 pull 路径。
 * - 错误退避 2s→4s→8s→16s→30s，成功回退 2s。
 * - done=true 停常规轮询；retry() 手动重读仍可用。
 * - 容量：原始事件按席位 ≤2.5 MiB（淘汰最旧并可从磁盘重读）；渲染端分段窗口
 *   （先最近 200 行，每次「显示更早」+200，DOM 活动行有界）。
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
  const [visibleCount, setVisibleCount] = useState(PROCESS_WINDOW_LINES);
  const [, setTick] = useState(0);

  const eventsRef = useRef<AttemptLiveEvent[]>([]);
  const blocksRef = useRef<TimelineBlock[]>([]);
  const bytesRef = useRef(0);
  const lastSeqRef = useRef(-1);
  const afterSeqRef = useRef(0);
  const failuresRef = useRef(0);
  const inFlightRef = useRef(false);
  /** AC-03：单调递增代次；cleanup 只 ++，永不复位。 */
  const requestSeqRef = useRef(0);
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
    const mySeq = ++requestSeqRef.current;
    const isCurrent = () => !isStaleResponse(mySeq, requestSeqRef.current);
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
    setVisibleCount(PROCESS_WINDOW_LINES);

    const bump = () => {
      if (isCurrent()) setTick((tick) => tick + 1);
    };

    const stickToBottom = () => {
      window.requestAnimationFrame(() => {
        if (!isCurrent() || !pinnedRef.current) return;
        const el = getScroller();
        if (el) el.scrollTop = el.scrollHeight;
      });
    };

    // AC-09：唯一定时器入口。排程前清旧 timer；hidden 时不排程（恢复路径在 visibilitychange）。
    let timer: number | undefined;
    const clearScheduled = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };
    const schedule = (delay: number) => {
      clearScheduled();
      if (!isCurrent() || document.hidden) return;
      timer = window.setTimeout(() => {
        timer = undefined;
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
      if (!isCurrent() || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await client.getCliRunAttemptLive(runId, attemptId, afterSeqRef.current);
        if (!isCurrent()) return; // AC-03：迟到响应，不得写入新席位
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
        if (!isCurrent()) return; // AC-03：迟到失败同样不得写入
        failuresRef.current += 1;
        setReadError(true);
        setReady(true);
        schedule(nextPollDelayMs(failuresRef.current));
      } finally {
        // AC-03：只有当前轮的 finally 才能复位 inFlight；迟到 finally 不影响新一轮。
        if (isCurrent()) inFlightRef.current = false;
      }
    };

    // AC-09 手动重读：清掉已有 timer，走同一条 pull 路径（响应后统一 schedule）。
    retryRef.current = () => {
      if (!isCurrent()) return;
      failuresRef.current = 0;
      if (!inFlightRef.current) {
        clearScheduled();
        void pull();
      }
    };

    // document.hidden：暂停排程；恢复可见时从当前游标立即续读（不重置）。
    const onVisibility = () => {
      if (!isCurrent()) return;
      if (document.hidden) {
        clearScheduled();
        return;
      }
      if (!inFlightRef.current) void pull();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onScroll = () => {
      const el = getScroller();
      if (!el) return;
      // 内容未加载时的滚动容器高度无意义（加载态 clamp 到 0 会伪造 nearBottom），
      // 此时不得转为跟随，否则切回席位时跟随会把恢复中的阅读位置拖到底部（AC-05）。
      if (blocksRef.current.length === 0) return;
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
      // AC-03：只递增代次使旧回调全部失效；绝不复位任何共享状态为「允许旧写」。
      requestSeqRef.current += 1;
      clearScheduled();
      document.removeEventListener("visibilitychange", onVisibility);
      scroller?.removeEventListener("scroll", onScroll);
    };
    // attempt.status 变化刻意不重建循环：终态信号经 reportReady 渲染层表达，
    // 轮询只认服务端 done（重建会移动阅读锚点，违反 INTERACTION-SPEC §4.4）。
  }, [runId, attemptId, getScroller]);

  const blocks = blocksRef.current;
  const { hiddenCount, fromIndex } = chunkedWindow(blocks.length, visibleCount);
  const windowBlocks = blocks.slice(fromIndex);
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
    showEarlier: () => setVisibleCount((count) => count + PROCESS_WINDOW_STEP),
    reportReady,
    truncated,
    retry: () => retryRef.current(),
  };
}
