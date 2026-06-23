import { collectText } from "@/lib/stream";
import type { ModelRequest, ModelType } from "@/types";
import { claudeService } from "./claude";
import { deepseekService } from "./deepseek";
import { getModelService, registerModelService } from "./model-registry";
import { openaiService } from "./openai";

let registered = false;

function ensureRegistered(): void {
  if (registered) return;
  registerModelService("claude", claudeService);
  registerModelService("openai", openaiService);
  registerModelService("deepseek", deepseekService);
  registered = true;
}

export function resolveService(model: ModelType) {
  ensureRegistered();
  const service = getModelService(model);
  if (!service) {
    throw new Error(`no model service registered for ${model}`);
  }
  return service;
}

/** 编排单 agent 流式发言，逐 chunk 回调。R7: 首条 ≤10s 由 streamDeltas 超时保障。 */
export async function dispatchStream(
  model: ModelType,
  req: ModelRequest,
  onDelta: (text: string) => void,
): Promise<void> {
  const service = resolveService(model);
  for await (const chunk of service.streamMessage(req)) {
    onDelta(chunk);
  }
}

/** 编排单 agent 发言并收集完整文本（用于总结等非流式场景）。 */
export async function dispatchMessage(model: ModelType, req: ModelRequest): Promise<string> {
  const service = resolveService(model);
  return collectText(service.streamMessage(req));
}
