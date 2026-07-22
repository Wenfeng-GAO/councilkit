import {
  AGENT_COLOR_PRESETS,
  type AgentColorPreset,
  findAgentColorPreset,
} from "@/models/discussion/agent-colors";

/**
 * 纯表单状态机（V1.1 §2 / plan-a §2）。
 *
 * 保存原始颜色字符串，避免编辑未触碰色板时改变遗留值或 hex 大小写。
 * 新建打开时无默认选择；编辑预设色高亮对应 swatch；编辑非预设 hex 不
 * 高亮并保留原值。点选 swatch 触碰（touched）后才允许提交预设成员。
 *
 * 状态机驱动 React 内部，且独立可单测（AC1），不依赖 Dexie/Host。
 */

export type AgentColorMode = "create" | "edit";

export interface AgentColorState {
  /** create / edit。 */
  mode: AgentColorMode;
  /** 当前选中预设（点选后设置；未触碰时由初始值匹配得出）。 */
  selected: AgentColorPreset | null;
  /** 原始颜色字符串（编辑遗留值时保留其大小写与原值）。 */
  original: string;
  /** 是否已主动点击色板（触碰后才能提交预设）。 */
  touched: boolean;
}

/** 构造初始状态：create 无选中；edit 预设色高亮、遗留色不高亮但保留。 */
export function createAgentColorState(mode: AgentColorMode, initialColor: string): AgentColorState {
  const matched = findAgentColorPreset(initialColor);
  return {
    mode,
    selected: matched,
    original: initialColor,
    touched: false,
  };
}

/** 点选一个预设：触碰标记为 true，selected 指向该预设。 */
export function selectAgentColor(
  state: AgentColorState,
  preset: AgentColorPreset,
): AgentColorState {
  return { ...state, selected: preset, touched: true };
}

/**
 * 解析最终可提交的颜色值。
 *
 * - 已触碰：提交所选预设的 `value`（统一收敛进闭集）；未选中返回 null（提示选择）。
 * - 编辑未触碰：逐字保留 `original`（遗留 hex 大小写与原值不变，Q19）。
 * - 新建未触碰：无选择，返回 null（提示选择预设）。
 */
export function resolveAgentColor(state: AgentColorState): string | null {
  if (state.touched) return state.selected?.value ?? null;
  return state.mode === "edit" ? state.original : null;
}

/** 色板可用预设（顺序稳定，便于 UI 与测试遍历）。 */
export const AGENT_COLOR_SWATCHES: readonly AgentColorPreset[] = AGENT_COLOR_PRESETS;
