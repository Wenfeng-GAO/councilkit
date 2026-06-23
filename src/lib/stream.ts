import type { StreamChunk } from "@/types";

const TIMEOUT_MS = 10_000;

export interface StreamOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
}

/**
 * 发起流式请求，按 StreamChunk 解析 SSE，产出 text delta。
 * SC-4: 10s 超时首 chunk 未到则 abort，调用方据此标 agent 离线。
 */
export async function* streamDeltas(opts: StreamOptions): AsyncIterable<StreamChunk> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      yield {
        type: "error",
        error: { message: `HTTP ${res.status}`, code: String(res.status) },
      };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          yield { type: "message_stop" };
          return;
        }
        const chunk = parseChunk(payload);
        if (chunk) yield chunk;
      }
    }
    yield { type: "message_stop" };
  } catch (err) {
    if (controller.signal.aborted) {
      yield { type: "error", error: { message: "timeout", code: "timeout" } };
      return;
    }
    yield {
      type: "error",
      error: { message: err instanceof Error ? err.message : "stream error", code: "stream" },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseChunk(payload: string): StreamChunk | null {
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    if (obj.type === "error") {
      return { type: "error", error: obj.error as { message: string; code: string } };
    }
    if (obj.type === "message_stop") return { type: "message_stop" };
    const delta = obj.delta as { text?: string } | undefined;
    if (delta && typeof delta.text === "string") {
      return { type: "content_block_delta", delta: { text: delta.text } };
    }
    return null;
  } catch {
    return null;
  }
}

export async function collectText(deltas: AsyncIterable<string>): Promise<string> {
  let acc = "";
  for await (const text of deltas) {
    acc += text;
  }
  return acc;
}
