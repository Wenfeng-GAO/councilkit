import { EmptyState } from "@/components/shared/EmptyState";
import { StatusPill } from "@/components/shared/StatusPill";
import { groupCliRuns } from "@/lib/report-groups";
import { getAppRuntime } from "@/runtime/bootstrap";
import type { CliRunStatusDto, CliRunSummaryDto } from "@shared/runtime/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

const STATUS_PILL: Record<
  CliRunStatusDto,
  { tone: "muted" | "info" | "success" | "error" | "warn"; text: string }
> = {
  completed: { tone: "success", text: "已完成" },
  failed: { tone: "error", text: "失败" },
  interrupted: { tone: "warn", text: "中断" },
  running: { tone: "info", text: "进行中" },
  unknown: { tone: "muted", text: "未知" },
};

const KIND_LABEL: Record<CliRunSummaryDto["kind"], string> = {
  review: "审查",
  discuss: "讨论",
  squad: "工程班",
  unknown: "Run",
};

export function ReportsPage() {
  const { client } = getAppRuntime();
  const query = useQuery({
    queryKey: ["cli-runs"],
    queryFn: () => client.listCliRuns(),
    retry: false,
    refetchInterval: (current) =>
      current.state.data?.runs.some(
        (run) =>
          run.status === "running" || (run.pipeline !== null && run.pipeline.phase !== "done"),
      )
        ? 2000
        : false,
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8 sm:px-8">
      <header>
        <h1 className="text-lg font-semibold text-fg">CLI 报告</h1>
        <p className="mt-1 text-sm text-muted">
          读取本机 CLI 落盘的 report.md（与浏览器讨论房间不互通）。
        </p>
      </header>
      {query.isPending ? <p className="text-sm text-muted">正在读取报告…</p> : null}
      {query.isError ? (
        <EmptyState title="无法读取 CLI 报告" hint="确认 Runtime Host 在线，且本机有 CLI runs。" />
      ) : null}
      {query.isSuccess && query.data.runs.length === 0 ? (
        <EmptyState
          title="还没有 CLI 报告"
          hint="先运行 councilkit init，再 councilkit review <pr-url>。"
        />
      ) : null}
      {query.isSuccess && query.data.runs.length > 0 ? (
        <div className="flex flex-col gap-8">
          {groupCliRuns(query.data.runs).map((group) => (
            <section key={group.key}>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="min-w-0 truncate font-display text-lg text-parchment">
                  {group.label}
                </h2>
                {group.runs.length >= 2 ? (
                  <Link
                    to={`/reports/compare/${group.runs[0].runId}/${group.runs[1].runId}`}
                    className="shrink-0 text-xs text-accent hover:underline"
                  >
                    对比最近两次
                  </Link>
                ) : null}
              </div>
              <ul className="flex flex-col gap-2">
                {group.runs.map((run) => (
                  <li key={run.runId}>
                    <RunRow run={run} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function runningPhaseHint(run: CliRunSummaryDto): string {
  const phase = run.progress?.phase;
  if (run.kind === "squad") {
    switch (phase) {
      case "briefing":
        return " · 简报";
      case "planning":
        return " · 规划";
      case "implementing":
        return " · 实现";
      case "auditing":
        return " · 审计";
      case "snapshotting":
        return " · 快照";
      case "reviewing":
        return " · 评审";
      case "fixing":
        return " · 修复轮";
      case "integrating":
        return " · 集成";
      default:
        return "";
    }
  }
  if (phase === "aggregating" || phase === "plan-aggregating") return " · 正在汇总";
  if (phase === "planning") return " · 起草方案";
  if (phase === "plan-review") return " · 方案陪审";
  if (phase === "applying") return " · 落地中";
  if (phase === "re-reviewing") return " · 复审中";
  return "";
}

function RunRow({ run }: { run: CliRunSummaryDto }) {
  const pill = STATUS_PILL[run.status];
  return (
    <Link
      to={`/reports/${run.runId}`}
      className="block rounded border border-edge bg-surface px-4 py-3 hover:border-accent"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-fg">{run.title}</p>
        <div className="flex items-center gap-1.5">
          <StatusPill tone="muted" text={KIND_LABEL[run.kind]} />
          <StatusPill tone={pill.tone} text={pill.text} />
          {run.pipeline && run.pipeline.phase !== "done" ? (
            <StatusPill tone="info" text="修复中" />
          ) : null}
          {run.pipeline?.applyStatus === "failure" ? (
            <StatusPill tone="error" text="修复失败" />
          ) : null}
        </div>
      </div>
      <p className="mt-1 font-mono text-xs text-muted">{run.runId}</p>
      {run.startedAt ? (
        <p className="text-xs text-muted">{new Date(run.startedAt).toLocaleString()}</p>
      ) : null}
      {run.status === "running" && run.progress ? (
        <p className="mt-2 text-xs text-info">
          {
            run.progress.attempts.filter(
              (row) =>
                row.status === "success" ||
                row.status === "failure" ||
                row.status === "cancelled",
            ).length
          }
          /{run.progress.attempts.length} 席位已结束
          {runningPhaseHint(run)}
        </p>
      ) : null}
    </Link>
  );
}
