import type { ModelRequest, ModelType } from "@/types";

/**
 * ModelService is the unitary contract every concrete model client
 * (claude/openai/deepseek, implemented in T5) must satisfy.
 */
export interface ModelService {
  streamMessage(req: ModelRequest): AsyncIterable<string>;
}

/**
 * Registry populated by T5 via registerModelService; T4 only owns the
 * contract + registry mechanism. dispatchMessage (actual streaming
 * orchestration) is intentionally deferred to T5/T7 where concrete
 * ModelService implementations exist — writing it in T4 produced only
 * stubs (caught by Step 3.1 MUST-HAVE WIRED/SUBSTANTIVE).
 */
const registry = new Map<ModelType, ModelService>();

export function registerModelService(model: ModelType, service: ModelService): void {
  registry.set(model, service);
}

export function getModelService(model: ModelType): ModelService | undefined {
  return registry.get(model);
}
