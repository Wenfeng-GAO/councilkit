export type ModelType = "claude" | "openai" | "deepseek";
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
