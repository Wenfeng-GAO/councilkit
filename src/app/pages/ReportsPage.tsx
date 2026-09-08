import "@/styles/reports-workspace.css";
import { PrCaseSummary } from "@/components/report/PrCaseSummary";
import { StartReviewForm } from "@/components/report/StartReviewForm";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusPill } from "@/components/shared/StatusPill";
import { TextInput } from "@/components/ui/TextInput";
import { cliRunNeedsPoll, primaryRunStatus } from "@/lib/cli-run-status";
import { HOST_DOWN_HINT, HOST_DOWN_TITLE, isHostUnreachableError } from "@/lib/host-status";
import {
  caseNeedsAttention,
  groupCliRuns,
  isWorkspaceRun,
  latestRun,
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

type StatusFilter = "attention" | "active" | "done" | "all";
type KindFilter = "all" | "review" | "squad";

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
  const catalog = useMemo(() => groupCliRuns(runs), [runs]);
  const queryText = search.trim().toLowerCase();
  const workspaceCases = catalog.filter((group) => group.runs.some(isWorkspaceRun));
  const ideateCount = runs.filter((run) => run.kind === "ideate").length;
  const filtered = workspaceCases
    .filter((group) => {
      if (kindFilter === "review" && !group.runs.some((run) => run.kind === "review")) return false;
      if (kindFilter === "squad" && !group.runs.some((run) => run.kind === "squad")) return false;
      if (queryText) {
        const blob = `${group.label} ${group.runs.map((run) => `${run.title} ${run.runId} ${run.reviewEvidence?.prUrl ?? ""}`).join(" ")}`;
        return blob.toLowerCase().includes(queryText);
      }
      if (statusFilter === "active") {
        return group.runs.some((run) => cliRunNeedsPoll(run.status, run.pipeline));
      }
      if (statusFilter === "done") {
        return group.runs.every(
          (run) => !cliRunNeedsPoll(run.status, run.pipeline) && run.status !== "failed",
        );
      }
      if (statusFilter === "attention") return caseNeedsAttention(group.runs);
      return true;
    })
    .sort((a, b) => {
      const aActive = a.runs.some((run) => cliRunNeedsPoll(run.status, run.pipeline));
      const bActive = b.runs.some((run) => cliRunNeedsPoll(run.status, run.pipeline));
      if (aActive !== bActive) return aActive ? -1 : 1;
      const aTime = latestRun(a.runs)?.startedAt ?? "";
      const bTime = latestRun(b.runs)?.startedAt ?? "";
      return bTime.localeCompare(aTime);
    });
  const searchedExtra =
    queryText.length > 0
      ? catalog.filter(
          (group) =>
            !group.runs.some(isWorkspaceRun) &&
            `${group.label} ${group.runs.map((run) => `${run.title} ${run.runId}`).join(" ")}`
              .toLowerCase()
              .includes(queryText),
        )
      : [];
  const visible = [...filtered, ...searchedExtra];

  const statusFilters: { id: StatusFilter; label: string; count: number }[] = [
    {
      id: "attention",
      label: "需要处理",
      count: workspaceCases.filter((group) => caseNeedsAttention(group.runs)).length,
    },
    {
      id: "active",
      label: "进行中",
      count: workspaceCases.filter((group) =>
        group.runs.some((run) => cliRunNeedsPoll(run.status, run.pipeline)),
      ).length,
    },
    {
      id: "done",
      label: "已完成",
      count: workspaceCases.filter((group) =>
        group.runs.every(
          (run) => !cliRunNeedsPoll(run.status, run.pipeline) && run.status !== "failed",
        ),
      ).length,
    },
    { id: "all", label: "全部案件", count: workspaceCases.length },
  ];
  const kindFilters: { id: KindFilter; label: string; count: number }[] = [
    { id: "all", label: "审查与工程班", count: workspaceCases.length },
    {
      id: "review",
      label: "审查",
      count: workspaceCases.filter((group) => group.runs.some((run) => run.kind === "review"))
        .length,
    },
    {
      id: "squad",
      label: "工程班",
      count: workspaceCases.filter((group) => group.runs.some((run) => run.kind === "squad"))
        .length,
    },
  ];

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
            案件 <span>{workspaceCases.length}</span>
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
            {visible.map((group) => (
              <CaseCard
                key={group.key}
                groupKey={group.key}
                label={group.label}
                runs={group.runs}
                expanded={expanded.has(group.key)}
                onToggle={() =>
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
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
  groupKey,
  label,
  runs,
  expanded,
  onToggle,
}: {
  groupKey: string;
  label: string;
  runs: readonly CliRunSummaryDto[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const latest = latestRun(runs);
  if (!latest) return null;
  const pill = primaryRunStatus(latest);
  const summary = summarizePrCase(runs);
  const title = readableCaseTitle(label);
  const kinds = [
    runs.some((run) => run.kind === "review") ? "审查" : null,
    runs.some((run) => run.kind === "squad") ? "工程班" : null,
    runs.some((run) => run.kind === "ideate") ? "创意" : null,
    runs.some((run) => run.kind === "discuss") ? "讨论" : null,
  ].filter((item): item is string => item !== null);
  const progress = seatProgress(latest);

  return (
    <article className="ck-case-card">
      <div className="ck-case-card-top">
        <div className="ck-case-card-title">
          <h3 title={label}>
            <Link to={`/reports/${latest.runId}`}>{title}</Link>
          </h3>
          <p className="ck-case-kinds">{kinds.join(" · ")}</p>
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
                <HistoryRow run={run} groupKey={groupKey} />
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
