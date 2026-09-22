import "@/styles/reports-workspace.css";
import { PrCaseSummary } from "@/components/report/PrCaseSummary";
import { StartReviewForm } from "@/components/report/StartReviewForm";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusPill } from "@/components/shared/StatusPill";
import { TextInput } from "@/components/ui/TextInput";
import { cliRunNeedsPoll, primaryRunStatus } from "@/lib/cli-run-status";
import { HOST_DOWN_HINT, HOST_DOWN_TITLE, isHostUnreachableError } from "@/lib/host-status";
import {
  type CaseKindFilter,
  type CaseStatusFilter,
  type CaseView,
  caseMatchesStatusFilter,
  caseViewOf,
  groupCliRuns,
  isWorkspaceRun,
  readableCaseTitle,
  runHistoryLabel,
  seatProgress,
} from "@/lib/report-groups";
import { getAppRuntime } from "@/runtime/bootstrap";
import { summarizePrCase } from "@shared/runtime/review-case";
import type { CliRunSummaryDto } from "@shared/runtime/schemas";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

type StatusFilter = CaseStatusFilter;
type KindFilter = CaseKindFilter;

export function ReportsPage() {
  const { client } = getAppRuntime();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("attention");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
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
  const queryText = search.trim().toLowerCase();
  const workspaceCases = useMemo(() => groupCliRuns(runs.filter(isWorkspaceRun)), [runs]);
  const ideateCount = runs.filter((run) => run.kind === "ideate").length;

  // 案件视图先套类型范围，再由状态/搜索过滤——搜索永远不绕过筛选。
  const scopedViews = useMemo(
    () =>
      workspaceCases
        .map((group) => caseViewOf(group, kindFilter))
        .filter((view): view is CaseView => view !== null),
    [workspaceCases, kindFilter],
  );
  // 搜索先于状态过滤：facet 徽标数与点开后实际可见的卡片数必须一致。
  const searchMatched = useMemo(
    () =>
      scopedViews.filter((view) => queryText.length === 0 || view.searchBlob.includes(queryText)),
    [scopedViews, queryText],
  );
  const visible = searchMatched
    .filter((view) => caseMatchesStatusFilter(view.status, statusFilter))
    .sort((a, b) => {
      if (a.status.active !== b.status.active) return a.status.active ? -1 : 1;
      const aTime = a.representative.startedAt ?? "";
      const bTime = b.representative.startedAt ?? "";
      return bTime.localeCompare(aTime);
    });

  // 状态计数基于搜索+类型范围（忽略当前状态）；类型计数基于搜索+状态范围
  // （忽略当前类型）——搜索任一维度时徽标反映的是“假如点开”的可见数。
  const statusFilters: { id: StatusFilter; label: string; count: number }[] = [
    {
      id: "attention",
      label: "需要处理",
      count: searchMatched.filter((view) => view.status.attention).length,
    },
    {
      id: "active",
      label: "进行中",
      count: searchMatched.filter((view) => view.status.active).length,
    },
    {
      id: "done",
      label: "已完成",
      count: searchMatched.filter((view) => view.status.done).length,
    },
    { id: "all", label: "全部案件", count: searchMatched.length },
  ];
  const kindFilters: { id: KindFilter; label: string; count: number }[] = (
    [
      { id: "all" as const, label: "审查与工程班" },
      { id: "review" as const, label: "审查" },
      { id: "squad" as const, label: "工程班" },
    ] satisfies { id: KindFilter; label: string }[]
  ).map((item) => ({
    ...item,
    count: workspaceCases.filter((group) => {
      const view = caseViewOf(group, item.id);
      return (
        view !== null &&
        (queryText.length === 0 || view.searchBlob.includes(queryText)) &&
        caseMatchesStatusFilter(view.status, statusFilter)
      );
    }).length,
  }));

  return (
    <div className="ck-reports-workspace">
      <header className="ck-reports-header">
        <div>
          <h1>审查与报告</h1>
          <p className="ck-reports-description">发起一次审查，或接着上次的结论继续。</p>
        </div>
      </header>
      <StartReviewForm />
      <section
        id="report-library"
        aria-labelledby="report-library-heading"
        className="ck-report-library"
      >
        <div className="ck-library-heading">
          <h2 id="report-library-heading">
            案件 <span>{`${visible.length} / ${workspaceCases.length}`}</span>
          </h2>
          <button
            type="button"
            className="ck-text-button"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "更新中…" : "刷新"}
          </button>
        </div>
        <div className="ck-library-toolbar">
          <div className="ck-library-filters" aria-label="案件状态">
            {statusFilters.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={statusFilter === item.id}
                onClick={() => setStatusFilter(item.id)}
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
        <div className="ck-library-kinds" aria-label="案件类型">
          {kindFilters.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={kindFilter === item.id}
              onClick={() => setKindFilter(item.id)}
            >
              {item.label}
              <span>{item.count}</span>
            </button>
          ))}
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
        {query.isSuccess && runs.length === 0 ? (
          <EmptyState
            title="第一份报告，从一个 PR 开始"
            hint="在上方粘贴 PR 链接，选择模型即可开始。"
          />
        ) : null}
        {query.isSuccess && runs.length > 0 && visible.length === 0 ? (
          <EmptyState
            title={
              statusFilter === "attention" && !queryText ? "没有需要处理的案件" : "没有找到匹配案件"
            }
            hint={
              statusFilter === "attention" && !queryText
                ? "进行中、失败或未决重大项会列在这里。"
                : "试试其他关键词，或切换案件状态。"
            }
          />
        ) : null}
        {query.isSuccess && visible.length > 0 ? (
          <div className="ck-report-groups">
            {visible.map((view) => (
              <CaseCard
                key={view.key}
                view={view}
                expanded={expanded.has(view.key)}
                onToggle={() =>
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(view.key)) next.delete(view.key);
                    else next.add(view.key);
                    return next;
                  })
                }
              />
            ))}
          </div>
        ) : null}
        {ideateCount > 0 ? (
          <p className="ck-library-aside">
            <Link to="/ideate">另有 {ideateCount} 条创意讨论</Link>
          </p>
        ) : null}
      </section>
      <footer className="ck-reports-footnote">
        本机报告 · 运行完成表示证据已收集；PR 是否可交付仍需核对当前 SHA、重大项和验收
      </footer>
    </div>
  );
}

