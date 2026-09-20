import { displayLastActivity } from "@/lib/live-transcript";
import { formatAttemptMs } from "@/lib/seat-inspector";
import { reviewSeatIdentity, reviewSeatTabLabel, reviewSeatTitle } from "@/lib/seat-label";
import { squadRoleName } from "@/lib/squad-workspace";
import type { CliRunDetailResponse, CliRunSummaryDto } from "@shared/runtime/schemas";
import { useEffect, useState } from "react";

type AttemptRow = NonNullable<CliRunSummaryDto["progress"]>["attempts"][number];

const ATTEMPT_LABEL = {
  pending: "等待",
  queued: "排队",
  running: "进行中",
  success: "执行完成",
  failure: "失败",
  cancelled: "已取消",
} as const;

export function LiveReviewProgress({
  run,
  onInspect,
}: {
  run:
    | Pick<CliRunSummaryDto, "runId" | "kind" | "status" | "startedAt" | "endedAt" | "progress">
    | CliRunDetailResponse;
  onInspect: (attemptId: string) => void;
}) {
  const progress = run.progress;
  const startedAt = run.startedAt;
  const elapsed = useElapsed(startedAt, run.status === "running", run.endedAt);
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
  if (run.kind === "squad") {
    const priority = (row: AttemptRow) =>
      row.status === "running" ? 0 : row.status === "failure" ? 1 : 2;
    const ordered = [...progress.attempts].sort((a, b) => priority(a) - priority(b));
    return (
      <section className="ck-squad-seats" aria-labelledby="squad-seats-title">
        <div className="ck-squad-section-head">
          <h2 id="squad-seats-title">席位与实时过程</h2>
          <p>
            {done} / {progress.attempts.length} 已结束{elapsed ? ` · 总历时 ${elapsed}` : ""}
          </p>
        </div>
        {ordered.length === 0 ? (
          <p className="text-sm text-muted">等待编排者启动席位。</p>
        ) : (
          <ul className="ck-squad-seat-grid">
            {ordered.map((attempt) => (
              <li key={attempt.attemptId}>
                <button
                  type="button"
                  className="ck-squad-seat"
                  data-status={attempt.status}
                  onClick={() => onInspect(attempt.attemptId)}
                  aria-haspopup="dialog"
                  aria-label={`查看过程：${seatLabel(attempt, duplicateNames)}`}
                >
                  <span className="ck-squad-seat-top">
                    <span className="ck-squad-seat-role">{squadRoleName(attempt.agentName)}</span>
                    <span
                      className={
                        attempt.status === "success" ? "text-muted" : statusClass(attempt.status)
                      }
                    >
                      {attempt.status === "running" ? (
                        <i className="ck-live-dot" aria-hidden />
                      ) : null}
                      {attempt.status === "success" ? "执行结束" : ATTEMPT_LABEL[attempt.status]}
                    </span>
                  </span>
                  <span className="ck-squad-seat-model">
                    {attempt.driverId === "host" ? "Host" : attempt.driverId}
                    {attempt.modelId && attempt.modelId !== "-" && attempt.modelId !== "current"
                      ? ` / ${attempt.modelId}`
                      : attempt.driverId !== "host"
                        ? " · 模型待回执"
                        : ""}
                    {duplicateNames.has(attempt.agentName) ? ` · ${attempt.attemptId}` : ""}
                  </span>
                  <span
                    className="ck-squad-seat-activity"
                    title={displayLastActivity(attempt.lastActivity) ?? undefined}
                  >
                    {displayLastActivity(attempt.lastActivity) ??
                      (attempt.status === "running"
                        ? "等待新的过程记录…"
                        : attempt.status === "success"
                          ? "执行已结束，可查看原始记录"
                          : "打开过程查看详情")}
                  </span>
                  <span className="ck-squad-seat-bottom">
                    <span>
                      {attempt.durationMs !== null
                        ? `记录 ${formatAttemptMs(attempt.durationMs)}`
                        : "尚无时长记录"}
                    </span>
                    <span>查看过程 ↗</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="ck-squad-timing-note">
          总历时包含编排等待；席位记录时长可能仅覆盖可见事件，不作为提速依据。
        </p>
      </section>
    );
  }
  const seats = progress.attempts.filter((row) => row.role === "attempt");
  const aggregators = progress.attempts.filter((row) => row.role === "aggregator");
  const ended = seats.filter((row) => isEndedAttempt(row.status)).length;
  const failed = seats.filter((row) => row.status === "failure").length;
  const running = seats.filter((row) => row.status === "running").length;
  const ideateGroups = run.kind === "ideate" ? groupIdeateSeats(seats) : null;
  const compact =
    running === 0 && seats.every((row) => isEndedAttempt(row.status) || row.status === "pending");
  const aggregatorDone = aggregators.some((row) => row.status === "success");
  return (
    <section className="ck-review-live" aria-labelledby="review-progress-title">
      <div className="ck-review-progress-head">
        <div>
          <p className="ck-review-eyebrow">审查席位</p>
          <h2 id="review-progress-title">本轮审查结果</h2>
        </div>
        <p className="ck-review-elapsed">{elapsed ? `总历时 ${elapsed}` : "等待启动"}</p>
      </div>
      <div className="ck-review-progress-summary">
        <p>
          <strong>
            {ended} / {seats.length}
          </strong>{" "}
          {run.kind === "ideate" ? "讨论席位已结束" : "审查席位已结束"}
        </p>
        <p>
          {running > 0 ? `${running} 席进行中` : ""}
          {failed > 0 ? ` · ${failed} 席失败` : ""}
        </p>
      </div>
      <progress
        className="ck-review-meter"
        aria-label="审查席位完成进度"
        value={ended}
        max={Math.max(1, seats.length)}
      />
      {failed > 0 ? (
        <p className="ck-review-failure-note">
          {failed} 个席位未成功完成，可打开结果查看记录；最终结论以汇总报告为准。
        </p>
      ) : null}
      {ideateGroups ? (
        <div className="flex flex-col gap-4">
          {ideateGroups.map((group) => (
            <div key={group.title}>
              <h3 className="mb-2 text-sm text-muted">{group.title}</h3>
              <ul className={compact ? "ck-review-seat-list" : "ck-review-seat-grid"}>
                {group.seats.map((attempt) => (
                  <li key={attempt.attemptId}>
                    <ReviewSeat
                      attempt={attempt}
                      siblings={seats}
                      compact={compact}
                      independent={!aggregatorDone}
                      onInspect={onInspect}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <ul className={compact ? "ck-review-seat-list" : "ck-review-seat-grid"}>
          {seats.map((attempt) => (
            <li key={attempt.attemptId}>
              <ReviewSeat
                attempt={attempt}
                siblings={seats}
                compact={compact}
                independent={!aggregatorDone}
                onInspect={onInspect}
              />
            </li>
          ))}
        </ul>
      )}
      {aggregators.length > 0 ? (
        <div className="ck-review-aggregation">
          <div className="ck-review-aggregation-head">
            <h3>
              汇总报告 <span>Aggregator</span>
            </h3>
            <p>收齐席位结果后生成报告</p>
          </div>
          {aggregators.map((attempt) => (
            <ReviewSeat
              key={attempt.attemptId}
              attempt={attempt}
              siblings={aggregators}
              compact={compact}
              independent={false}
              onInspect={onInspect}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function groupIdeateSeats(seats: AttemptRow[]): Array<{ title: string; seats: AttemptRow[] }> {
  const proposals = seats.filter((row) => row.attemptId.startsWith("proposal-"));
  const debates = seats.filter((row) => row.attemptId.startsWith("debate-"));
  const other = seats.filter(
    (row) => !row.attemptId.startsWith("proposal-") && !row.attemptId.startsWith("debate-"),
  );
  const groups: Array<{ title: string; seats: AttemptRow[] }> = [];
  if (proposals.length > 0) groups.push({ title: "提案", seats: proposals });
  const rounds = new Map<number, AttemptRow[]>();
  for (const row of debates) {
    const match = /^debate-r(\d+)-/.exec(row.attemptId);
    const round = match ? Number.parseInt(match[1] ?? "1", 10) : 1;
    const list = rounds.get(round) ?? [];
    list.push(row);
    rounds.set(round, list);
  }
  for (const round of [...rounds.keys()].sort((a, b) => a - b)) {
    groups.push({ title: `第 ${round} 轮辩论`, seats: rounds.get(round) ?? [] });
  }
  if (other.length > 0) groups.push({ title: "其他席位", seats: other });
  return groups;
}

function ReviewSeat({
  attempt,
  siblings,
  compact,
  independent,
  onInspect,
}: {
  attempt: AttemptRow;
  siblings: readonly AttemptRow[];
  compact: boolean;
  independent: boolean;
  onInspect: (attemptId: string) => void;
}) {
  const running = attempt.status === "running";
  const waiting = attempt.status === "pending" || attempt.status === "queued";
  const ended = isEndedAttempt(attempt.status);
  const activity = displayLastActivity(attempt.lastActivity);
  const title = reviewSeatTabLabel(attempt, siblings, attempt.attemptId);
  const inspectLabel = running ? "过程进行中" : ended ? "查看结果" : "查看过程";
  return (
    <button
      type="button"
      className={compact ? "ck-review-seat ck-review-seat-compact" : "ck-review-seat"}
      data-status={attempt.status}
      aria-haspopup="dialog"
      aria-label={`${inspectLabel}：${title}`}
      onClick={() => onInspect(attempt.attemptId)}
    >
      <span className="ck-review-seat-top">
        <strong>{reviewSeatTitle(attempt)}</strong>
        <span className={statusClass(attempt.status)}>
          {running ? <i className="ck-live-dot" aria-hidden /> : null}
          {ATTEMPT_LABEL[attempt.status]}
        </span>
      </span>
      {compact ? null : <span className="ck-review-seat-model">{attempt.modelId}</span>}
      {compact ? null : (
        <span className="ck-review-seat-identity">{reviewSeatIdentity(attempt)}</span>
      )}
      <span className="ck-review-seat-activity" title={activity ?? undefined}>
        {running
          ? (activity ?? "等待新的过程记录…")
          : attempt.status === "success"
            ? seatResultLine(attempt, independent && attempt.role === "attempt")
            : attempt.status === "failure"
              ? "执行失败，打开结果查看详情"
              : waiting
                ? attempt.role === "aggregator"
                  ? "等待审查席位结束"
                  : "等待执行"
                : "执行已取消"}
      </span>
      <span className="ck-review-seat-bottom">
        <span>
          {attempt.durationMs !== null ? `执行 ${formatAttemptMs(attempt.durationMs)}` : "尚未启动"}
        </span>
        <span>{running ? "查看实时过程" : ended ? "查看结果" : "查看过程"} ↗</span>
      </span>
    </button>
  );
}

function seatResultLine(attempt: AttemptRow, independent: boolean): string {
  const prefix = independent ? "独立意见 · " : "";
  const result = attempt.result;
  if (result?.parseStatus === "parsed") {
    if (result.findingCount === 0) return `${prefix}未列出发现`;
    return `${prefix}${result.findingCount} 项发现`;
  }
  return `${prefix}结果待解析`;
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

function statusClass(status: AttemptRow["status"]): string {
  if (status === "success") return "text-success";
  if (status === "failure") return "text-error";
  if (status === "running") return "text-info";
  if (status === "cancelled") return "text-muted";
  return "text-muted";
}

function useElapsed(
  startedAt: string | null,
  live: boolean,
  endedAt: string | null,
): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || !startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live, startedAt]);
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return null;
  const end = live ? now : endedAt ? Date.parse(endedAt) : Number.NaN;
  if (!Number.isFinite(end)) return null;
  return formatAttemptMs(Math.max(0, end - start));
}
