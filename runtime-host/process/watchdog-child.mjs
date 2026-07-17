#!/usr/bin/env node
/**
 * CouncilKit process watchdog child (dependency-free by design).
 *
 * The watchdog is the direct parent of one Driver process and owns its
 * process group. Stdio plumbing (spawned with five pipes by the Host):
 *
 *   fd0  Host   -> watchdog -> driver stdin
 *   fd1  driver stdout -> watchdog -> Host
 *   fd2  watchdog's own diagnostics (Host logs them, capped)
 *   fd3  control channel, newline-delimited JSON, both directions
 *   fd4  driver stderr -> watchdog -> Host (Host keeps the bounded ring)
 *
 * Contract:
 * - Host -> watchdog: { type: "spawn", executable, argv, cwd, env }
 *                     { type: "close-stdin" }
 *                     { type: "kill", signal: "SIGTERM"|"SIGKILL", graceMs? }
 *                     { type: "shutdown", graceMs? }
 * - watchdog -> Host: { type: "supervised", pid, pgid, startedAt }
 *                     { type: "spawn-error", message }
 *                     { type: "exit", pid, code, signal }
 *                     { type: "reaped", reason }
 *
 * If the control channel hits EOF (Host died or hung up), the watchdog
 * SIGTERMs the whole process group and escalates to SIGKILL within
 * REAP_GRACE_MS, then exits. No Driver process may outlive its Host by more
 * than that window.
 */
import { spawn } from "node:child_process";
import net from "node:net";

const REAP_GRACE_MS = 5000;

const hostStdin = process.stdin;
const hostStdout = process.stdout;
const control = new net.Socket({ fd: 3, readable: true, writable: true });
const driverStderrOut = new net.Socket({ fd: 4, readable: false, writable: true });

/** @type {import("node:child_process").ChildProcess | null} */
let driver = null;
let driverPid = null;
let reaping = false;

function send(message) {
  try {
    if (control && !control.destroyed) {
      control.write(`${JSON.stringify(message)}\n`);
    }
  } catch {
    // Control channel is gone; the reap path will handle teardown.
  }
}

function killGroup(signal) {
  if (driverPid === null) return;
  try {
    process.kill(-driverPid, signal);
  } catch {
    // Group already gone (ESRCH) — nothing to do.
  }
}

function exitSoon(code, delayMs = 25) {
  setTimeout(() => process.exit(code), delayMs).unref();
}

/**
 * Reap the entire process group: SIGTERM first, SIGKILL after the grace
 * window, then the watchdog exits. Idempotent.
 */
function reap(reason, graceMs = REAP_GRACE_MS) {
  if (reaping) return;
  reaping = true;
  killGroup("SIGTERM");
  setTimeout(
    () => {
      killGroup("SIGKILL");
      send({ type: "reaped", reason });
      exitSoon(0);
    },
    Math.max(0, graceMs),
  ).unref();
}

function handleSpawn(message) {
  if (driver) {
    send({ type: "spawn-error", message: "driver already spawned" });
    return;
  }
  let child;
  try {
    child = spawn(message.executable, message.argv ?? [], {
      cwd: message.cwd,
      env: message.env ?? {},
      detached: true, // new process group; PGID === driver pid
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    send({ type: "spawn-error", message: String(error?.message ?? error) });
    exitSoon(1);
    return;
  }

  child.on("error", (error) => {
    send({ type: "spawn-error", message: String(error?.message ?? error) });
    exitSoon(1);
  });

  driver = child;
  driverPid = child.pid ?? null;

  hostStdin.pipe(child.stdin);
  child.stdout.pipe(hostStdout);
  child.stderr.pipe(driverStderrOut);

  child.on("exit", (code, signal) => {
    send({ type: "exit", pid: driverPid, code, signal });
    driverPid = null;
    // Our supervised process is gone; nothing left to guard.
    exitSoon(reaping ? 0 : code === 0 ? 0 : 1);
  });

  send({
    type: "supervised",
    pid: child.pid,
    pgid: child.pid, // detached: driver is the process-group leader
    startedAt: new Date().toISOString(),
  });
}

function handleControl(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // malformed control frame: ignore, never crash the watchdog
  }
  switch (message?.type) {
    case "spawn":
      handleSpawn(message);
      break;
    case "close-stdin":
      try {
        driver?.stdin.end();
      } catch {
        // stdin already closed.
      }
      break;
    case "kill": {
      const signal = message.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
      if (signal === "SIGKILL") {
        killGroup("SIGKILL");
      } else {
        reap("host-requested-kill", message.graceMs ?? REAP_GRACE_MS);
      }
      break;
    }
    case "shutdown":
      reap("host-shutdown", message.graceMs ?? REAP_GRACE_MS);
      break;
    default:
      break; // unknown control messages are ignored
  }
}

let controlBuffer = "";
control.setEncoding("utf8");
control.on("data", (chunk) => {
  controlBuffer += chunk;
  let index = controlBuffer.indexOf("\n");
  while (index !== -1) {
    const line = controlBuffer.slice(0, index).trim();
    controlBuffer = controlBuffer.slice(index + 1);
    if (line) handleControl(line);
    index = controlBuffer.indexOf("\n");
  }
});

// Host death/hangup: control EOF starts the bounded reap window.
control.on("end", () => reap("control-eof"));
control.on("close", () => reap("control-closed"));
control.on("error", () => reap("control-error"));

process.on("uncaughtException", () => {
  reap("watchdog-fault", 250);
});
process.on("unhandledRejection", () => {
  reap("watchdog-fault", 250);
});

// The watchdog must never outlive its purpose: if nothing was ever spawned
// and the Host goes silent, control EOF above still fires. Keep the event
// loop alive only through the stdio handles.
