import { AttemptLiveTranscript } from "@/components/report/AttemptLiveTranscript";
import { formatAttemptMs } from "@/lib/seat-inspector";
import type { CliRunSummaryDto } from "@shared/runtime/schemas";
import { useEffect, useRef } from "react";
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
              {selected.agentName}
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
              {selected.durationMs !== null ? (
                <>
                  <span className="mx-1.5 text-edge">·</span>
                  {formatAttemptMs(selected.durationMs)}
                </>
              ) : null}
            </p>
            {selected.status === "running" && selected.lastActivity ? (
              <p className="mt-1 truncate font-command text-[0.68rem] text-muted">
                {selected.lastActivity}
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
                title={row.role === "aggregator" ? `${row.agentName} · Aggregator` : row.agentName}
                onClick={() => onSelect(row.attemptId)}
              >
                {row.status === "running" ? <span className="ck-live-dot" aria-hidden /> : null}
                <span className="truncate">
                  {row.role === "aggregator" ? `${row.agentName} · 汇总` : row.agentName}
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
          collapseDeliverable={selected.role === "aggregator"}
          className="ck-inspector-body"
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
