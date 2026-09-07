import type { IdeateModels } from "@shared/runtime/schemas";
import type { AgentRecord } from "../store/schemas";

const PERSONAS = [
  "你是产品席。只从用户价值和验证出发：谁在什么场景下得到什么结果，第一版做什么、明确不做什么。每个方案必须覆盖目标用户/问题、用户价值、MVP 与非目标、实现成本、验证成本、关键假设、风险与停止条件。估算必须标明假设。",
  "你是工程席。评估可行性、实现成本和约束。每个方案必须覆盖目标用户/问题、用户价值、MVP 与非目标、实现成本、验证成本、关键假设、风险与停止条件。指出做不到的部分，不要把未验证判断写成事实。",
  "你是质疑席。提出独立替代方案，挑战前提与失败条件。每个方案必须覆盖目标用户/问题、用户价值、MVP 与非目标、实现成本、验证成本、关键假设、风险与停止条件。不要为了反对而编造问题。",
] as const;

/** Ephemeral ideate seats. Never reuse review-model personas. */
export function ideateModelAgents(config: IdeateModels): AgentRecord[] {
  return config.models.map((model, index) => ({
    id: `ideate-model-${index + 1}`,
    name: `${model.modelId} · ${index + 1}`.slice(0, 128),
    modelId: model.modelId,
    driverSelection: model.driverSelection,
    enabled: true,
    color: "#38bdf8",
    personaPrompt: PERSONAS[index] ?? PERSONAS[2],
  }));
}

export function modelConfigKey(input: {
  driverSelection: { driverId: string; options: unknown };
  modelId: string;
}): string {
  return JSON.stringify([input.driverSelection.driverId, input.driverSelection.options, input.modelId]);
}
