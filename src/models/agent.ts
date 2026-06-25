import type { AgentStatus, ValidationResult } from "@/types";

export interface Agent {
  id: string;
  gatewayId: string;
  model: string;
  role: string;
  color: string;
  roomId?: string;
  templateId?: string;
  status: AgentStatus;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function validateAgent(agent: Agent): ValidationResult {
  const errors: string[] = [];
  if (agent.gatewayId.length === 0) {
    errors.push("gatewayId must be non-empty");
  }
  if (agent.model.length === 0) {
    errors.push("model must be non-empty");
  }
  if (agent.role.length === 0) {
    errors.push("role must be non-empty");
  }
  if (agent.role.length > 100) {
    errors.push("role length must be <= 100");
  }
  if (!HEX_COLOR.test(agent.color)) {
    errors.push("color must be a 6-digit hex (e.g. #6366f1)");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
