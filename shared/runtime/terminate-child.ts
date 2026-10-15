import type { ChildProcess } from "node:child_process";

const DEFAULT_GRACE_MS = 1_000;
const DRAIN_POLL_MS = 25;

/**
 * SIGTERM a spawned child, then SIGKILL if it is still running after graceMs.
 * `group` signals a detached leader's process group. Group SIGKILL runs only
 * when that group SIGTERM landed. A failed group signal falls back to
 * `child.kill` and must not signal a process-group id that can be reused.
 *
 * The leader exiting does not cancel group escalation while original members
 * remain (they ignore SIGTERM and outlive the leader). Escalation is skipped
 * when the leader pid is alive again (the id was reused) or the group is
 * empty. The non-group path still clears its timer when the child exits.
 *
 * Occupancy is rechecked until the grace deadline. A descendant that exits
 * during SIGTERM cleanup cancels the timer instead of holding the caller for
 * the rest of the grace.
 *
 * The escalation timer stays referenced so the SIGKILL still runs when the
 * caller has nothing else keeping the loop alive.
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
  let drainTimer: ReturnType<typeof setInterval> | null = null;

  const stopDrainWatch = (): void => {
    if (drainTimer === null) return;
    clearInterval(drainTimer);
    drainTimer = null;
  };
  const release = (): void => {
    stopDrainWatch();
    clearTimeout(timer);
    child.off("exit", onExit);
  };

  const timer = setTimeout(() => {
    release();
    if (groupSignaled && pid !== undefined && shouldEscalateGroup(child, pid)) {
      if (signalGroup(pid, "SIGKILL")) return;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, graceMs);
  const onExit = (): void => {
    if (!groupSignaled || pid === undefined || !groupOccupiedByOriginalMembers(pid)) {
      release();
      return;
    }
    const groupPid = pid;
    drainTimer = setInterval(() => {
      if (groupOccupiedByOriginalMembers(groupPid)) return;
      release();
    }, DRAIN_POLL_MS);
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
  if (!delivered) release();
}

function shouldEscalateGroup(child: ChildProcess, pid: number): boolean {
  const leaderGone = child.exitCode !== null || child.signalCode !== null;
  return !leaderGone || groupOccupiedByOriginalMembers(pid);
}

/**
 * True when `pid` is not a live process and its process group still has a
 * member. A live pid after the leader's exit belongs to a new process.
 * While any original member keeps pgid == pid, the kernel will not reuse pid.
 */
function groupOccupiedByOriginalMembers(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (signalTargetsLiveProcess(pid)) return false;
  return signalTargetsLiveProcess(-pid);
}

function signalTargetsLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
