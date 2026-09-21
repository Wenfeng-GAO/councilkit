import { AppShell } from "@/components/layout/AppShell";
import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { FindingLedger } from "@/components/report/FindingLedger";
import { FixPlanDocument, formatCliActionError } from "@/components/report/FixPipeline";
import { IdeateIntegrityCard } from "@/components/report/IdeateIntegrityCard";
import { LiveReviewProgress } from "@/components/report/LiveReviewProgress";
import { PrCaseSummary } from "@/components/report/PrCaseSummary";
import { RepairExportCard } from "@/components/report/RepairExportCard";
import { RepairRunPanel } from "@/components/report/RepairRunPanel";
import { ReviewReportView } from "@/components/report/ReviewReportView";
import { SeatInspector } from "@/components/report/SeatInspector";
import { SquadWorkspace } from "@/components/report/SquadWorkspace";
import { ReviewWorkbench } from "@/components/report/workbench/ReviewWorkbench";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/Button";
import { cliRunNeedsPoll } from "@/lib/cli-run-status";
import { type AgainstLedgerState, againstLedgerFromDetail } from "@/lib/finding-list";
import { buildFixFromReviewPrompt, buildReviewResumeCommand } from "@/lib/fix-prompt";
import { HOST_DOWN_HINT, HOST_DOWN_TITLE, isHostUnreachableError } from "@/lib/host-status";
import { buildPrComment } from "@/lib/report-groups";
import { parseReviewReport } from "@/lib/review-report";
import { getAppRuntime } from "@/runtime/bootstrap";
import { writerRepoFromPrUrl } from "@shared/runtime/pr-url";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import "@/styles/report.css";
import "@/styles/review-live.css";

type CopiedKind = "markdown" | "prompt" | "comment" | "apply" | "resume" | null;

