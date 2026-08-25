import { cliRunPhaseHeading } from "@/lib/cli-run-status";
import { displayLastActivity } from "@/lib/live-transcript";
import { formatAttemptMs } from "@/lib/seat-inspector";
import type { CliRunDetailResponse, CliRunSummaryDto } from "@shared/runtime/schemas";
import { useEffect, useState } from "react";

type AttemptRow = NonNullable<CliRunSummaryDto["progress"]>["attempts"][number];

const ATTEMPT_LABEL = {
  pending: "等待",
  queued: "排队",
  running: "进行中",
  success: "完成",
  failure: "失败",
  cancelled: "已取消",
} as const;

export function LiveReviewProgress({
  run,
  onInspect,
}: {
  run:
    | Pick<CliRunSummaryDto, "runId" | "kind" | "status" | "startedAt" | "progress">
    | CliRunDetailResponse;
  onInspect: (attemptId: string) => void;
}) {
  const progress = run.progress;
  const startedAt = run.startedAt;
  const elapsed = useElapsed(startedAt, run.status === "running");
  if (progress === null) {
    return (
      <section className="border border-edge bg-surface px-4 py-4">
        <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">
          {run.status === "running"
            ? run.kind === "squad"
              ? "工程班进行中"
              : "审查进行中"
            : run.status === "awaiting_orchestrator"
              ? "等待编排"
              : run.status === "closed" && run.kind === "squad"
                ? "已收工"
                : run.kind === "squad"
                  ? "工程班"
                  : "审查"}
        </p>
        {elapsed ? <p className="mt-2 font-command text-sm text-muted">{elapsed}</p> : null}
      </section>
    );
  }

  const done = progress.attempts.filter((row) => isEndedAttempt(row.status)).length;
  const duplicateNames = namesWithDuplicates(progress.attempts);
  return (
    <section className="ck-report mb-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">
            {cliRunPhaseHeading(run.kind, run.status, progress.phase)}
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
                {seatLabel(attempt, duplicateNames)}
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
              <p className="mt-2 text-xs text-muted">
                {run.kind === "squad" ? "进行中…" : "审查中…"}
              </p>
            ) : null}
            {attempt.status === "running" && displayLastActivity(attempt.lastActivity) ? (
              <p
                className="mt-1 truncate font-command text-[0.68rem] text-muted"
                title={displayLastActivity(attempt.lastActivity) ?? undefined}
              >
                {displayLastActivity(attempt.lastActivity)}
              </p>
            ) : null}
            <InspectButton attempt={attempt} onInspect={onInspect} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function isEndedAttempt(status: AttemptRow["status"]): boolean {
  return status === "success" || status === "failure" || status === "cancelled";
}

function namesWithDuplicates(attempts: readonly AttemptRow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of attempts) {
    counts.set(row.agentName, (counts.get(row.agentName) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
}

function seatLabel(attempt: AttemptRow, duplicateNames: Set<string>): string {
  if (!duplicateNames.has(attempt.agentName)) return attempt.agentName;
  return `${attempt.agentName} · ${attempt.attemptId}`;
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
  if (status === "cancelled") return "text-muted";
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
