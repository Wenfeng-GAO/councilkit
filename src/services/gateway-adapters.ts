import { streamDeltas } from "@/lib/stream";
import type { GatewayError, ModelMessage } from "@/types";

/**
 * D-04: gateway-type adapter 分派。两个 adapter 都从 streamDeltas 拿到 StreamChunk，
 * 但 OpenAI-compatible 的 SSE shape 与 Anthropic 不同（choices[].delta.content vs
 * delta.text），故新增专用 streamOpenAIDeltas（复制 streamDeltas 主体，仅替换
 * parseChunk）。这样 Anthropic 路径不动，D-04 分派清晰。
 */

export function normalizeBaseUrl(baseUrl: string): string {
  let u = baseUrl.trim();
  // strip trailing slash(es)
  while (u.endsWith("/")) u = u.slice(0, -1);
  // strip a single /v1 suffix if present (兼容用户填 https://api.openai.com/v1)
  if (u.endsWith("/v1")) u = u.slice(0, -3);
  return u;
}

export function mapStreamErrorToGatewayError(input: {
  httpStatus?: number;
  errorCode?: string;
  errorMessage: string;
}): GatewayError {
  const { httpStatus, errorCode, errorMessage } = input;
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: "invalid_key", message: errorMessage, httpStatus };
  }
  if (httpStatus === 429) {
    return { kind: "rate_limit", message: errorMessage, httpStatus: 429 };
  }
  if (httpStatus !== undefined && httpStatus >= 500 && httpStatus < 600) {
    return { kind: "upstream", message: errorMessage, httpStatus };
  }
  if (errorCode === "timeout") {
    return { kind: "timeout", message: errorMessage };
  }
  return { kind: "network", message: errorMessage };
}

interface AnthropicStream {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

function toAnthropicPayload(messages: ModelMessage[]): AnthropicStream {
  const systemEntry = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  return {
    system: systemEntry?.content,
    messages: rest.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  };
}

function errorFromStreamCode(message: string, code: string): GatewayError {
  const numeric = Number.parseInt(code, 10);
  if (Number.isFinite(numeric) && code.length > 0) {
    return mapStreamErrorToGatewayError({ httpStatus: numeric, errorMessage: message });
  }
  return mapStreamErrorToGatewayError({ errorMessage: message, errorCode: code });
}

export async function* anthropicAdapter(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
  /** Override default max_tokens (1024). testGatewayConnection passes 1 (T-03-05). */
  maxTokens?: number;
}): AsyncIterable<string | GatewayError> {
  const { system, messages } = toAnthropicPayload(params.messages);
  const url = `${normalizeBaseUrl(params.baseUrl)}/v1/messages`;
  const headers: Record<string, string> = {
    "x-api-key": params.apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "Content-Type": "application/json",
  };
  const body = {
    model: params.model,
    system,
    messages,
    stream: true,
    max_tokens: params.maxTokens ?? 1024,
  };
  const stream = streamDeltas({ url, headers, body, signal: params.signal });
  for await (const chunk of stream) {
    if (chunk.type === "content_block_delta") {
      yield chunk.delta.text;
    } else if (chunk.type === "error") {
      yield errorFromStreamCode(chunk.error.message, chunk.error.code);
    } else if (chunk.type === "message_stop") {
      return;
    }
  }
}

export async function* openaiCompatibleAdapter(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
  /** Override default. testGatewayConnection passes 1 (T-03-05). */
  maxTokens?: number;
}): AsyncIterable<string | GatewayError> {
  const url = `${normalizeBaseUrl(params.baseUrl)}/v1/chat/completions`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.apiKey}`,
    "Content-Type": "application/json",
  };
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  };
  if (params.maxTokens !== undefined) {
    body.max_tokens = params.maxTokens;
  }
  const stream = streamOpenAIDeltas({ url, headers, body, signal: params.signal });
  for await (const chunk of stream) {
    if (chunk.type === "content_block_delta") {
      yield chunk.delta.text;
    } else if (chunk.type === "error") {
      yield errorFromStreamCode(chunk.error.message, chunk.error.code);
    } else if (chunk.type === "message_stop") {
      return;
    }
  }
}

// --- OpenAI SSE 解析（与 streamDeltas 同构，仅 parseChunk 不同；不动 stream.ts 主路径） ---

import type { StreamChunk } from "@/types";

const TIMEOUT_MS = 10_000;

async function* streamOpenAIDeltas(opts: {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
}): AsyncIterable<StreamChunk> {
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
      yield { type: "error", error: { message: `HTTP ${res.status}`, code: String(res.status) } };
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
        const chunk = parseOpenAIChunk(payload);
        if (chunk) yield chunk;
      }
    }
    yield { type: "message_stop" };
  } catch (err) {
    const isAbort =
      controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    if (isAbort) {
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

function parseOpenAIChunk(payload: string): StreamChunk | null {
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    if (obj.type === "error") {
      return { type: "error", error: obj.error as { message: string; code: string } };
    }
    if (obj.type === "message_stop") return { type: "message_stop" };
    const choices = obj.choices as Array<{ delta?: { content?: string } }> | undefined;
    const delta = choices?.[0]?.delta;
    if (delta && typeof delta.content === "string") {
      return { type: "content_block_delta", delta: { text: delta.content } };
    }
    return null;
  } catch {
    return null;
  }
}
