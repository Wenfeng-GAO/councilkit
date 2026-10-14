/**
 * A deadline may settle a turn only while that turn is still the active,
 * unsettled owner and cancel/close has not latched it.
 *
 * Cancel waits out an interrupt or a process exit. Turn, idle, dispatch-ack,
 * and stdout-drain timers keep running across that wait unless they are
 * cleared when the latch is taken. This guard is the backstop for a callback
 * that was already queued, or for an idle timer a late frame re-armed. Without
 * both, the deadline reports timeout or a retryable failure instead of
 * user_cancelled.
 */
export function deadlineMaySettle(
  turn: { cancelling?: boolean; settled?: boolean },
  isActive: boolean,
): boolean {
  return isActive && turn.cancelling !== true && turn.settled !== true;
}
