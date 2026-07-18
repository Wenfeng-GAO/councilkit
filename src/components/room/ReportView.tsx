import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { MessageBubble } from "@/components/message/MessageBubble";
import { Button } from "@/components/ui/Button";
import type { DecisionReport } from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";
import { useState } from "react";

/**
 * Decision-report presentation (S4). Three sibling components + one pure
 * filename helper, all report-related UI centralized here:
 *
 * - `ReportView` — the committed report card: SafeMarkdown body (the repo's
 *   sole untrusted renderer, reused — never re-rendered here) plus copy and
 *   download affordances. The nine required Markdown sections (product.md
 *   §5.5) are produced by the report instruction and rendered passively; this
 *   component never parses or re-sections the report text.
 * - `ReportProgress` — the concluding-state streaming card, mirroring
 *   DiscussionStream's private `ActivePreview` (which a report execution can
 *   never reach: it never occupies `round.activeExecutionId`).
 * - `ReportFailureBanner` — the room-level failure banner + retry entry (S2
 *   ruling #5 UX gap closure).
 */

/** Build the download filename for a report: `<safe-topic>-report.md`.
 * Trims the topic, collapses filesystem-hostile characters (`\\/:*?"<>|`) and
 * runs of whitespace to dashes, collapses adjacent dashes/leading-trailing
 * dashes, truncates to 50 chars, and falls back to `room` when nothing safe
 * remains. */
export function reportFilename(topic: string): string {
  const collapsed = topic
    .trim()
    .replace(/[\\/:*?"<>|]|\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = collapsed.length === 0 ? "room" : collapsed.slice(0, 50);
  return `${base}-report.md`;
}

interface ReportViewProps {
  report: DecisionReport;
  topic: string;
}

export function ReportView({ report, topic }: ReportViewProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(report.content);
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };

  const onDownload = () => {
    const blob = new Blob([report.content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = reportFilename(topic);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      data-testid="report-view"
      id="report"
      className="mx-auto w-full max-w-3xl rounded border border-edge bg-surface px-6 py-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-base font-semibold text-fg">决策报告</h2>
          <span className="text-xs text-muted">{new Date(report.createdAt).toLocaleString()}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={onCopy}>
            {copied ? "已复制 ✓" : "复制 Markdown"}
          </Button>
          <Button variant="ghost" onClick={onDownload}>
            下载 Markdown
          </Button>
        </div>
      </div>
      {copyFailed ? <p className="mb-2 text-xs text-warn">复制失败,请手动选择正文复制</p> : null}
      <SafeMarkdown content={report.content} />
    </section>
  );
}

interface ReportProgressProps {
  previewText: string;
  speakerName: string;
  speakerColor: string;
}

/** The concluding-state streaming card. Mirrors DiscussionStream's
 * `ActivePreview` two-state shape (preview text → bubble; empty → spinner
 * line + info badge), but reads its preview from `previewByExecution` for the
 * report execution which never owns `round.activeExecutionId`. */
export function ReportProgress({ previewText, speakerName, speakerColor }: ReportProgressProps) {
  const badge = "报告生成中·尚未保存";
  return (
    <div
      data-testid="report-progress"
      aria-label={badge}
      className="mx-auto w-full max-w-3xl px-6 py-4"
    >
      {previewText.length > 0 ? (
        <MessageBubble
          name={speakerName}
          color={speakerColor}
          content={previewText}
          badge={badge}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2 py-2 text-sm text-muted">
          <span aria-hidden="true">⟳</span>
          <span>{speakerName} 正在生成决策报告…</span>
          <span className="rounded border border-info bg-info/10 px-2 py-0.5 text-xs text-info">
            {badge}
          </span>
        </div>
      )}
    </div>
  );
}

interface ReportFailureBannerProps {
  /** The newest terminal-failure report execution (failed/interrupted/discarded). */
  execution: ModelExecution;
  onRetry: () => void;
  retryPending: boolean;
  retryDisabled: boolean;
  disabledHint?: string;
}

export function ReportFailureBanner({
  execution,
  onRetry,
  retryPending,
  retryDisabled,
  disabledHint,
}: ReportFailureBannerProps) {
  const code = execution.error?.code ?? "执行失败";
  const message = execution.error?.message ?? null;
  return (
    <div
      data-testid="report-failure"
      className="mx-auto w-full max-w-3xl rounded border border-error bg-error/10 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-error">报告生成失败</span>
          {/* Untrusted detail rendered as plain text (SafeMarkdown/ExecutionFailureRecord discipline). */}
          <span className="text-xs text-error">{code}</span>
          {message ? <span className="text-xs text-muted">{message}</span> : null}
        </div>
        <Button
          variant="ghost"
          onClick={onRetry}
          disabled={retryDisabled || retryPending}
          title={retryDisabled ? disabledHint : undefined}
        >
          {retryPending ? "正在重试…" : "重试生成报告"}
        </Button>
      </div>
    </div>
  );
}
