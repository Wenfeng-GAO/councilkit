/**
 * No-progress watchdog shared by the per-turn drivers (B4, #279).
 *
 * Product rule: while a turn is generating, the only user-visible timeout is
 * "no model output for `streamIdleMs`" (120s). Every output chunk calls
 * `touch()`, which restarts the window, so a long report that keeps emitting
 * is never cut; `turnMs` stays only as a far-away safety ceiling.
 */
export interface IdleWatchdog {
  /** Output arrived: restart the no-progress window. No-op once cleared. */
  touch(): void;
  /** Stop for good (turn settled, cancelled or the process exited). */
  clear(): void;
}

export function startIdleWatchdog(idleMs: number, onIdle: () => void): IdleWatchdog {
  let timer: NodeJS.Timeout | undefined;
  let cleared = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (cleared) return;
      cleared = true;
      onIdle();
    }, idleMs);
  };
  arm();
  return {
    touch() {
      if (!cleared) arm();
    },
    clear() {
      cleared = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
