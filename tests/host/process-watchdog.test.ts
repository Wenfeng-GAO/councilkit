import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { HostConfig } from "@host/config";
import { createLogger } from "@host/logging";
import {
  type DriverProcess,
  type DriverSpawnSpec,
  type ProcessSupervisor,
  buildSupervisedEnv,
  createBoundedRing,
  createProcessSupervisor,
  filterDeniedEnv,
  prepareParticipantCwd,
} from "@host/process/process-supervisor";
import { TIMEOUTS } from "@shared/runtime/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const WATCHDOG_PROGRAM = join(repoRoot, "runtime-host/process/watchdog-child.mjs");
const TOY_DRIVER = join(repoRoot, "tests/fixtures/drivers/toy-driver.mjs");
const HARNESS_PROGRAM = join(repoRoot, "tests/fixtures/host-harness.ts");

// ---------------------------------------------------------------------------
// Shared test plumbing
// ---------------------------------------------------------------------------

let tempRoot = "";
let supervisors: ProcessSupervisor[] = [];
let childProcesses: ChildProcess[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "councilkit-watchdog-test-"));
});

afterEach(async () => {
  for (const supervisor of supervisors) {
    await supervisor.shutdownAll(300).catch(() => undefined);
  }
  supervisors = [];
  for (const child of childProcesses) {
    try {
      if (child.pid) process.kill(child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  childProcesses = [];
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
  // Hard requirement: no stray supervised processes survive the test file.
  await waitFor(
    () => pgrepCount("toy-driver.mjs") === 0 && pgrepCount("watchdog-child.mjs") === 0,
    5000,
  ).catch(() => undefined);
  expect(pgrepCount("toy-driver.mjs")).toBe(0);
  expect(pgrepCount("watchdog-child.mjs")).toBe(0);
  await rm(tempRoot, { recursive: true, force: true });
});

function setEnv(name: string, value: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}

function pgrepCount(pattern: string): number {
  try {
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  if (!condition()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, rejectPromise) =>
      setTimeout(() => rejectPromise(new Error(`timed out: ${label}`)), timeoutMs),
    ),
  ]);
}

class LineReader {
  private buffer = "";
  private lines: string[] = [];
  private waiters: { resolve: (line: string) => void; timer: NodeJS.Timeout }[] = [];

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

  next(timeoutMs = 5000): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () => rejectPromise(new Error("timed out waiting for a stdout line")),
        timeoutMs,
      );
      this.waiters.push({ resolve: resolvePromise, timer });
    });
  }
}

async function waitForLine(
  lines: LineReader,
  predicate: (line: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("timed out waiting for the expected line");
    const line = await lines.next(remaining);
    if (predicate(line)) return line;
  }
}

function createSupervisor(): ProcessSupervisor {
  const config: HostConfig = {
    mode: "development",
    hostname: "127.0.0.1",
    port: 0,
    hostHeader: "127.0.0.1",
    distDir: tempRoot,
    watchdogProgram: WATCHDOG_PROGRAM,
    driverWorkRoot: join(tempRoot, "work"),
  };
  const logger = createLogger({ sink: () => {} });
  const supervisor = createProcessSupervisor({ config, logger });
  supervisors.push(supervisor);
  return supervisor;
}

