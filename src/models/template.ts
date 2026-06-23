import type { ModelType, ValidationResult } from "@/types";

export interface TemplateAgentConfig {
  model: ModelType;
  role: string;
  color: string;
}

export interface Template {
  id: string;
  name: string;
  agentConfigs: TemplateAgentConfig[];
  createdAt: number;
}

export function validateTemplate(t: Template): ValidationResult {
  const errors: string[] = [];
  if (t.name.length === 0) errors.push("name must be non-empty");
  if (t.agentConfigs.length === 0) errors.push("agentConfigs must be non-empty");
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function createTemplate(input: {
  name: string;
  agentConfigs: TemplateAgentConfig[];
}): Template {
  const t: Template = {
    id: crypto.randomUUID(),
    name: input.name,
    agentConfigs: input.agentConfigs,
    createdAt: Date.now(),
  };
  const result = validateTemplate(t);
  if (!result.ok) throw new Error(`Invalid Template: ${result.errors.join("; ")}`);
  return t;
}
