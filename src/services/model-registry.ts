import type { GatewayError, ModelRequest } from "@/types";

/**
 * ModelService 契约：每个 model client 必须实现。P02 起 adapter 按 gateway.type
 * 直接分派（src/services/gateway-adapters.ts），不再走 Map<ModelType, ModelService>
 * 全局注册；该接口仅保留为 streamMessage 返回类型契约。
 */
export interface ModelService {
  streamMessage(req: ModelRequest): AsyncIterable<string | GatewayError>;
}