async function spawnToy(
  supervisor: ProcessSupervisor,
  participantId: string,
  extra: Partial<DriverSpawnSpec> = {},
): Promise<DriverProcess> {
  const cwd = await prepareParticipantCwd(join(tempRoot, "work"), participantId);
  return supervisor.spawnDriver({
    participantId,
    executable: process.execPath,
    argv: [TOY_DRIVER],
    cwd,
    envInherit: ["PATH", "HOME"],
    envSet: { TOY_DRIVER: "1" },
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Environment hygiene (pure helpers)
// ---------------------------------------------------------------------------

describe("environment hygiene", () => {
  it("passes only allowlisted inherited vars plus envSet through the denylist", () => {
    const sourceEnv = {
      PATH: "/usr/bin",
      HOME: "/home/test",
      CANARY_SECRET_TOKEN: "canary-secret-value",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NODE_OPTIONS: "--inspect=0.0.0.0:9229",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      LD_PRELOAD: "/tmp/evil.so",
      BASH_ENV: "/tmp/evil.sh",
      ENV: "/tmp/evil.sh",
      MY_CUSTOM: "custom-value",
    };
    const env = buildSupervisedEnv(["PATH", "HOME"], { DRIVER_DECLARED: "1" }, sourceEnv);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/test", DRIVER_DECLARED: "1" });
  });

  it("strips denylisted envSet entries but honors exact-name envInherit entries", () => {
    const sourceEnv = { MY_SAFE_KEY: "inherited", PATH: "/usr/bin" };
    const env = buildSupervisedEnv(
      ["PATH", "MY_SAFE_KEY"],
      { SMUGGLED_TOKEN: "nope", NODE_OPTIONS: "--inspect", DRIVER_DECLARED: "yes" },
      sourceEnv,
    );
    // Pattern-denied name inherited by exact name survives; NODE_OPTIONS never does.
    expect(env).toEqual({
      PATH: "/usr/bin",
      MY_SAFE_KEY: "inherited",
      DRIVER_DECLARED: "yes",
    });
    expect(env).not.toHaveProperty("SMUGGLED_TOKEN");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("filterDeniedEnv applies exact and prefix denies even to exempt names", () => {
    const out = filterDeniedEnv(
      {
        NODE_OPTIONS: "--inspect",
        DYLD_PRINT_LIBRARIES: "1",
        LD_LIBRARY_PATH: "/tmp",
        BASH_ENV: "x",
        ENV: "x",
        API_PASSWORD: "secret",
        http_proxy: "http://proxy",
        PATH: "/usr/bin",
      },
      { exemptInheritedNames: ["NODE_OPTIONS", "DYLD_PRINT_LIBRARIES", "PATH"] },
    );
    expect(out).toEqual({ PATH: "/usr/bin" });
  });
});

describe("createBoundedRing", () => {
  it("keeps only the most recent bytes within the limit", () => {
    const ring = createBoundedRing(4);
    ring.append("abc");
    ring.append("def");
    expect(ring.byteLength()).toBe(4);
    expect(ring.text()).toBe("cdef");
    ring.append(Buffer.from("ghij"));
    expect(ring.text()).toBe("ghij");
    ring.clear();
    expect(ring.byteLength()).toBe(0);
  });
});

describe("prepareParticipantCwd", () => {
  it("creates the participant directory and is idempotent", async () => {
    const root = join(tempRoot, "work");
    const first = await prepareParticipantCwd(root, "p-1");
    expect(first).toBe(join(root, "p-1"));
    const second = await prepareParticipantCwd(root, "p-1");
    expect(second).toBe(first);
  });

  it("rejects escaping participantIds and relative roots", async () => {
    const root = join(tempRoot, "work");
    for (const bad of ["../escape", "a/b", ".", "..", ""]) {
      await expect(prepareParticipantCwd(root, bad)).rejects.toMatchObject({
        code: "DRIVER_SPAWN_FAILED",
      });
    }
    await expect(prepareParticipantCwd("relative/root", "p-1")).rejects.toMatchObject({
      code: "DRIVER_SPAWN_FAILED",
    });
  });

  it("rejects a symlink at the participant target", async () => {
    const root = join(tempRoot, "work");
    await mkdir(root, { recursive: true });
    const elsewhere = join(tempRoot, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(root, "p-link"));
    await expect(prepareParticipantCwd(root, "p-link")).rejects.toMatchObject({
      code: "DRIVER_SPAWN_FAILED",
    });
  });
});

// ---------------------------------------------------------------------------
// Driver lifecycle through the real watchdog
// ---------------------------------------------------------------------------

describe("driver lifecycle", () => {
  it("spawns, gates on supervised, echoes PING/PONG and tracks liveCount", async () => {
    const supervisor = createSupervisor();
    const exits: [string, number | null, string | null][] = [];
    supervisor.events.on("driver-exit", (participantId, code, signal) =>
      exits.push([participantId, code, signal]),
    );
    const driver = await spawnToy(supervisor, "alpha");
    expect(driver.pid).toBeNull();
    expect(supervisor.liveCount()).toBe(0);

    await driver.waitSupervised(5000);
    expect(driver.pid).toBeGreaterThan(0);
    expect(driver.pgid).toBe(driver.pid); // detached group leader
    expect(driver.watchdogPid).toBeGreaterThan(0);
    expect(supervisor.liveCount()).toBe(1);

    const lines = new LineReader(driver.stdout);
    driver.stdin.write("PING\n");
    expect(await lines.next()).toBe("PONG");

    const pid = driver.pid as number;
    await driver.shutdown(500);
    await waitFor(() => !pidAlive(pid), 2000);
    expect(supervisor.liveCount()).toBe(0);
    expect(exits).toEqual([["alpha", 0, null]]);
  });

  it("rejects non-absolute executable and cwd before spawning anything", async () => {
    const supervisor = createSupervisor();
    const cwd = await prepareParticipantCwd(join(tempRoot, "work"), "beta");
    const base: DriverSpawnSpec = {
      participantId: "beta",
      executable: process.execPath,
      argv: [TOY_DRIVER],
      cwd,
      envInherit: ["PATH"],
      envSet: {},
    };
    await expect(supervisor.spawnDriver({ ...base, executable: "node" })).rejects.toMatchObject({
      code: "DRIVER_SPAWN_FAILED",
    });
    await expect(supervisor.spawnDriver({ ...base, cwd: "relative/dir" })).rejects.toMatchObject({
      code: "DRIVER_SPAWN_FAILED",
    });
    // Missing cwd outside driverWorkRoot is never created implicitly.
    await expect(
      supervisor.spawnDriver({ ...base, cwd: join(tempRoot, "outside", "nope") }),
    ).rejects.toMatchObject({ code: "DRIVER_SPAWN_FAILED" });
    expect(supervisor.liveCount()).toBe(0);
  });

  it("rejects a symlinked driver cwd", async () => {
    const supervisor = createSupervisor();
    const elsewhere = join(tempRoot, "elsewhere");
    await mkdir(elsewhere);
    const linked = join(tempRoot, "linked-cwd");
    await symlink(elsewhere, linked);
    await expect(
      supervisor.spawnDriver({
        participantId: "gamma",
        executable: process.execPath,
        argv: [TOY_DRIVER],
        cwd: linked,
        envInherit: ["PATH"],
        envSet: {},
      }),
    ).rejects.toMatchObject({ code: "DRIVER_SPAWN_FAILED" });
    expect(supervisor.liveCount()).toBe(0);
  });

  it("surfaces a watchdog spawn-error and settles the never-started driver", async () => {
    const supervisor = createSupervisor();
    const cwd = await prepareParticipantCwd(join(tempRoot, "work"), "delta");
    const driver = await supervisor.spawnDriver({
      participantId: "delta",
      executable: join(tempRoot, "does-not-exist"),
      argv: [],
      cwd,
      envInherit: ["PATH"],
      envSet: {},
    });
    // The watchdog reports supervised synchronously right after spawn();
    // async spawn failures (ENOENT) arrive as a spawn-error event right
    // after, and the supervisor settles the driver so liveCount drops.
    const spawnError = withTimeout(
      new Promise<{ message: string }>((resolvePromise) =>
        driver.events.once("spawn-error", resolvePromise),
      ),
      5000,
      "spawn-error event",
    );
    await driver.waitSupervised(5000);
    const { message } = await spawnError;
    expect(message.length).toBeGreaterThan(0);
    await waitFor(() => supervisor.liveCount() === 0, 1000);
  });

  it("delivers only allowlisted env to the driver and strips canaries", async () => {
    setEnv("CANARY_SECRET_TOKEN", "canary-secret-value");
    setEnv("HTTPS_PROXY", "http://127.0.0.1:9");
    setEnv("NODE_OPTIONS", "--inspect=0.0.0.0:9229");
    setEnv("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib");
    setEnv("MY_CUSTOM", "custom-value");
    setEnv("ALLOWED_CANARY", "allowed-value");

    const supervisor = createSupervisor();
    const driver = await spawnToy(supervisor, "env-test", {
      envInherit: ["PATH", "HOME", "ALLOWED_CANARY"],
      envSet: { DRIVER_DECLARED: "yes", SMUGGLED_TOKEN: "nope" },
    });
    await driver.waitSupervised(5000);
    const lines = new LineReader(driver.stdout);
    driver.stdin.write("ENV\n");
    const line = await lines.next();
    expect(line.startsWith("ENV ")).toBe(true);
    const env = JSON.parse(line.slice(4)) as Record<string, string>;
    expect(env.ALLOWED_CANARY).toBe("allowed-value");
    expect(env.DRIVER_DECLARED).toBe("yes");
    expect(env.PATH).toBe(process.env.PATH);
    for (const denied of [
      "CANARY_SECRET_TOKEN",
      "HTTPS_PROXY",
      "NODE_OPTIONS",
      "DYLD_INSERT_LIBRARIES",
      "MY_CUSTOM",
      "SMUGGLED_TOKEN",
    ]) {
      expect(env).not.toHaveProperty(denied);
    }
    expect(line).not.toContain("canary-secret-value");
    expect(line).not.toContain("custom-value");
    expect(line).not.toContain("evil.dylib");
  });
});

// ---------------------------------------------------------------------------
// Host death: watchdog reaps the whole process group (harness tests)
// ---------------------------------------------------------------------------

let harnessCounter = 0;

async function startHarness(participants: string[], options: { early?: boolean } = {}) {
  const id = harnessCounter++;
  const specPath = join(tempRoot, `harness-spec-${id}.json`);
  await writeFile(
    specPath,
    JSON.stringify({
      participants,
      toyDriver: TOY_DRIVER,
      driverWorkRoot: join(tempRoot, `harness-work-${id}`),
      watchdogProgram: WATCHDOG_PROGRAM,
    }),
  );
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (options.early) env.HARNESS_KILLABLE_EARLY = "1";
  const child = spawn(process.execPath, ["--import", "tsx", HARNESS_PROGRAM, specPath], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", () => {});
  childProcesses.push(child);
  return { child, lines: new LineReader(child.stdout as Readable) };
}

function parsePidList(ready: string, key: string): number[] {
  const match = ready.match(new RegExp(`${key}=([0-9,]+)`));
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .filter((part) => part.length > 0)
    .map(Number);
}

describe("host death reaping", () => {
  it("reaps both driver groups well inside reapAfterHostDeathMs when the host dies", async () => {
    // Unrelated control process (different process group): must survive.
    const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    childProcesses.push(control);
    const controlPid = control.pid as number;

    const { child, lines } = await startHarness(["h-alpha", "h-beta"]);
    const ready = await waitForLine(lines, (line) => line.startsWith("HARNESS-READY"), 20000);
    const pids = parsePidList(ready, "pids");
    const gpids = parsePidList(ready, "gpids");
    const grandchildren = parsePidList(ready, "grandchild");
    expect(pids).toHaveLength(2);
    expect(gpids).toEqual(pids);
    expect(grandchildren).toHaveLength(2);
    for (const pid of [...pids, ...grandchildren]) expect(pidAlive(pid)).toBe(true);

    const started = Date.now();
    process.kill(child.pid as number, "SIGKILL");
    await waitFor(
      () => [...pids, ...grandchildren].every((pid) => !pidAlive(pid)),
      TIMEOUTS.reapAfterHostDeathMs - 500,
      50,
    );
    expect(Date.now() - started).toBeLessThan(TIMEOUTS.reapAfterHostDeathMs);
    expect(pidAlive(controlPid)).toBe(true);
  });

  it("leaves no orphans when the host dies before supervision completes", async () => {
    const { lines } = await startHarness(["early-a", "early-b"], { early: true });
    const pidLine = await waitForLine(lines, (line) => line.startsWith("HARNESS-PID"), 20000);
    const harnessPid = Number(pidLine.split(" ")[1]);
    expect(pidAlive(harnessPid)).toBe(true);
    // Kill inside the spawn -> supervised window (harness delays ~250ms).
    process.kill(harnessPid, "SIGKILL");
    await waitFor(() => !pidAlive(harnessPid), 2000);
    // Give any racing spawn a chance to appear, then prove nothing survives.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
    expect(pgrepCount("toy-driver.mjs")).toBe(0);
    expect(pgrepCount("watchdog-child.mjs")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Watchdog crash: supervisor reaps via the recorded pgid
// ---------------------------------------------------------------------------

describe("watchdog crash recovery", () => {
  it("reaps the driver group via pgid when the watchdog is SIGKILLed", async () => {
    const supervisor = createSupervisor();
    const driver = await spawnToy(supervisor, "crash-test");
    await driver.waitSupervised(5000);
    const driverPid = driver.pid as number;
    expect(pidAlive(driverPid)).toBe(true);

    const watchdogExit = withTimeout(
      new Promise((resolvePromise) => driver.events.once("watchdog-exit", resolvePromise)),
      5000,
      "watchdog-exit event",
    );
    process.kill(driver.watchdogPid, "SIGKILL");
    await watchdogExit;
    await waitFor(() => !pidAlive(driverPid), 2000);
    await waitFor(() => supervisor.liveCount() === 0, 1000);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Grace escalation and group signal delivery
// ---------------------------------------------------------------------------

describe("kill escalation", () => {
  it("delivers SIGTERM to the group and a cooperative driver exits before escalation", async () => {
    const supervisor = createSupervisor();
    const driver = await spawnToy(supervisor, "gentle");
    await driver.waitSupervised(5000);
    const pid = driver.pid as number;
    const lines = new LineReader(driver.stdout);
    // waitSupervised means the watchdog parented the process; sync on PONG to
    // prove the toy finished booting and installed its SIGTERM handler.
    driver.stdin.write("PING\n");
    expect(await lines.next()).toBe("PONG");

    driver.kill("SIGTERM", 2000);
    expect(await lines.next()).toBe("SIGTERM-SEEN");
    await waitFor(() => !pidAlive(pid), 1500);
    await waitFor(() => supervisor.liveCount() === 0, 1000);
    // Cooperative exit: the watchdog never had to escalate to SIGKILL.
    expect(supervisor.reapedByWatchdogCount()).toBe(0);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(0);
  });

  it("escalates to SIGKILL after graceMs for a stubborn driver", async () => {
    const supervisor = createSupervisor();
    const driver = await spawnToy(supervisor, "stubborn");
    await driver.waitSupervised(5000);
    const pid = driver.pid as number;
    const lines = new LineReader(driver.stdout);
    driver.stdin.write("STUBBORN\n");
    expect(await lines.next()).toBe("STUBBORN-OK");

    driver.kill("SIGTERM", 300);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    expect(pidAlive(pid)).toBe(true); // SIGTERM ignored in STUBBORN mode
    await waitFor(() => !pidAlive(pid), 1500); // SIGKILL followed within the grace window
    await waitFor(() => supervisor.liveCount() === 0, 1000);
    await waitFor(() => supervisor.reapedByWatchdogCount() === 1, 1000);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Shutdown paths
// ---------------------------------------------------------------------------

describe("shutdown", () => {
  it("shutdown() closes driver and watchdog cleanly and is idempotent", async () => {
    const supervisor = createSupervisor();
    const driver = await spawnToy(supervisor, "shutdown-test");
    await driver.waitSupervised(5000);
    const pid = driver.pid as number;

    await driver.shutdown(500);
    await waitFor(() => !pidAlive(pid), 2000);
    expect(supervisor.liveCount()).toBe(0);
    await expect(driver.shutdown(500)).resolves.toBeUndefined();
  });

  it("shutdownAll() reaps multiple drivers", async () => {
    const supervisor = createSupervisor();
    const drivers = await Promise.all([
      spawnToy(supervisor, "multi-1"),
      spawnToy(supervisor, "multi-2"),
      spawnToy(supervisor, "multi-3"),
    ]);
    await Promise.all(drivers.map((driver) => driver.waitSupervised(5000)));
    expect(supervisor.liveCount()).toBe(3);
    const pids = drivers.map((driver) => driver.pid as number);

    await supervisor.shutdownAll(500);
    for (const pid of pids) {
      await waitFor(() => !pidAlive(pid), 2000);
    }
    expect(supervisor.liveCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Control channel abuse
// ---------------------------------------------------------------------------

describe("control channel abuse", () => {
  it("closes the watchdog and reaps the driver on an oversized control frame", async () => {
    const supervisor = createSupervisor();
    const driver = await spawnToy(supervisor, "abuse-test");
    await driver.waitSupervised(5000);
    const pid = driver.pid as number;

    const watchdogExit = withTimeout(
      new Promise((resolvePromise) => driver.events.once("watchdog-exit", resolvePromise)),
      5000,
      "watchdog-exit event",
    );
    // >64 KiB single line on fd3 (test-only injection into the inbound parser).
    driver.__testInjectControlLine("x".repeat(70 * 1024));
    await watchdogExit;
    await waitFor(() => !pidAlive(pid), 2000);
    await waitFor(() => supervisor.liveCount() === 0, 1000);
    expect(supervisor.reapedAfterWatchdogDeath()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stale watchdog exit race (ROT-BYPART-001)
// ---------------------------------------------------------------------------

describe("stale watchdog exit race", () => {
  it("a stale watchdog exit does NOT clobber a newer record's byParticipant slot", async () => {
    const supervisor = createSupervisor();

    // Turn-1 driver A is spawned and supervised.
    const driverA = await spawnToy(supervisor, "rot-race");
    await driverA.waitSupervised(5000);
    expect(supervisor.liveCount()).toBe(1);

    // The driver `exit` control frame arrives on fd3 BEFORE the watchdog OS
    // process exits (normal teardown ordering). settleDriver(A) clears the
    // byParticipant slot for "rot-race" and marks A as settled.
    driverA.__testInjectControlLine('{"type":"exit","code":0}');
    await waitFor(() => supervisor.liveCount() === 0, 2000);

    // Turn-2 reclaims the SAME participantId before A's watchdog process has
    // finished exiting (this is the grok-stream-json per-turn spawn path,
    // which does NOT await old-process teardown). Record B is now live.
    const driverB = await spawnToy(supervisor, "rot-race");
    await driverB.waitSupervised(5000);
    expect(supervisor.liveCount()).toBe(1);
    const driverBPid = driverB.pid as number;
    expect(pidAlive(driverBPid)).toBe(true);

    // A's stale watchdog OS process finally exits now. handleWatchdogExit(A)
    // runs on the "expected" path (expectingWatchdogExit is true). Without the
    // ownership check this would unconditionally delete byParticipant["rot-race"],
    // removing B's entry while B is still live and supervised.
    const staleWatchdogPid = driverA.watchdogPid;
    process.kill(staleWatchdogPid, "SIGKILL");
    await waitFor(() => !pidAlive(staleWatchdogPid), 2000);
    // Allow the Node child-exit handler (handleWatchdogExit) to tick.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));

    // B must still be alive and supervised — the stale watchdog exit must not
    // have reaped or settled it.
    expect(pidAlive(driverBPid)).toBe(true);
    expect(supervisor.liveCount()).toBe(1);

    // The duplicate guard in spawnDriver must still reject a second concurrent
    // driver for "rot-race": byParticipant["rot-race"] still points at B.
    // With the bug, the stale exit would have clobbered it and this spawn would
    // succeed, creating a second concurrently-live driver (the P2 defect).
    await expect(spawnToy(supervisor, "rot-race")).rejects.toMatchObject({
      code: "DRIVER_SPAWN_FAILED",
    });

    // Cleanup: B is the only live driver now.
    await driverB.shutdown(500);
    await waitFor(() => !pidAlive(driverBPid), 2000);
    expect(supervisor.liveCount()).toBe(0);
  });
});
