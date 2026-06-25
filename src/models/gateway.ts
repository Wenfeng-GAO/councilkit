import type { ValidationResult } from "@/types";

export type GatewayType = "anthropic" | "openai-compatible";

export interface Gateway {
  id: string;
  name: string;
  type: GatewayType;
  baseUrl: string;
  defaultModel: string;
  createdAt: number;
}

const ALLOWED_TYPES: ReadonlySet<GatewayType> = new Set(["anthropic", "openai-compatible"]);

const NAME_MAX = 50;
const HTTP_URL = /^https?:\/\//;

export function validateGateway(g: Gateway): ValidationResult {
  const errors: string[] = [];
  if (g.name.length === 0) {
    errors.push("name must be non-empty");
  }
  if (g.name.length > NAME_MAX) {
    errors.push(`name length must be <= ${NAME_MAX}`);
  }
  if (!ALLOWED_TYPES.has(g.type)) {
    errors.push(`type must be one of ${[...ALLOWED_TYPES].join(", ")}`);
  }
  if (g.baseUrl.length === 0) {
    errors.push("baseUrl must be non-empty");
  } else if (!HTTP_URL.test(g.baseUrl)) {
    errors.push("baseUrl must start with http:// or https://");
  }
  if (g.defaultModel.length === 0) {
    errors.push("defaultModel must be non-empty");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export interface CreateGatewayInput {
  name: string;
  type: GatewayType;
  baseUrl: string;
  defaultModel: string;
}

export function createGateway(input: CreateGatewayInput): Gateway {
  const g: Gateway = {
    id: crypto.randomUUID(),
    name: input.name,
    type: input.type,
    baseUrl: input.baseUrl,
    defaultModel: input.defaultModel,
    createdAt: Date.now(),
  };
  const result = validateGateway(g);
  if (!result.ok) {
    throw new Error(`Invalid Gateway: ${result.errors.join("; ")}`);
  }
  return g;
}
