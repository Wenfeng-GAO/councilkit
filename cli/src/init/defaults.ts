/**
 * Default PR-jury roster. Names, colors and model ids are the product
 * contract `councilkit init` writes — tests assert these literals.
 */
import type { DriverSelection } from "../store/schemas";

export const PR_JURY_COUNCIL_NAME = "pr-jury" as const;
export const PR_JURY_TOPIC = "并行独立审查同一任务并对比汇总";
export const PR_JURY_BACKGROUND =
  "N 个审查者独立完成同一审查任务，再由 reporter 对比汇总。councilkit review 忽略 rounds。";
export const PR_JURY_TARGET_OUTPUT =
  "五章节聚合报告：概览 / 共识发现 / 独有发现 / 分歧 / 结论，外加各审查者附录。";
export const PR_JURY_ROUNDS = 1;

export const DEFAULT_AGENT_NAMES = [
  "review-security",
  "review-correctness",
  "review-maintainability",
  "review-adversarial",
] as const;

export type DefaultAgentName = (typeof DEFAULT_AGENT_NAMES)[number];

export interface DefaultAgentSpec {
  name: DefaultAgentName;
  executable: "cld" | "codex" | "kimi" | "grok";
  driverSelection: DriverSelection;
  modelId: string;
  color: string;
  personaPrompt: string;
  preferredReporter: boolean;
}

export const DEFAULT_AGENT_SPECS: readonly DefaultAgentSpec[] = [
  {
    name: "review-security",
    executable: "cld",
    driverSelection: { driverId: "claude-stream-json", options: { route: "cfuse" } },
    modelId: "antchat/GLM-5.2[1m]",
    color: "#f74f6e",
    preferredReporter: false,
    personaPrompt: [
      "你是安全审查员。只报告可利用或可验证的安全问题：注入、鉴权绕过、数据暴露、密钥泄漏、依赖供应链、不可信输入通向副作用。",
      "每条发现必须包含：严重度 [critical|major|minor|nit]、复现条件、建议修复。",
      "不要报纯风格或抽象洁癖。没跑验证就在「验证」里写「未验证」。",
      "最终消息只输出 Markdown，使用标题「发现 / 验证 / 结论」。结论一行：approve | changes-requested | comment。",
    ].join("\n"),
  },
  {
    name: "review-correctness",
    executable: "grok",
    driverSelection: { driverId: "grok-stream-json", options: {} },
    modelId: "grok-4.6",
    color: "#4f6ef7",
    preferredReporter: false,
    personaPrompt: [
      "你是正确性审查员。寻找逻辑错误、边界条件、并发/状态机缺陷、错误处理漏洞、契约被违反的路径。",
      "每条发现给出一个反例场景（输入/时序/状态）。严重度用 [critical|major|minor|nit]。",
      "最终消息只输出 Markdown，使用标题「发现 / 验证 / 结论」。结论一行：approve | changes-requested | comment。",
    ].join("\n"),
  },
  {
    name: "review-maintainability",
    executable: "kimi",
    driverSelection: { driverId: "kimi-stream-json", options: {} },
    modelId: "kimi-code/k3",
    color: "#4ff76e",
    preferredReporter: false,
    personaPrompt: [
      "你是可维护性与架构审查员。关注耦合、抽象过度或不足、命名、测试缺口、与仓库既有约定不一致。",
      "只报会在下一次改动中造成真实成本的问题。每条带严重度 [critical|major|minor|nit] 和具体位置。",
      "最终消息只输出 Markdown，使用标题「发现 / 验证 / 结论」。结论一行：approve | changes-requested | comment。",
    ].join("\n"),
  },
  {
    name: "review-adversarial",
    executable: "grok",
    driverSelection: { driverId: "grok-stream-json", options: {} },
    modelId: "grok-4.6",
    color: "#a78bfa",
    preferredReporter: true,
    personaPrompt: [
      "你是对抗式审查员。主动寻找会被其他审查者漏掉的假设：错误前提、范围外副作用、不可测的断言、与需求相反的实现。",
      "每条发现带严重度 [critical|major|minor|nit] 和可证伪的反例。不要重复纯风格意见。",
      "作为 Aggregator 时只根据各 Attempt 的交付物对比汇总，不得把失败或缺席的 Attempt 写成共识来源。",
      "最终消息只输出 Markdown，使用标题「发现 / 验证 / 结论」。结论一行：approve | changes-requested | comment。",
    ].join("\n"),
  },
];

export const NEXT_REVIEW_HINT = "councilkit review --council pr-jury --pr <url>";
