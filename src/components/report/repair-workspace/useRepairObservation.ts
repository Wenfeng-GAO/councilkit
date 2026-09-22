import {
  REPAIR_OBS_PIN_THRESHOLD_PX,
  REPAIR_OBS_POLL_MS,
  type RepairEvidence,
  type RepairObservation,
  type RepairOperation,
  applyUiWindow,
  countNewOperations,
  markUnfinishedTools,
  isStaleRequest,
  nextPollDelayMs,
} from "@shared/runtime/repair-observation";
import {
  exportRepairEvidence,
  fetchRepairEvidence,
  fetchRepairObservation,
} from "@/runtime/repair-observation-client";
import { useCallback, useEffect, useRef, useState } from "react";

export type RepairReadingState = {
  tab: "activity" | "evidence";
  roleKey: string;
  kind: string;
  query: string;
  pinned: boolean;
  newCount: number;
  selectedEventId: string | null;
  round: number | "current";
};

function laterTimestamp(next: string | null, prev: string | null): string | null {
  if (!next) return prev;
  if (!prev) return next;
  return next > prev ? next : prev;
}

const INITIAL_READING: RepairReadingState = {
  tab: "activity",
  roleKey: "all",
  kind: "all",
  query: "",
  pinned: true,
  newCount: 0,
  selectedEventId: null,
  round: "current",
};

