import type { CliRunDetailResponse, CliRunSummaryDto } from "@shared/runtime/schemas";
import { useEffect, useState } from "react";
import { AttemptLiveTranscript } from "./AttemptLiveTranscript";

type AttemptRow = NonNullable<CliRunSummaryDto["progress"]>["attempts"][number];

const PHASE_LABEL = {
  attempts: "席位审查中",
  aggregating: "正在汇总",
  done: "已结束",
} as const;

const ATTEMPT_LABEL = {
  pending: "等待",
  running: "进行中",
  success: "完成",
  failure: "失败",
} as const;

export function LiveReviewProgress({
  run,
}: {
  run: Pick<CliRunSummaryDto, "runId" | "status" | "startedAt" | "progress"> | CliRunDetailResponse;
}) {
  const progress = run.progress;
  const startedAt = run.startedAt;
  const elapsed = useElapsed(startedAt, run.status === "running");
  if (progress === null) {
    return (
      <section className="border border-edge bg-surface px-4 py-4">
        <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">
          {run.status === "running" ? "审查进行中" : "审查"}
        </p>
        {elapsed ? <p className="mt-2 font-command text-sm text-muted">{elapsed}</p> : null}
      </section>
    );
  }

  const done = progress.attempts.filter(
    (row) => row.status === "success" || row.status === "failure",
  ).length;
  return (
    <section className="ck-report mb-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">
            {PHASE_LABEL[progress.phase]}
          </p>
          <p className="mt-1 text-sm text-muted">
            {done}/{progress.attempts.length} 席位已结束
            {elapsed ? ` · ${elapsed}` : ""}
          </p>
        </div>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {progress.attempts.map((attempt) => (
          <li key={attempt.attemptId} className="border border-edge bg-surface px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-fg">
                {attempt.agentName}
                {attempt.role === "aggregator" ? (
                  <span className="ml-2 font-command text-[0.62rem] text-brass">Aggregator</span>
                ) : null}
              </p>
              <span
                className={`font-command text-[0.68rem] ${
                  attempt.status === "success"
                    ? "text-success"
                    : attempt.status === "failure"
                      ? "text-error"
                      : attempt.status === "running"
                        ? "text-info"
                        : "text-muted"
                }`}
              >
                {ATTEMPT_LABEL[attempt.status]}
              </span>
            </div>
            <p className="mt-1 font-command text-[0.68rem] text-muted">
              {attempt.driverId}/{attempt.modelId}
            </p>
            {attempt.durationMs !== null ? (
              <p className="mt-2 text-xs text-muted">{formatMs(attempt.durationMs)}</p>
            ) : attempt.status === "running" ? (
              <p className="mt-2 text-xs text-muted">审查中…</p>
            ) : null}
            {attempt.status === "running" && attempt.lastActivity ? (
              <p
                className="mt-1 truncate font-command text-[0.68rem] text-muted"
                title={attempt.lastActivity}
              >
                {attempt.lastActivity}
              </p>
            ) : null}
            <AttemptProcess runId={run.runId} attempt={attempt} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AttemptProcess({ runId, attempt }: { runId: string; attempt: AttemptRow }) {
  const [open, setOpen] = useState(attempt.status === "running");
  useEffect(() => {
    if (attempt.status === "running") setOpen(true);
  }, [attempt.status]);
  return (
    <details
      className="mt-2"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer font-command text-[0.68rem] text-brass">过程</summary>
      {open ? (
        <AttemptLiveTranscript
          runId={runId}
          attemptId={attempt.attemptId}
          active={attempt.status === "running"}
        />
      ) : null}
    </details>
  );
}

function useElapsed(startedAt: string | null, live: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || !startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live, startedAt]);
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return null;
  return formatMs(Math.max(0, now - start));
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m${String(s).padStart(2, "0")}s`;
}
