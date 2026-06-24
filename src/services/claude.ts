import { collectText, streamDeltas } from "@/lib/stream";
import type { ModelMessage, ModelRequest } from "@/types";
import type { ModelService } from "./model-registry";

// base_url 可配（CR1）。dev 走 vite proxy /api/claude 避浏览器 CORS；
// prod 直连 base/v1/messages（部署侧自行处理 CORS/反代）。
const CLAUDE_BASE =
  (import.meta.env.VITE_CLAUDE_BASE_URL as string | undefined) ?? "https://api.anthropic.com";
const CLAUDE_URL = import.meta.env.DEV
  ? "/api/claude/v1/messages"
  : `${CLAUDE_BASE.replace(/\/$/, "")}/v1/messages`;

function toClaudeMessages(messages: ModelMessage[]): {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
} {
  const systemEntry = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  return {
    system: systemEntry?.content,
    messages: rest.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  };
}

export const claudeService: ModelService = {
  async *streamMessage(req: ModelRequest): AsyncIterable<string> {
    const apiKey = import.meta.env.VITE_CLAUDE_API_KEY as string | undefined;
    if (!apiKey) {
      yield "";
      return;
    }
    const { system, messages } = toClaudeMessages(req.messages);
    const chunks = streamDeltas({
      url: CLAUDE_URL,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: { model: req.model, system, messages, stream: true, max_tokens: 1024 },
    });
    for await (const chunk of chunks) {
      if (chunk.type === "content_block_delta") yield chunk.delta.text;
    }
  },
};

export async function claudeComplete(req: ModelRequest): Promise<string> {
  return collectText(claudeService.streamMessage(req));
}
