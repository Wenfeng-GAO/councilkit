import { AttemptLiveTranscript } from "@/components/report/AttemptLiveTranscript";
import { type LiveEventSpan, displayLastActivity } from "@/lib/live-transcript";
import { formatAttemptMs } from "@/lib/seat-inspector";
import type { CliRunSummaryDto } from "@shared/runtime/schemas";
import { useEffect, useRef, useState } from "react";
import "@/styles/report.css";

type AttemptRow = NonNullable<CliRunSummaryDto["progress"]>["attempts"][number];

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

const ATTEMPT_LABEL = {
  pending: "等待",
  queued: "排队",
  running: "进行中",
  success: "完成",
  failure: "失败",
  cancelled: "已取消",
} as const;

export function SeatInspector({
  open,
  onClose,
  runId,
  attempts,
  selectedId,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  runId: string;
  attempts: readonly AttemptRow[];
  selectedId: string | null;
  onSelect: (attemptId: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selected = attempts.find((row) => row.attemptId === selectedId) ?? attempts[0] ?? null;
  const [span, setSpan] = useState<LiveEventSpan | null>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? dialog).focus();
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const dialog = dialogRef.current;
        const body = dialog?.querySelector(".ck-inspector-body");
        const target = event.target;
        if (
          attempts.length < 2 ||
          selected === null ||
          (body instanceof HTMLElement && target instanceof Node && body.contains(target))
        ) {
          return;
        }
        event.preventDefault();
        const index = attempts.findIndex((row) => row.attemptId === selected.attemptId);
        if (index < 0) return;
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const next = attempts[(index + delta + attempts.length) % attempts.length];
        if (next) onSelect(next.attemptId);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, attempts, selected, onSelect]);

  useEffect(() => {
    if (!open || selectedId === null) return;
    const dialog = dialogRef.current;
    const tab = dialog?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    tab?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [open, selectedId]);

  if (!open || selected === null) return null;

  return (
    <div className="ck-inspector">
      <button
        type="button"
        className="ck-inspector-scrim"
        aria-label="关闭过程"
        onClick={onClose}
      />
      <dialog
        ref={dialogRef}
        open
        aria-modal="true"
        aria-labelledby="ck-inspector-title"
        tabIndex={-1}
        className="ck-inspector-panel"
      >
        <header className="ck-inspector-head">
          <div className="min-w-0 flex-1">
            <p
              id="ck-inspector-title"
              className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass"
            >
              过程
            </p>
            <h2 className="mt-1 truncate font-display text-xl text-parchment">
              {inspectorSeatLabel(selected, attempts)}
              {selected.role === "aggregator" ? " " : null}
              {selected.role === "aggregator" ? (
                <span className="ml-2 font-command text-[0.62rem] text-brass">Aggregator</span>
              ) : null}
            </h2>
            <p className="mt-1 truncate font-command text-[0.68rem] text-muted">
              {selected.driverId}/{selected.modelId}
            </p>
            <p className="mt-2 font-command text-[0.68rem] text-muted">
              <span className={statusClass(selected.status)}>{ATTEMPT_LABEL[selected.status]}</span>
              {inspectorDuration(selected.durationMs, span) ? (
                <>
                  <span className="mx-1.5 text-edge">·</span>
                  {inspectorDuration(selected.durationMs, span)}
                </>
              ) : null}
            </p>
            {selected.status === "running" && displayLastActivity(selected.lastActivity) ? (
              <p className="mt-1 truncate font-command text-[0.68rem] text-muted">
                {displayLastActivity(selected.lastActivity)}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 font-command text-[0.72rem] text-muted hover:text-fg"
          >
            关闭
          </button>
        </header>
        {attempts.length > 1 ? (
          <div className="ck-inspector-tabs" role="tablist" aria-label="席位">
            {attempts.map((row) => (
              <button
                key={row.attemptId}
                type="button"
                role="tab"
                aria-selected={row.attemptId === selected.attemptId}
                className="ck-inspector-tab"
                title={
                  row.role === "aggregator"
                    ? `${row.agentName} · Aggregator`
                    : inspectorSeatLabel(row, attempts)
                }
                onClick={() => onSelect(row.attemptId)}
              >
                {row.status === "running" ? <span className="ck-live-dot" aria-hidden /> : null}
                <span className="truncate">
                  {row.role === "aggregator"
                    ? `${row.agentName} · 汇总`
                    : inspectorSeatLabel(row, attempts)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <AttemptLiveTranscript
          key={selected.attemptId}
          runId={runId}
          attemptId={selected.attemptId}
          active={selected.status === "running"}
          collapseDeliverable
          className="ck-inspector-body"
          onTimeline={setSpan}
        />
      </dialog>
    </div>
  );
}

function statusClass(status: AttemptRow["status"]): string {
  if (status === "success") return "text-success";
  if (status === "failure") return "text-error";
  if (status === "running") return "text-info";
  return "text-muted";
}

function inspectorSeatLabel(row: AttemptRow, attempts: readonly AttemptRow[]): string {
  const dup = attempts.filter((item) => item.agentName === row.agentName).length > 1;
  return dup ? `${row.agentName} · ${row.attemptId}` : row.agentName;
}

function inspectorDuration(receiptMs: number | null, span: LiveEventSpan | null): string | null {
  if (span?.hasTimeline && span.spanMs !== null) return formatAttemptMs(span.spanMs);
  if (receiptMs === null) return null;
  if (span && span.eventCount > 0 && !span.hasTimeline) {
    return `${formatAttemptMs(receiptMs)} · 过程无时间轴`;
  }
  return formatAttemptMs(receiptMs);
}
