import "@/styles/reports-workspace.css";
import { PrCaseSummary } from "@/components/report/PrCaseSummary";
import { StartIdeateForm } from "@/components/report/StartIdeateForm";
import { StartReviewForm } from "@/components/report/StartReviewForm";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusPill } from "@/components/shared/StatusPill";
import { TextInput } from "@/components/ui/TextInput";
import { cliRunNeedsPoll, cliRunStatusPill } from "@/lib/cli-run-status";
import { HOST_DOWN_HINT, HOST_DOWN_TITLE, isHostUnreachableError } from "@/lib/host-status";
import { groupCliRuns } from "@/lib/report-groups";
import { getAppRuntime } from "@/runtime/bootstrap";
import type { CliRunSummaryDto } from "@shared/runtime/schemas";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

const KIND_LABEL: Record<CliRunSummaryDto["kind"], string> = {
  review: "审查",
  discuss: "讨论",
  squad: "工程班",
  ideate: "创意",
  unknown: "Run",
};

export function ReportsPage() {
  const { client } = getAppRuntime();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const query = useQuery({
    queryKey: ["cli-runs"],
    queryFn: () => client.listCliRuns(),
    retry: false,
    refetchInterval: (current) =>
      current.state.data?.runs.some((run) => cliRunNeedsPoll(run.status, run.pipeline))
        ? 2000
        : false,
  });

  const runs = query.data?.runs ?? [];
  const filters = [
    { id: "all", label: "全部报告", count: runs.length },
    { id: "review", label: "PR 审查", count: runs.filter((run) => run.kind === "review").length },
    { id: "ideate", label: "创意", count: runs.filter((run) => run.kind === "ideate").length },
    { id: "squad", label: "工程班", count: runs.filter((run) => run.kind === "squad").length },
    { id: "discuss", label: "讨论", count: runs.filter((run) => run.kind === "discuss").length },
    {
      id: "active",
      label: "进行中",
      count: runs.filter((run) => cliRunNeedsPoll(run.status, run.pipeline)).length,
    },
  ];
  const filtered = runs.filter(
    (run) =>
      (filter === "all" ||
        (filter === "active" ? cliRunNeedsPoll(run.status, run.pipeline) : run.kind === filter)) &&
      `${run.title} ${run.runId} ${run.reviewEvidence?.prUrl ?? ""}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const groups = groupCliRuns(filtered);
  const allGroups = new Map(groupCliRuns(runs).map((group) => [group.key, group.runs]));

  return (
    <div className="ck-reports-workspace">
      <header className="ck-reports-header">
        <div>
          <p className="ck-eyebrow">COUNCILKIT / WORKSPACE</p>
          <h1>审查与报告</h1>
          <p className="ck-reports-description">发起一次审查或产品创意讨论，或接着上次的结论继续。</p>
        </div>
        <a className="ck-header-link" href="#report-library">
          浏览报告 <span aria-hidden="true">↓</span>
        </a>
      </header>
      <div className="flex flex-col gap-6">
        <StartReviewForm />
        <StartIdeateForm />
      </div>
      <section
        id="report-library"
        aria-labelledby="report-library-heading"
        className="ck-report-library"
      >
        <div className="ck-library-heading">
          <div>
            <p className="ck-eyebrow">REPORT LIBRARY</p>
            <h2 id="report-library-heading">
              报告记录 <span>{runs.length}</span>
            </h2>
          </div>
          <button
            type="button"
            className="ck-text-button"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "更新中…" : "刷新报告"}
          </button>
        </div>
        <div className="ck-library-toolbar">
          <div className="ck-library-filters" aria-label="报告类型">
            {filters.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                <span>{item.count}</span>
              </button>
            ))}
          </div>
          <TextInput
            id="report-search"
            aria-label="搜索报告"
            type="search"
            placeholder="搜索项目、PR 或 Run ID"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {query.isPending ? <p className="text-sm text-muted">正在读取报告…</p> : null}
        {query.isError ? (
          <EmptyState
            title={isHostUnreachableError(query.error) ? HOST_DOWN_TITLE : "无法读取 CLI 报告"}
            hint={
              isHostUnreachableError(query.error)
                ? HOST_DOWN_HINT
                : "确认 Runtime Host 在线，且本机有 CLI runs。"
            }
          />
        ) : null}
        {query.isSuccess && query.data.runs.length === 0 ? (
          <EmptyState
            title="第一份报告，从一个 PR 开始"
            hint="在上方粘贴 PR 链接，选择模型即可开始。"
          />
        ) : null}
        {query.isSuccess && runs.length > 0 && groups.length === 0 ? (
          <EmptyState title="没有找到匹配报告" hint="试试其他关键词，或切换报告类型。" />
        ) : null}
        {query.isSuccess && groups.length > 0 ? (
          <div className="ck-report-groups">
            {groups.map((group) => (
              <section key={group.key} className="ck-report-group">
                <div className="ck-group-heading">
                  <h3 title={group.label}>{readableGroupTitle(group.label)}</h3>
                  <span>{group.runs.length} 份报告</span>
                </div>
                <PrCaseSummary runs={allGroups.get(group.key) ?? group.runs} />
                <ul className="ck-run-list">
                  {(expanded.has(group.key) ? group.runs : group.runs.slice(0, 3)).map((run) => (
                    <li key={run.runId}>
                      <RunRow run={run} />
                    </li>
                  ))}
                </ul>
                {group.runs.length > 3 ? (
                  <button
                    type="button"
                    className="ck-show-history"
                    aria-expanded={expanded.has(group.key)}
                    onClick={() =>
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                  >
                    {expanded.has(group.key)
                      ? "收起历史"
                      : `展开其余 ${group.runs.length - 3} 份报告`}{" "}
                    <span aria-hidden="true">{expanded.has(group.key) ? "−" : "+"}</span>
                  </button>
                ) : null}
              </section>
            ))}
          </div>
        ) : null}
      </section>
      <footer className="ck-reports-footnote">本机报告 · 数据保存在本地，运行中自动更新</footer>
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
  if (phase === "proposing") return " · 独立提案";
  if (phase === "debating") return " · 交叉辩论";
  if (phase === "aggregating" || phase === "plan-aggregating") return " · 正在汇总";
  if (phase === "planning") return " · 起草方案";
  if (phase === "plan-review") return " · 方案陪审";
  if (phase === "applying") return " · 落地中";
  if (phase === "re-reviewing") return " · 复审中";
  return "";
}

function RunRow({ run }: { run: CliRunSummaryDto }) {
  const pill = cliRunStatusPill(run.kind, run.status);
  return (
    <Link to={`/reports/${run.runId}`} className="ck-run-row">
      <div className="ck-run-row-top">
        <p className="truncate text-sm font-medium text-fg">{readableGroupTitle(run.title)}</p>
        <div className="ck-run-status">
          <StatusPill tone="muted" text={KIND_LABEL[run.kind]} />
          <StatusPill tone={pill.tone} text={pill.text} />
          {run.pipeline && run.pipeline.phase !== "done" ? (
            <StatusPill tone="info" text="修复中" />
          ) : null}
          {run.pipeline?.applyStatus === "failure" ? (
            <StatusPill tone="error" text="修复失败" />
          ) : null}
          {run.kind === "ideate" && run.ideateIntegrity?.incomplete ? (
            <StatusPill tone="warn" text="降级" />
          ) : null}
        </div>
      </div>
      <div className="ck-run-meta">
        <code title={run.runId}>{run.runId}</code>
        {run.startedAt ? (
          <time dateTime={run.startedAt}>
            {new Date(run.startedAt).toLocaleString("zh-CN", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        ) : null}
      </div>
      {(run.status === "running" || run.status === "awaiting_orchestrator") && run.progress ? (
        <p className="mt-2 text-xs text-info">
          {
            run.progress.attempts.filter(
              (row) =>
                row.status === "success" || row.status === "failure" || row.status === "cancelled",
            ).length
          }
          /{run.progress.attempts.length} 席位已结束
          {run.status === "awaiting_orchestrator" ? " · 等待编排" : runningPhaseHint(run)}
        </p>
      ) : null}
    </Link>
  );
}

function readableGroupTitle(label: string): string {
  try {
    const url = new URL(label);
    const match = /^(.*)\/(?:pull|pull_requests)\/(\d+)\/?$/.exec(url.pathname);
    if (match) return `${match[1]?.replace(/^\//, "")}  #${match[2]}`;
  } catch {
    /* Non-URL task titles stay as supplied. */
  }
  return label;
}
