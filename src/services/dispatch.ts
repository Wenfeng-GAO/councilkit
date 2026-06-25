import { loadGatewayApiKey } from "@/lib/crypto";
import { db } from "@/lib/db";
import type { Agent, Gateway } from "@/models";
import type { GatewayError, ModelRequest } from "@/types";
import { anthropicAdapter, openaiCompatibleAdapter } from "./gateway-adapters";

/**
 * 按 agent.gatewayId resolve gateway 元数据 + multi-key AES 解出的 apiKey。
 * 失败时返回结构化 GatewayError 供调用方按 kind 分类（P04 充实）。
 */
export async function resolveGatewayAndKey(
  agent: Pick<Agent, "gatewayId" | "model">,
): Promise<{ gateway: Gateway; apiKey: string } | GatewayError> {
  const gateway = await db.gateways.get(agent.gatewayId);
  if (!gateway) {
    return {
      kind: "invalid_key",
      message: `gateway not found: ${agent.gatewayId}`,
    };
  }
  const apiKey = await loadGatewayApiKey(agent.gatewayId);
  if (!apiKey) {
    return {
      kind: "invalid_key",
      message: `apiKey not configured for gateway ${gateway.name}`,
    };
  }
  return { gateway, apiKey };
}

/**
 * 编排单 agent 流式发言，逐 chunk 透传（含 GatewayError）。
 * onChunk 接收 string | GatewayError；调用方（runRound）自行决定如何处理 error。
 * R7: 首 chunk ≤10s 超时由 streamDeltas / streamOpenAIDeltas 内部兜底。
 */
export async function* dispatchStream(
  agent: Pick<Agent, "gatewayId" | "model">,
  req: ModelRequest,
  onChunk?: (chunk: string | GatewayError) => void,
): AsyncIterable<string | GatewayError> {
  const resolved = await resolveGatewayAndKey(agent);
  if ("kind" in resolved) {
    if (onChunk) onChunk(resolved);
    yield resolved;
    return;
  }
  const { gateway, apiKey } = resolved;
  const params = {
    baseUrl: gateway.baseUrl,
    apiKey,
    model: agent.model,
    messages: req.messages,
  };
  const iter =
    gateway.type === "anthropic" ? anthropicAdapter(params) : openaiCompatibleAdapter(params);
  for await (const chunk of iter) {
    if (onChunk) onChunk(chunk);
    yield chunk;
  }
}

/** 编排单 agent 发言并收集完整文本（用于 summary 等非流式场景）。
 *  遇 GatewayError 即 throw（保留旧 summary 失败抛错语义；summary.ts 已有 try/catch 兜底）。 */
export async function dispatchMessage(
  agent: Pick<Agent, "gatewayId" | "model">,
  req: ModelRequest,
): Promise<string> {
  let acc = "";
  for await (const chunk of dispatchStream(agent, req)) {
    if (typeof chunk === "string") {
      acc += chunk;
    } else {
      throw new Error(chunk.message);
    }
  }
  return acc;
}
