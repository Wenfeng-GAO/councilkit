import { spawnSync } from "node:child_process";

export interface ProcessFingerprint {
  pid: number;
  pgid: number;
  startKey: string;
}

export function fingerprintPid(pid: number): ProcessFingerprint | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const state = readState(pid);
  if (state === null || /^Z/i.test(state)) return null;
  const pgid = readPgid(pid);
  const startKey = readStartKey(pid);
  if (pgid === null || startKey === null) return null;
  return { pid, pgid, startKey };
}

export function waitForLeaderFingerprint(pid: number, timeoutMs = 500): ProcessFingerprint | null {
  const deadline = Date.now() + timeoutMs;
  let last = fingerprintPid(pid);
  while (Date.now() < deadline) {
    last = fingerprintPid(pid);
    if (last && isProcessGroupLeader(last)) return last;
    spawnSync("/bin/sleep", ["0.02"], { shell: false, timeout: 200 });
  }
  return last;
}

export function sameProcess(
  expected: ProcessFingerprint,
  live: ProcessFingerprint | null,
): boolean {
  return (
    live !== null &&
    live.pid === expected.pid &&
    live.pgid === expected.pgid &&
    live.startKey === expected.startKey
  );
}

export function listGroupPids(pgid: number): number[] {
  if (!Number.isInteger(pgid) || pgid <= 0) return [];
  const listed = spawnSync("pgrep", ["-g", String(pgid)], { encoding: "utf8", timeout: 2_000 });
  if (listed.status === 0 && listed.stdout.trim().length > 0) {
    return uniquePids(listed.stdout.split(/\s+/).map((row) => Number.parseInt(row, 10)));
  }
  const ps = spawnSync("ps", ["-ax", "-o", "pid=,pgid="], { encoding: "utf8", timeout: 2_000 });
  if (ps.status !== 0) return [];
  const found: number[] = [];
  for (const line of ps.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number.parseInt(parts[0] ?? "", 10);
    const group = Number.parseInt(parts[1] ?? "", 10);
    if (pid > 0 && group === pgid) found.push(pid);
  }
  return uniquePids(found);
}

export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pgid) || pgid <= 0) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    for (const pid of listGroupPids(pgid)) {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
  }
}

export function groupHasLiveMembers(pgid: number, expected?: ProcessFingerprint): boolean {
  const members = listGroupPids(pgid);
  if (members.length === 0) return false;
  if (!expected) return members.some((pid) => fingerprintPid(pid) !== null);
  return members.some((pid) => {
    const live = fingerprintPid(pid);
    return live !== null && live.pgid === expected.pgid;
  });
}

export function waitForGroupIdle(
  pgid: number,
  timeoutMs: number,
  expected?: ProcessFingerprint,
): boolean {
  const deadline = Date.now() + timeoutMs;
  while (groupHasLiveMembers(pgid, expected) && Date.now() < deadline) {
    spawnSync("/bin/sleep", ["0.05"], { shell: false, timeout: 200 });
  }
  return !groupHasLiveMembers(pgid, expected);
}

export function isProcessGroupLeader(fp: ProcessFingerprint): boolean {
  return fp.pid === fp.pgid && fp.pgid > 1;
}

function readState(pid: number): string | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "state="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status !== 0) return null;
  const state = result.stdout.trim();
  return state.length > 0 ? state : null;
}

function readPgid(pid: number): number | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status !== 0) return null;
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function readStartKey(pid: number): string | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status !== 0) return null;
  const key = result.stdout.trim();
  return key.length > 0 ? key : null;
}

function uniquePids(values: number[]): number[] {
  return [...new Set(values.filter((pid) => Number.isInteger(pid) && pid > 0))];
}
