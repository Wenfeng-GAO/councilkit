import { tallyAttemptSeats } from "@/lib/seat-count";
import { CirclePauseIcon, CircleXIcon } from "./icons";

/** #365 seat fraction. The success ratio stays in the primary text color. */
export function SeatCount({
  attempts,
}: {
  attempts: readonly { status: string; role?: string }[];
}) {
  const tally = tallyAttemptSeats(attempts);
  if (tally.total === 0) return null;
  return (
    <span className="ck-wb-seat-count">
      <span className="ck-wb-seat-count-main">
        {tally.success}/{tally.total} 席位成功
      </span>
      {tally.failure > 0 ? (
        <span className="ck-wb-seat-count-fail">
          <span aria-hidden="true"> · </span>
          <CircleXIcon className="ck-wb-icon ck-wb-icon-state" />
          {tally.failure} 路失败
        </span>
      ) : null}
      {tally.interrupted > 0 ? (
        <span className="ck-wb-seat-count-interrupt">
          <span aria-hidden="true"> · </span>
          <CirclePauseIcon className="ck-wb-icon ck-wb-icon-state" />
          {tally.interrupted} 路中断
        </span>
      ) : null}
    </span>
  );
}
