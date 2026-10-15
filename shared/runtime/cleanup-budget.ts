/**
 * Shared cleanup abort budget for the CLI turn runner and the in-app real call.
 *
 * One timer covers cancel → observe → ACK → close. Disposing clears the timer
 * and aborts with "cleanup-disposed" only when the signal is not already
 * aborted, so a fired "cleanup-deadline" is never replaced.
 * Node timers are objects with unref; browsers return a number.
 */

export const CLEANUP_BUDGET_MS = 10_000;

const DEADLINE_REASON = "cleanup-deadline";
const DISPOSED_REASON = "cleanup-disposed";

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
}

function armDeadline(controller: AbortController, budgetMs: number): () => void {
  const timer = setTimeout(() => controller.abort(DEADLINE_REASON), budgetMs);
  unrefTimer(timer);
  return () => clearTimeout(timer);
}

export interface CleanupBudget {
  signal: AbortSignal;
  dispose: () => void;
}

export interface PreparedCleanupBudget extends CleanupBudget {
  /** Starts the deadline on the first call. A later call does not reset it. */
  arm: () => void;
}

/**
 * Timer stays unarmed until `arm()`, so a path that never cleans up never
 * starts one. `arm()` after `dispose()` may start another timer; the signal
 * reason stays on the first abort.
 */
export function prepareCleanupBudget(budgetMs: number = CLEANUP_BUDGET_MS): PreparedCleanupBudget {
  const controller = new AbortController();
  let clear: (() => void) | null = null;
  return {
    signal: controller.signal,
    arm: () => {
      if (clear !== null) return;
      clear = armDeadline(controller, budgetMs);
    },
    dispose: () => {
      if (clear !== null) clear();
      clear = null;
      if (!controller.signal.aborted) controller.abort(DISPOSED_REASON);
    },
  };
}

/** Arm the budget immediately. `dispose` is safe to call unbound. */
export function startCleanupBudget(budgetMs: number = CLEANUP_BUDGET_MS): CleanupBudget {
  const budget = prepareCleanupBudget(budgetMs);
  budget.arm();
  return { signal: budget.signal, dispose: budget.dispose };
}
