import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostConfig } from "../../runtime-host/config";
import { type DiagnosticEntry, type Logger, createLogger } from "../../runtime-host/logging";
import {
  type DriverProcess,
  type DriverSpawnSpec,
  type ProcessSupervisor,
  createProcessSupervisor,
} from "../../runtime-host/process/process-supervisor";
import { childEnvFromLine } from "../helpers/os-injected-env";

const WATCHDOG_PROGRAM = new URL("../../runtime-host/process/watchdog-child.mjs", import.meta.url)
  .pathname;
const TOY_DRIVER = new URL("../fixtures/drivers/toy-driver.mjs", import.meta.url).pathname;

const DELAYED_WATCHDOG = `
import net from "node:net";
const control = new net.Socket({ fd: 3, readable: true, writable: true });
const delay = Number(process.env.WD_DELAY ?? "40");
const kind = process.env.WD_KIND ?? "spawn-error";
setTimeout(() => {
  if (kind === "die") {
    process.exit(1);
    return;
  }
  const message = kind === "exit"
    ? { type: "exit", code: 9, signal: "SIGTERM" }
    : { type: "spawn-error", message: "disk full" };
  control.write(JSON.stringify(message) + "\\n");
  setTimeout(() => process.exit(1), 30);
}, delay);
`;

const SHUTDOWN_EXIT_WATCHDOG = `
import net from "node:net";
const control = new net.Socket({ fd: 3, readable: true, writable: true });
let buffer = "";
control.setEncoding("utf8");
control.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      const message = JSON.parse(line);
      if (message.type === "spawn") {
        control.write(JSON.stringify({
          type: "supervised",
          pid: 2147483001,
          pgid: 2147483001,
          startedAt: "2020-01-01T00:00:00.000Z",
        }) + "\\n");
      } else if (message.type === "shutdown" || message.type === "kill") {
        process.exit(0);
      }
    }
    index = buffer.indexOf("\\n");
  }
});
`;

const IGNORE_SHUTDOWN_WATCHDOG = `
import net from "node:net";
const control = new net.Socket({ fd: 3, readable: true, writable: true });
let buffer = "";
control.setEncoding("utf8");
control.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line && JSON.parse(line).type === "spawn") {
      control.write(JSON.stringify({
        type: "supervised",
        pid: 2147483002,
        pgid: 2147483002,
        startedAt: "2020-01-01T00:00:00.000Z",
      }) + "\\n");
    }
    index = buffer.indexOf("\\n");
  }
});
setInterval(() => {}, 1000);
`;

const FLOOD_WATCHDOG = `
import net from "node:net";
const control = new net.Socket({ fd: 3, readable: true, writable: true });
setTimeout(() => control.write("x".repeat(70 * 1024)), 30);
setInterval(() => {}, 1000);
`;

const DIAG_WATCHDOG = `
process.stderr.write("wd-diag-hello\\n");
setTimeout(() => process.exit(0), 30);
`;

const SILENT_WATCHDOG = "setInterval(() => {}, 1000);\n";

interface Harness {
  supervisor: ProcessSupervisor;
  logger: Logger;
  logs: string[];
}

let tempRoot = "";
let supervisors: ProcessSupervisor[] = [];
const trackedPids: number[] = [];

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ck-proc-life-"));
});

afterEach(async () => {
  for (const supervisor of supervisors) {
    await supervisor.shutdownAll(200).catch(() => undefined);
  }
  supervisors = [];
  for (const pid of trackedPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Group already gone.
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already gone.
    }
  }
  await rm(tempRoot, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }
    await delay(15);
  }
}

class LineReader {
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<{
    resolve: (line: string) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(stream: Readable) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(line);
        } else {
          this.lines.push(line);
        }
        index = this.buffer.indexOf("\n");
      }
    });
  }

  next(timeoutMs = 2000): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a stdout line")),
        timeoutMs,
      );
      this.waiters.push({ resolve, timer });
    });
  }
}

