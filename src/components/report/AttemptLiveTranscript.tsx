import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
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
  unwrapShellSummary,
} from "@/lib/live-transcript";
import { getAppRuntime } from "@/runtime/bootstrap";
import type { AttemptLiveEvent } from "@shared/runtime/attempt-live-events";
import { useEffect, useRef, useState } from "react";

const POLL_MS = 2000;
const PIN_THRESHOLD_PX = 48;

export function AttemptLiveTranscript({
  runId,
  attemptId,
  active,
  collapseDeliverable = false,
  className = "",
  onTimeline,
}: {
  runId: string;
  attemptId: string;
  active: boolean;
  collapseDeliverable?: boolean;
  className?: string;
  onTimeline?: (span: LiveEventSpan) => void;
}) {
  const [events, setEvents] = useState<AttemptLiveEvent[]>([]);
  const [done, setDone] = useState(false);
  const [ready, setReady] = useState(false);
  const afterSeqRef = useRef(0);
  const eventsRef = useRef<AttemptLiveEvent[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinToBottomRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const client = getAppRuntime().client;
    afterSeqRef.current = 0;
    eventsRef.current = [];
    setEvents([]);
    setDone(false);
    setReady(false);
    pinToBottomRef.current = active;

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
        }
        afterSeqRef.current = res.nextSeq;
        setReady(true);
        stickToBottom();
        if (res.done) {
          setDone(true);
          return;
        }
        if (active) {
          timer = window.setTimeout(() => {
            void pull();
          }, POLL_MS);
        }
      } catch {
        if (cancelled) return;
        setReady(true);
        if (active) {
          timer = window.setTimeout(() => {
            void pull();
          }, POLL_MS);
        }
      }
    };

    void pull();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runId, attemptId, active]);

  const span = liveEventSpan(events);
  useEffect(() => {
    onTimeline?.(liveEventSpan(events));
  }, [onTimeline, events]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    pinToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
  };

  if (!ready) {
    return (
      <div ref={scrollerRef} className={className}>
        <p className="font-command text-[0.68rem] text-muted">读取过程…</p>
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div ref={scrollerRef} className={className}>
        <p className="font-command text-[0.68rem] text-muted">
          {active && !done ? "等待过程输出…" : "该 driver 无过程输出"}
        </p>
      </div>
    );
  }

  const origin = originAt(events);
  const { tally, timeline } = silentToolTally(foldLiveEvents(events));
  const last = timeline.length - 1;
  return (
    <div ref={scrollerRef} className={className} onScroll={onScroll}>
      <div className="flex flex-col gap-2.5">
        {span.eventCount > 0 && !span.hasTimeline ? (
          <p className="font-command text-[0.68rem] text-muted">过程无时间轴</p>
        ) : null}
        {tally.length > 0 ? (
          <p className="ck-inspector-tally">
            {tally.map((row) => `${row.name} ${row.count}`).join(" · ")}
            {" · "}无路径/命令摘要
          </p>
        ) : null}
        {timeline.map((block, index) => (
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
      </div>
    </div>
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
