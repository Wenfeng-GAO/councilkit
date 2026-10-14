/**
 * One event-stream connection ended without a terminal event. Decide whether
 * another follow from `consumedSeq` can still deliver one.
 *
 * A running execution can still emit, so the caller reconnects. A terminal
 * execution reconnects only while the host's lastSeq is ahead of the cursor
 * and either this connection delivered something (the tail may still be
 * buffered) or we have not yet spent the one empty catch-up. A connection
 * that delivers nothing after that, or a cursor that is already caught up,
 * cannot make progress: ACK released the buffer, or there is no unseen seq.
 * Reconnecting there is a hot loop — the discussion driver has no deadline.
 */

export interface FollowCloseSnapshot {
  state: string;
  lastSeq: number;
}

export type FollowAfterClose =
  | { action: "reconnect"; catchUpSpent: boolean }
  | { action: "stop"; reason: "lost" | "exhausted" };

export function decideFollowAfterClose(input: {
  snapshot: FollowCloseSnapshot | null;
  consumedSeq: number;
  /** True when this connection delivered at least one event. */
  progressed: boolean;
  /** An earlier connection already delivered nothing while the host was terminal and ahead. */
  catchUpSpent: boolean;
}): FollowAfterClose {
  const snapshot = input.snapshot;
  if (!snapshot) return { action: "stop", reason: "lost" };
  if (snapshot.state === "running") {
    return { action: "reconnect", catchUpSpent: false };
  }
  const ahead = Number.isFinite(snapshot.lastSeq) && snapshot.lastSeq > input.consumedSeq;
  if (!ahead) return { action: "stop", reason: "exhausted" };
  if (input.progressed) return { action: "reconnect", catchUpSpent: false };
  if (!input.catchUpSpent) return { action: "reconnect", catchUpSpent: true };
  return { action: "stop", reason: "exhausted" };
}
