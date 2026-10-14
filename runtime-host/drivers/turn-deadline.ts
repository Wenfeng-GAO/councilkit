/**
 * A late callback may settle a turn only while that turn is still the active,
 * unsettled owner and cancel/close has not latched it.
 *
 * Cancel waits out an interrupt or a process exit. Turn, idle, dispatch-ack,
 * and stdout-drain timers keep running across that wait unless they are
 * cleared when the latch is taken. A protocol notification that fails the
 * turn (Codex `error`, `thread/compacted`) is the same class: it can arrive
 * on the open stream during that wait. This guard is the backstop for a
 * callback that was already queued, a timer a late frame re-armed, or one of
 * those notifications. Without it, the callback reports timeout or a
 * retryable failure instead of user_cancelled.
 */
export function deadlineMaySettle(
  turn: { cancelling?: boolean; settled?: boolean },
  isActive: boolean,
): boolean {
  return isActive && turn.cancelling !== true && turn.settled !== true;
}
