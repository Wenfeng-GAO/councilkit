import type { GatewayError, ModelMessage } from "@/types";

/**
 * RED stubs — GREEN implementation pending. tests/unit/adapters.test.ts
 * is expected to fail against these stubs by design.
 */

export function normalizeBaseUrl(baseUrl: string): string {
  throw new Error(`normalizeBaseUrl not implemented: ${baseUrl}`);
}

export function mapStreamErrorToGatewayError(input: {
  httpStatus?: number;
  errorCode?: string;
  errorMessage: string;
}): GatewayError {
  void input;
  throw new Error("mapStreamErrorToGatewayError not implemented");
}

export async function* anthropicAdapter(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
}): AsyncIterable<string | GatewayError> {
  void params;
  throw new Error("anthropicAdapter not implemented");
}

export async function* openaiCompatibleAdapter(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
}): AsyncIterable<string | GatewayError> {
  void params;
  throw new Error("openaiCompatibleAdapter not implemented");
}