export function ReportDetailPage() {
  const { runId = "" } = useParams();
  const { client } = getAppRuntime();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState<CopiedKind>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"fix" | "re-review" | null>(null);
  const [watchUntil, setWatchUntil] = useState(0);
  const [inspectId, setInspectId] = useState<string | null>(null);
  // 轮询纪律（DELIVERY-PLAN §3.1）：隐藏页面时停轮询，恢复可见时立即续读一次。
  const pageVisibleRef = useRef(typeof document === "undefined" ? true : !document.hidden);
  const [resumeToken, setResumeToken] = useState(0);
  useEffect(() => {
    const sync = () => {
      pageVisibleRef.current = !document.hidden;
      if (!document.hidden) setResumeToken((token) => token + 1);
    };
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  useEffect(() => {
    if (resumeToken === 0 || runId.length === 0) return;
    void queryClient.invalidateQueries({ queryKey: ["cli-runs", runId] });
  }, [resumeToken, runId, queryClient]);
  const query = useQuery({
    queryKey: ["cli-runs", runId],
    queryFn: () => client.getCliRun(runId),
    enabled: runId.length > 0,
    retry: false,
    refetchInterval: (current) => {
      if (!pageVisibleRef.current) return false;
      const live = current.state.data;
      if (live && cliRunNeedsPoll(live.status, live.pipeline, live.kind)) return 2000;
      if (Date.now() < watchUntil) return 2000;
      return false;
    },
  });
  const action = useMutation({
    mutationFn: (kind: "fix" | "re-review") => client.startCliRunAction(runId, kind),
    onMutate: (kind) => {
      setActionError(null);
      setPendingAction(kind);
      setWatchUntil(Date.now() + 5 * 60 * 1000);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["cli-runs"] });
    },
    onError: (error) => {
      setPendingAction(null);
      setActionError(formatCliActionError(error));
    },
    onSettled: () => {
      window.setTimeout(() => setPendingAction(null), 1500);
    },
  });
  const listQuery = useQuery({
    queryKey: ["cli-runs"],
    queryFn: () => client.listCliRuns(),
    enabled: query.data?.kind === "review" || query.data?.kind === "repair",
    retry: false,
  });
  const parsed = useMemo(
    () => (query.data?.markdown ? parseReviewReport(query.data.markdown) : null),
    [query.data?.markdown],
  );
  const againstId =
    query.data?.kind === "review" ? (query.data.reviewEvidence?.againstRunId ?? null) : null;
  const againstQuery = useQuery({
    queryKey: ["cli-runs", againstId],
    queryFn: () => client.getCliRun(againstId ?? ""),
    enabled: Boolean(againstId),
    retry: false,
  });
  const againstState: AgainstLedgerState =
    againstId == null
      ? { status: "none" }
      : againstQuery.isPending
        ? { status: "loading" }
        : againstQuery.isSuccess && againstQuery.data
          ? againstLedgerFromDetail(againstQuery.data)
          : { status: "unavailable" };

  const copyText = async (kind: Exclude<CopiedKind, null>, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  };

  const copyMarkdown = () => {
    if (!query.data) return;
    void copyText("markdown", query.data.markdown);
  };

  const copyFixPrompt = () => {
    if (!query.data) return;
    void copyText(
      "prompt",
      buildFixFromReviewPrompt({
        markdown: query.data.markdown,
        title: query.data.title,
        kind: query.data.kind,
        truncated: query.data.truncated,
        verdict: parsed?.verdict ?? null,
      }),
    );
  };

  const copyComment = () => {
    if (!query.data || !parsed) return;
    void copyText("comment", buildPrComment(query.data.title, parsed));
  };

  const caseRuns = query.data?.reviewEvidence?.prUrl
    ? (listQuery.data?.runs ?? []).filter(
        (row) => row.reviewEvidence?.prUrl === query.data?.reviewEvidence?.prUrl,
      )
    : [];
  const failedSeats =
    query.data?.progress?.attempts.filter(
      (row) => row.role === "attempt" && row.status === "failure",
    ) ?? [];
  const isSquad = query.data?.kind === "squad";
  const isIdeate = query.data?.kind === "ideate";
  const reviewActions = !isSquad && !isIdeate && query.data?.kind !== "repair";
  const profilesQuery = useQuery({
    queryKey: ["cli-repair-profiles", runId],
    queryFn: () => client.listCliRepairProfiles(runId),
    enabled: query.data?.kind === "review",
    retry: false,
  });
  const repairMutation = useMutation({
    mutationFn: async (input: {
      kind: "start" | "stop" | "resume" | "save";
      profile?: string;
      launch?: { name: string; sourceBranch: string; base: string };
    }) => {
      if (input.kind === "save") {
        const prUrl = query.data?.reviewEvidence?.prUrl ?? "";
        const repo = writerRepoFromPrUrl(prUrl);
        if (!prUrl || !repo) {
          throw new Error("这份审查没有可用的 PR 身份，无法保存修复授权。");
        }
        const launch = input.launch;
        if (!launch) throw new Error("缺少启动摘要。");
        const saved = await client.saveCliRepairProfile({
          name: launch.name,
          prUrl,
          repo,
          sourceBranch: launch.sourceBranch,
          base: launch.base,
          capabilities: ["push-source-branch"],
        });
        return client.startCliRepair({ from: runId, profile: saved.name });
      }
      if (input.kind === "start") {
        return client.startCliRepair({ from: runId, profile: input.profile ?? "default" });
      }
      if (input.kind === "stop") return client.stopCliRepair(runId);
      return client.resumeCliRepair(runId);
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["cli-runs"] });
      await queryClient.invalidateQueries({ queryKey: ["cli-repair-profiles"] });
      if ("runId" in result && result.runId !== runId && query.data?.kind === "review") {
        window.location.assign(`/reports/${result.runId}`);
      }
    },
    onError: (error) => {
      setActionError(formatCliActionError(error));
    },
  });
  const reviewId = query.data?.kind === "review" ? query.data.runId : null;
  const activeRepair = reviewId
    ? (listQuery.data?.runs.find(
        (row) => row.kind === "repair" && row.sourceRunId === reviewId && row.status === "running",
      ) ??
      listQuery.data?.runs.find((row) => row.kind === "repair" && row.sourceRunId === reviewId) ??
      null)
    : null;
  const resumeCommand =
    query.data && reviewActions && failedSeats.length > 0 && query.data.status !== "running"
      ? buildReviewResumeCommand(query.data.runId, query.data.title, query.data.markdown)
      : null;
  const showSeats = Boolean(query.data?.progress);

  // kind=review 走固定席位工作台：整页三栏布局，自带全局导航，因此路由不再包 AppShell，
  // 由本页在非 review kind 时自行包壳（见文件底部 return）。
  if (query.data?.kind === "review") {
    const run = query.data;
    return (
      <ReviewWorkbench
        key={`workbench:${run.runId}`}
        run={run}
        parsed={parsed}
        stale={query.isError}
        onRefetch={() => void query.refetch()}
        backTo={{ to: "/reports", label: "返回报告列表" }}
        againstState={againstState}
        repair={{
          profiles: profilesQuery.data?.profiles ?? [],
          activeRepair,
          sourceBranchDefault: profilesQuery.data?.sourceBranchHint ?? "",
          baseDefault: profilesQuery.data?.baseHint ?? "",
          hintSource: profilesQuery.data?.hintSource ?? null,
          bridgeAvailable: profilesQuery.data?.bridgeAvailable ?? false,
          bridgeLoading: profilesQuery.isPending,
          bridgeReason: profilesQuery.data?.bridgeReason ?? null,
          outerUsed: run.outerUsed ?? 0,
          outerMax: run.outerMax ?? 10,
          error:
            actionError ??
            run.lastError ??
            (profilesQuery.isError ? formatCliActionError(profilesQuery.error) : null),
          pending: repairMutation.isPending,
          onStart: (profile) => repairMutation.mutate({ kind: "start", profile }),
          onStop: () => repairMutation.mutate({ kind: "stop" }),
          onResume: () => repairMutation.mutate({ kind: "resume" }),
          onSaveProfile: (launch) => repairMutation.mutate({ kind: "save", launch }),
        }}
        pipeline={{
          busy: action.isPending || pendingAction !== null,
          pendingAction,
          error: actionError,
          followUpRun: run.pipeline?.followUpRunId
            ? (listQuery.data?.runs.find((row) => row.runId === run.pipeline?.followUpRunId) ??
              null)
            : null,
          onFix: () => action.mutate("fix"),
          onReReview: () => action.mutate("re-review"),
        }}
      />
    );
  }

  return (
    <AppShell>
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-8 sm:px-8">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted">
            <Link to={isIdeate ? "/ideate" : "/reports"} className="text-accent hover:underline">
              {isIdeate ? "← 产品创意" : "← CLI 报告"}
            </Link>
          </p>
          {query.data?.markdown ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={copyMarkdown}>
                {copied === "markdown" ? "已复制" : "复制 Markdown"}
              </Button>
              {reviewActions ? (
                <>
                  <Button variant="ghost" onClick={copyComment} disabled={!parsed}>
                    {copied === "comment" ? "已复制评论" : "复制 PR 评论"}
                  </Button>
                  {resumeCommand ? (
                    <Button variant="ghost" onClick={() => void copyText("resume", resumeCommand)}>
                      {copied === "resume" ? "已复制重跑" : "复制重跑失败席"}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void copyText("apply", `councilkit apply --run ${query.data.runId}`)
                    }
                  >
                    {copied === "apply" ? "已复制 apply" : "复制 apply 命令"}
                  </Button>
                  <Button onClick={copyFixPrompt}>
                    {copied === "prompt" ? "已复制 Prompt" : "复制修复 Prompt"}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        {query.isPending ? <p className="text-sm text-muted">正在打开报告…</p> : null}
        {query.isError && !query.data ? (
          <EmptyState
            title={isHostUnreachableError(query.error) ? HOST_DOWN_TITLE : "找不到这份报告"}
            hint={
              isHostUnreachableError(query.error)
                ? HOST_DOWN_HINT
                : "run id 无效，或 report.md 尚未写入。"
            }
          />
        ) : null}
        {query.data ? (
          <>
            {query.isError ? (
              <output className="text-sm text-warn">
                更新失败，当前显示上次成功读取的记录。
                <button
                  type="button"
                  className="ml-2 underline"
                  onClick={() => void query.refetch()}
                >
                  重新读取
                </button>
              </output>
            ) : null}
            {query.data.truncated ? (
              <p className="text-sm text-warn">报告超过 2MB，已截断显示。</p>
            ) : null}
            {query.data.kind === "ideate" && query.data.ideateIntegrity ? (
              <IdeateIntegrityCard integrity={query.data.ideateIntegrity} />
            ) : null}
            <PrCaseSummary runs={caseRuns} />
            {resumeCommand ? (
              <p className="text-sm text-warn">
                {failedSeats.length} 个席位失败。复制「重跑失败席」只重跑失败的
                Attempt，成功席会复用。
              </p>
            ) : null}
            {isSquad ? (
              <SquadWorkspace
                key={`workspace:${query.data.runId}`}
                run={query.data}
                onInspect={setInspectId}
              />
            ) : null}
            {query.data.kind === "repair" ? (
              <RepairRunPanel
                run={query.data}
                profiles={profilesQuery.data?.profiles ?? []}
                sourceBranchDefault={profilesQuery.data?.sourceBranchHint ?? ""}
                baseDefault={profilesQuery.data?.baseHint ?? ""}
                hintSource={profilesQuery.data?.hintSource ?? null}
                activeRepair={activeRepair}
                bridgeAvailable={profilesQuery.data?.bridgeAvailable ?? false}
                bridgeLoading={profilesQuery.isPending}
                bridgeReason={profilesQuery.data?.bridgeReason ?? null}
                outerUsed={query.data.outerUsed ?? 0}
                outerMax={query.data.outerMax ?? 10}
                error={
                  actionError ??
                  query.data.lastError ??
                  (profilesQuery.isError ? formatCliActionError(profilesQuery.error) : null)
                }
                pending={repairMutation.isPending}
                onStart={(profile) => repairMutation.mutate({ kind: "start", profile })}
                onStop={() => repairMutation.mutate({ kind: "stop" })}
                onResume={() => repairMutation.mutate({ kind: "resume" })}
                onSaveProfile={(launch) => repairMutation.mutate({ kind: "save", launch })}
              />
            ) : null}
            {!isSquad && showSeats && query.data.progress ? (
              <LiveReviewProgress run={query.data} onInspect={setInspectId} />
            ) : null}
            <FindingLedger run={query.data} />
            {!isSquad && query.data.planMarkdown.trim().length > 0 ? (
              <FixPlanDocument
                markdown={query.data.planMarkdown}
                truncated={query.data.planTruncated}
              />
            ) : null}
            {isSquad ? null : !query.data.hasReport || query.data.markdown.trim().length === 0 ? (
              query.data.status === "running" ||
              query.data.status === "awaiting_orchestrator" ? null : (
                <EmptyState title="还没有 report.md" hint="这次 run 可能失败在写报告之前。" />
              )
            ) : parsed ? (
              <div id="review-report-body" className="scroll-mt-6">
                <ReviewReportView
                  report={parsed}
                  liveAttempts={query.data.progress?.attempts ?? []}
                  onInspect={setInspectId}
                />
              </div>
            ) : (
              <article
                id="review-report-body"
                className="border border-edge bg-surface px-5 py-5 sm:px-7 sm:py-6"
              >
                <SafeMarkdown variant="document" content={query.data.markdown} />
              </article>
            )}
            {reviewActions && query.data.status !== "running" ? (
              <RepairExportCard key={`repair:${query.data.runId}`} run={query.data} />
            ) : null}
            {query.data.progress ? (
              <SeatInspector
                open={inspectId !== null}
                onClose={() => setInspectId(null)}
                runId={query.data.runId}
                attempts={query.data.progress.attempts}
                selectedId={inspectId}
                onSelect={setInspectId}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
