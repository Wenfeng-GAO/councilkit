import { loadGatewayApiKey } from "@/lib/crypto";
import type { Gateway } from "@/models";
import { anthropicAdapter, openaiCompatibleAdapter } from "@/services/gateway-adapters";
import type { GatewayError, ModelMessage } from "@/types";

export type TestConnectionResult = { ok: true } | { ok: false; error: GatewayError };

/**
 * D-08 测试连接：以最小流式请求验证 gateway 配置可达且密钥有效。
 *
 * 流程：
 * 1. loadGatewayApiKey(gateway.id) → null 时直接返 invalid_key（不发请求）。
 * 2. 按 gateway.type 选 adapter，发 model=gateway.defaultModel、max_tokens=1、
 *    stream:true 的 ping 请求。
 * 3. for-await：收到任意 string chunk → {ok:true}（连接已建立）；
 *    收到 GatewayError chunk → {ok:false, error}（401/429/5xx 等）。
 * 4. 流正常结束但未 yield 任何 chunk（max_tokens=1 可能产生 0 delta）→ 视为成功。
 * 5. 任意 throw → network 错误。
 *
 * 结果不抛错，全以 {ok, error?} 封装返回，由调用方据此切换 UI 状态。
 */
export async function testGatewayConnection(gateway: Gateway): Promise<TestConnectionResult> {
  const apiKey = loadGatewayApiKey(gateway.id);
  if (!apiKey) {
    return {
      ok: false,
      error: { kind: "invalid_key", message: "未配置 API 密钥" },
    };
  }

  const adapter = gateway.type === "anthropic" ? anthropicAdapter : openaiCompatibleAdapter;
  const messages: ModelMessage[] = [{ role: "user", content: "ping" }];

  try {
    for await (const chunk of adapter({
      baseUrl: gateway.baseUrl,
      apiKey,
      model: gateway.defaultModel,
      messages,
      maxTokens: 1,
    })) {
      if (typeof chunk === "string") {
        if (chunk.length > 0) return { ok: true };
        continue;
      }
      return { ok: false, error: chunk };
    }
    // 流正常结束（已建立连接且 200，max_tokens=1 可能无可见 delta）
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "network",
        message: err instanceof Error ? err.message : "stream error",
      },
    };
  }
}
