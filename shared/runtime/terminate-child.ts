import type { ChildProcess } from "node:child_process";

const DEFAULT_GRACE_MS = 1_000;

/**
 * SIGTERM a spawned child, then SIGKILL if it is still running after graceMs.
 * `group` signals a detached leader's process group. Group SIGKILL runs only
 * when that group SIGTERM landed. A failed group signal falls back to
 * `child.kill` and must not signal a process-group id that can be reused.
 * The escalation timer stays referenced until exit so the SIGKILL still runs
 * when the caller has nothing else keeping the loop alive.
 */
export function terminateChild(
  child: ChildProcess,
  options?: { graceMs?: number; group?: boolean },
): void {
  const graceMs = options?.graceMs ?? DEFAULT_GRACE_MS;
  const pid = child.pid;
  const wantGroup = options?.group === true && typeof pid === "number" && pid > 0;
  // Set before the timer can fire. graceMs 0 still waits until this turn ends.
  let groupSignaled = false;

  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (groupSignaled && pid !== undefined && signalGroup(pid, "SIGKILL")) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, graceMs);
  const onExit = (): void => {
    clearTimeout(timer);
  };
  child.once("exit", onExit);

  if (wantGroup && pid !== undefined) groupSignaled = signalGroup(pid, "SIGTERM");
  if (groupSignaled) return;

  let delivered = false;
  try {
    delivered = child.kill("SIGTERM");
  } catch {
    delivered = false;
  }
  if (!delivered) {
    clearTimeout(timer);
    child.off("exit", onExit);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}
