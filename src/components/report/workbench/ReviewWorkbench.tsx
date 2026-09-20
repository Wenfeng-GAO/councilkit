import type { ParsedReviewReport } from "@/lib/review-report";
import { reviewSeatTitle } from "@/lib/seat-label";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";
import { type Ref, useCallback, useEffect, useRef } from "react";
import { ContextBar } from "./ContextBar";
import { OverviewView } from "./OverviewView";
import { RepairView, type WorkbenchPipelineProps, type WorkbenchRepairProps } from "./RepairView";
import { SeatColumn } from "./SeatColumn";
import { SeatDetailView } from "./SeatDetailView";
import { StatusBar, type WorkbenchBackLink } from "./StatusBar";
import { ViewBar } from "./ViewBar";
import { WorkbenchNav } from "./WorkbenchNav";
import { hostStatusLabel, useWorkbenchHostStatus } from "./host-status";
import { type WorkbenchSelection, defaultSeatTab, useWorkbenchSelection } from "./selection";
import { useAttemptResult } from "./useAttemptResult";
import "@/styles/review-workbench.css";

const ATTEMPT_TERMINAL = new Set(["success", "failure", "cancelled"]);

/**
 * kind=review 报告页的固定席位工作台壳（WORKSPACE-STATES 唯一权威布局）：
 * 184px 全局导航 + 248px 席位列 + 上下文栏/视图栏/状态栏，主内容随唯一
 * selectedAttempt（overview | repair | attemptId）切换。席位详情为 B2 真实内容：
 * 报告轴只读 B1 durable result，过程轴只读 live sidecar 游标，两轴独立。
 */
export function ReviewWorkbench({
  run,
  parsed,
  repair,
  pipeline,
  stale,
  onRefetch,
  backTo,
}: {
  run: CliRunDetailResponse;
  parsed: ParsedReviewReport | null;
  repair: WorkbenchRepairProps;
  pipeline: WorkbenchPipelineProps;
  /** detail 轮询已失败但仍持有上次成功数据时为 true（显示「重新读取」）。 */
  stale: boolean;
  onRefetch: () => void;
  backTo: WorkbenchBackLink;
}) {
  const hostStatus = useWorkbenchHostStatus();
  const { selected, select, tabs, setTab } = useWorkbenchSelection();

  const attempts = run.progress?.attempts ?? [];
  const hasRepair = run.pipeline !== null;
  const seats = attempts.filter((row) => row.role === "attempt");
  const aggregators = attempts.filter((row) => row.role === "aggregator");

  // 选择兜底：repair 仅在真实 pipeline 存在时可选；attemptId 必须在当前 attempts 中，
  // 否则回退总览，不留无效选中态。
  const effectiveSelection: WorkbenchSelection =
    selected === "repair" && !hasRepair
      ? "overview"
      : selected !== "overview" &&
          selected !== "repair" &&
          !attempts.some((row) => row.attemptId === selected)
        ? "overview"
        : selected;

  const selectedAttempt =
    effectiveSelection !== "overview" && effectiveSelection !== "repair"
      ? (attempts.find((row) => row.attemptId === effectiveSelection) ?? null)
      : null;

  const viewTitle =
    effectiveSelection === "overview"
      ? "本轮总览"
      : effectiveSelection === "repair"
        ? "当前修复"
        : selectedAttempt
          ? reviewSeatTitle(selectedAttempt)
          : "本轮总览";

  const runningSeats = seats.filter((row) => !ATTEMPT_TERMINAL.has(row.status)).length;
  const note = stale
    ? "更新失败，显示上次成功记录"
    : runningSeats > 0
      ? `其他 ${runningSeats} 席仍在运行`
      : hostStatusLabel(hostStatus);

  const tab = selectedAttempt
    ? (tabs[selectedAttempt.attemptId] ?? defaultSeatTab(selectedAttempt))
    : "report";

  // 单席复制：报告 Tab 且 durable 正文 available 时复制该席原文，否则退回 run 级汇总。
  const { result: seatResult } = useAttemptResult(run.runId, selectedAttempt);
  const readerRef = useRef<HTMLElement | null>(null);
  const getScroller = useCallback(() => readerRef.current, []);
  const scrollMemoryRef = useRef(new Map<string, number>());
  const viewKey = `${effectiveSelection}:${tab}`;
  const prevViewKeyRef = useRef<string | null>(null);

  // 阅读连续性（当前挂载会话内）：切席/切 Tab 记住滚动位置，切回恢复。
  useEffect(() => {
    const prev = prevViewKeyRef.current;
    if (prev !== null && prev !== viewKey) {
      const el = readerRef.current;
      if (el) scrollMemoryRef.current.set(prev, el.scrollTop);
      const saved = scrollMemoryRef.current.get(viewKey);
      window.requestAnimationFrame(() => {
        if (readerRef.current && saved !== undefined) readerRef.current.scrollTop = saved;
      });
    }
    prevViewKeyRef.current = viewKey;
  }, [viewKey]);

  const copyText = () => {
    if (selectedAttempt && tab === "report") {
      if (seatResult?.availability === "available" && seatResult.markdown?.trim()) {
        return seatResult.markdown;
      }
    }
    if (run.markdown.trim().length === 0) return null;
    return run.markdown;
  };

  return (
    <div className="ck-wb ck-wb-app">
      <WorkbenchNav hostStatus={hostStatus} />
      <ContextBar run={run} hostStatus={hostStatus} />
      <SeatColumn attempts={attempts} hasRepair={hasRepair} />
      <main className="ck-wb-main">
        <ViewBar
          title={viewTitle}
          attempt={selectedAttempt}
          tab={tab}
          onTabChange={(next) => {
            if (selectedAttempt) setTab(selectedAttempt.attemptId, next);
          }}
          mobileSelect={{
            value: effectiveSelection,
            onChange: select,
            seats,
            aggregators,
            hasRepair,
          }}
          getCopyText={copyText}
        />
        <div className="ck-wb-reader" ref={readerRef as Ref<HTMLDivElement>}>
          {effectiveSelection === "overview" ? (
            <OverviewView
              run={run}
              parsed={parsed}
              hasRepair={hasRepair}
              onOpenRepair={() => select("repair")}
            />
          ) : effectiveSelection === "repair" ? (
            <RepairView run={run} repair={repair} pipeline={pipeline} />
          ) : selectedAttempt ? (
            <SeatDetailView
              runId={run.runId}
              attempt={selectedAttempt}
              tab={tab}
              onTabChange={(next) => setTab(selectedAttempt.attemptId, next)}
              getScroller={getScroller}
            />
          ) : null}
        </div>
      </main>
      <StatusBar note={note} onRefetch={stale ? onRefetch : undefined} backTo={backTo} />
    </div>
  );
}
