/**
 * Agent 颜色预设闭集（V1.1 §1 / Q1）。
 *
 * 10 个命名 swatch 构成产品闭集，深色 UI（surface `#15181d`）下两两可区分；
 * 红绿对（玫红/翠绿）通过 WCAG 相对明度差区分，避免仅靠色相。
 *
 * 闭集只在表单层强制（AC1）；数据模型 `DiscussionAgent.color: string`
 * 不收紧，遗留值与导入值继续兼容。比较预设成员时忽略 hex 大小写。
 */
export interface AgentColorPreset {
  name: string;
  value: string;
}

export const AGENT_COLOR_PRESETS = [
  { name: "靛蓝", value: "#4f6ef7" },
  { name: "玫红", value: "#f74f6e" },
  { name: "翠绿", value: "#4ff76e" },
  { name: "琥珀", value: "#f59e0b" },
  { name: "天蓝", value: "#38bdf8" },
  { name: "紫罗兰", value: "#a78bfa" },
  { name: "青色", value: "#22d3ee" },
  { name: "石灰", value: "#a3e635" },
  { name: "橙红", value: "#f97316" },
  { name: "板岩", value: "#94a3b8" },
] as const satisfies readonly AgentColorPreset[];

export type AgentColorPresetValue = (typeof AGENT_COLOR_PRESETS)[number]["value"];

/** 大小写不敏感地判断一个 hex 是否属于预设闭集。 */
export function isAgentColorPreset(hex: string): boolean {
  const target = hex.toLowerCase();
  return AGENT_COLOR_PRESETS.some((preset) => preset.value.toLowerCase() === target);
}

/** 返回与给定 hex 匹配的预设（大小写不敏感）；非成员返回 null。 */
export function findAgentColorPreset(hex: string): AgentColorPreset | null {
  const target = hex.toLowerCase();
  return AGENT_COLOR_PRESETS.find((preset) => preset.value.toLowerCase() === target) ?? null;
}
