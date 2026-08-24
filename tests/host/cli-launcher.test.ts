import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handshakeReview } from "@host/cli-launcher";
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
