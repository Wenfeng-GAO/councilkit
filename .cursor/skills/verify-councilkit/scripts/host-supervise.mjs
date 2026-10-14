/**
 * Parent of one verification Runtime Host.
 *
 * launch.sh records this process and cleanup signals only this PID (then the
 * child tree it spawned). It is not a process-name sweeper.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { descendants, readProc } from "./proc.mjs";

const args = process.argv.slice(2);
let logPath = "";
let childPidFile = "";
const command = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--log") logPath = args[++i] ?? "";
  else if (args[i] === "--child-pid-file") childPidFile = args[++i] ?? "";
  else if (args[i] === "--") {
    command.push(...args.slice(i + 1));
    break;
  } else {
    process.stderr.write(`unknown argument ${args[i]}\n`);
    process.exit(2);
  }
}
if (!logPath || !childPidFile || command.length === 0) {
  process.stderr.write(
    "usage: host-supervise.mjs --log FILE --child-pid-file FILE -- <command> [args]\n",
  );
  process.exit(2);
}

const logFd = openSync(logPath, "a");
const child = spawn(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", logFd, logFd],
  detached: false,
});
writeFileSync(childPidFile, `${child.pid}\n`);

function snapshotTree(pid) {
  const rows = [];
  for (const target of descendants(pid)) {
    const proc = readProc(target);
    if (!proc || proc.starttime === undefined) continue;
    rows.push({ pid: target, starttime: proc.starttime });
  }
  return rows;
}

function signalSnapshot(rows, signal) {
  for (const row of [...rows].reverse()) {
    const proc = readProc(row.pid);
    if (!proc || proc.starttime !== row.starttime) continue;
    try {
      process.kill(row.pid, signal);
    } catch {
      // Already exited.
    }
  }
}

let stopping = false;
let snapshot = [];
function stop(signal) {
  if (stopping) return;
  stopping = true;
  snapshot = snapshotTree(child.pid);
  signalSnapshot(snapshot, signal);
  const timer = setTimeout(() => {
    signalSnapshot(snapshot, "SIGKILL");
  }, 12_000);
  timer.unref?.();
}

process.on("SIGHUP", () => {
  // The launching shell may exit. The host stays until cleanup signals SIGTERM.
});
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

child.on("exit", (code, signal) => {
  try {
    closeSync(logFd);
  } catch {
    // The log fd may already be closed on a second exit event.
  }
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
