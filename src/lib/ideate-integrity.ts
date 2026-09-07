import type { IdeateIntegrityDto } from "@shared/runtime/schemas";

const STAGE_LABEL = {
  proposal: "提案",
  debate: "辩论",
  aggregate: "汇总",
} as const;

export function ideateStageLabel(stage: IdeateIntegrityDto["failedSeats"][number]["stage"]): string {
  return STAGE_LABEL[stage];
}

export function oneLineIdeateMessage(message: string, max = 160): string {
  const text = message.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
