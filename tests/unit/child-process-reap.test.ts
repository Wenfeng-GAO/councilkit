import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function stubbornChild(detached: boolean): ChildProcess {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e9);"],
    { detached, stdio: "ignore" },
  );
  if (child.pid === undefined) throw new Error("stubborn child has no pid");
  leakedPids.push(child.pid);
  return child;
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
    const child = stubbornChild(false);
    terminateChild(child, { graceMs: 200 });
    await expect(diesWithin(child.pid as number, 2_000)).resolves.toBe(true);
  });

  it("SIGKILLs a detached process group that ignores SIGTERM", async () => {
    const child = stubbornChild(true);
    terminateChild(child, { graceMs: 200, group: true });
    await expect(diesWithin(child.pid as number, 2_000)).resolves.toBe(true);
  });

  it("falls back to the child handle when the pid is not a process group", async () => {
    const child = stubbornChild(false);
    terminateChild(child, { graceMs: 200, group: true });
    await expect(diesWithin(child.pid as number, 2_000)).resolves.toBe(true);
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

  it("does nothing when the child has already exited", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0);"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(() => terminateChild(child, { graceMs: 50 })).not.toThrow();
  });
});

describe("handshakeReview timeout", () => {
  it("reaps a detached child that traps SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-reap-hs-"));
    dirs.push(root);
    const child = stubbornChild(true);
    const pid = child.pid as number;
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
  });
});
