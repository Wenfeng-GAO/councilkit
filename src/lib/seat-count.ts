/** Attempt row enough to count review seats. Aggregator is not a review seat. */
export interface SeatCountRow {
  status: string;
  role?: string;
}

export interface SeatTally {
  total: number;
  success: number;
  failure: number;
  interrupted: number;
}

/** #365: the numerator is seats that succeeded. Failure and cancellation stay in the total. */
export function tallyAttemptSeats(attempts: readonly SeatCountRow[]): SeatTally {
  const seats = attempts.filter((row) => row.role !== "aggregator");
  let success = 0;
  let failure = 0;
  let interrupted = 0;
  for (const seat of seats) {
    if (seat.status === "success") success += 1;
    else if (seat.status === "failure") failure += 1;
    else if (seat.status === "cancelled") interrupted += 1;
  }
  return { total: seats.length, success, failure, interrupted };
}

/**
 * `{成功}/{总数} 席位成功`, then `· N 路失败` and `· N 路中断` only when those counts
 * are non-zero. No failures and no interruptions is just the success fraction.
 */
export function formatSeatCount(attempts: readonly SeatCountRow[]): string | null {
  const tally = tallyAttemptSeats(attempts);
  if (tally.total === 0) return null;
  const parts = [`${tally.success}/${tally.total} 席位成功`];
  if (tally.failure > 0) parts.push(`${tally.failure} 路失败`);
  if (tally.interrupted > 0) parts.push(`${tally.interrupted} 路中断`);
  return parts.join(" · ");
}
