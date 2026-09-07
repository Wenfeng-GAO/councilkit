import type { ReviewModels } from "@shared/runtime/schemas";
import type { AgentRecord } from "../store/schemas";

/** Ephemeral seats stay in this run; the saved pr-jury is never overwritten. */
export function reviewModelAgents(config: ReviewModels): AgentRecord[] {
  return config.models.map((model, index) => ({
    id: `review-model-${index + 1}`,
    name: `${model.modelId} · ${index + 1}`.slice(0, 128),
    modelId: model.modelId,
    driverSelection: model.driverSelection,
    enabled: true,
    color: "#c4a574",
    personaPrompt:
      "你是独立代码审查员。检查正确性、安全性、边界条件、回归与测试缺口。只报告有具体位置和可验证依据的问题，每条带严重度 [critical|major|minor|nit]、复现条件与建议修复。未执行的验证明确写未验证。最终输出 Markdown，使用标题「发现 / 验证 / 结论」，结论为 approve | changes-requested | comment。作为 Aggregator 时仅根据成功 Attempt 的交付物对比汇总。",
  }));
}
