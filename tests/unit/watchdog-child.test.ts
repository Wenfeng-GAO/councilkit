import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough, type Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The watchdog is a separate program the host spawns with control on fd 3 and
 * driver stderr on fd 4. Coverage only sees code that runs in this process, so
 * these tests load that program here and substitute those two sockets.
 */
const WATCHDOG_HREF = new URL("../../runtime-host/process/watchdog-child.mjs", import.meta.url)
  .href;
const TOY_DRIVER = new URL("../fixtures/drivers/toy-driver.mjs", import.meta.url).pathname;

const createdSockets: ControlSocket[] = [];
const faultHandlers: {
  uncaughtException: Array<() => void>;
  unhandledRejection: Array<() => void>;
} = { uncaughtException: [], unhandledRejection: [] };

let caseId = 0;
let activeExits: number[] = [];
let tempRoot = "";
const livePids: number[] = [];

const originalSocket = net.Socket;
const originalExit = process.exit;
const originalOn = process.on;
const originalStdin = process.stdin;
const originalStdout = process.stdout;

class ControlSocket extends Duplex {
  readonly fd: number;
  private pending = "";
  private queue: unknown[] = [];
  private waiters: Array<{
    resolve: (message: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private raw: Buffer[] = [];

  constructor(opts?: { fd?: number }) {
    super();
    this.fd = opts?.fd ?? -1;
    createdSockets.push(this);
  }

  override _read(): void {}

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (this.fd !== 3) {
      this.raw.push(buffer);
      callback();
      return;
    }
    this.pending += buffer.toString("utf8");
    let index = this.pending.indexOf("\n");
    while (index !== -1) {
      const line = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + 1);
      const message = JSON.parse(line) as unknown;
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.queue.push(message);
      }
      index = this.pending.indexOf("\n");
    }
    callback();
  }

  text(): string {
    return Buffer.concat(this.raw).toString("utf8");
  }

  nextMessage(timeoutMs = 2000): Promise<unknown> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error("timed out waiting for a watchdog control message"));
      }, timeoutMs);
      this.waiters.push({ resolve, timer });
    });
  }
}

interface Session {
  control: ControlSocket;
  stderr: ControlSocket;
  stdin: PassThrough;
  stdout: PassThrough;
  exits: number[];
  uncaught: () => void;
  rejection: () => void;
}

beforeAll(() => {
  // child_process calls `net.Socket({handle})` with no `new`. Only fd 3 and fd 4
  // belong to the watchdog; every other socket must stay a real net.Socket.
  function WrappedSocket(opts?: { fd?: number }) {
    if (opts && (opts.fd === 3 || opts.fd === 4)) return new ControlSocket(opts);
    return new originalSocket(opts as never);
  }
  WrappedSocket.prototype = originalSocket.prototype;
  Object.setPrototypeOf(WrappedSocket, originalSocket);
  net.Socket = WrappedSocket as unknown as typeof net.Socket;
  process.exit = ((code?: number) => {
    activeExits.push(code ?? 0);
  }) as typeof process.exit;
  process.on = ((event: string, listener: (...args: never[]) => void) => {
    if (event === "uncaughtException" || event === "unhandledRejection") {
      faultHandlers[event].push(listener as () => void);
      return process;
    }
    return originalOn.call(process, event as "exit", listener as () => void);
  }) as typeof process.on;
});

afterAll(() => {
  net.Socket = originalSocket;
  process.exit = originalExit;
  process.on = originalOn;
  Object.defineProperty(process, "stdin", { configurable: true, value: originalStdin });
  Object.defineProperty(process, "stdout", { configurable: true, value: originalStdout });
});

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "ck-watchdog-"));
});

