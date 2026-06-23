import type { Message } from "@/models";
import { dispatchMessage } from "@/services/dispatch";
import type { ModelType } from "@/types";
import { buildContext } from "./context";

const SUMMARY_PROMPT =
  "你是讨论总结者。基于以下讨论，生成一个中立、有用的综合结论（Markdown），提炼关键分歧与共识，不要敷衍地说“两边都有道理”。";

/** 独立模型调用生成本轮总结（DESIGN: 总结须中立客观，不交由末位 agent）。R5。 */
export async function generateSummary(params: {
  model: ModelType;
  topic: string;
  messages: Message[];
  priorSummary: string | null;
}): Promise<string> {
  const { system, messages } = buildContext(params.messages, params.priorSummary, params.topic);
  const text = await dispatchMessage(params.model, {
    model: params.model,
    stream: true,
    messages: [{ role: "system", content: `${SUMMARY_PROMPT}\n\n${system}` }, ...messages],
  });
  return text.trim() || "（未能生成总结）";
}
