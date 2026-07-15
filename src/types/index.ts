/**
 * @deprecated Phase 1 gateway 改造后保留仅供迁移期 P05 清理；新代码用 Agent.gatewayId + Agent.model。
 */
export type ModelType = "claude" | "openai" | "deepseek";
export type GatewayErrorKind = "invalid_key" | "rate_limit" | "upstream" | "timeout" | "network";
export interface GatewayError {
  kind: GatewayErrorKind;
  message: string;
  httpStatus?: number;
}
export type SenderType = "agent" | "user";
export type RoomStatus = "idle" | "discussing" | "paused";
export type RoundStatus = "pending" | "active" | "completed";
export type AgentStatus = "online" | "offline" | "typing";

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

export interface ModelMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  stream: true;
}

export type StreamChunk =
  | { type: "content_block_delta"; delta: { text: string } }
  | { type: "message_stop" }
  | { type: "error"; error: { message: string; code: string } };
