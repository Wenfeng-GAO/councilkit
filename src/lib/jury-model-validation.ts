import type { ReviewJurySeat } from "@shared/runtime/review-jury";

/** A saved binding is not evidence that Cursor still offers that model. */
export function unavailableCursorSeats(
  seats: readonly ReviewJurySeat[],
  catalog: readonly string[],
): ReviewJurySeat[] {
  return seats.filter((seat) => {
    if (seat.driverSelection.driverId !== "cursor-stream-json") return false;
    const isDefault = ["auto", "default", "configured"].includes(seat.modelId.trim().toLowerCase());
    return !catalog.includes(isDefault ? "auto" : seat.modelId);
  });
}
