import type { ChildProcess } from "node:child_process";

const DEFAULT_GRACE_MS = 1_000;

/**
 * SIGTERM a spawned child, then SIGKILL if it is still running after graceMs.
 * `group` is for a detached leader whose pid is the process group. A failed
 * group SIGTERM does not schedule a group SIGKILL, so a reused process-group
 * id is not signaled. The escalation timer stays referenced until exit so the
 * SIGKILL still runs when the caller has nothing else keeping the loop alive.
 */
export function terminateChild(
  child: ChildProcess,
  options?: { graceMs?: number; group?: boolean },
): void {
  const graceMs = options?.graceMs ?? DEFAULT_GRACE_MS;
  const pid = child.pid;
  const group = options?.group === true && typeof pid === "number" && pid > 0;

  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (group && pid !== undefined && signalGroup(pid, "SIGKILL")) return;
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

  let delivered = false;
  if (group && pid !== undefined) delivered = signalGroup(pid, "SIGTERM");
  if (!delivered) {
    try {
      delivered = child.kill("SIGTERM");
    } catch {
      delivered = false;
    }
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
