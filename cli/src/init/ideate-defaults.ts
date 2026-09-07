/**
 * Default product-jury roster. Names and personas are the product contract
 * `councilkit init` writes for `councilkit ideate`. Model ids for grok/kimi
 * reuse the existing review literals; Codex is not guessed.
 */
import type { DriverSelection } from "../store/schemas";

export const PRODUCT_JURY_COUNCIL_NAME = "product-jury" as const;
export const PRODUCT_JURY_TOPIC = "并行独立提案、串行交叉质疑，再由中立 Aggregator 给出产品决策";
export const PRODUCT_JURY_BACKGROUND =
  "各席先独立提案，再按 roster 顺序辩论；Aggregator 使用中立决策指令，不增加一票。";
export const PRODUCT_JURY_TARGET_OUTPUT =
  "十章节决策报告：背景与问题 / 目标用户与场景 / 方案对比 / 辩论要点与分歧 / 决策与范围 / 产品形态与关键流程 / 技术方案与约束 / 里程碑 / 验证计划 / 风险与未决问题。";
export const PRODUCT_JURY_ROUNDS = 1;

export const IDEATE_AGENT_NAMES = [
  "ideate-product",
  "ideate-engineering",
  "ideate-challenger",
] as const;

export type IdeateAgentName = (typeof IDEATE_AGENT_NAMES)[number];

export interface IdeateAgentSpec {
  name: IdeateAgentName;
  executable: "grok" | "kimi" | "codex";
  driverSelection: DriverSelection;
  /** Used only when the driver has a project-contract default. Codex stays unset. */
  modelId: string | null;
  color: string;
  personaPrompt: string;
}

export const IDEATE_AGENT_SPECS: readonly IdeateAgentSpec[] = [
  {
    name: "ideate-product",
    executable: "grok",
    driverSelection: { driverId: "grok-stream-json", options: {} },
    modelId: "grok-4.6",
    color: "#38bdf8",
    personaPrompt: [
      "你是产品席。只从用户价值和验证出发：谁在什么场景下得到什么结果，第一版做什么、明确不做什么。",
      "每个方案必须覆盖：目标用户/问题、用户价值、MVP 与非目标、实现成本、验证成本、关键假设、风险与停止条件。",
      "估算必须标明假设。市场判断不能写成已验证事实。允许结论是先验证或不做。",
    ].join("\n"),
  },
  {
    name: "ideate-engineering",
    executable: "kimi",
    driverSelection: { driverId: "kimi-stream-json", options: {} },
    modelId: "kimi-code/k3",
    color: "#4ade80",
    personaPrompt: [
      "你是工程席。评估可行性、实现成本、复杂度和约束，而不是推销功能清单。",
      "每个方案必须覆盖：目标用户/问题、用户价值、MVP 与非目标、实现成本、验证成本、关键假设、风险与停止条件。",
      "指出两周内做不到的部分。估算必须标明假设。不要把未验证的技术判断写成事实。",
    ].join("\n"),
  },
  {
    name: "ideate-challenger",
    executable: "codex",
    driverSelection: { driverId: "codex-app-server", options: {} },
    modelId: null,
    color: "#f472b6",
    personaPrompt: [
      "你是质疑席。提出独立替代方案，挑战前提、范围和失败条件。",
      "每个方案必须覆盖：目标用户/问题、用户价值、MVP 与非目标、实现成本、验证成本、关键假设、风险与停止条件。",
      "明确什么条件下这个产品不该做。不要为了反对而编造问题。",
    ].join("\n"),
  },
];

export const IDEATE_REPORTER_FALLBACK = [
  "ideate-challenger",
  "ideate-product",
  "ideate-engineering",
] as const;

export const NEXT_IDEATE_HINT = 'councilkit ideate "<idea>" --council product-jury';
