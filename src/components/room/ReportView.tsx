import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { MessageBubble } from "@/components/message/MessageBubble";
import { Button } from "@/components/ui/Button";
import type { DecisionReport } from "@/models/discussion/entities";
import type { ModelExecution } from "@/models/discussion/model-execution";
import { isOneShotDriver } from "@shared/runtime/generation-timeouts";
import {
  isReportInterruptionCode,
  oneShotGeneratingNote,
  reportInterruptionCopy,
} from "@shared/runtime/interruption-copy";
import { clipUtf16 } from "@shared/text/clip-utf16";
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
  const base = collapsed.length === 0 ? "room" : clipUtf16(collapsed, 50);
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
  /** Reporter seat's driver: one-shot tools get the grey 「一次性给出」 line. */
  driverId?: string | null;
  /** The Host's one-shot limit (health), when known. */
  oneshotLimitMs?: number | null;
}

/** The concluding-state streaming card. Mirrors DiscussionStream's
 * `ActivePreview` two-state shape (preview text → bubble; empty → spinner
 * line + info badge), but reads its preview from `previewByExecution` for the
 * report execution which never owns `round.activeExecutionId`. */
export function ReportProgress({
  previewText,
  speakerName,
  speakerColor,
  driverId,
  oneshotLimitMs,
}: ReportProgressProps) {
  const badge = "报告生成中·尚未保存";
  const oneShotNote = isOneShotDriver(driverId)
    ? oneShotGeneratingNote(driverId, oneshotLimitMs ?? undefined)
    : null;
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
      {oneShotNote ? (
        <p data-testid="report-oneshot-note" className="mt-1 text-xs text-muted">
          {oneShotNote}
        </p>
      ) : null}
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
  /** Reporter seat's driver, for the tool name in 「详情」. */
  driverId?: string | null;
}

export interface ReportFailureCopy {
  title: string;
  action: string;
  /** Small print under the button; null when retrying is not a new model call. */
  note: string | null;
  /** True when the run was cut off: regenerating is then the room's main action. */
  interrupted: boolean;
  /** Chinese explanation shown in 「详情」 instead of the raw Host message, if known. */
  detail: string | null;
}

/** B4-05: designer-approved copy (shared with the CLI). Codes that mean "the
 * report run was cut off" (tab closed, Host restarted, no output, one-shot not
 * finished, model process exited) get the interrupted card; the raw code only
 * appears as small print in 「详情」, never as the headline. `driverId` is the
 * reporter seat's driver when the error itself does not carry one. */
export function reportFailureCopy(
  execution: ModelExecution,
  driverId?: string | null,
): ReportFailureCopy {
  const code = execution.error?.code ?? "";
  const interrupted = execution.state === "interrupted" || isReportInterruptionCode(code);
  if (interrupted) {
    const copy =
      reportInterruptionCopy({
        code,
        driverId: execution.error?.driverId ?? driverId ?? null,
        limitMs: execution.error?.limitMs ?? null,
      }) ?? reportInterruptionCopy({ code: "INTERRUPTED_UNKNOWN" });
    return {
      title: copy?.title ?? "",
      action: "重新生成报告",
      note: "将重新调用模型",
      interrupted: true,
      detail: copy?.detail ?? null,
    };
  }
  return {
    title: "报告生成失败",
    action: "重试生成报告",
    note: "将重新调用模型",
    interrupted: false,
    detail: null,
  };
}

export function ReportFailureBanner({
  execution,
  onRetry,
  retryPending,
  retryDisabled,
  disabledHint,
  driverId,
}: ReportFailureBannerProps) {
  const copy = reportFailureCopy(execution, driverId);
  const code = execution.error?.code ?? null;
  const message = copy.detail ?? execution.error?.message ?? null;
  return (
    <div
      data-testid="report-failure"
      className="mx-auto w-full max-w-3xl rounded border border-error bg-error/10 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-error">{copy.title}</span>
          {code || message ? (
            <details className="text-xs text-muted" data-testid="report-failure-detail">
              <summary className="cursor-pointer select-none">详情</summary>
              {/* Untrusted detail rendered as plain text (SafeMarkdown/ExecutionFailureRecord discipline). */}
              {message ? <span className="block">{message}</span> : null}
              {code ? <span className="block font-mono text-[10px] opacity-80">{code}</span> : null}
            </details>
          ) : null}
        </div>
        {/* At 390 the button wraps under the title: the small print lines up
            with the button's left edge there, its right edge on wide screens. */}
        <div className="flex flex-col items-start gap-0.5 sm:items-end">
          <Button
            variant={copy.interrupted ? "primary" : "ghost"}
            onClick={onRetry}
            disabled={retryDisabled || retryPending}
            title={retryDisabled ? disabledHint : undefined}
          >
            {retryPending ? "正在重试…" : copy.action}
          </Button>
          {copy.note ? <span className="text-xs text-muted">{copy.note}</span> : null}
        </div>
      </div>
    </div>
  );
}