afterEach(async () => {
  for (const pid of livePids.splice(0)) {
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
  // Let an in-process exitSoon() land in this test's exit list.
  await delay(40);
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

function feed(control: ControlSocket, payload: unknown): void {
  const text = typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`;
  control.push(Buffer.from(text));
}

async function loadWatchdog(): Promise<Session> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.on("error", () => {});
  stdout.on("error", () => {});
  const exits: number[] = [];
  activeExits = exits;
  const socketCount = createdSockets.length;
  const uncaughtCount = faultHandlers.uncaughtException.length;
  const rejectionCount = faultHandlers.unhandledRejection.length;
  Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
  Object.defineProperty(process, "stdout", { configurable: true, value: stdout });
  try {
    await import(`${WATCHDOG_HREF}?case=${caseId++}`);
  } finally {
    Object.defineProperty(process, "stdin", { configurable: true, value: originalStdin });
    Object.defineProperty(process, "stdout", { configurable: true, value: originalStdout });
  }
  const control = createdSockets[socketCount];
  const stderr = createdSockets[socketCount + 1];
  const uncaught = faultHandlers.uncaughtException[uncaughtCount];
  const rejection = faultHandlers.unhandledRejection[rejectionCount];
  if (!control || !stderr || control.fd !== 3 || stderr.fd !== 4 || !uncaught || !rejection) {
    throw new Error("watchdog module did not open fd 3, fd 4, and fault handlers");
  }
  control.on("error", () => {});
  stderr.on("error", () => {});
  return { control, stderr, stdin, stdout, exits, uncaught, rejection };
}

function track(pid: number): void {
  livePids.push(pid);
}

describe("watchdog control protocol", () => {
  it("ignores junk, parents a driver, and closes its stdin", async () => {
    const script = join(tempRoot, "eof-driver.mjs");
    await writeFile(
      script,
      [
        "process.stderr.write('err-marker\\n');",
        "process.stdout.write('ready\\n');",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write('STDIN-EOF\\n');",
        "  process.exit(0);",
        "});",
        "",
      ].join("\n"),
    );
    const session = await loadWatchdog();
    const lines = new LineReader(session.stdout);
    feed(session.control, { type: "kill", signal: "SIGKILL" });
    feed(session.control, "\n   \n");
    feed(session.control, "{not-json\n");
    feed(
      session.control,
      `${JSON.stringify({ type: "nope" })}\n${JSON.stringify({ type: "also" })}\n`,
    );
    feed(session.control, { type: "close-stdin" });

    const spawnMessage = {
      type: "spawn",
      executable: process.execPath,
      argv: [script],
      cwd: tempRoot,
      env: { PATH: process.env.PATH },
    };
    const raw = JSON.stringify(spawnMessage);
    feed(session.control, raw.slice(0, 12));
    feed(session.control, `${raw.slice(12)}\n`);

    const supervised = (await session.control.nextMessage()) as {
      type: string;
      pid: number;
      pgid: number;
      startedAt: string;
    };
    track(supervised.pid);
    expect(supervised.type).toBe("supervised");
    expect(supervised.pgid).toBe(supervised.pid);
    expect(pidAlive(supervised.pid)).toBe(true);
    expect(supervised.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await lines.next()).toBe("ready");
    expect(session.stderr.text()).toBe("err-marker\n");

    feed(session.control, { type: "close-stdin" });
    feed(session.control, { type: "close-stdin" });
    expect(await lines.next()).toBe("STDIN-EOF");
    expect(await session.control.nextMessage()).toEqual({
      type: "exit",
      pid: supervised.pid,
      code: 0,
      signal: null,
    });
    await delay(50);
    expect(session.exits).toEqual([0]);
    expect(pidAlive(supervised.pid)).toBe(false);
  });

  it("rejects a second spawn and keeps the driver when the control write throws", async () => {
    const session = await loadWatchdog();
    const lines = new LineReader(session.stdout);
    feed(session.control, {
      type: "spawn",
      executable: process.execPath,
      argv: [TOY_DRIVER],
      cwd: tempRoot,
      env: { PATH: process.env.PATH },
    });
    const supervised = (await session.control.nextMessage()) as { pid: number };
    track(supervised.pid);
    session.stdin.write("PING\n");
    expect(await lines.next()).toBe("PONG");

    const originalWrite = session.control.write.bind(session.control);
    session.control.write = (() => {
      throw new Error("broken pipe");
    }) as typeof session.control.write;
    feed(session.control, {
      type: "spawn",
      executable: process.execPath,
      argv: [TOY_DRIVER],
      cwd: tempRoot,
      env: {},
    });
    session.control.write = originalWrite;
    session.stdin.write("PING\n");
    expect(await lines.next()).toBe("PONG");
    expect(pidAlive(supervised.pid)).toBe(true);

    session.control.write = originalWrite;
    feed(session.control, {
      type: "spawn",
      executable: process.execPath,
      argv: ["-e", "process.exit(0)"],
      cwd: tempRoot,
      env: {},
    });
    expect(await session.control.nextMessage()).toEqual({
      type: "spawn-error",
      message: "driver already spawned",
    });
  });

  it("reports SIGKILL without a reaped frame", async () => {
    const session = await loadWatchdog();
    feed(session.control, {
      type: "spawn",
      executable: process.execPath,
      argv: [TOY_DRIVER],
      cwd: tempRoot,
      env: { PATH: process.env.PATH },
    });
    const supervised = (await session.control.nextMessage()) as { pid: number };
    track(supervised.pid);
    feed(session.control, { type: "kill", signal: "SIGKILL" });
    expect(await session.control.nextMessage()).toEqual({
      type: "exit",
      pid: supervised.pid,
      code: null,
      signal: "SIGKILL",
    });
    await delay(50);
    expect(session.exits).toEqual([1]);
    expect(pidAlive(supervised.pid)).toBe(false);
  });

  it("escalates SIGTERM to SIGKILL when the driver ignores it", async () => {
    const session = await loadWatchdog();
    const lines = new LineReader(session.stdout);
    feed(session.control, {
      type: "spawn",
      executable: process.execPath,
      argv: [TOY_DRIVER],
      cwd: tempRoot,
      env: { PATH: process.env.PATH },
    });
    const supervised = (await session.control.nextMessage()) as { pid: number };
    track(supervised.pid);
    session.stdin.write("STUBBORN\n");
    expect(await lines.next()).toBe("STUBBORN-OK");
    feed(session.control, { type: "kill", signal: "SIGTERM", graceMs: 80 });
    const messages = [await session.control.nextMessage(), await session.control.nextMessage()];
    expect(messages).toContainEqual({ type: "reaped", reason: "host-requested-kill" });
    expect(messages).toContainEqual({
      type: "exit",
      pid: supervised.pid,
      code: null,
      signal: "SIGKILL",
    });
    await delay(80);
    expect(session.exits).toEqual([0]);
    expect(pidAlive(supervised.pid)).toBe(false);
  });

  it("SIGKILLs a grandchild that ignores SIGTERM after the leader exits", async () => {
    const readyFile = join(tempRoot, "grand.ready");
    const grand = join(tempRoot, "grand.mjs");
    const leader = join(tempRoot, "leader.mjs");
    await writeFile(
      grand,
      `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(process.argv[2], "ready");
setInterval(() => {}, 1e9);
`,
    );
    const grandArg = JSON.stringify(grand);
    const readyArg = JSON.stringify(readyFile);
    await writeFile(
      leader,
      `import { spawn } from "node:child_process";
const grand = spawn(process.execPath, [${grandArg}, ${readyArg}], {
  stdio: "ignore",
});
process.stdout.write("GRAND " + grand.pid + "\\n");
setInterval(() => {}, 1e9);
`,
    );
    const session = await loadWatchdog();
    const lines = new LineReader(session.stdout);
    feed(session.control, {
      type: "spawn",
      executable: process.execPath,
      argv: [leader],
      cwd: tempRoot,
      env: { PATH: process.env.PATH },
    });
    const supervised = (await session.control.nextMessage()) as { pid: number };
    track(supervised.pid);
    const grandLine = await lines.next();
    const grandchildPid = Number(grandLine.slice("GRAND ".length));
    expect(Number.isInteger(grandchildPid)).toBe(true);
    track(grandchildPid);
    const readyDeadline = Date.now() + 2_000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      try {
        await access(readyFile);
        ready = true;
        break;
      } catch {
        await delay(20);
      }
    }
    expect(ready).toBe(true);
    feed(session.control, { type: "shutdown", graceMs: 150 });
    expect(await session.control.nextMessage()).toEqual({
      type: "exit",
      pid: supervised.pid,
      code: null,
      signal: "SIGTERM",
    });
    // The mocked process.exit must not count as leaving while the grandchild lives.
    await delay(40);
    expect(pidAlive(grandchildPid)).toBe(true);
    expect(session.exits).toEqual([]);
    expect(await session.control.nextMessage()).toEqual({
      type: "reaped",
      reason: "host-shutdown",
    });
    await delay(50);
    expect(pidAlive(grandchildPid)).toBe(false);
    expect(session.exits).toEqual([0]);
  });

  it("leaves during grace when a grandchild finishes SIGTERM cleanup", async () => {
    const readyFile = join(tempRoot, "grand.ready");
    const grand = join(tempRoot, "grand.mjs");
    const leader = join(tempRoot, "leader.mjs");
    const holdMs = 200;
    const graceMs = 3_000;
    await writeFile(
      grand,
      `import { writeFileSync } from "node:fs";
let held = false;
process.on("SIGTERM", () => {
  if (held) return;
  held = true;
  setTimeout(() => process.exit(0), ${holdMs});
});
writeFileSync(process.argv[2], "ready");
setInterval(() => {}, 1e9);
`,
    );
    const grandArg = JSON.stringify(grand);
    const readyArg = JSON.stringify(readyFile);
    await writeFile(
      leader,
      `import { spawn } from "node:child_process";
const grand = spawn(process.execPath, [${grandArg}, ${readyArg}], {
  stdio: "ignore",
});
process.stdout.write("GRAND " + grand.pid + "\\n");
setInterval(() => {}, 1e9);
`,
    );
    const session = await loadWatchdog();
    const lines = new LineReader(session.stdout);
    feed(session.control, {
      type: "spawn",
      executable: process.execPath,
      argv: [leader],
      cwd: tempRoot,
      env: { PATH: process.env.PATH },
    });
    const supervised = (await session.control.nextMessage()) as { pid: number };
    track(supervised.pid);
    const grandLine = await lines.next();
    const grandchildPid = Number(grandLine.slice("GRAND ".length));
    expect(Number.isInteger(grandchildPid)).toBe(true);
    track(grandchildPid);
    const readyDeadline = Date.now() + 2_000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      try {
        await access(readyFile);
        ready = true;
        break;
      } catch {
        await delay(20);
      }
    }
    expect(ready).toBe(true);
    const started = Date.now();
    feed(session.control, { type: "shutdown", graceMs });
    expect(await session.control.nextMessage()).toEqual({
      type: "exit",
      pid: supervised.pid,
      code: null,
      signal: "SIGTERM",
    });
    const deadline = started + 1_500;
    while (session.exits.length === 0 && Date.now() < deadline) await delay(20);
    expect(session.exits).toEqual([0]);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(pidAlive(grandchildPid)).toBe(false);
    await expect(session.control.nextMessage(50)).rejects.toThrow(/timed out/);
  });

  it("lets a cooperative driver exit on SIGTERM before the grace window", async () => {
    const session = await loadWatchdog();
    const lines = new LineReader(session.stdout);
    feed(session.control, {
      type: "spawn",
      executable: process.execPath,
      argv: [TOY_DRIVER],
      cwd: tempRoot,
      env: { PATH: process.env.PATH },
    });
    const supervised = (await session.control.nextMessage()) as { pid: number };
    track(supervised.pid);
    session.stdin.write("PING\n");
    expect(await lines.next()).toBe("PONG");
    feed(session.control, { type: "shutdown", graceMs: 300 });
    expect(await lines.next()).toBe("SIGTERM-SEEN");
    expect(await session.control.nextMessage()).toEqual({
      type: "exit",
      pid: supervised.pid,
      code: 0,
      signal: null,
    });
    await delay(400);
    expect(session.exits).toEqual([0]);
    await expect(session.control.nextMessage(50)).rejects.toThrow(/timed out/);
  });

  it("reaps immediately when grace is zero or negative and no driver exists", async () => {
    const shutdown = await loadWatchdog();
    feed(shutdown.control, { type: "shutdown", graceMs: 0 });
    expect(await shutdown.control.nextMessage()).toEqual({
      type: "reaped",
      reason: "host-shutdown",
    });
    await delay(40);
    expect(shutdown.exits).toEqual([0]);

    const quit = await loadWatchdog();
    feed(quit.control, { type: "kill", signal: "SIGQUIT", graceMs: 0 });
    expect(await quit.control.nextMessage()).toEqual({
      type: "reaped",
      reason: "host-requested-kill",
    });
    await delay(40);
    expect(quit.exits).toEqual([0]);

    const negative = await loadWatchdog();
    feed(negative.control, { type: "kill", signal: "SIGTERM", graceMs: -5 });
    expect(await negative.control.nextMessage()).toEqual({
      type: "reaped",
      reason: "host-requested-kill",
    });
    await delay(40);
    expect(negative.exits).toEqual([0]);
  });

  it("reports spawn failures for a missing binary and a non-string executable", async () => {
    const missing = join(tempRoot, "missing-bin");
    const enoent = await loadWatchdog();
    feed(enoent.control, {
      type: "spawn",
      executable: missing,
      argv: [],
      cwd: tempRoot,
      env: {},
    });
    const supervised = (await enoent.control.nextMessage()) as {
      type: string;
      startedAt: string;
      pid?: number;
    };
    expect(supervised.type).toBe("supervised");
    expect(supervised.pid).toBeUndefined();
    expect(supervised.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await enoent.control.nextMessage()).toEqual({
      type: "spawn-error",
      message: `spawn ${missing} ENOENT`,
    });
    await delay(40);
    expect(enoent.exits).toEqual([1]);

    const bad = await loadWatchdog();
    feed(bad.control, { type: "spawn", executable: 1, argv: [], cwd: tempRoot, env: {} });
    expect(await bad.control.nextMessage()).toEqual({
      type: "spawn-error",
      message: 'The "file" argument must be of type string. Received type number (1)',
    });
    await delay(40);
    expect(bad.exits).toEqual([1]);
  });

  it("defaults omitted argv and env, and maps a nonzero driver status to exit code 1", async () => {
    const script = join(tempRoot, "print-env.mjs");
    await writeFile(
      script,
      `#!${process.execPath}\nprocess.stdout.write("ARGV " + JSON.stringify(process.argv.slice(1)) + "\\n");\nconst { __CF_USER_TEXT_ENCODING: _osInjected, ...env } = process.env;\nprocess.stdout.write("ENV " + JSON.stringify(env) + "\\n");\nprocess.exit(0);\n`,
    );
    await chmod(script, 0o755);
    const empty = await loadWatchdog();
    const lines = new LineReader(empty.stdout);
    const spawnMessage = { type: "spawn", executable: script, cwd: tempRoot };
    feed(empty.control, spawnMessage);
    const supervised = (await empty.control.nextMessage()) as { pid: number };
    track(supervised.pid);
    expect(await lines.next()).toBe(`ARGV ${JSON.stringify([script])}`);
    expect(await lines.next()).toBe("ENV {}");
    expect(await empty.control.nextMessage()).toEqual({
      type: "exit",
      pid: supervised.pid,
      code: 0,
      signal: null,
    });
    await delay(40);
    expect(empty.exits).toEqual([0]);

    const failed = await loadWatchdog();
    feed(failed.control, {
      type: "spawn",
      executable: process.execPath,
      argv: ["-e", "process.exit(4)"],
      cwd: tempRoot,
      env: {},
    });
    const started = (await failed.control.nextMessage()) as { pid: number };
    track(started.pid);
    expect(await failed.control.nextMessage()).toEqual({
      type: "exit",
      pid: started.pid,
      code: 4,
      signal: null,
    });
    await delay(40);
    expect(failed.exits).toEqual([1]);
  });

  it("reaps on an uncaught exception and ignores a second fault", async () => {
    const session = await loadWatchdog();
    session.uncaught();
    session.rejection();
    expect(await session.control.nextMessage()).toEqual({
      type: "reaped",
      reason: "watchdog-fault",
    });
    await delay(40);
    expect(session.exits).toEqual([0]);
  });

  it("still reports exit when the driver group is already gone", async () => {
    const session = await loadWatchdog();
    feed(session.control, {
      type: "spawn",
      executable: process.execPath,
      argv: [TOY_DRIVER],
      cwd: tempRoot,
      env: { PATH: process.env.PATH },
    });
    const supervised = (await session.control.nextMessage()) as { pid: number };
    track(supervised.pid);
    process.kill(supervised.pid, "SIGKILL");
    feed(session.control, { type: "kill", signal: "SIGKILL" });
    expect(await session.control.nextMessage()).toEqual({
      type: "exit",
      pid: supervised.pid,
      code: null,
      signal: "SIGKILL",
    });
    expect(pidAlive(supervised.pid)).toBe(false);
  });
});
