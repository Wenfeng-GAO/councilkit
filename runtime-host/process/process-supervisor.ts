/**
 * Host-side process supervisor (U3).
 *
 * The supervisor is the Host-side client of the watchdog control protocol
 * implemented by `watchdog-child.mjs`. Each Driver process gets one watchdog
 * child, spawned with five pipes:
 *
 *   fd0  Host -> watchdog -> Driver stdin
 *   fd1  Driver stdout -> watchdog -> Host
 *   fd2  watchdog diagnostics (logged here, capped)
 *   fd3  newline-delimited JSON control channel, both directions
 *   fd4  Driver stderr -> watchdog -> Host (pass-through, never buffered here)
 *
 * Guarantees enforced in this module:
 * - A Driver is usable only after the watchdog reports `supervised`, which
 *   eliminates the spawn -> registration orphan window.
 * - Environment hygiene: the watchdog and the Driver receive ONLY inherited
 *   variables named in `envInherit` plus Driver-declared `envSet`, filtered
 *   through an explicit denylist (tokens, proxies, dynamic loading, debug and
 *   injection variables). The rest of the Host environment is never passed.
 * - If the watchdog itself dies while its Driver may still be alive, the
 *   supervisor SIGKILLs the recorded process group (-pgid) on its own.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";
import { TIMEOUTS } from "@shared/runtime/contracts";
import { type RuntimeError, makeError } from "@shared/runtime/errors";
import type { HostConfig } from "../config";
import type { Logger } from "../logging";

/** Newline-delimited JSON control frames on fd3 are capped at 64 KiB. */
export const CONTROL_LINE_CAP_BYTES = 64 * 1024;

/** Watchdog diagnostics (fd2) are kept in a small ring and logged on exit. */
const WATCHDOG_DIAGNOSTIC_RING_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DriverSpawnSpec {
  participantId: string;
  /** MUST be absolute — anything else is rejected. Never goes through a shell. */
  executable: string;
  /** Fixed argv, passed through as-is (no shell anywhere). */
  argv: string[];
  /** Participant-dedicated dir; must exist or be creatable under driverWorkRoot. */
  cwd: string;
  /** Allowlisted variables copied from process.env (exact names only). */
  envInherit: readonly string[];
  /** Driver-declared variables (e.g. CLD_SKIP_UPDATE_CHECK, CLD_CLAUDE_BIN). */
  envSet: Record<string, string>;
}

export interface DriverProcess {
  readonly participantId: string;
  /** Driver pid, null until the watchdog reports `supervised`. */
  readonly pid: number | null;
  /** Driver process-group id (detached group: pgid === driver pid). */
  readonly pgid: number | null;
  /** Pid of the watchdog child that parents this Driver. */
  readonly watchdogPid: number;
  /** Bytes written here reach Driver stdin via the watchdog. */
  readonly stdin: Writable;
  /** Driver stdout (pass-through; NDJSON framing/caps live in the Driver layer). */
  readonly stdout: Readable;
  /** Driver stderr via fd4 (pass-through; bounded ring lives in the Driver layer). */
  readonly stderr: Readable;
  /**
   * Events:
   * - "supervised" ({ pid, pgid, startedAt })
   * - "exit" ({ code, signal }) — the Driver process terminated
   * - "spawn-error" ({ message }) — the watchdog failed to spawn the Driver
   * - "watchdog-exit" ({ code, signal }) — the watchdog died unexpectedly
   */
  readonly events: EventEmitter;
  /** Resolves on "supervised"; rejects on spawn-error/exit/watchdog death/timeout. */
  waitSupervised(timeoutMs: number): Promise<void>;
  /** Signal the whole Driver process group via the watchdog control channel. */
  kill(signal: "SIGTERM" | "SIGKILL", graceMs?: number): void;
  /** Close Driver stdin (EOF) without killing the process. */
  closeStdin(): void;
  /** Watchdog shutdown + bounded wait for exit, then SIGKILL escalation. */
  shutdown(graceMs?: number): Promise<void>;
  /**
   * Test-only hook: feed a raw line into the inbound fd3 parser exactly as if
   * the watchdog had sent it (including the 64 KiB cap enforcement).
   */
  __testInjectControlLine(line: string): void;
}