export function useRepairObservation(input: {
  runId: string;
  getScroller: () => HTMLElement | null;
}) {
  const [observation, setObservation] = useState<RepairObservation | null>(null);
  const [evidence, setEvidence] = useState<RepairEvidence | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [reading, setReading] = useState<RepairReadingState>(INITIAL_READING);
  const [visibleCount, setVisibleCount] = useState(200);
  const [stopAckPending, setStopAckPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestSeqRef = useRef(0);
  const inFlightRef = useRef(false);
  const failuresRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const knownOpsRef = useRef<Set<string>>(new Set());
  const pinnedRef = useRef(true);
  const bufferRef = useRef<RepairOperation[]>([]);
  const readingRoundRef = useRef<number | "current">("current");
  const observationDoneRef = useRef(false);

  pinnedRef.current = reading.pinned;
  readingRoundRef.current = reading.round;

  const mergeObservation = useCallback((next: RepairObservation, applyBuffer: boolean) => {
    setObservation((prev) => {
      const nowMs = Date.parse(next.serverTime);
      if (!prev || next.reset) {
        const upserts = markUnfinishedTools(next.upserts, nowMs);
        knownOpsRef.current = new Set(upserts.map((op) => op.operationId));
        return { ...next, upserts };
      }
      const byId = new Map(prev.upserts.map((op) => [op.operationId, op]));
      for (const op of next.upserts) byId.set(op.operationId, op);
      const merged = markUnfinishedTools(
        [...byId.values()].sort((a, b) =>
          a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0,
        ),
        nowMs,
      );
      if (!pinnedRef.current && !applyBuffer) {
        const counted = countNewOperations(knownOpsRef.current, next.upserts);
        bufferRef.current = next.upserts.filter((op) => !knownOpsRef.current.has(op.operationId));
        knownOpsRef.current = counted.ids;
        setReading((r) => ({ ...r, newCount: r.newCount + counted.count }));
        return {
          ...next,
          upserts: merged,
        };
      }
      knownOpsRef.current = new Set(merged.map((op) => op.operationId));
      bufferRef.current = [];
      return {
        ...next,
        upserts: merged,
        task: {
          ...next.task,
          lastActivityAt: laterTimestamp(next.task.lastActivityAt, prev.task.lastActivityAt),
        },
      };
    });
    cursorRef.current = next.nextCursor;
    observationDoneRef.current = next.observationDone;
  }, []);

  useEffect(() => {
    const mySeq = ++requestSeqRef.current;
    const isCurrent = () => !isStaleRequest(mySeq, requestSeqRef.current);
    cursorRef.current = null;
    knownOpsRef.current = new Set();
    bufferRef.current = [];
    failuresRef.current = 0;
    inFlightRef.current = false;
    observationDoneRef.current = false;
    setObservation(null);
    setEvidence(null);
    setConnectionLost(false);
    setError(null);
    setReading((r) => ({ ...r, newCount: 0, pinned: true }));
    setVisibleCount(200);

    let timer: number | undefined;
    let aborted = false;
    let controller: AbortController | null = null;

    const clearScheduled = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };

    const schedule = (delay: number) => {
      clearScheduled();
      if (!isCurrent() || aborted || document.hidden) return;
      if (observationDoneRef.current) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void pull();
      }, delay);
    };

    const pull = async () => {
      if (!isCurrent() || aborted || inFlightRef.current) return;
      inFlightRef.current = true;
      controller?.abort();
      controller = new AbortController();
      try {
        const data = await fetchRepairObservation({
          runId: input.runId,
          round: readingRoundRef.current,
          cursor: cursorRef.current,
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        failuresRef.current = 0;
        setConnectionLost(false);
        setError(null);
        mergeObservation(data, false);
        if (readingRoundRef.current === "current" || readingRoundRef.current === data.currentRound) {
          try {
            const ev = await fetchRepairEvidence({
              runId: input.runId,
              round: data.round,
              signal: controller.signal,
            });
            if (isCurrent()) setEvidence(ev);
          } catch {
            // evidence is optional for activity polling
          }
        }
        schedule(REPAIR_OBS_POLL_MS);
      } catch (err) {
        if (!isCurrent()) return;
        if ((err as { name?: string }).name === "AbortError") return;
        failuresRef.current += 1;
        setConnectionLost(true);
        setError(err instanceof Error ? err.message : "观察读取失败");
        schedule(nextPollDelayMs(failuresRef.current));
      } finally {
        if (isCurrent()) inFlightRef.current = false;
      }
    };

    void pull();

    const onVisibility = () => {
      if (!isCurrent()) return;
      if (document.hidden) {
        clearScheduled();
        return;
      }
      void pull();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      aborted = true;
      requestSeqRef.current += 1;
      clearScheduled();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [input.runId, mergeObservation]);

  useEffect(() => {
    const onScroll = () => {
      const el = input.getScroller();
      if (!el) return;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance > REPAIR_OBS_PIN_THRESHOLD_PX && pinnedRef.current) {
        setReading((r) => ({ ...r, pinned: false }));
      }
    };
    const el = input.getScroller();
    el?.addEventListener("scroll", onScroll, { passive: true });
    return () => el?.removeEventListener("scroll", onScroll);
  }, [input.getScroller, observation?.upserts.length]);

  useEffect(() => {
    if (!reading.pinned) return;
    const el = input.getScroller();
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [observation?.upserts, reading.pinned, input.getScroller]);

  const setFilter = useCallback((patch: Partial<RepairReadingState>) => {
    setReading((r) => ({ ...r, ...patch }));
  }, []);

  const clearFilter = useCallback(() => {
    setReading((r) => ({ ...r, roleKey: "all", kind: "all", query: "" }));
  }, []);

  const toggleFollow = useCallback(() => {
    setReading((r) => {
      const nextPinned = !r.pinned;
      if (nextPinned) {
        knownOpsRef.current = new Set([
          ...knownOpsRef.current,
          ...bufferRef.current.map((op) => op.operationId),
        ]);
        bufferRef.current = [];
        return { ...r, pinned: true, newCount: 0 };
      }
      return { ...r, pinned: false };
    });
  }, []);

  const viewNew = useCallback(() => {
    setReading((r) => ({ ...r, pinned: true, newCount: 0 }));
    bufferRef.current = [];
  }, []);

  const loadEarlier = useCallback(() => {
    const scroller = input.getScroller();
    const first = scroller?.querySelector<HTMLElement>("[data-testid^='repair-activity-row-']");
    const anchorId = first?.getAttribute("data-event-id");
    const offset = first ? first.getBoundingClientRect().top : 0;
    setVisibleCount((n) => Math.min(400, n + 200));
    window.requestAnimationFrame(() => {
      if (!anchorId || !scroller) return;
      const node = scroller.querySelector<HTMLElement>(`[data-event-id='${anchorId}']`);
      if (!node) return;
      const delta = node.getBoundingClientRect().top - offset;
      scroller.scrollTop += delta;
    });
  }, [input.getScroller]);

  const windowed = applyUiWindow(observation?.upserts ?? [], visibleCount);

  const downloadEvidence = useCallback(
    async (format: "json" | "md") => {
      const result = await exportRepairEvidence({
        runId: input.runId,
        round: observation?.round,
        format,
      });
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    },
    [input.runId, observation?.round],
  );

  return {
    observation,
    evidence,
    connectionLost,
    reading,
    setFilter,
    clearFilter,
    toggleFollow,
    viewNew,
    loadEarlier,
    windowed,
    stopAckPending,
    setStopAckPending,
    error,
    downloadEvidence,
    retry: () => {
      failuresRef.current = 0;
      cursorRef.current = null;
      requestSeqRef.current += 1;
      // effect restart via round bump
      setReading((r) => ({ ...r }));
    },
  };
}
