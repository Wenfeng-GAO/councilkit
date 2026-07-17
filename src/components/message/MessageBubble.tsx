import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";

interface MessageBubbleProps {
  /** Resolved speaker display name (参与者名 / 你). */
  name: string;
  /** Resolved speaker color; the name text is always shown alongside. */
  color: string;
  /** Untrusted markdown body — rendered through SafeMarkdown only. */
  content: string;
  /** ISO timestamp of the committed message; omitted for previews. */
  timestamp?: string | null;
  /** Text badge (e.g. 生成中·尚未保存) — status is never color-only. */
  badge?: string | null;
}

/**
 * One discussion bubble (U6). Dumb presentational component: speaker
 * resolution happens in the DiscussionStream, content stays untrusted and
 * only ever passes through SafeMarkdown.
 */
export function MessageBubble({ name, color, content, timestamp, badge }: MessageBubbleProps) {
  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium text-white"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        >
          {name.slice(0, 1)}
        </span>
        <span className="text-sm font-medium text-fg">{name}</span>
        {badge ? (
          <span className="rounded border border-info bg-info/10 px-2 py-0.5 text-xs text-info">
            {badge}
          </span>
        ) : null}
        {timestamp ? (
          <span className="text-xs text-muted">{new Date(timestamp).toLocaleTimeString()}</span>
        ) : null}
      </div>
      <SafeMarkdown className="ml-8 text-sm text-fg" content={content} />
    </div>
  );
}