export interface ProcessSupervisor {
  /** "driver-exit" (participantId, code, signal) for every Driver termination. */
  readonly events: EventEmitter;
  /** Resolves right after the watchdog is spawned; callers await waitSupervised. */
  spawnDriver(spec: DriverSpawnSpec): Promise<DriverProcess>;
  /** Processes currently supervised (feeds the global quota of 16). */
  liveCount(): number;
  /** Groups the watchdog had to SIGKILL-escalate itself ("reaped" frames). */
  reapedByWatchdogCount(): number;
  /** Groups the supervisor reaped via pgid after the watchdog died unexpectedly. */
  reapedAfterWatchdogDeath(): number;
  /** Shut down every live Driver; used on Host exit. */
  shutdownAll(graceMs?: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Environment hygiene
// ---------------------------------------------------------------------------

const ENV_DENY_EXACT: ReadonlySet<string> = new Set(["NODE_OPTIONS", "BASH_ENV", "ENV"]);
const ENV_DENY_PREFIXES: readonly string[] = ["DYLD_", "LD_"];
const ENV_DENY_PATTERN = /TOKEN|SECRET|KEY|PASSWORD|PROXY/i;

/**
 * Denylist decision for one environment variable name. Exact denies
 * (NODE_OPTIONS, BASH_ENV, ENV) and prefix denies (DYLD_*, LD_*) always apply;
 * the TOKEN/SECRET/KEY/PASSWORD/PROXY pattern is waived only for names the
 * caller explicitly inherited by exact name via `envInherit` (e.g. PATH/HOME
 * style entries are always fine, and a deliberate exact-name inherit wins).
 */
export function isDeniedEnvName(name: string, explicitInherit = false): boolean {
  if (ENV_DENY_EXACT.has(name)) return true;
  if (ENV_DENY_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if (explicitInherit) return false;
  return ENV_DENY_PATTERN.test(name);
}

/** Explicit denylist filter over a final env object. */
export function filterDeniedEnv(
  env: Record<string, string>,
  options: { exemptInheritedNames?: readonly string[] } = {},
): Record<string, string> {
  const exempt = new Set(options.exemptInheritedNames ?? []);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (isDeniedEnvName(name, exempt.has(name))) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Build the environment for BOTH the watchdog and the Driver: only
 * `envInherit` names copied from `sourceEnv`, overlaid with `envSet`, then
 * passed through the denylist filter. Nothing else from the Host environment
 * can leak through.
 */
export function buildSupervisedEnv(
  envInherit: readonly string[],
  envSet: Record<string, string>,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const name of envInherit) {
    const value = sourceEnv[name];
    if (typeof value === "string") merged[name] = value;
  }
  for (const [name, value] of Object.entries(envSet)) {
    merged[name] = value;
  }
  return filterDeniedEnv(merged, { exemptInheritedNames: envInherit });
}

// ---------------------------------------------------------------------------
// Bounded byte ring (stderr ring users arrive with the Driver layer)
// ---------------------------------------------------------------------------

export interface BoundedRing {
  append(chunk: Buffer | string): void;
  text(): string;
  byteLength(): number;
  clear(): void;
}

/** Keeps only the most recent `limitBytes` bytes appended. */
export function createBoundedRing(limitBytes: number): BoundedRing {
  let chunks: Buffer[] = [];
  let total = 0;
  return {
    append(chunk) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (buffer.length === 0) return;
      chunks.push(buffer);
      total += buffer.length;
      while (total > limitBytes && chunks.length > 0) {
        const excess = total - limitBytes;
        const head = chunks[0] as Buffer;
        if (head.length <= excess) {
          chunks.shift();
          total -= head.length;
        } else {
          chunks[0] = head.subarray(excess);
          total -= excess;
        }
      }
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
    byteLength() {
      return total;
    },
    clear() {
      chunks = [];
      total = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Participant cwd preparation
// ---------------------------------------------------------------------------

const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function spawnFailed(message: string, participantId?: string): RuntimeError {
  return makeError("DRIVER_SPAWN_FAILED", "prewarm", message.slice(0, 512), {
    ...(participantId ? { participantId } : {}),
  });
}

async function lstatIfExists(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Create (mkdir -p) and return the Participant-dedicated cwd
 * `<root>/<participantId>`. A symlink at the target is rejected, as are
 * participantIds that could escape `root`.
 */
export async function prepareParticipantCwd(root: string, participantId: string): Promise<string> {
  if (!isAbsolute(root)) {
    throw spawnFailed("driverWorkRoot must be an absolute path", participantId);
  }
  if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
    throw spawnFailed("participantId is not safe for a dedicated cwd", participantId);
  }
  await mkdir(root, { recursive: true });
  const target = join(root, participantId);
  const existing = await lstatIfExists(target);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw spawnFailed("participant cwd must not be a symlink", participantId);
    }
    if (!existing.isDirectory()) {
      throw spawnFailed("participant cwd exists and is not a directory", participantId);
    }
    return target;
  }
  await mkdir(target);
  return target;
}

// ---------------------------------------------------------------------------
// Supervisor internals
// ---------------------------------------------------------------------------

interface DriverRecord {
  readonly spec: DriverSpawnSpec;
  readonly child: ChildProcess;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly driverStderr: Readable;
  readonly control: Duplex;
  readonly events: EventEmitter;
  readonly diagnostics: BoundedRing;
  pid: number | null;
  pgid: number | null;
  supervised: boolean;
  /** Driver is known dead (watchdog "exit" frame or our own fallback reap). */
  driverSettled: boolean;
  spawnError: string | null;
  /** Watchdog exit is part of a requested/natural teardown, not a crash. */
  expectingWatchdogExit: boolean;
  watchdogHandled: boolean;
  watchdogExit: { code: number | null; signal: NodeJS.Signals | null } | null;
  controlBuffer: Buffer;
  exitWaiters: Set<() => void>;
}

export function createProcessSupervisor(deps: {
  config: HostConfig;
  logger: Logger;
}): ProcessSupervisor {
  const { config, logger } = deps;
  const records = new Set<DriverRecord>();
  const byParticipant = new Map<string, DriverRecord>();
  const supervisorEvents = new EventEmitter();
  let reapedByWatchdog = 0;
  let reapedAfterWatchdogDeathCount = 0;

  function reapGroup(pgid: number): void {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // ESRCH: the group is already gone — nothing to reap.
    }
  }

  function settleDriver(record: DriverRecord, code: number | null, signal: string | null): void {
    if (record.driverSettled) return;
    record.driverSettled = true;
    // Ownership-checked delete: a newer record can already hold the same
    // participantId slot (e.g. a per-turn respawn that did not await old
    // watchdog teardown). Only clobber the slot when it still points at THIS
    // record, so the duplicate guard in `spawnDriver` stays authoritative.
    if (byParticipant.get(record.spec.participantId) === record) {
      byParticipant.delete(record.spec.participantId);
    }
    record.events.emit("exit", { code, signal });
    supervisorEvents.emit("driver-exit", record.spec.participantId, code, signal);
  }

  function sendControl(record: DriverRecord, message: Record<string, unknown>): void {
    if (record.watchdogHandled || record.control.destroyed) return;
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > CONTROL_LINE_CAP_BYTES) {
      // Control frames are tiny; hitting this means a local protocol bug.
      closeAfterProtocolViolation(record, "outgoing control frame exceeds 64 KiB");
      return;
    }
    try {
      record.control.write(line);
    } catch {
      // Control pipe already gone; the watchdog exit path handles teardown.
    }
  }

  function closeAfterProtocolViolation(record: DriverRecord, reason: string): void {
    logger.diagnostic("watchdog-protocol-violation", reason, {
      participantId: record.spec.participantId,
      watchdogPid: record.child.pid ?? null,
    });
    record.control.destroy();
    try {
      record.child.kill("SIGKILL");
    } catch {
      // Watchdog already gone.
    }
    // The watchdog-exit handler performs the pgid fallback reap.
  }

  function handleControlLine(record: DriverRecord, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: { type?: unknown; [key: string]: unknown };
    try {
      message = JSON.parse(trimmed) as { type?: unknown };
    } catch {
      logger.diagnostic("watchdog-protocol", "ignoring malformed control frame", {
        participantId: record.spec.participantId,
      });
      return;
    }
    switch (message.type) {
      case "supervised": {
        record.pid = typeof message.pid === "number" ? message.pid : null;
        record.pgid = typeof message.pgid === "number" ? message.pgid : null;
        record.supervised = true;
        record.events.emit("supervised", {
          pid: record.pid,
          pgid: record.pgid,
          startedAt: typeof message.startedAt === "string" ? message.startedAt : null,
        });
        break;
      }
      case "spawn-error": {
        record.spawnError = String(message.message ?? "unknown spawn error").slice(0, 512);
        record.expectingWatchdogExit = true; // the watchdog exits itself after spawn-error
        record.events.emit("spawn-error", { message: record.spawnError });
        if (record.supervised && !record.driverSettled) {
          // The watchdog reports supervised synchronously and async spawn
          // failures (e.g. ENOENT) arrive as spawn-error right after; such a
          // driver is dead before it ever ran, and the watchdog is exiting.
          settleDriver(record, null, null);
        }
        break;
      }
      case "exit": {
        record.expectingWatchdogExit = true; // the watchdog exits once its Driver is gone
        settleDriver(
          record,
          typeof message.code === "number" ? message.code : null,
          typeof message.signal === "string" ? message.signal : null,
        );
        break;
      }
      case "reaped": {
        reapedByWatchdog += 1;
        logger.info("watchdog.reaped", {
          participantId: record.spec.participantId,
          reason: typeof message.reason === "string" ? message.reason : "unknown",
        });
        break;
      }
      default:
        break; // unknown control frames are ignored, like the watchdog does
    }
  }

  function handleControlChunk(record: DriverRecord, chunk: Buffer): void {
    if (record.watchdogHandled) return;
    record.controlBuffer = Buffer.concat([record.controlBuffer, chunk]);
    let index = record.controlBuffer.indexOf(0x0a);
    while (index !== -1) {
      const line = record.controlBuffer.subarray(0, index);
      record.controlBuffer = record.controlBuffer.subarray(index + 1);
      if (line.length > CONTROL_LINE_CAP_BYTES) {
        closeAfterProtocolViolation(record, "inbound control frame exceeds 64 KiB");
        return;
      }
      handleControlLine(record, line.toString("utf8"));
      if (record.watchdogHandled) return;
      index = record.controlBuffer.indexOf(0x0a);
    }
    if (record.controlBuffer.length > CONTROL_LINE_CAP_BYTES) {
      closeAfterProtocolViolation(record, "inbound control frame exceeds 64 KiB");
    }
  }

  function handleWatchdogExit(
    record: DriverRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (record.watchdogHandled) return;
    record.watchdogHandled = true;
    record.watchdogExit = { code, signal };
    const expected =
      record.expectingWatchdogExit || record.driverSettled || record.spawnError !== null;
    if (!expected) {
      // The watchdog died while its Driver may still be alive: the Host reaps
      // the recorded process group itself (ESRCH tolerated).
      if (record.pgid !== null && !record.driverSettled) {
        reapGroup(record.pgid);
        reapedAfterWatchdogDeathCount += 1;
        settleDriver(record, null, "SIGKILL");
        logger.diagnostic(
          "watchdog-exit",
          "watchdog died unexpectedly; driver group reaped via pgid",
          { participantId: record.spec.participantId, pgid: record.pgid },
        );
      } else {
        logger.diagnostic("watchdog-exit", "watchdog died before supervision completed", {
          participantId: record.spec.participantId,
        });
      }
      record.events.emit("watchdog-exit", { code, signal });
    }
    const diagnosticsText = record.diagnostics.text();
    if (diagnosticsText.length > 0) {
      logger.diagnostic("watchdog-stderr", diagnosticsText, {
        participantId: record.spec.participantId,
      });
    }
    for (const waiter of record.exitWaiters) waiter();
    record.exitWaiters.clear();
    records.delete(record);
    // Ownership-checked delete (see `settleDriver`): the watchdog OS process can
    // exit well after the driver `exit` control frame already settled this
    // record and freed the slot. A newer record reclaiming the same
    // participantId must not be clobbered by the stale watchdog exit.
    if (byParticipant.get(record.spec.participantId) === record) {
      byParticipant.delete(record.spec.participantId);
    }
  }

  function waitForWatchdogExit(record: DriverRecord, timeoutMs: number): Promise<boolean> {
    if (record.watchdogHandled) return Promise.resolve(true);
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        record.exitWaiters.delete(done);
        resolvePromise(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        record.exitWaiters.delete(done);
        resolvePromise(true);
      };
      record.exitWaiters.add(done);
    });
  }

