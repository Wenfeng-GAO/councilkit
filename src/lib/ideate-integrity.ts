import type { IdeateIntegrityDto } from "@shared/runtime/schemas";
import { clipUtf16 } from "@shared/text/clip-utf16";

const STAGE_LABEL = {
  proposal: "提案",
  debate: "辩论",
  aggregate: "汇总",
} as const;

export function ideateStageLabel(
  stage: IdeateIntegrityDto["failedSeats"][number]["stage"],
): string {
  return STAGE_LABEL[stage];
}

export function oneLineIdeateMessage(message: string, max = 160): string {
  const text = message.replace(/\s+/g, " ").trim();
  return clipUtf16(text, max, "…");
}
