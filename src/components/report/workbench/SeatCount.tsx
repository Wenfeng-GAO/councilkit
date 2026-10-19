import { CircleXIcon } from "./icons";

export interface ReviewSeatCount {
  success: number;
  total: number;
  failures: number;
  interrupted: number;
  /** Visible sentence. Failures and interruptions are suffixes, never part of the numerator. */
  text: string;
}

/**
 * Review-seat tally for the report header and the line under the title.
 * The numerator counts successful review seats only. The aggregator is not a seat.
 * No failures and no interruptions: `{success}/{total} 席位成功`.
 * Otherwise append `· N 路失败` and/or `· N 路中断`.
 */
export function reviewSeatCount(
  attempts: readonly { role: string; status: string }[] | null | undefined,
): ReviewSeatCount | null {
  const seats = (attempts ?? []).filter((row) => row.role === "attempt");
  if (seats.length === 0) return null;
  const success = seats.filter((row) => row.status === "success").length;
  const failures = seats.filter((row) => row.status === "failure").length;
  const interrupted = seats.filter((row) => row.status === "cancelled").length;
  const parts = [`${success}/${seats.length} 席位成功`];
  if (failures > 0) parts.push(`${failures} 路失败`);
  if (interrupted > 0) parts.push(`${interrupted} 路中断`);
  return { success, total: seats.length, failures, interrupted, text: parts.join(" · ") };
}

export function SeatCount({
  attempts,
}: {
  attempts: readonly { role: string; status: string }[] | null | undefined;
}) {
  const count = reviewSeatCount(attempts);
  if (count === null) return null;
  return (
    <span className="ck-wb-seat-count" data-seat-count={count.text}>
      {`${count.success}/${count.total} 席位成功`}
      {count.failures > 0 ? (
        <span className="ck-wb-seat-fail" data-seat-fail-icon="circle-x">
          {" · "}
          <CircleXIcon className="ck-wb-icon ck-wb-icon-state" />
          {`${count.failures} 路失败`}
        </span>
      ) : null}
      {count.interrupted > 0 ? ` · ${count.interrupted} 路中断` : null}
    </span>
  );
}