  async function shutdownRecord(record: DriverRecord, graceMs: number): Promise<void> {
    if (!record.watchdogHandled) {
      record.expectingWatchdogExit = true;
      sendControl(record, { type: "shutdown", graceMs });
      const exited = await waitForWatchdogExit(record, graceMs + 1000);
      if (!exited) {
        try {
          record.child.kill("SIGKILL");
        } catch {
          // Watchdog already gone.
        }
        if (record.pgid !== null && !record.driverSettled) {
          reapGroup(record.pgid);
          settleDriver(record, null, "SIGKILL");
        }
        await waitForWatchdogExit(record, 1000);
      }
    }
    // Fallback: never leave a supervised group behind after shutdown().
    if (record.pgid !== null && !record.driverSettled) {
      reapGroup(record.pgid);
      settleDriver(record, null, "SIGKILL");
    }
  }

  function validateSpec(spec: DriverSpawnSpec): void {
    const fail = (message: string): never => {
      throw spawnFailed(message, spec?.participantId);
    };
    if (!spec || typeof spec.participantId !== "string" || spec.participantId.length === 0) {
      fail("participantId is required");
    }
    if (typeof spec.executable !== "string" || !isAbsolute(spec.executable)) {
      fail("executable must be an absolute path");
    }
    if (!Array.isArray(spec.argv) || spec.argv.some((arg) => typeof arg !== "string")) {
      fail("argv must be an array of strings");
    }
    if (typeof spec.cwd !== "string" || !isAbsolute(spec.cwd)) {
      fail("cwd must be an absolute path");
    }
    if (
      !Array.isArray(spec.envInherit) ||
      spec.envInherit.some((name) => typeof name !== "string")
    ) {
      fail("envInherit must be an array of variable names");
    }
    if (
      typeof spec.envSet !== "object" ||
      spec.envSet === null ||
      Object.values(spec.envSet).some((value) => typeof value !== "string")
    ) {
      fail("envSet must be a map of strings to strings");
    }
  }