function spawnFailed(message: string, participantId?: string) {
  return {
    code: "DRIVER_SPAWN_FAILED",
    phase: "prewarm",
    message,
    retryable: false,
    ...(participantId ? { participantId } : {}),
  };
}

function driverCrash(participantId: string) {
  return {
    code: "DRIVER_CRASH",
    phase: "prewarm",
    message: "driver exited before it was supervised",
    retryable: false,
    participantId,
  };
}

function stableDiagnostics(entries: readonly DiagnosticEntry[]) {
  return entries.map((entry) => ({
    kind: entry.kind,
    message: entry.message,
    ...(entry.context ? { context: entry.context } : {}),
  }));
}

function infoEvents(logs: string[]) {
  return logs
    .map((line) => JSON.parse(line) as { level: string; event: string; context?: unknown })
    .filter((entry) => entry.level === "info")
    .map((entry) => ({ level: entry.level, event: entry.event, context: entry.context }));
}

async function writeScript(name: string, source: string): Promise<string> {
  const path = join(tempRoot, name);
  await writeFile(path, source);
  return path;
}

function createHarness(
  watchdogProgram = WATCHDOG_PROGRAM,
  driverWorkRoot = join(tempRoot, "work"),
): Harness {
  const logs: string[] = [];
  const logger = createLogger({ sink: (line) => logs.push(line) });
  const config: HostConfig = {
    mode: "development",
    hostname: "127.0.0.1",
    port: 0,
    hostHeader: "127.0.0.1",
    distDir: tempRoot,
    watchdogProgram,
    driverWorkRoot,
  };
  const supervisor = createProcessSupervisor({ config, logger });
  supervisors.push(supervisor);
  return { supervisor, logger, logs };
}

async function spec(
  participantId: string,
  extra: Partial<DriverSpawnSpec> = {},
  createCwd = true,
): Promise<DriverSpawnSpec> {
  const cwd = extra.cwd ?? join(tempRoot, "work", participantId);
  if (createCwd) await mkdir(cwd, { recursive: true });
  return {
    participantId,
    executable: process.execPath,
    argv: extra.argv ?? [TOY_DRIVER],
    cwd,
    envInherit: extra.envInherit ?? ["PATH"],
    envSet: extra.envSet ?? {},
  };
}

function remember(driver: DriverProcess): number {
  const pid = driver.pid;
  if (typeof pid !== "number") throw new Error("driver has no pid");
  trackedPids.push(pid);
  return pid;
}

