import { collectText, streamDeltas } from "@/lib/stream";
import type { ModelMessage, ModelRequest } from "@/types";
import type { ModelService } from "./model-registry";

const OPENAI_URL =
  (import.meta.env.VITE_OPENAI_BASE_URL as string | undefined) ??
  "https://api.openai.com/v1/chat/completions";

function toOpenAIMessages(messages: ModelMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

export const openaiService: ModelService = {
  async *streamMessage(req: ModelRequest): AsyncIterable<string> {
    const apiKey = import.meta.env.VITE_OPENAI_API_KEY as string | undefined;
    if (!apiKey) {
      yield "";
      return;
    }
    const chunks = streamDeltas({
      url: OPENAI_URL,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: { model: req.model, messages: toOpenAIMessages(req.messages), stream: true },
    });
    for await (const chunk of chunks) {
      if (chunk.type === "content_block_delta") yield chunk.delta.text;
    }
  },
};

export async function openaiComplete(req: ModelRequest): Promise<string> {
  return collectText(openaiService.streamMessage(req));
}
