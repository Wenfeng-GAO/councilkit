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
import {
  type SeatViewTab,
  type WorkbenchSelection,
  defaultSeatTab,
  useWorkbenchSelection,
} from "./selection";
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
  const { selected, select, tabs, setTab, getOrInitTab } = useWorkbenchSelection();

  const attempts = run.progress?.attempts ?? [];
  // AC-01：kind=review 即可达「当前修复」（沿用旧 reviewActions 语义）——无 pipeline 时
  // RepairView 内的 RepairRunPanel/FixPipeline 提供真实启动能力；入口不是占位。
  const repairAvailable = true;
  // 真实修复证据（内置 pipeline 或独立 Squad 自动修复 Run）；只控制总览内的快捷入口，
  // 不把「尚未启动」藏成没有入口。
  const repairExists = run.pipeline !== null || repair.activeRepair !== null;
  const seats = attempts.filter((row) => row.role === "attempt");
  const aggregators = attempts.filter((row) => row.role === "aggregator");

  // 选择兜底：attemptId 必须在当前 attempts 中，否则回退总览，不留无效选中态。
  const effectiveSelection: WorkbenchSelection =
    selected !== "overview" &&
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

  const selectedAttemptId = selectedAttempt?.attemptId ?? null;
  // AC-04：默认 Tab 在首次选择该席位时计算一次（渲染期 ref 记忆保证当次渲染稳定），
  // 随后由 effect 持久化进 tabs store；之后永不重算——席位完成只提示「报告已就绪」。
  const renderTabDefaultsRef = useRef<Record<string, SeatViewTab>>({});
  let renderDefault: SeatViewTab | null = null;
  if (selectedAttempt && selectedAttemptId && !tabs[selectedAttemptId]) {
    renderDefault =
      renderTabDefaultsRef.current[selectedAttemptId] ?? defaultSeatTab(selectedAttempt);
    renderTabDefaultsRef.current[selectedAttemptId] = renderDefault;
  }
  const tab =
    selectedAttempt && selectedAttemptId
      ? (tabs[selectedAttemptId] ?? renderDefault ?? "report")
      : "report";
  useEffect(() => {
    if (selectedAttemptId && !tabs[selectedAttemptId]) {
      getOrInitTab(selectedAttemptId, tab);
    }
  }, [selectedAttemptId, tabs, tab, getOrInitTab]);

  // 单席复制（诚实范围）：单席报告 Tab 且 durable 正文 available 时复制该席原文；
  // 过程 Tab/正文不可用一律禁用，不回退 run.markdown（范围不一致）。总览复制 run 级汇总。
  const { result: seatResult } = useAttemptResult(run.runId, selectedAttempt);
  const readerRef = useRef<HTMLElement | null>(null);
  const getScroller = useCallback(() => readerRef.current, []);
  const viewKey = `${effectiveSelection}:${tab}`;
  const viewKeyRef = useRef(viewKey);
  viewKeyRef.current = viewKey;
  // AC-05 阅读连续性。旧位置必须在渲染期（DOM 提交前）捕获：effect 里读到的
  // 已经是新视图 clamp 后的 scrollTop（内容变矮时清 0），会把旧视图记忆冲掉。
  // StrictMode 双渲染写同值，无害。捕获后到恢复 effect 运行为止，clamp/恢复自身
  // 触发的 scroll 事件不得写记忆（suppress）。
  const scrollMemoryRef = useRef(new Map<string, number>());
  const suppressScrollMemoryRef = useRef(false);
  const committedViewKeyRef = useRef(viewKey);
  if (committedViewKeyRef.current !== viewKey) {
    const el = readerRef.current;
    if (el) scrollMemoryRef.current.set(committedViewKeyRef.current, el.scrollTop);
    suppressScrollMemoryRef.current = true;
    committedViewKeyRef.current = viewKey;
  }

  // scroll 时 rAF 节流记录当前位置（视图切换过渡期间不写，见上）。
  useEffect(() => {
    const el = readerRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf !== 0 || suppressScrollMemoryRef.current) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        if (suppressScrollMemoryRef.current) return;
        scrollMemoryRef.current.set(viewKeyRef.current, el.scrollTop);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf !== 0) window.cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const saved = scrollMemoryRef.current.get(viewKey);
    const el = readerRef.current;
    if (saved === undefined || !el) {
      suppressScrollMemoryRef.current = false;
      return;
    }
    // 等内容就绪并短暂守住位置：过程数据/正文异步渲染，scrollHeight 达到目标位置前
    // 逐帧等待；内容稳定前浏览器 clamp 或跟随可能再次移动 scrollTop（观察到 collapse
    // 回加载态再回涨），因此在窗口期内持续再断言。窗口内 suppress 记忆写入，
    // 这些非用户滚动不得覆盖恢复值。
    let attempts = 0;
    let heldFrames = 0;
    let raf = 0;
    const tallEnough = (node: HTMLElement) =>
      node.scrollHeight >= saved + node.clientHeight - 8;
    const tryRestore = () => {
      const node = readerRef.current;
      if (!node) return;
      if (attempts >= 90 || (heldFrames >= 12 && attempts > 0)) {
        suppressScrollMemoryRef.current = false;
        return;
      }
      attempts += 1;
      if (tallEnough(node)) {
        if (node.scrollTop !== saved) node.scrollTop = saved;
        heldFrames = node.scrollTop === saved ? heldFrames + 1 : 0;
      }
      raf = window.requestAnimationFrame(tryRestore);
    };
    suppressScrollMemoryRef.current = true;
    raf = window.requestAnimationFrame(tryRestore);
    return () => {
      window.cancelAnimationFrame(raf);
      suppressScrollMemoryRef.current = false;
    };
  }, [viewKey]);

  const copyText = () => {
    if (selectedAttempt && selectedAttemptId) {
      if (tab === "report" && seatResult?.availability === "available" && seatResult.markdown) {
        return seatResult.markdown;
      }
      return null;
    }
    if (effectiveSelection === "overview") {
      return run.markdown.trim().length > 0 ? run.markdown : null;
    }
    return null;
  };

  return (
    <div className="ck-wb ck-wb-app">
      <WorkbenchNav hostStatus={hostStatus} />
      <ContextBar run={run} hostStatus={hostStatus} />
      <SeatColumn attempts={attempts} hasRepair={repairAvailable} />
      <main className="ck-wb-main">
        <ViewBar
          title={viewTitle}
          attempt={selectedAttempt}
          tab={tab}
          onTabChange={(next) => {
            if (selectedAttemptId) setTab(selectedAttemptId, next);
          }}
          mobileSelect={{
            value: effectiveSelection,
            onChange: select,
            seats,
            aggregators,
            hasRepair: repairAvailable,
          }}
          getCopyText={copyText}
        />
        <div className="ck-wb-reader" ref={readerRef as Ref<HTMLDivElement>}>
          {effectiveSelection === "overview" ? (
            <OverviewView
              run={run}
              parsed={parsed}
              hasRepair={repairExists}
              onOpenRepair={() => select("repair")}
            />
          ) : effectiveSelection === "repair" ? (
            <RepairView run={run} repair={repair} pipeline={pipeline} />
          ) : selectedAttempt && selectedAttemptId ? (
            <SeatDetailView
              runId={run.runId}
              attempt={selectedAttempt}
              tab={tab}
              onTabChange={(next) => setTab(selectedAttemptId, next)}
              getScroller={getScroller}
            />
          ) : null}
        </div>
      </main>
      <StatusBar note={note} onRefetch={stale ? onRefetch : undefined} backTo={backTo} />
    </div>
  );
}
