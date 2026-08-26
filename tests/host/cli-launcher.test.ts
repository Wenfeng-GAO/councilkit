import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  handshakeReview,
  launchArgs,
  resolveCouncilkitLauncher,
  resolveCouncilkitSpawn,
} from "@host/cli-launcher";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUN_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";

let home: string;
let oldHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-launcher-"));
  oldHome = process.env.COUNCILKIT_HOME;
  process.env.COUNCILKIT_HOME = home;
});

afterEach(() => {
  if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
  else process.env.COUNCILKIT_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

describe("launchArgs", () => {
  it("passes --run-id so the Host handshake can pin the run directory", () => {
    expect(
      launchArgs({
        action: "review",
        runId: RUN_ID,
        logPath: "/tmp/x.log",
        pr: "https://github.com/acme/repo/pull/126",
      }),
    ).toEqual(["review", "https://github.com/acme/repo/pull/126", "--run-id", RUN_ID]);
  });
});

describe("resolveCouncilkitSpawn", () => {
  it("uses tsx + CLI source outside production so stale dist cannot reject --run-id", () => {
    const spec = resolveCouncilkitSpawn();
    expect(spec).not.toBeNull();
    if (spec === null) return;
    expect(spec.argvPrefix.some((part) => part.endsWith("cli/src/main.ts"))).toBe(true);
    expect(spec.argvPrefix.some((part) => part.includes("tsx"))).toBe(true);
  });
});

describe("councilkit accepts Host --run-id", () => {
  it("tsx source rejects a bad --run-id value, not the flag itself", () => {
    const spec = resolveCouncilkitSpawn();
    expect(spec).not.toBeNull();
    if (spec === null) return;
    const result = spawnSync(
      spec.execPath,
      [...spec.argvPrefix, "review", "--run-id", "not-a-uuid", "--task", "x", "--json"],
      { encoding: "utf8" },
    );
    const text = `${result.stdout}${result.stderr}`;
    expect(text).not.toMatch(/Unknown option '--run-id'/);
    expect(text).toMatch(/--run-id must be a ck-review/);
  }, 20_000);

  it("bundled dist accepts --run-id when cli/dist exists", () => {
    const launcher = resolveCouncilkitLauncher();
    const dist = resolve(process.cwd(), "cli/dist/main.mjs");
    if (launcher === null || !existsSync(dist)) return;
    const result = spawnSync(
      process.execPath,
      [launcher, "review", "--run-id", "not-a-uuid", "--task", "x", "--json"],
      { encoding: "utf8" },
    );
    const text = `${result.stdout}${result.stderr}`;
    expect(text).not.toMatch(/Unknown option '--run-id'/);
    expect(text).toMatch(/--run-id must be a ck-review/);
  }, 20_000);
});

describe("handshakeReview", () => {
  it("fails when the child mkdir then exits, even if the run dir exists", async () => {
    const runDir = join(home, "runs", RUN_ID);
    const logPath = join(home, "review.log");
    writeFileSync(logPath, "driver not on PATH\n");
    const script = `
      const { mkdirSync } = require("node:fs");
      mkdirSync(${JSON.stringify(runDir)}, { recursive: true });
      process.exit(2);
    `;
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (child.pid === undefined) throw new Error("no pid");
    await expect(
      handshakeReview(
        child,
        { action: "review", runId: RUN_ID, logPath, pr: "https://github.com/a/b/pull/1" },
        child.pid,
      ),
    ).rejects.toThrow(/driver not on PATH|exited 2/);
  });

  it("succeeds only while the child is still alive after creating the run dir", async () => {
    const runDir = join(home, "runs", RUN_ID);
    const logPath = join(home, "review.log");
    writeFileSync(logPath, "");
    const script = `
      const { mkdirSync } = require("node:fs");
      mkdirSync(${JSON.stringify(runDir)}, { recursive: true });
      setTimeout(() => {}, 4000);
    `;
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error("no pid");
    try {
      await expect(
        handshakeReview(
          child,
          { action: "review", runId: RUN_ID, logPath, pr: "https://github.com/a/b/pull/1" },
          pid,
        ),
      ).resolves.toEqual({ pid });
    } finally {
      try {
        child.kill("SIGTERM");
      } catch {
        // gone
      }
    }
  });
});
