export interface SeatAttemptRef {
  attemptId: string;
  agentName: string;
  driverId: string;
  modelId: string;
}

/** Map a report roster / 过程对比 row onto a live attempt id. */
export function matchSeatAttempt(
  attempts: readonly SeatAttemptRef[],
  name: string,
  driver?: string,
): SeatAttemptRef | undefined {
  const named = attempts.filter((row) => row.agentName === name);
  if (named.length === 0) return undefined;
  if (named.length === 1 || driver === undefined || driver.length === 0) return named[0];
  return (
    named.find(
      (row) => driver === `${row.driverId}/${row.modelId}` || driver.startsWith(`${row.driverId}/`),
    ) ?? named[0]
  );
}

export function formatAttemptMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

export function inspectorDuration(
  receiptMs: number | null,
  span: { hasTimeline: boolean; spanMs: number | null; eventCount: number } | null,
  status?: string,
): string | null {
  if (status === "running") {
    return receiptMs === null ? null : formatAttemptMs(receiptMs);
  }
  if (span?.hasTimeline && span.spanMs !== null) {
    const spanText = formatAttemptMs(span.spanMs);
    if (receiptMs === null) return spanText;
    return `${formatAttemptMs(receiptMs)} · 过程 ${spanText}`;
  }
  if (receiptMs === null) return null;
  if (span && span.eventCount > 0 && !span.hasTimeline) {
    return `${formatAttemptMs(receiptMs)} · 过程无时间轴`;
  }
  return formatAttemptMs(receiptMs);
}
