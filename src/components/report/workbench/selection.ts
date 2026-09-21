import type { CliRunDetailResponse } from "@shared/runtime/schemas";
import { createStore, useStore } from "zustand";

/**
 * progress.attempts 的元素类型（schema 推导）。注意它比 shared 的
 * CliRunAttemptProgress 接口更宽（lastActivity 可为 undefined），组件统一用本别名。
 */
export type WorkbenchAttempt = NonNullable<CliRunDetailResponse["progress"]>["attempts"][number];

/**
 * 工作台唯一选择器（WORKSPACE-STATES §1）。
 * 模型只有三种取值："overview"（本轮总览）| "repair"（当前修复；kind=review 即可达——
 * 无 pipeline 时 RepairView 提供真实启动面板，不留无效占位）| attemptId（单席报告/过程
 * 共用同一个所选 Attempt，含 Aggregator）。
 * 窄屏 <select>、席位列、键盘切换全部读写本 store，保证全页面只有一个 selectedAttempt。
 *
 * 轮询纪律接入点（DELIVERY-PLAN §3.1，阶段 B 使用）：
 * - select() 会使 generation 自增。过程/结果轮询应在发起请求前记录当前 generation，
 *   响应到达时比对；不一致即丢弃（迟到响应不得落到新席位）。
 * - 监听 generation 变化时 abort 未完成请求，保证同一席位同一时间最多一个 live 请求。
 */
export type WorkbenchSelection = "overview" | "repair" | (string & {});

export type SeatViewTab = "report" | "process";

interface WorkbenchSelectionState {
  selected: WorkbenchSelection;
  /** 选择代次：每次 select() 自增，供阶段 B 做请求取消/迟到丢弃。 */
  generation: number;
  /** 每个席位各自记住上次使用的 Tab，切回同一席位时恢复（WORKSPACE-STATES §3）。 */
  tabs: Record<string, SeatViewTab>;
  select: (next: WorkbenchSelection) => void;
  setTab: (attemptId: string, tab: SeatViewTab) => void;
  /**
   * AC-04：首次选择席位时一次性写入默认 Tab 并持久化；之后永不重算
   * （完成事件不得把过程自动切成报告）。已存在记录时原样返回。
   */
  getOrInitTab: (attemptId: string, fallback: SeatViewTab) => SeatViewTab;
}

export const workbenchSelectionStore = createStore<WorkbenchSelectionState>()((set, get) => ({
  selected: "overview",
  generation: 0,
  tabs: {},
  select: (next) =>
    set((state) =>
      next === state.selected ? state : { selected: next, generation: state.generation + 1 },
    ),
  setTab: (attemptId, tab) => set((state) => ({ tabs: { ...state.tabs, [attemptId]: tab } })),
  getOrInitTab: (attemptId, fallback) => {
    const existing = get().tabs[attemptId];
    if (existing) return existing;
    set((state) => ({ tabs: { ...state.tabs, [attemptId]: fallback } }));
    return fallback;
  },
}));

export function useWorkbenchSelection(): WorkbenchSelectionState {
  return useStore(workbenchSelectionStore);
}

/** 首次进入默认 Tab（WORKSPACE-STATES §3）：运行中/排队席位默认过程，已结束席位默认报告。 */
export function defaultSeatTab(attempt: Pick<WorkbenchAttempt, "status">): SeatViewTab {
  return attempt.status === "running" || attempt.status === "queued" || attempt.status === "pending"
    ? "process"
    : "report";
}