describe("driver lifecycle", () => {
  it("answers PING and a second shutdown is a no-op", async () => {
    const { supervisor } = createHarness();
    const exits: unknown[][] = [];
    supervisor.events.on("driver-exit", (...args) => exits.push(args));
    const driver = await supervisor.spawnDriver(await spec("alpha"));
    expect(driver.pid).toBeNull();
    expect(supervisor.liveCount()).toBe(0);
    await driver.waitSupervised(2000);
    await driver.waitSupervised(2000);
    const pid = remember(driver);
    expect(driver.pgid).toBe(pid);
    expect(supervisor.liveCount()).toBe(1);
    const lines = new LineReader(driver.stdout);
    driver.stdin.write("PING\n");
    expect(await lines.next()).toBe("PONG");
    await driver.shutdown(200);
    await waitUntil(() => !pidAlive(pid), 2000);
    expect(exits).toEqual([["alpha", 0, null]]);
    expect(supervisor.liveCount()).toBe(0);
    await driver.shutdown(200);
    expect(exits).toEqual([["alpha", 0, null]]);
  });

  it("closeStdin delivers EOF and the driver exits 0", async () => {
    const script = await writeScript(
      "eof.mjs",
      "process.stdin.resume();\nprocess.stdin.on('end', () => {\n  process.stdout.write('STDIN-EOF\\n');\n  process.exit(0);\n});\n",
    );
    const { supervisor } = createHarness();
    const driver = await supervisor.spawnDriver(await spec("eof", { argv: [script] }));
    await driver.waitSupervised(2000);
    const pid = remember(driver);
    const lines = new LineReader(driver.stdout);
    driver.closeStdin();
    expect(await lines.next()).toBe("STDIN-EOF");
    await waitUntil(() => !pidAlive(pid), 2000);
    expect(supervisor.liveCount()).toBe(0);
  });

  it("passes only inherited names and envSet through to the driver", async () => {
    const previous = {
      CANARY_SECRET_TOKEN: process.env.CANARY_SECRET_TOKEN,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      ALLOWED_CANARY: process.env.ALLOWED_CANARY,
      CK_QA_CANARY: process.env.CK_QA_CANARY,
    };
    process.env.CK_QA_CANARY = "1";
    process.env.CANARY_SECRET_TOKEN = "canary-secret-value";
    process.env.NODE_OPTIONS = "--inspect=0.0.0.0:9229";
    process.env.ALLOWED_CANARY = "allowed-value";
    try {
      const { supervisor } = createHarness();
      const driver = await supervisor.spawnDriver(
        await spec("env", {
          envInherit: ["PATH", "ALLOWED_CANARY", "NODE_OPTIONS"],
          envSet: { DRIVER_DECLARED: "yes", SMUGGLED_TOKEN: "nope" },
        }),
      );
      await driver.waitSupervised(2000);
      remember(driver);
      const lines = new LineReader(driver.stdout);
      driver.stdin.write("ENV\n");
      // Exactly {inherited by name} ∪ {envSet}; only OS-injected keys tolerated.
      const childEnv = childEnvFromLine(await lines.next());
      expect(childEnv).not.toHaveProperty("CK_QA_CANARY");
      expect(childEnv).not.toHaveProperty("CANARY_SECRET_TOKEN");
      expect(childEnv).toEqual({
        PATH: process.env.PATH,
        ALLOWED_CANARY: "allowed-value",
        DRIVER_DECLARED: "yes",
      });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("delivers SIGTERM and records a clean driver exit", async () => {
    const { supervisor } = createHarness();
    const driver = await supervisor.spawnDriver(await spec("gentle"));
    await driver.waitSupervised(2000);
    const pid = remember(driver);
    const lines = new LineReader(driver.stdout);
    driver.stdin.write("PING\n");
    expect(await lines.next()).toBe("PONG");
    const exitPromise = once(driver.events, "exit");
    driver.kill("SIGTERM", 500);
    expect(await lines.next()).toBe("SIGTERM-SEEN");
    const [payload] = await exitPromise;
    expect(payload).toEqual({ code: 0, signal: null });
    await waitUntil(() => !pidAlive(pid), 2000);
    expect(supervisor.reapedByWatchdogCount()).toBe(0);
    expect(supervisor.liveCount()).toBe(0);
  });

  it("SIGKILL reports the signal and does not count a watchdog reap", async () => {
    const { supervisor } = createHarness();
    const exits: unknown[][] = [];
    supervisor.events.on("driver-exit", (...args) => exits.push(args));
    const driver = await supervisor.spawnDriver(await spec("kill"));
    await driver.waitSupervised(2000);
    const pid = remember(driver);
    driver.kill("SIGKILL");
    await waitUntil(() => !pidAlive(pid), 2000);
    await waitUntil(() => exits.length === 1, 2000);
    expect(exits).toEqual([["kill", null, "SIGKILL"]]);
    expect(supervisor.reapedByWatchdogCount()).toBe(0);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(0);
    expect(supervisor.liveCount()).toBe(0);
  });

  it("shutdownAll stops every live driver", async () => {
    const { supervisor } = createHarness();
    const drivers = await Promise.all(
      ["one", "two"].map(async (id) => supervisor.spawnDriver(await spec(id))),
    );
    await Promise.all(drivers.map((driver) => driver.waitSupervised(2000)));
    const pids = drivers.map((driver) => remember(driver));
    expect(supervisor.liveCount()).toBe(2);
    await supervisor.shutdownAll(200);
    for (const pid of pids) await waitUntil(() => !pidAlive(pid), 2000);
    expect(supervisor.liveCount()).toBe(0);
  });

  it("rejects a second live driver for the same participant", async () => {
    const { supervisor } = createHarness();
    const driver = await supervisor.spawnDriver(await spec("dup"));
    await driver.waitSupervised(2000);
    remember(driver);
    await expect(supervisor.spawnDriver(await spec("dup"))).rejects.toEqual(
      spawnFailed("participant already has a live driver", "dup"),
    );
    expect(supervisor.liveCount()).toBe(1);
  });

  it("creates a missing cwd under the work root", async () => {
    const { supervisor } = createHarness();
    const cwd = join(tempRoot, "work", "made");
    const driver = await supervisor.spawnDriver(await spec("made", { cwd }, false));
    await driver.waitSupervised(2000);
    remember(driver);
    const lines = new LineReader(driver.stdout);
    driver.stdin.write("PING\n");
    expect(await lines.next()).toBe("PONG");
    expect((await stat(cwd)).isDirectory()).toBe(true);
  });

  it("rejects a cwd that is a file, a symlink, or outside the work root", async () => {
    const { supervisor } = createHarness();
    const work = join(tempRoot, "work");
    await mkdir(work, { recursive: true });
    const fileCwd = join(work, "not-a-dir");
    await writeFile(fileCwd, "x");
    await expect(
      supervisor.spawnDriver(await spec("file", { cwd: fileCwd }, false)),
    ).rejects.toEqual(spawnFailed("driver cwd is not a directory", "file"));

    const elsewhere = join(tempRoot, "elsewhere");
    await mkdir(elsewhere);
    const link = join(tempRoot, "linked-cwd");
    await symlink(elsewhere, link);
    await expect(supervisor.spawnDriver(await spec("link", { cwd: link }, false))).rejects.toEqual(
      spawnFailed("driver cwd must not be a symlink", "link"),
    );

    await expect(
      supervisor.spawnDriver(await spec("out", { cwd: join(tempRoot, "outside") }, false)),
    ).rejects.toEqual(
      spawnFailed("driver cwd does not exist and is outside driverWorkRoot", "out"),
    );

    const absent = join(tempRoot, "absent-root");
    const rooted = createHarness(WATCHDOG_PROGRAM, absent);
    await expect(
      rooted.supervisor.spawnDriver(await spec("root", { cwd: absent }, false)),
    ).rejects.toEqual(
      spawnFailed("driver cwd does not exist and is outside driverWorkRoot", "root"),
    );
    expect(supervisor.liveCount()).toBe(0);
  });
});

describe("control frames", () => {
  it("ignores junk, counts reaped frames, and still answers PING", async () => {
    const { supervisor, logger, logs } = createHarness();
    const driver = await supervisor.spawnDriver(await spec("junk"));
    await driver.waitSupervised(2000);
    const pid = remember(driver);
    const supervisedPromise = once(driver.events, "supervised");
    driver.__testInjectControlLine(
      JSON.stringify({ type: "supervised", pid: "no", pgid: false, startedAt: 1 }),
    );
    const [supervised] = await supervisedPromise;
    expect(supervised).toEqual({ pid: null, pgid: null, startedAt: null });
    expect(driver.pid).toBeNull();
    expect(driver.pgid).toBeNull();

    driver.__testInjectControlLine("   ");
    driver.__testInjectControlLine("{");
    driver.__testInjectControlLine(JSON.stringify({ type: "nope" }));
    driver.__testInjectControlLine(JSON.stringify({ type: "reaped", reason: "host-shutdown" }));
    driver.__testInjectControlLine(JSON.stringify({ type: "reaped", reason: 12 }));

    const lines = new LineReader(driver.stdout);
    driver.stdin.write("PING\n");
    expect(await lines.next()).toBe("PONG");
    expect(supervisor.reapedByWatchdogCount()).toBe(2);
    expect(supervisor.liveCount()).toBe(1);
    expect(infoEvents(logs)).toEqual([
      {
        level: "info",
        event: "watchdog.reaped",
        context: { participantId: "junk", reason: "host-shutdown" },
      },
      {
        level: "info",
        event: "watchdog.reaped",
        context: { participantId: "junk", reason: "unknown" },
      },
    ]);
    expect(stableDiagnostics(logger.diagnostics())).toEqual([
      {
        kind: "watchdog-protocol",
        message: "ignoring malformed control frame",
        context: { participantId: "junk" },
      },
    ]);
    expect(pidAlive(pid)).toBe(true);
  });

  it("settles once on an exit frame and ignores a later kill", async () => {
    const { supervisor } = createHarness();
    const driver = await supervisor.spawnDriver(await spec("exit-once"));
    await driver.waitSupervised(2000);
    remember(driver);
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    const driverExits: unknown[][] = [];
    driver.events.on("exit", (payload) => exits.push(payload));
    supervisor.events.on("driver-exit", (...args) => driverExits.push(args));
    driver.__testInjectControlLine(JSON.stringify({ type: "exit", code: false, signal: 1 }));
    driver.__testInjectControlLine(JSON.stringify({ type: "exit", code: 5, signal: "SIGKILL" }));
    expect(exits).toEqual([{ code: null, signal: null }]);
    expect(driverExits).toEqual([["exit-once", null, null]]);
    expect(supervisor.liveCount()).toBe(0);
    driver.kill("SIGKILL");
    driver.closeStdin();
    expect(exits).toEqual([{ code: null, signal: null }]);
    expect(driverExits).toEqual([["exit-once", null, null]]);
  });

  it("clips a late spawn-error and settles the supervised driver", async () => {
    const { supervisor } = createHarness();
    const driver = await supervisor.spawnDriver(await spec("clip"));
    await driver.waitSupervised(2000);
    remember(driver);
    const messages: string[] = [];
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    driver.events.on("spawn-error", ({ message }: { message: string }) => messages.push(message));
    driver.events.on("exit", (payload) => exits.push(payload));
    const raw = `${"a".repeat(511)}😀${"z".repeat(30)}`;
    driver.__testInjectControlLine(JSON.stringify({ type: "spawn-error" }));
    driver.__testInjectControlLine(JSON.stringify({ type: "spawn-error", message: raw }));
    expect(messages).toEqual(["unknown spawn error", "a".repeat(511)]);
    expect(exits).toEqual([{ code: null, signal: null }]);
    expect(supervisor.liveCount()).toBe(0);
  });

  it("reaps the driver group when an inbound control frame exceeds 64 KiB", async () => {
    const { supervisor, logger } = createHarness();
    const driver = await supervisor.spawnDriver(await spec("abuse"));
    await driver.waitSupervised(2000);
    const pid = remember(driver);
    const watchdogExit = once(driver.events, "watchdog-exit");
    const driverExits: unknown[][] = [];
    supervisor.events.on("driver-exit", (...args) => driverExits.push(args));
    driver.__testInjectControlLine("x".repeat(70 * 1024));
    const [payload] = await watchdogExit;
    expect(payload).toEqual({ code: null, signal: "SIGKILL" });
    await waitUntil(() => !pidAlive(pid), 2000);
    expect(driverExits).toEqual([["abuse", null, "SIGKILL"]]);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(1);
    expect(supervisor.liveCount()).toBe(0);
    expect(stableDiagnostics(logger.diagnostics())[0]).toEqual({
      kind: "watchdog-protocol-violation",
      message: "inbound control frame exceeds 64 KiB",
      context: { participantId: "abuse", watchdogPid: driver.watchdogPid },
    });
    driver.closeStdin();
    driver.kill("SIGTERM", 10);
    expect(driverExits).toEqual([["abuse", null, "SIGKILL"]]);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(1);
  });

  it("kills the watchdog when the outbound spawn frame exceeds 64 KiB", async () => {
    const { supervisor, logger } = createHarness();
    const driver = await supervisor.spawnDriver(
      await spec("huge", { envSet: { PAYLOAD: "x".repeat(70 * 1024) } }),
    );
    await expect(driver.waitSupervised(1000)).rejects.toEqual(
      spawnFailed("watchdog exited before reporting supervised", "huge"),
    );
    expect(stableDiagnostics(logger.diagnostics())).toEqual([
      {
        kind: "watchdog-protocol-violation",
        message: "outgoing control frame exceeds 64 KiB",
        context: { participantId: "huge", watchdogPid: driver.watchdogPid },
      },
      {
        kind: "watchdog-exit",
        message: "watchdog died before supervision completed",
        context: { participantId: "huge" },
      },
    ]);
    expect(supervisor.liveCount()).toBe(0);
  });

  it("logs watchdog stderr when the watchdog exits before supervision", async () => {
    const program = await writeScript("diag.mjs", DIAG_WATCHDOG);
    const { supervisor, logger } = createHarness(program);
    const driver = await supervisor.spawnDriver(await spec("diag"));
    await delay(80);
    await expect(driver.waitSupervised(500)).rejects.toEqual(
      spawnFailed("watchdog exited before reporting supervised", "diag"),
    );
    expect(stableDiagnostics(logger.diagnostics())).toEqual([
      {
        kind: "watchdog-exit",
        message: "watchdog died before supervision completed",
        context: { participantId: "diag" },
      },
      {
        kind: "watchdog-stderr",
        message: "wd-diag-hello",
        context: { participantId: "diag" },
      },
    ]);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(0);
  });
});

describe("supervision failures", () => {
  it("rejects outcomes that were recorded before waitSupervised", async () => {
    const program = await writeScript("delayed.mjs", DELAYED_WATCHDOG);
    const spawnError = createHarness(program);
    const errored = await spawnError.supervisor.spawnDriver(
      await spec("already-error", { envSet: { WD_KIND: "spawn-error", WD_DELAY: "20" } }),
    );
    await delay(80);
    await expect(errored.waitSupervised(500)).rejects.toEqual(
      spawnFailed("disk full", "already-error"),
    );

    const earlyExit = createHarness(program);
    const exited = await earlyExit.supervisor.spawnDriver(
      await spec("already-exit", { envSet: { WD_KIND: "exit", WD_DELAY: "20" } }),
    );
    await delay(80);
    await expect(exited.waitSupervised(500)).rejects.toEqual(driverCrash("already-exit"));

    const died = createHarness(program);
    const dead = await died.supervisor.spawnDriver(
      await spec("already-dead", { envSet: { WD_KIND: "die", WD_DELAY: "20" } }),
    );
    await delay(80);
    await expect(dead.waitSupervised(500)).rejects.toEqual(
      spawnFailed("watchdog exited before reporting supervised", "already-dead"),
    );
  });

  it("rejects the same outcomes while waitSupervised is pending", async () => {
    const program = await writeScript("delayed-wait.mjs", DELAYED_WATCHDOG);
    const spawnError = createHarness(program);
    const errored = await spawnError.supervisor.spawnDriver(
      await spec("wait-error", { envSet: { WD_KIND: "spawn-error", WD_DELAY: "120" } }),
    );
    await expect(errored.waitSupervised(1000)).rejects.toEqual(
      spawnFailed("disk full", "wait-error"),
    );

    const earlyExit = createHarness(program);
    const exited = await earlyExit.supervisor.spawnDriver(
      await spec("wait-exit", { envSet: { WD_KIND: "exit", WD_DELAY: "120" } }),
    );
    await expect(exited.waitSupervised(1000)).rejects.toEqual(driverCrash("wait-exit"));

    const died = createHarness(program);
    const dead = await died.supervisor.spawnDriver(
      await spec("wait-dead", { envSet: { WD_KIND: "die", WD_DELAY: "120" } }),
    );
    await expect(dead.waitSupervised(1000)).rejects.toEqual(
      spawnFailed("watchdog exited before reporting supervised", "wait-dead"),
    );
  });

  it("times out and kills a watchdog that never reports supervised", async () => {
    const program = await writeScript("silent.mjs", SILENT_WATCHDOG);
    const { supervisor, logger } = createHarness(program);
    const driver = await supervisor.spawnDriver(await spec("silent"));
    await expect(driver.waitSupervised(80)).rejects.toEqual(
      spawnFailed('timed out after 80ms waiting for watchdog "supervised"', "silent"),
    );
    expect(logger.diagnostics()).toEqual([]);
    expect(supervisor.liveCount()).toBe(0);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(0);
  });

  it("reaps a supervised group the watchdog abandons on shutdown", async () => {
    const program = await writeScript("shutdown-exit.mjs", SHUTDOWN_EXIT_WATCHDOG);
    const { supervisor } = createHarness(program);
    const driver = await supervisor.spawnDriver(await spec("abandon"));
    const supervisedPromise = once(driver.events, "supervised");
    await driver.waitSupervised(1000);
    const [info] = await supervisedPromise;
    expect(info).toEqual({
      pid: 2147483001,
      pgid: 2147483001,
      startedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(supervisor.liveCount()).toBe(1);
    const exits: unknown[][] = [];
    supervisor.events.on("driver-exit", (...args) => exits.push(args));
    await driver.shutdown(100);
    expect(exits).toEqual([["abandon", null, "SIGKILL"]]);
    expect(supervisor.liveCount()).toBe(0);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(0);
  });

  it("SIGKILLs a watchdog that ignores shutdown", async () => {
    const program = await writeScript("ignore.mjs", IGNORE_SHUTDOWN_WATCHDOG);
    const { supervisor } = createHarness(program);
    const driver = await supervisor.spawnDriver(await spec("stall"));
    await driver.waitSupervised(1000);
    expect(driver.pid).toBe(2147483002);
    expect(supervisor.liveCount()).toBe(1);
    const exits: unknown[][] = [];
    supervisor.events.on("driver-exit", (...args) => exits.push(args));
    await supervisor.shutdownAll(50);
    expect(exits).toEqual([["stall", null, "SIGKILL"]]);
    expect(supervisor.liveCount()).toBe(0);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(0);
    expect(supervisor.reapedByWatchdogCount()).toBe(0);
  });

  it("reaps the driver group when the watchdog is SIGKILLed", async () => {
    const { supervisor } = createHarness();
    const driver = await supervisor.spawnDriver(await spec("crash"));
    await driver.waitSupervised(2000);
    const pid = remember(driver);
    const watchdogExit = once(driver.events, "watchdog-exit");
    process.kill(driver.watchdogPid, "SIGKILL");
    const [payload] = await watchdogExit;
    expect(payload).toEqual({ code: null, signal: "SIGKILL" });
    await waitUntil(() => !pidAlive(pid), 2000);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(1);
    expect(supervisor.liveCount()).toBe(0);
  });

  it("stops the driver when the watchdog writes an unterminated oversized frame", async () => {
    const program = await writeScript("flood.mjs", FLOOD_WATCHDOG);
    const { supervisor, logger } = createHarness(program);
    const driver = await supervisor.spawnDriver(await spec("flood"));
    await expect(driver.waitSupervised(1000)).rejects.toEqual(
      spawnFailed("watchdog exited before reporting supervised", "flood"),
    );
    expect(stableDiagnostics(logger.diagnostics())).toEqual([
      {
        kind: "watchdog-protocol-violation",
        message: "inbound control frame exceeds 64 KiB",
        context: { participantId: "flood", watchdogPid: driver.watchdogPid },
      },
      {
        kind: "watchdog-exit",
        message: "watchdog died before supervision completed",
        context: { participantId: "flood" },
      },
    ]);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(0);
  });
});
