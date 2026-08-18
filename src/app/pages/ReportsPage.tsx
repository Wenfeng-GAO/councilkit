import { EmptyState } from "@/components/shared/EmptyState";
import { StatusPill } from "@/components/shared/StatusPill";
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
  unknown: "Run",
};

export function ReportsPage() {
  const { client } = getAppRuntime();
  const query = useQuery({
    queryKey: ["cli-runs"],
    queryFn: () => client.listCliRuns(),
    retry: false,
  });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8">
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
          hint="先运行 councilkit init，再 councilkit review --council pr-jury --pr <url>。"
        />
      ) : null}
      {query.isSuccess ? (
        <ul className="flex flex-col gap-2">
          {query.data.runs.map((run) => (
            <li key={run.runId}>
              <RunRow run={run} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
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
        </div>
      </div>
      <p className="mt-1 font-mono text-xs text-muted">{run.runId}</p>
      {run.startedAt ? (
        <p className="text-xs text-muted">{new Date(run.startedAt).toLocaleString()}</p>
      ) : null}
    </Link>
  );
}
