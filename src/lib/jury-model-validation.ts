import { isDefaultModelAlias } from "@shared/runtime/default-model-alias";
import type { ReviewJurySeat } from "@shared/runtime/review-jury";

/** A saved binding is not evidence that Cursor still offers that model. */
export function unavailableCursorSeats(
  seats: readonly ReviewJurySeat[],
  catalog: readonly string[],
): ReviewJurySeat[] {
  return seats.filter((seat) => {
    if (seat.driverSelection.driverId !== "cursor-stream-json") return false;
    if (isDefaultModelAlias(seat.modelId)) return false;
    return !catalog.includes(seat.modelId);
  });
}
