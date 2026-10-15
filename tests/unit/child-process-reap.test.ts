import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPidAlive } from "@shared/runtime/cli-run-progress";
import { terminateChild } from "@shared/runtime/terminate-child";
import { afterEach, describe, expect, it } from "vitest";
import { handshakeReview } from "../../runtime-host/cli-launcher";
import { inspectPrBranches } from "../../runtime-host/repair-branch-hints";

const dirs: string[] = [];
const leakedPids: number[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function diesWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(40);
  }
  return !isPidAlive(pid);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

/**
 * The trap is installed before the ready file exists. A SIGTERM in the same
 * turn as spawn kills Node before `process.on` runs, so callers must wait.
 */
function writeTrap(
  root: string,
  readyFile: string,
  grandchild: boolean,
  leaderTraps = true,
): string {
  const scriptPath = join(root, "trap.js");
  let grandSpawn = "";
  if (grandchild) {
    const grandReady = join(root, "grand.ready");
    const grandPid = join(root, "grand.pid");
    const grandPath = join(root, "grand.js");
    writeFileSync(
      grandPath,
      `const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(grandReady)}, "ready");
setInterval(() => {}, 1e9);
`,
    );
    grandSpawn = `const { spawn } = require("node:child_process");
const grand = spawn(process.execPath, [${JSON.stringify(grandPath)}], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(grandPid)}, String(grand.pid));
`;
  }
  const leaderTrap = leaderTraps ? `process.on("SIGTERM", () => {});\n` : "";
  writeFileSync(
    scriptPath,
    `const fs = require("node:fs");
${leaderTrap}${grandSpawn}fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");
setInterval(() => {}, 1e9);
`,
  );
  return scriptPath;
}

async function armedChild(
  detached: boolean,
  grandchild: boolean,
  leaderTraps = true,
): Promise<{ child: ChildProcess; pid: number; grandchildPid: number | null }> {
  const root = mkdtempSync(join(tmpdir(), "ck-reap-child-"));
  dirs.push(root);
  const readyFile = join(root, "ready");
  const child = spawn(process.execPath, [writeTrap(root, readyFile, grandchild, leaderTraps)], {
    detached,
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("stubborn child has no pid");
  const pid = child.pid;
  leakedPids.push(pid);
  await waitForFile(readyFile);
  if (!grandchild) return { child, pid, grandchildPid: null };
  await waitForFile(join(root, "grand.pid"));
  await waitForFile(join(root, "grand.ready"));
  const grandchildPid = Number(readFileSync(join(root, "grand.pid"), "utf8"));
  if (!Number.isInteger(grandchildPid) || grandchildPid <= 0) {
    throw new Error("grandchild pid was not written");
  }
  leakedPids.push(grandchildPid);
  return { child, pid, grandchildPid };
}

function recordGroupSignals(pid: number): { signals: string[]; restore: () => void } {
  const signals: string[] = [];
  const original = process.kill;
  process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
    if (target === -pid) signals.push(String(signal));
    return original.call(process, target, signal as NodeJS.Signals);
  }) as typeof process.kill;
  return {
    signals,
    restore() {
      process.kill = original;
    },
  };
}

