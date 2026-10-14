import type { ReviewJurySeat } from "@shared/runtime/review-jury";
import type { IdeateModels, ReviewModel } from "@shared/runtime/schemas";

export const IDEATE_ROLE_LABELS: Record<string, string> = {
  "ideate-product": "产品席",
  "ideate-engineering": "工程席",
  "ideate-challenger": "质疑席",
};

export function ideateRoleLabel(name: string): string {
  return IDEATE_ROLE_LABELS[name] ?? name;
}

export function modelConfigKey(model: ReviewModel): string {
  return JSON.stringify([model.driverSelection.driverId, model.driverSelection.options, model.modelId]);
}

export function rosterToIdeateModels(
  seats: readonly ReviewJurySeat[],
  reporterAgentId: string,
): IdeateModels {
  const aggregatorIndex = Math.max(
    0,
    seats.findIndex((seat) => seat.agentId === reporterAgentId),
  );
  return {
    models: seats.map((seat) => ({
      modelId: seat.modelId,
      driverSelection: seat.driverSelection,
    })),
    aggregatorIndex,
  };
}

export function savedRosterUnchanged(
  seats: readonly ReviewJurySeat[],
  reporterAgentId: string,
  draft: readonly ReviewJurySeat[],
  draftReporter: string,
): boolean {
  if (seats.length !== draft.length || reporterAgentId !== draftReporter) return false;
  return seats.every((seat, index) => {
    const next = draft[index];
    return (
      next !== undefined &&
      seat.agentId === next.agentId &&
      modelConfigKey(seat) === modelConfigKey(next)
    );
  });
}

export function uniqueModelConfigCount(seats: readonly ReviewJurySeat[]): number {
  return new Set(seats.map((seat) => modelConfigKey(seat))).size;
}
