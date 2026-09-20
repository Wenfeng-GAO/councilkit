import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { liveEmptyProcessMessage, liveFollowNotice } from "@/lib/live-follow";
import {
  type LiveEventSpan,
  type TimelineBlock,
  displayToolName,
  foldLiveEvents,
  formatElapsed,
  formatSpan,
  hasUnmatchedFence,
  isDeliverableText,
  isJsonDeliverable,
  isPathTool,
  liveEventSpan,
  originAt,
  shortenActivityPath,
  showsTick,
  silentToolTally,
  splitSeatDeliverable,
  unwrapShellSummary,
} from "@/lib/live-transcript";
import { getAppRuntime } from "@/runtime/bootstrap";
import type { AttemptLiveEvent } from "@shared/runtime/attempt-live-events";
import { type CliRunAttemptResult, summarizeSeatOutput } from "@shared/runtime/seat-result";
import { useEffect, useRef, useState } from "react";

const POLL_MS = 2000;
const PIN_THRESHOLD_PX = 48;
const QUIET_MS = 30_000;

export function AttemptLiveTranscript({
  runId,
  attemptId,
  active,
  collapseDeliverable = false,
  resultFirst = false,
  independent = false,
  fallbackResult,
  className = "",
  onTimeline,
}: {
  runId: string;
  attemptId: string;
  active: boolean;
  collapseDeliverable?: boolean;
  resultFirst?: boolean;
  independent?: boolean;
  fallbackResult?: CliRunAttemptResult;
  className?: string;
  onTimeline?: (span: LiveEventSpan) => void;
}) {
  const [events, setEvents] = useState<AttemptLiveEvent[]>([]);
  const [done, setDone] = useState(false);
  const [ready, setReady] = useState(false);
  const [readError, setReadError] = useState(false);
  const [pinned, setPinned] = useState(active);
  const [newCount, setNewCount] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const retryRef = useRef<() => void>(() => {});
  const afterSeqRef = useRef(0);
  const eventsRef = useRef<AttemptLiveEvent[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinToBottomRef = useRef(active);
  const unpinnedAtRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const client = getAppRuntime().client;
    afterSeqRef.current = 0;
    eventsRef.current = [];
    setEvents([]);
    setDone(false);
    setReady(false);
    setReadError(false);
    pinToBottomRef.current = activeRef.current;
    setPinned(activeRef.current);
    unpinnedAtRef.current = 0;
    setNewCount(0);

    const stickToBottom = () => {
      window.requestAnimationFrame(() => {
        if (cancelled || !pinToBottomRef.current) return;
        const el = scrollerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    };

    const pull = async (): Promise<void> => {
      try {
        const res = await client.getCliRunAttemptLive(runId, attemptId, afterSeqRef.current);
        if (cancelled) return;
        if (res.events.length > 0) {
          eventsRef.current = [...eventsRef.current, ...res.events];
          setEvents(eventsRef.current);
          if (!pinToBottomRef.current) {
            setNewCount(Math.max(0, eventsRef.current.length - unpinnedAtRef.current));
          }
        }
        afterSeqRef.current = res.nextSeq;
        setReadError(false);
        setReady(true);
        stickToBottom();
        if (res.done) {
          setDone(true);
          return;
        }
        if (activeRef.current) {
          timer = window.setTimeout(() => {
            void pull();
          }, POLL_MS);
        } else {
          setDone(true);
        }
      } catch {
        if (cancelled) return;
        setReadError(true);
        setReady(true);
        if (activeRef.current) {
          timer = window.setTimeout(() => {
            void pull();
          }, POLL_MS);
        }
      }
    };

    retryRef.current = () => {
      void pull();
    };
    void pull();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runId, attemptId]);

  useEffect(() => {
    onTimeline?.(liveEventSpan(events));
  }, [onTimeline, events]);

  useEffect(() => {
    if (!active || events.length === 0 || done) return;
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, [active, events.length, done]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
    if (nearBottom) {
      pinToBottomRef.current = true;
      unpinnedAtRef.current = eventsRef.current.length;
      setPinned(true);
      setNewCount(0);
      return;
    }
    if (pinToBottomRef.current) {
      pinToBottomRef.current = false;
      unpinnedAtRef.current = eventsRef.current.length;
      setPinned(false);
    }
  };

  const jumpToLatest = () => {
    pinToBottomRef.current = true;
    unpinnedAtRef.current = eventsRef.current.length;
    setPinned(true);
    setNewCount(0);
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const jumpToResult = () => {
    pinToBottomRef.current = false;
    setPinned(false);
    document.getElementById("ck-seat-result")?.scrollIntoView({ block: "start" });
  };

  const errorNotice = readError ? (
    <output className="mb-3 block text-sm text-warn">
      过程读取失败。{active ? "正在自动重试，已读取的记录仍保留。" : "请重试读取过程记录。"}
      {!active ? (
        <button type="button" className="ml-2 underline" onClick={() => retryRef.current()}>
          重新读取过程
        </button>
      ) : null}
    </output>
  ) : null;

  const empty = liveEmptyProcessMessage({
    ready,
    active,
    done,
    error: readError,
  });
  const seatComplete = done || !active;
  if (!ready || events.length === 0) {
    return (
      <div ref={scrollerRef} className={className}>
        {errorNotice}
        {resultFirst && seatComplete ? (
          <SeatResultPanel
            text={null}
            independent={independent}
            complete
            fallback={fallbackResult}
          />
        ) : null}
        {empty && !errorNotice ? <p className="text-sm text-muted">{empty}</p> : null}
      </div>
    );
  }

  const span = liveEventSpan(events);
  const origin = originAt(events);
  const { tally, timeline } = silentToolTally(foldLiveEvents(events));
  const split = resultFirst
    ? splitSeatDeliverable(timeline, seatComplete)
    : { deliverable: null, process: timeline };
  const process = split.process;
  const last = process.length - 1;
  const lastAt = events[events.length - 1]?.at;
  const lastMs = lastAt ? Date.parse(lastAt) : Number.NaN;
  const quiet = active && !done && Number.isFinite(lastMs) && now - lastMs > QUIET_MS;
  const notice = liveFollowNotice({
    pinned,
    newCount,
    resultReady: resultFirst && seatComplete && !pinned,
  });

  return (
    <div ref={scrollerRef} className={className} onScroll={onScroll}>
      {errorNotice}
      {notice ? (
        <div className="ck-follow-bar">
          <p>{notice.text}</p>
          <button
            type="button"
            onClick={notice.action === "查看结果" ? jumpToResult : jumpToLatest}
          >
            {notice.action}
          </button>
        </div>
      ) : null}
      {quiet ? <p className="mb-3 text-sm text-muted">暂时没有新输出</p> : null}
      {resultFirst ? (
        <SeatResultPanel
          text={split.deliverable}
          independent={independent}
          complete={seatComplete}
          fallback={fallbackResult}
        />
      ) : null}
      <div className="flex flex-col gap-2.5">
        {resultFirst && process.length > 0 ? (
          <details className="ck-inspector-process" open={!split.deliverable}>
            <summary className="cursor-pointer font-command text-[0.68rem] text-brass">
              历史过程
            </summary>
            <div className="mt-2.5 flex flex-col gap-2.5">
              <ProcessTimeline
                origin={origin}
                span={span}
                tally={tally}
                process={process}
                last={last}
                active={active}
                done={done}
                collapseDeliverable={false}
              />
            </div>
          </details>
        ) : (
          <ProcessTimeline
            origin={origin}
            span={span}
            tally={tally}
            process={process}
            last={last}
            active={active}
            done={done}
            collapseDeliverable={collapseDeliverable && !resultFirst}
          />
        )}
      </div>
    </div>
  );
}

function SeatResultPanel({
  text,
  independent,
  complete,
  fallback,
}: {
  text: string | null;
  independent: boolean;
  complete: boolean;
  fallback?: CliRunAttemptResult;
}) {
  const parsed = text ? summarizeSeatOutput(text) : (fallback ?? summarizeSeatOutput(null));
  const markdown =
    text && isJsonDeliverable(text) ? (
      <pre className="max-h-[min(28rem,55vh)] overflow-auto whitespace-pre-wrap break-words font-command text-[0.72rem] leading-5 text-fg">
        {text}
      </pre>
    ) : text ? (
      <SafeMarkdown className="text-sm" variant="document" content={text} />
    ) : null;
  const status =
    parsed.parseStatus === "parsed"
      ? parsed.findingCount === 0
        ? "未列出发现"
        : `${parsed.findingCount} 项发现${parsed.blockingCount ? ` · ${parsed.blockingCount} 项阻塞` : ""}`
      : complete
        ? "结果待解析"
        : null;
  if (!complete && text === null) return null;
  return (
    <section id="ck-seat-result" className="ck-seat-result">
      <p className="ck-seat-result-kicker">席位结果</p>
      {independent ? (
        <p className="ck-seat-result-note">Aggregator 完成前，这是独立意见，不是最终裁决。</p>
      ) : null}
      {status ? <p className="ck-seat-result-status">{status}</p> : null}
      {parsed.summary && parsed.parseStatus === "parsed" ? (
        <p className="ck-seat-result-summary">{parsed.summary}</p>
      ) : null}
      {markdown}
    </section>
  );
}

function ProcessTimeline({
  origin,
  span,
  tally,
  process,
  last,
  active,
  done,
  collapseDeliverable,
}: {
  origin: string;
  span: LiveEventSpan;
  tally: Array<{ name: string; count: number }>;
  process: TimelineBlock[];
  last: number;
  active: boolean;
  done: boolean;
  collapseDeliverable: boolean;
}) {
  return (
    <>
      {span.eventCount > 0 && !span.hasTimeline ? (
        <p className="font-command text-[0.68rem] text-muted">过程无时间轴</p>
      ) : null}
      {tally.length > 0 ? (
        <p className="ck-inspector-tally">
          {tally.map((row) => `${row.name} ${row.count}`).join(" · ")}
          {" · "}无路径/命令摘要
        </p>
      ) : null}
      {process.map((block, index) => (
        <div key={`${block.kind}-${index}`} className="ck-inspector-step">
          <span className="ck-inspector-tick">
            {showsTick(block, collapseDeliverable) ? formatElapsed(origin, block.at) : ""}
          </span>
          <div className="min-w-0">
            <TimelineItem
              block={block}
              streaming={active && !done && index === last}
              collapseDeliverable={collapseDeliverable}
            />
          </div>
        </div>
      ))}
    </>
  );
}

function TimelineItem({
  block,
  streaming,
  collapseDeliverable,
}: {
  block: TimelineBlock;
  streaming: boolean;
  collapseDeliverable: boolean;
}) {
  if (block.kind === "text") {
    const asPre = streaming && hasUnmatchedFence(block.text);
    if (asPre) {
      return (
        <pre className="whitespace-pre-wrap break-words font-command text-[0.78rem] leading-5 text-fg">
          {block.text}
        </pre>
      );
    }
    const markdown = isJsonDeliverable(block.text) ? (
      <pre className="max-h-[min(28rem,55vh)] overflow-auto whitespace-pre-wrap break-words font-command text-[0.72rem] leading-5 text-fg">
        {block.text}
      </pre>
    ) : (
      <SafeMarkdown className="text-sm" variant="document" content={block.text} />
    );
    if (!streaming && collapseDeliverable && isDeliverableText(block.text)) {
      const n = Array.from(block.text).length;
      const restatesReport =
        /^(?:# Autonomous Review Report\b|## (?:概览|共识发现|独有发现|分歧|结论))/m.test(
          block.text,
        );
      return (
        <details className="ck-inspector-think">
          <summary className="cursor-pointer font-command text-[0.68rem] text-brass">
            席位交付物 · {n} 字
            {restatesReport ? <span className="ml-2 text-muted">· 与报告正文重复</span> : null}
          </summary>
          <div className="mt-2">{markdown}</div>
        </details>
      );
    }
    return markdown;
  }
  if (block.kind === "thinking") {
    const n = Array.from(block.text).length;
    return (
      <details className="ck-inspector-think">
        <summary className="cursor-pointer font-command text-[0.68rem] text-brass">
          思考 · {n} 字
        </summary>
        <pre className="mt-1.5 max-h-[min(24rem,50vh)] overflow-auto whitespace-pre-wrap break-words font-command text-[0.72rem] leading-5 text-muted">
          {block.text}
        </pre>
      </details>
    );
  }
  if (block.kind === "truncated") {
    return (
      <p className="font-command text-[0.68rem] text-warn">
        过程输出已截断（丢弃 {block.dropped} 条增量）
      </p>
    );
  }
  return <ToolRow block={block} />;
}

function ToolRow({
  block,
}: {
  block: Extract<TimelineBlock, { kind: "tool" }>;
}) {
  const path = isPathTool(block.name);
  const span = block.endAt ? formatSpan(block.at, block.endAt) : "";
  const summary = path
    ? shortenActivityPath(unwrapShellSummary(block.summary))
    : unwrapShellSummary(block.summary);
  return (
    <div className="ck-inspector-tool">
      <div className="ck-inspector-tool-head">
        <p className="font-command text-[0.68rem] text-brass">
          {displayToolName(block.name)}
          <span className="ml-2 text-muted">
            {block.status === "started" ? "进行中" : "完成"}
            {span ? ` · ${span}` : ""}
          </span>
        </p>
        {summary.length > 0 ? <CopyCommand text={summary} /> : null}
      </div>
      {summary.length > 0 ? (
        <pre className="ck-inspector-cmd">
          {path ? <span className="mr-2 text-muted">路径</span> : null}
          {summary}
        </pre>
      ) : null}
    </div>
  );
}

function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, []);
  return (
    <button
      type="button"
      className="shrink-0 font-command text-[0.62rem] text-muted hover:text-parchment"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => setCopied(false), 1600);
          },
          () => {
            setCopied(false);
          },
        );
      }}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
}
