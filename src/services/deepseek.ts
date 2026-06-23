import { collectText, streamDeltas } from "@/lib/stream";
import type { ModelMessage, ModelRequest } from "@/types";
import type { ModelService } from "./model-registry";

const DEEPSEEK_URL =
  (import.meta.env.VITE_DEEPSEEK_BASE_URL as string | undefined) ??
  "https://api.deepseek.com/v1/chat/completions";

function toDeepSeekMessages(messages: ModelMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export const deepseekService: ModelService = {
  async *streamMessage(req: ModelRequest): AsyncIterable<string> {
    const apiKey = import.meta.env.VITE_DEEPSEEK_API_KEY as string | undefined;
    if (!apiKey) {
      yield "";
      return;
    }
    const chunks = streamDeltas({
      url: DEEPSEEK_URL,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: { model: req.model, messages: toDeepSeekMessages(req.messages), stream: true },
    });
    for await (const chunk of chunks) {
      if (chunk.type === "content_block_delta") yield chunk.delta.text;
    }
  },
};

export async function deepseekComplete(req: ModelRequest): Promise<string> {
  return collectText(deepseekService.streamMessage(req));
}
