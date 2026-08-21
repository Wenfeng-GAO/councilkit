import { getAppRuntime } from "@/runtime/bootstrap";
import type { AttemptLiveEvent } from "@shared/runtime/attempt-live-events";
import { useEffect, useRef, useState } from "react";

const POLL_MS = 2000;

type TimelineBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; summary: string; status: "started" | "completed" }
  | { kind: "truncated"; dropped: number };

export function AttemptLiveTranscript({
  runId,
  attemptId,
  active,
}: {
  runId: string;
  attemptId: string;
  active: boolean;
}) {
  const [events, setEvents] = useState<AttemptLiveEvent[]>([]);
  const [done, setDone] = useState(false);
  const [ready, setReady] = useState(false);
  const afterSeqRef = useRef(0);
  const eventsRef = useRef<AttemptLiveEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const client = getAppRuntime().client;

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

  if (!ready) {
    return <p className="mt-2 font-command text-[0.68rem] text-muted">读取过程…</p>;
  }
  if (events.length === 0) {
    return (
      <p className="mt-2 font-command text-[0.68rem] text-muted">
        {active && !done ? "等待过程输出…" : "该 driver 无过程输出"}
      </p>
    );
  }

  const blocks = foldEvents(events);
  return (
    <div className="mt-2 flex flex-col gap-2">
      {blocks.map((block, index) => (
        <TimelineItem key={`${block.kind}-${index}`} block={block} />
      ))}
    </div>
  );
}

function foldEvents(events: readonly AttemptLiveEvent[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  for (const event of events) {
    const last = blocks[blocks.length - 1];
    if (event.type === "text.delta") {
      if (last?.kind === "text") last.text += event.text;
      else blocks.push({ kind: "text", text: event.text });
    } else if (event.type === "thinking.delta") {
      if (last?.kind === "thinking") last.text += event.text;
      else blocks.push({ kind: "thinking", text: event.text });
    } else if (event.type === "tool.started") {
      blocks.push({
        kind: "tool",
        name: event.name,
        summary: event.summary,
        status: "started",
      });
    } else if (event.type === "tool.completed") {
      blocks.push({
        kind: "tool",
        name: event.name,
        summary: event.summary,
        status: "completed",
      });
    } else if (event.type === "truncated") {
      blocks.push({ kind: "truncated", dropped: event.dropped });
    }
  }
  return blocks;
}

function TimelineItem({ block }: { block: TimelineBlock }) {
  if (block.kind === "text") {
    return (
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-command text-[0.72rem] text-fg">
        {block.text}
      </pre>
    );
  }
  if (block.kind === "thinking") {
    const n = Array.from(block.text).length;
    return (
      <details className="border border-edge bg-surface">
        <summary className="cursor-pointer px-2 py-1 font-command text-[0.68rem] text-brass">
          思考 · {n} 字
        </summary>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all px-2 pb-2 font-command text-[0.72rem] text-muted">
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
  return (
    <div className="border border-edge px-2 py-1">
      <p className="font-command text-[0.68rem] text-brass">
        {block.name}
        <span className="ml-2 text-muted">{block.status === "started" ? "进行中" : "完成"}</span>
      </p>
      {block.summary.length > 0 ? (
        <p className="truncate font-command text-[0.68rem] text-muted" title={block.summary}>
          {block.summary}
        </p>
      ) : null}
    </div>
  );
}
