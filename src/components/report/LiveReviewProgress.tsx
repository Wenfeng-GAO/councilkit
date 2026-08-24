import { formatAttemptMs } from "@/lib/seat-inspector";
import type { CliRunDetailResponse, CliRunSummaryDto } from "@shared/runtime/schemas";
import { useEffect, useState } from "react";

type AttemptRow = NonNullable<CliRunSummaryDto["progress"]>["attempts"][number];

const PHASE_LABEL = {
  attempts: "席位审查中",
  aggregating: "正在汇总",
  done: "已结束",
  planning: "正在起草修复方案",
  "plan-review": "方案陪审中",
  "plan-aggregating": "正在汇总方案",
  applying: "正在按方案落地",
  "re-reviewing": "正在复审",
} as const;

const ATTEMPT_LABEL = {
  pending: "等待",
  queued: "排队",
  running: "进行中",
  success: "完成",
  failure: "失败",
} as const;

export function LiveReviewProgress({
  run,
  onInspect,
}: {
  run: Pick<CliRunSummaryDto, "runId" | "status" | "startedAt" | "progress"> | CliRunDetailResponse;
  onInspect: (attemptId: string) => void;
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
              <span className={`font-command text-[0.68rem] ${statusClass(attempt.status)}`}>
                {ATTEMPT_LABEL[attempt.status]}
              </span>
            </div>
            <p className="mt-1 font-command text-[0.68rem] text-muted">
              {attempt.driverId}/{attempt.modelId}
            </p>
            {attempt.durationMs !== null ? (
              <p className="mt-2 text-xs text-muted">{formatAttemptMs(attempt.durationMs)}</p>
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
            <InspectButton attempt={attempt} onInspect={onInspect} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function InspectButton({
  attempt,
  onInspect,
}: {
  attempt: AttemptRow;
  onInspect: (attemptId: string) => void;
}) {
  const running = attempt.status === "running";
  return (
    <button
      type="button"
      className="mt-2 inline-flex items-center gap-1.5 font-command text-[0.68rem] text-brass hover:text-parchment"
      aria-haspopup="dialog"
      aria-label={`${running ? "过程进行中" : "查看过程"}：${attempt.agentName}`}
      onClick={() => onInspect(attempt.attemptId)}
    >
      {running ? <span className="ck-live-dot" aria-hidden /> : null}
      {running ? "过程进行中" : "查看过程"}
    </button>
  );
}

function statusClass(status: AttemptRow["status"]): string {
  if (status === "success") return "text-success";
  if (status === "failure") return "text-error";
  if (status === "running") return "text-info";
  return "text-muted";
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
  return formatAttemptMs(Math.max(0, now - start));
}
