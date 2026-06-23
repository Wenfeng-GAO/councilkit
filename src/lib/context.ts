import type { Message } from "@/models";
import type { ModelMessage } from "@/types";

const WINDOW_ROUNDS = 5;

export interface ContextWindow {
  system: string;
  messages: ModelMessage[];
}

/**
 * 滑动窗口上下文压缩: 取最近 WINDOW_ROUNDS 轮的消息 + 注入既有过往摘要作为固定前缀。
 * 避免长对话后半段 agent 遗忘早期结论（TECH 实现风险）。
 */
export function buildContext(
  messages: Message[],
  priorSummary: string | null,
  topic: string,
): ContextWindow {
  const recent = messages.slice(-WINDOW_ROUNDS * 4);
  const systemParts = [`讨论话题: ${topic}`];
  if (priorSummary) {
    systemParts.push(`过往讨论摘要:\n${priorSummary}`);
  }
  const system = systemParts.join("\n\n");
  const mapped: ModelMessage[] = recent.map((m) => ({
    role: m.senderType === "user" ? "user" : "assistant",
    content: m.content,
  }));
  return { system, messages: mapped };
}
