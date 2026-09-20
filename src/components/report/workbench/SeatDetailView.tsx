import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import { displayLastActivity } from "@/lib/live-transcript";
import { formatAttemptMs } from "@/lib/seat-inspector";
import { reviewSeatTitle } from "@/lib/seat-label";
import { WorkbenchProcessView } from "./WorkbenchProcessView";
import { CircleHelpIcon, Clock3Icon, STATUS_ICONS } from "./icons";
import { seatReportView } from "./seatDetailModel";
import type { SeatViewTab, WorkbenchAttempt } from "./selection";
import { useAttemptResult } from "./useAttemptResult";
import { useWorkbenchProcess } from "./useWorkbenchProcess";

/**
 * 席位详情（B2 三轴状态机 + 过程双 Tab）。
 * 正文只来自 B1 durable result 端点；过程只来自 live sidecar 游标续读；
 * 两轴独立渲染，一条失败不清空另一条。
 */
export function SeatDetailView({
  runId,
  attempt,
  tab,
  onTabChange,
  getScroller,
}: {
  runId: string;
  attempt: WorkbenchAttempt;
  tab: SeatViewTab;
  onTabChange: (tab: SeatViewTab) => void;
  getScroller: () => HTMLElement | null;
}) {
  const { result, retriesExhausted, lastFetchFailed, refetch } = useAttemptResult(runId, attempt);
  const process = useWorkbenchProcess({ runId, attempt, getScroller });

  const view = seatReportView({
    attempt,
    result,
    lastFetchFailed,
    retriesLeft: retriesExhausted ? 0 : 1,
  });

  const StatusIcon = STATUS_ICONS[attempt.status] ?? CircleHelpIcon;
  const statusText =
    view.kind === "failure"
      ? "执行失败"
      : view.kind === "cancelled"
        ? "已取消"
        : (STATUS_TEXT[attempt.status] ?? "状态未知");
  const model = attempt.observedModelId ?? attempt.requestedModelId ?? attempt.modelId;

  return (
    <article className="ck-wb-document">
      <h1>{reviewSeatTitle(attempt)}</h1>
      <p className="ck-wb-report-meta">
        <span className={view.kind === "failure" ? "ck-wb-fail-text" : "ck-wb-done-label"}>
          <StatusIcon
            className={`ck-wb-icon ck-wb-icon-state${attempt.status === "running" ? " ck-wb-running-icon" : ""}`}
          />
          {statusText}
        </span>
        {attempt.durationMs !== null ? (
          <span className="ck-wb-numeric">{formatAttemptMs(attempt.durationMs)}</span>
        ) : null}
        {model ? <span>{model}</span> : null}
      </p>
      {result?.reusedFrom ? (
        <p className="ck-wb-source">复用已有结果 · 来源执行 {result.reusedFrom.executionRef}</p>
      ) : null}
      {tab === "report" ? (
        <section role="tabpanel" id="ck-wb-panel-report" aria-labelledby="ck-wb-tab-report">
          <SeatReportBody
            view={view}
            activity={attempt.lastActivity}
            onViewProcess={() => onTabChange("process")}
            onRefetch={refetch}
          />
        </section>
      ) : (
        <section role="tabpanel" id="ck-wb-panel-process" aria-labelledby="ck-wb-tab-process">
          <WorkbenchProcessView
            state={process}
            getScroller={getScroller}
            onViewReport={() => onTabChange("report")}
          />
        </section>
      )}
    </article>
  );
}

const STATUS_TEXT: Record<WorkbenchAttempt["status"], string> = {
  pending: "等待启动",
  queued: "排队中",
  running: "执行中",
  success: "执行完成",
  failure: "执行失败",
  cancelled: "已取消",
};

function SeatReportBody({
  view,
  activity,
  onViewProcess,
  onRefetch,
}: {
  view: ReturnType<typeof seatReportView>;
  activity: string | null | undefined;
  onViewProcess: () => void;
  onRefetch: () => void;
}) {
  switch (view.kind) {
    case "running": {
      const shown = displayLastActivity(activity);
      return (
        <div className="ck-wb-process-head">
          <p>{shown ? `当前动作：${shown}` : "执行中"}</p>
          <p>
            报告尚未生成。可以
            <button type="button" className="ck-wb-statusbar-action" onClick={onViewProcess}>
              切换到过程
            </button>
            查看已保存记录。
          </p>
        </div>
      );
    }
    case "reading":
      return (
        <p className="ck-wb-source">
          <Clock3Icon className="ck-wb-icon ck-wb-icon-state" />
          正在读取报告…
        </p>
      );
    case "available":
      return (
        <>
          <p className="ck-wb-source">本次执行的报告原文 · 暂无结构化摘要</p>
          <SafeMarkdown variant="document" content={view.markdown} />
          <p className="ck-wb-history-link">
            <button type="button" className="ck-wb-ghost" onClick={onViewProcess}>
              查看历史过程
            </button>
          </p>
        </>
      );
    case "empty":
      return (
        <div className="ck-wb-process-head">
          <p>执行完成 · 暂无结果正文</p>
          <p>
            空输出不等于零发现。可
            <button type="button" className="ck-wb-statusbar-action" onClick={onViewProcess}>
              查看已保存过程
            </button>
            。
          </p>
        </div>
      );
    case "failure":
      return (
        <div className="ck-wb-process-head ck-wb-fail-block">
          <p className="ck-wb-fail-text">执行失败</p>
          <p>已记录原因：{view.message}</p>
          <p>
            过程里的结论文本不构成审查结论。可
            <button type="button" className="ck-wb-statusbar-action" onClick={onViewProcess}>
              查看过程
            </button>
            或复制净化诊断。
          </p>
        </div>
      );
    case "cancelled":
      return (
        <div className="ck-wb-process-head">
          <p>已取消</p>
          <p>
            <button type="button" className="ck-wb-statusbar-action" onClick={onViewProcess}>
              查看过程
            </button>
          </p>
        </div>
      );
    case "unavailable":
      return (
        <output className="ck-wb-notice ck-wb-notice-warn">
          <CircleHelpIcon className="ck-wb-icon ck-wb-icon-state" />
          报告暂时无法读取
          <button type="button" className="ck-wb-statusbar-action" onClick={onRefetch}>
            重新读取
          </button>
        </output>
      );
  }
}
