/**
 * Stop the verification host this run started, then delete its scratch home.
 * Evidence under artifacts/verify stays. A PID is signaled only when its cwd
 * and command line still match the recorded host.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { descendants, isVerificationProcess, readProc } from "./proc.mjs";

function snapshotTree(supervisorPid, cwd) {
  const supervisor = readProc(supervisorPid);
  if (!supervisor || !isVerificationProcess(supervisor, cwd)) return [];
  const rows = [];
  for (const pid of descendants(supervisorPid)) {
    const proc = readProc(pid);
    if (!proc || proc.cwd !== cwd || proc.starttime === undefined) continue;
    rows.push({ pid, starttime: proc.starttime, cmd: proc.cmd });
  }
  return rows;
}

function signalSnapshot(rows, cwd, signal) {
  const signaled = [];
  for (const row of [...rows].reverse()) {
    const proc = readProc(row.pid);
    if (!proc || proc.starttime !== row.starttime || proc.cwd !== cwd) continue;
    try {
      process.kill(row.pid, signal);
      signaled.push({ pid: row.pid, signal });
    } catch {
      // Already exited.
    }
  }
  return signaled;
}

function stillMatching(rows, cwd) {
  return rows.filter((row) => {
    const proc = readProc(row.pid);
    return proc !== null && proc.starttime === row.starttime && proc.cwd === cwd;
  });
}

const statePath = process.env.VERIFY_STATE;
const evidenceDir = process.env.VERIFY_EVIDENCE;
if (!statePath || !evidenceDir) {
  process.stderr.write("cleanup requires VERIFY_STATE and VERIFY_EVIDENCE\n");
  process.exit(1);
}

function writeReport(report) {
  writeFileSync(`${evidenceDir}/cleanup.json`, `${JSON.stringify(report, null, 2)}\n`);
}

let state = null;
try {
  state = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
  writeReport({ ok: true, stopped: false, reason: "no host state" });
  process.exit(0);
}

if (state.status === "stopped") {
  removeScratch(state);
  writeReport({ ok: true, stopped: false, reason: "already stopped", scratchRemoved: true });
  process.exit(0);
}

const snapshot = snapshotTree(state.supervisorPid, state.cwd);
if (snapshot.length === 0) {
  state.status = "stopped";
  state.stoppedAt = new Date().toISOString();
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  removeScratch(state);
  writeReport({
    ok: true,
    stopped: false,
    reason: "recorded supervisor is gone or no longer matches the verification host",
    supervisorPid: state.supervisorPid,
  });
  process.exit(0);
}

const signaled = signalSnapshot(snapshot, state.cwd, "SIGTERM");
const deadline = Date.now() + 15_000;
while (Date.now() < deadline && stillMatching(snapshot, state.cwd).length > 0) {
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (stillMatching(snapshot, state.cwd).length > 0) {
  signaled.push(...signalSnapshot(snapshot, state.cwd, "SIGKILL"));
}
await new Promise((resolve) => setTimeout(resolve, 300));
const remaining = stillMatching(snapshot, state.cwd).map((row) => row.pid);

state.status = remaining.length === 0 ? "stopped" : "stop-failed";
state.stoppedAt = new Date().toISOString();
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
removeScratch(state);

const report = {
  ok: remaining.length === 0,
  signaled,
  remaining,
  evidenceDir,
  scratchRemoved: true,
};
writeReport(report);
if (remaining.length > 0) {
  process.stderr.write(`cleanup left verification pids running: ${remaining.join(", ")}\n`);
  process.exit(1);
}

function removeScratch(current) {
  const root = current.scratchRoot;
  if (typeof root !== "string" || root.length === 0) return;
  let real;
  try {
    real = realpathSync(root);
  } catch {
    return;
  }
  if (!real.startsWith("/tmp/verify-councilkit.")) {
    process.stderr.write(`refusing to delete scratch outside /tmp/verify-councilkit.: ${real}\n`);
    process.exit(1);
  }
  rmSync(real, { recursive: true, force: true });
}