  async function ensureCwd(cwd: string, participantId: string): Promise<void> {
    const existing = await lstatIfExists(cwd);
    if (existing) {
      if (existing.isSymbolicLink()) {
        throw spawnFailed("driver cwd must not be a symlink", participantId);
      }
      if (!existing.isDirectory()) {
        throw spawnFailed("driver cwd is not a directory", participantId);
      }
      return;
    }
    const rel = relative(config.driverWorkRoot, cwd);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw spawnFailed("driver cwd does not exist and is outside driverWorkRoot", participantId);
    }
    await mkdir(cwd, { recursive: true });
  }

  function waitSupervised(record: DriverRecord, timeoutMs: number): Promise<void> {
    const { participantId } = record.spec;
    if (record.supervised) return Promise.resolve();
    if (record.spawnError !== null) {
      return Promise.reject(spawnFailed(record.spawnError, participantId));
    }
    if (record.driverSettled) {
      return Promise.reject(
        makeError("DRIVER_CRASH", "prewarm", "driver exited before it was supervised", {
          participantId,
        }),
      );
    }
    if (record.watchdogHandled) {
      return Promise.reject(
        spawnFailed("watchdog exited before reporting supervised", participantId),
      );
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        cleanup();
        // Never leave an unregistered driver running: best-effort kill through
        // the watchdog, then destroy the watchdog and reap the group if known.
        record.expectingWatchdogExit = true;
        sendControl(record, { type: "kill", signal: "SIGKILL" });
        try {
          record.child.kill("SIGKILL");
        } catch {
          // Watchdog already gone.
        }
        if (record.pgid !== null && !record.driverSettled) {
          reapGroup(record.pgid);
          settleDriver(record, null, "SIGKILL");
        }
        rejectPromise(
          spawnFailed(
            `timed out after ${timeoutMs}ms waiting for watchdog "supervised"`,
            participantId,
          ),
        );
      }, timeoutMs);
      const onSupervised = () => {
        cleanup();
        resolvePromise();
      };
      const onSpawnError = ({ message }: { message: string }) => {
        cleanup();
        rejectPromise(spawnFailed(message, participantId));
      };
      const onExit = () => {
        cleanup();
        rejectPromise(
          makeError("DRIVER_CRASH", "prewarm", "driver exited before it was supervised", {
            participantId,
          }),
        );
      };
      const onWatchdogExit = () => {
        cleanup();
        rejectPromise(spawnFailed("watchdog exited before reporting supervised", participantId));
      };
      function cleanup() {
        clearTimeout(timer);
        record.events.off("supervised", onSupervised);
        record.events.off("spawn-error", onSpawnError);
        record.events.off("exit", onExit);
        record.events.off("watchdog-exit", onWatchdogExit);
      }
      record.events.once("supervised", onSupervised);
      record.events.once("spawn-error", onSpawnError);
      record.events.once("exit", onExit);
      record.events.once("watchdog-exit", onWatchdogExit);
    });
  }

  async function spawnDriver(spec: DriverSpawnSpec): Promise<DriverProcess> {
    validateSpec(spec);
    await ensureCwd(spec.cwd, spec.participantId);
    const duplicate = byParticipant.get(spec.participantId);
    if (duplicate && !duplicate.driverSettled) {
      throw spawnFailed("participant already has a live driver", spec.participantId);
    }
    const env = buildSupervisedEnv(spec.envInherit, spec.envSet);
    const child = spawn(process.execPath, [config.watchdogProgram], {
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      env,
    });
    const stdin = child.stdio[0];
    const stdout = child.stdio[1];
    const watchdogStderr = child.stdio[2];
    const controlRaw = child.stdio[3];
    const driverStderrRaw = child.stdio[4];
    if (!stdin || !stdout || !watchdogStderr || !controlRaw || !driverStderrRaw) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      throw spawnFailed("watchdog stdio pipes were not established", spec.participantId);
    }
    const control = controlRaw as unknown as Duplex;
    const driverStderr = driverStderrRaw as unknown as Readable;

    const record: DriverRecord = {
      spec,
      child,
      stdin,
      stdout,
      driverStderr,
      control,
      events: new EventEmitter(),
      diagnostics: createBoundedRing(WATCHDOG_DIAGNOSTIC_RING_BYTES),
      pid: null,
      pgid: null,
      supervised: false,
      driverSettled: false,
      spawnError: null,
      expectingWatchdogExit: false,
      watchdogHandled: false,
      watchdogExit: null,
      controlBuffer: Buffer.alloc(0),
      exitWaiters: new Set(),
    };
    records.add(record);
    byParticipant.set(spec.participantId, record);

    // Pass-through streams must never crash the Host with unhandled errors.
    for (const stream of [stdin, stdout, watchdogStderr, control, driverStderr]) {
      stream.on("error", () => {});
    }
    watchdogStderr.on("data", (chunk: Buffer) => record.diagnostics.append(chunk));
    control.on("data", (chunk: Buffer) => handleControlChunk(record, chunk));
    child.on("error", (error) => {
      logger.diagnostic("watchdog-spawn", `watchdog process error: ${error.message}`, {
        participantId: spec.participantId,
      });
      handleWatchdogExit(record, null, null);
    });
    child.on("exit", (code, signal) => handleWatchdogExit(record, code, signal));

    sendControl(record, {
      type: "spawn",
      executable: spec.executable,
      argv: spec.argv,
      cwd: spec.cwd,
      env,
    });

    const process_: DriverProcess = {
      participantId: spec.participantId,
      get pid() {
        return record.pid;
      },
      get pgid() {
        return record.pgid;
      },
      get watchdogPid() {
        return record.child.pid ?? -1;
      },
      stdin,
      stdout,
      stderr: driverStderr,
      events: record.events,
      waitSupervised: (timeoutMs: number) => waitSupervised(record, timeoutMs),
      kill(signal: "SIGTERM" | "SIGKILL", graceMs?: number) {
        if (record.driverSettled) return;
        record.expectingWatchdogExit = true;
        sendControl(record, {
          type: "kill",
          signal,
          ...(graceMs === undefined ? {} : { graceMs }),
        });
      },
      closeStdin() {
        sendControl(record, { type: "close-stdin" });
      },
      shutdown: (graceMs: number = TIMEOUTS.shutdownGraceMs) => shutdownRecord(record, graceMs),
      __testInjectControlLine(line: string) {
        handleControlChunk(record, Buffer.concat([Buffer.from(line, "utf8"), Buffer.from("\n")]));
      },
    };
    return process_;
  }

  return {
    events: supervisorEvents,
    spawnDriver,
    liveCount() {
      let count = 0;
      for (const record of records) {
        if (record.supervised && !record.driverSettled) count += 1;
      }
      return count;
    },
    reapedByWatchdogCount() {
      return reapedByWatchdog;
    },
    reapedAfterWatchdogDeath() {
      return reapedAfterWatchdogDeathCount;
    },
    async shutdownAll(graceMs: number = TIMEOUTS.shutdownGraceMs) {
      const pending = [...records].map((record) => shutdownRecord(record, graceMs));
      await Promise.allSettled(pending);
    },
  };
}