function CaseCard({
  view,
  expanded,
  onToggle,
}: {
  view: CaseView;
  expanded: boolean;
  onToggle: () => void;
}) {
  const latest = view.representative;
  const runs = view.scopedRuns;
  const pill = primaryRunStatus(latest);
  const summary = summarizePrCase(runs);
  const title = readableCaseTitle(view.label);
  const progress = seatProgress(latest);

  return (
    <article className="ck-case-card">
      <div className="ck-case-card-top">
        <div className="ck-case-card-title">
          <h3 title={view.label}>
            <Link to={`/reports/${latest.runId}`}>{title}</Link>
          </h3>
          <p className="ck-case-kinds">{view.kindLabels.join(" · ")}</p>
        </div>
        <StatusPill tone={pill.tone} text={pill.text} />
      </div>
      {summary.prUrl ? <p className="ck-case-next">下一步：{summary.nextAction}</p> : null}
      <div className="ck-case-meta">
        <span>
          {progress ? `${progress} 席` : `${runs.length} 份记录`}
          {latest.startedAt ? (
            <>
              {" · "}
              <time dateTime={latest.startedAt}>{formatRunTime(latest.startedAt)}</time>
            </>
          ) : null}
        </span>
        <div className="ck-case-actions">
          <Link to={`/reports/${latest.runId}`}>打开</Link>
          {runs.length > 1 ? (
            <button type="button" aria-expanded={expanded} onClick={onToggle}>
              {expanded ? "收起历史" : `历史 ${runs.length - 1}`}
            </button>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <>
          <PrCaseSummary runs={runs} variant="inline" />
          <ul className="ck-run-list">
            {runs.map((run) => (
              <li key={run.runId}>
                <HistoryRow run={run} groupKey={view.key} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </article>
  );
}

function HistoryRow({ run, groupKey }: { run: CliRunSummaryDto; groupKey: string }) {
  const pill = primaryRunStatus(run);
  const progress = seatProgress(run);
  return (
    <Link to={`/reports/${run.runId}`} className="ck-run-row" title={run.runId}>
      <div className="ck-run-row-top">
        <p className="truncate text-sm font-medium text-fg">{runHistoryLabel(run, groupKey)}</p>
        <StatusPill tone={pill.tone} text={pill.text} />
      </div>
      <div className="ck-run-meta">
        <span>{progress ? `${progress} 席` : "\u00a0"}</span>
        {run.startedAt ? (
          <time dateTime={run.startedAt}>{formatRunTime(run.startedAt)}</time>
        ) : null}
      </div>
    </Link>
  );
}

function formatRunTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