afterEach(() => {
  for (const pid of leakedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("inspectPrBranches timeout", () => {
  it("reaps a gh that traps SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-reap-"));
    dirs.push(root);
    const bin = join(root, "bin");
    const home = join(root, "home");
    mkdirSync(bin);
    mkdirSync(home);
    const pidFile = join(root, "pid");
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1e9);
`,
    );
    chmodSync(gh, 0o755);

    const hints = await inspectPrBranches("https://github.com/acme/repo/pull/1", {
      cwd: root,
      env: { HOME: home, PATH: bin },
    });

    expect(hints).toEqual({ sourceBranch: null, base: null });
    const pid = Number(readFileSync(pidFile, "utf8"));
    leakedPids.push(pid);
    expect(pid).toBeGreaterThan(0);
    await expect(diesWithin(pid, 2_500)).resolves.toBe(true);
  }, 15_000);
});

describe("terminateChild", () => {
  it("SIGKILLs a child that ignores SIGTERM", async () => {
    const { child, pid } = await armedChild(false, false);
    terminateChild(child, { graceMs: 200 });
    await expect(diesWithin(pid, 2_000)).resolves.toBe(true);
  });

  it("SIGKILLs a detached process group that ignores SIGTERM", async () => {
    const { child, pid, grandchildPid } = await armedChild(true, true);
    if (grandchildPid === null) throw new Error("missing grandchild");
    terminateChild(child, { graceMs: 200, group: true });
    await expect(diesWithin(pid, 2_000)).resolves.toBe(true);
    await expect(diesWithin(grandchildPid, 2_000)).resolves.toBe(true);
  });

  it("SIGKILLs a detached grandchild that ignores SIGTERM after the leader exits", async () => {
    const { child, pid, grandchildPid } = await armedChild(true, true, false);
    if (grandchildPid === null) throw new Error("missing grandchild");
    terminateChild(child, { graceMs: 200, group: true });
    await expect(diesWithin(pid, 2_000)).resolves.toBe(true);
    await expect(diesWithin(grandchildPid, 2_000)).resolves.toBe(true);
  });

  it("does not SIGKILL a detached group after its leader exits with no descendants", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9);"], {
      detached: true,
      stdio: "ignore",
    });
    if (child.pid === undefined) throw new Error("child has no pid");
    const pid = child.pid;
    leakedPids.push(pid);
    const group = recordGroupSignals(pid);
    try {
      terminateChild(child, { graceMs: 200, group: true });
      await expect(diesWithin(pid, 2_000)).resolves.toBe(true);
      await sleep(400);
    } finally {
      group.restore();
    }
    expect(group.signals.filter((signal) => signal !== "0")).toEqual(["SIGTERM"]);
  });

  it("falls back to the child handle when the pid is not a process group", async () => {
    const { child, pid } = await armedChild(false, false);
    const group = recordGroupSignals(pid);
    try {
      terminateChild(child, { graceMs: 200, group: true });
      await expect(diesWithin(pid, 2_000)).resolves.toBe(true);
      await sleep(300);
    } finally {
      group.restore();
    }
    expect(group.signals).toEqual(["SIGTERM"]);
  });

  it("reaps a child that exits on SIGTERM before the grace elapses", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9);"], {
      stdio: "ignore",
    });
    if (child.pid === undefined) throw new Error("child has no pid");
    leakedPids.push(child.pid);
    const started = Date.now();
    terminateChild(child, { graceMs: 5_000 });
    await expect(diesWithin(child.pid, 2_000)).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("sends no signal when the child has already exited", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0);"], { stdio: "ignore" });
    if (child.pid === undefined) throw new Error("child has no pid");
    const pid = child.pid;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    const signals: string[] = [];
    const originalChildKill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number) => {
      signals.push(`child:${String(signal)}`);
      return originalChildKill(signal);
    };
    const original = process.kill;
    process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
      if (target === pid || target === -pid) signals.push(`process:${target}:${String(signal)}`);
      return original.call(process, target, signal as NodeJS.Signals);
    }) as typeof process.kill;
    try {
      terminateChild(child, { graceMs: 50 });
      await sleep(200);
    } finally {
      process.kill = original;
    }
    expect(signals).toEqual(["child:SIGTERM"]);
    expect(child.killed).toBe(false);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  });
});

describe("handshakeReview timeout", () => {
  it("reaps a detached child that traps SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-reap-hs-"));
    dirs.push(root);
    const previous = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = root;
    try {
      const { child, pid } = await armedChild(true, false);
      await expect(
        handshakeReview(
          child,
          {
            action: "review",
            runId: "ck-review-reap-timeout",
            logPath: join(root, "missing.log"),
            pr: "https://github.com/acme/repo/pull/1",
          },
          pid,
          200,
        ),
      ).rejects.toThrow(/handshake timed out/);
      await expect(diesWithin(pid, 2_500)).resolves.toBe(true);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
      else process.env.COUNCILKIT_HOME = previous;
    }
  });
});
