/**
 * Scratch re-review keeps the killed review's spec contract and PR base.
 * The first review is a real CLI process, killed -9 while a seat is running.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCliRuns } from "@shared/runtime/cli-runs-index";
import { afterEach, describe, expect, it } from "vitest";
import { DRIVER_PROBE_PROMPT } from "../src/auto/driver-commands";
import type { SpawnImpl, SpawnInput, SpawnOutput } from "../src/auto/runner";
import { FixExit, runFix } from "../src/commands/fix";
import { Store } from "../src/store/store";

const REPO_ROOT = join(import.meta.dirname, "../..");

function envelope(text: string): SpawnOutput {
  return {
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }),
    exitCode: 0,
    timedOut: false,
    aborted: false,
  };
}

function completingSpawn(calls: SpawnInput[]): SpawnImpl {
  return async (input) => {
    calls.push(input);
    if (input.prompt === DRIVER_PROBE_PROMPT) return envelope("ok");
    if (input.prompt.includes("对比汇总")) {
      return envelope("## Overview\nok\n## Verdict\napprove\n");
    }
    return envelope("## Findings\n- [nit] ok\n## Verification\n未验证\n## Verdict\ncomment\n");
  };
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-c", "init.defaultBranch=main", "-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "councilkit",
      GIT_AUTHOR_EMAIL: "councilkit@example.com",
      GIT_COMMITTER_NAME: "councilkit",
      GIT_COMMITTER_EMAIL: "councilkit@example.com",
    },
  }).trim();
}

function initRepo(): { repo: string; head: string; base: string } {
  const repo = mkdtempSync(join(tmpdir(), "ck-rereview-repo-"));
  git(repo, ["init"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "pay.ts"), "export const paid = false;\n");
  git(repo, ["add", "pay.ts"]);
  git(repo, ["commit", "-m", "feature"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  return { repo, head, base };
}

function orphanHead(repo: string): void {
  git(repo, ["checkout", "--orphan", "no-parent"]);
  git(repo, ["rm", "-rf", "."]);
  writeFileSync(join(repo, "orphan.txt"), "root\n");
  git(repo, ["add", "orphan.txt"]);
  git(repo, ["commit", "-m", "orphan root"]);
}

function prepareHome(): { home: string; bin: string } {
  const home = mkdtempSync(join(tmpdir(), "ck-rereview-contract-"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["cld", "kimi", "codex"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  const previous = process.env.COUNCILKIT_HOME;
  process.env.COUNCILKIT_HOME = home;
  const store = new Store();
  const alice = store.createAgent({
    name: "review-security",
    personaPrompt: "security",
    modelId: "m",
    color: "#000000",
    driverSelection: { driverId: "claude-stream-json", options: { route: "cfuse" } },
  });
  const bob = store.createAgent({
    name: "review-adversarial",
    personaPrompt: "adversarial",
    modelId: "m",
    color: "#111111",
    driverSelection: { driverId: "claude-stream-json", options: { route: "cfuse" } },
  });
  store.createCouncil({
    name: "pr-jury",
    topic: "jury",
    agentIds: [alice.id, bob.id],
    rounds: 1,
    reporterAgentId: bob.id,
  });
  if (previous === undefined) delete process.env.COUNCILKIT_HOME;
  else process.env.COUNCILKIT_HOME = previous;
  return { home, bin };
}

function startReview(home: string, bin: string, args: string[]): ChildProcess {
  return spawn(
    process.execPath,
    ["--import", "tsx", "cli/tests/support/hang-review-seat.ts", ...args],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        COUNCILKIT_HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function waitForSeat(home: string, child: ChildProcess): Promise<string> {
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`review exited ${child.exitCode} before a seat hung\n${stderr.join("")}`);
    }
    const runs = join(home, "runs");
    if (existsSync(runs)) {
      for (const name of readdirSync(runs)) {
        if (!name.startsWith("ck-review-")) continue;
        const dir = join(runs, name);
        if (!existsSync(join(dir, "review.pid"))) continue;
        if (!existsSync(join(dir, "status.json"))) continue;
        const live = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as {
          progress?: { attempts?: Array<{ role?: string; status?: string }> };
        };
        const seatRunning = (live.progress?.attempts ?? []).some(
          (row) => row.role === "attempt" && row.status === "running",
        );
        if (seatRunning) return name;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for a hung seat\n${stderr.join("")}`);
}

function ageIntoInterruption(home: string, runId: string): void {
  const statusPath = join(home, "runs", runId, "status.json");
  const live = JSON.parse(readFileSync(statusPath, "utf8")) as {
    progress: { updatedAt: string };
  };
  live.progress.updatedAt = new Date(Date.now() - 31_000).toISOString();
  writeFileSync(statusPath, `${JSON.stringify(live)}\n`);
  process.env.COUNCILKIT_HOME = home;
  const listed = listCliRuns(process.env).find((run) => run.runId === runId);
  expect(listed?.status).toBe("interrupted");
}

describe("scratch re-review keeps the original contract", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function killMidSeat(
    args: string[],
  ): Promise<{ home: string; bin: string; runId: string }> {
    const { home, bin } = prepareHome();
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const child = startReview(home, bin, args);
    cleanups.push(() => {
      if (child.exitCode === null && child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    });
    const runId = await waitForSeat(home, child);
    if (child.pid === undefined) throw new Error("review child has no pid");
    process.kill(child.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    ageIntoInterruption(home, runId);
    return { home, bin, runId };
  }

  async function rerun(
    home: string,
    bin: string,
    runId: string,
  ): Promise<{ lines: string[]; calls: SpawnInput[] }> {
    process.env.COUNCILKIT_HOME = home;
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    const calls: SpawnInput[] = [];
    const lines: string[] = [];
    const sink = {
      json: false,
      progress(message: string) {
        lines.push(message);
      },
      diag() {},
      finish() {
        return Promise.resolve();
      },
    };
    try {
      await runFix(["--run", runId, "--re-review-only"], sink, {
        spawnImpl: completingSpawn(calls),
      });
    } catch (error) {
      if (!(error instanceof FixExit) || error.exitCode !== 0) {
        throw new Error(
          `re-review failed (${error instanceof Error ? error.message : String(error)})\n${lines.join("\n")}`,
        );
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    return { lines, calls };
  }

  it("restarts a killed --spec task with that spec and running seats", async () => {
    const specDir = mkdtempSync(join(tmpdir(), "ck-spec-"));
    cleanups.push(() => rmSync(specDir, { recursive: true, force: true }));
    const spec = join(specDir, "acceptance.md");
    writeFileSync(spec, "# 结算\n\n## 验收\n\n- [ ] 失败时展示说明 AC-1\n");
    const { home, bin, runId } = await killMidSeat([
      "--task",
      "给结算页补一张失败态说明",
      "--spec",
      spec,
    ]);
    const manifest = JSON.parse(
      readFileSync(join(home, "runs", runId, "invocation-manifest.v1.json"), "utf8"),
    ) as { task: { specSource?: string }; requireSpec?: boolean };
    expect(manifest.task.specSource).toBe(spec);
    expect(manifest.requireSpec).not.toBe(false);

    const { lines, calls } = await rerun(home, bin, runId);
    const text = lines.join("\n");
    expect(text).toContain(`spec: ${spec}`);
    expect(text).not.toContain("SPEC_REQUIRED");
    expect(text).not.toContain("DRIVER_SPAWN_FAILED");
    expect(text).not.toContain("(unbound)");
    expect(calls.some((call) => call.prompt !== DRIVER_PROBE_PROMPT)).toBe(true);
  });

  it("restarts a killed --no-require-spec task without binding a spec", async () => {
    const { home, bin, runId } = await killMidSeat([
      "--task",
      "给结算页补一张失败态说明",
      "--no-require-spec",
    ]);
    const manifest = JSON.parse(
      readFileSync(join(home, "runs", runId, "invocation-manifest.v1.json"), "utf8"),
    ) as { requireSpec?: boolean };
    expect(manifest.requireSpec).toBe(false);

    const { lines, calls } = await rerun(home, bin, runId);
    const text = lines.join("\n");
    expect(text).toContain("--no-require-spec");
    expect(text).not.toContain("SPEC_REQUIRED");
    expect(text).not.toContain("DRIVER_SPAWN_FAILED");
    expect(calls.some((call) => call.prompt !== DRIVER_PROBE_PROMPT)).toBe(true);
  });

  it("restarts a killed PR review against the stored base when HEAD~1 is gone", async () => {
    const { repo, head, base } = initRepo();
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
    const pr = "https://github.com/acme/payments/pull/366";
    const { home, bin, runId } = await killMidSeat([
      pr,
      "--repo",
      repo,
      "--pin-sha",
      head,
      "--no-require-spec",
    ]);
    const context = readFileSync(join(home, "runs", runId, "review-context.md"), "utf8");
    expect(context).toContain(`- base: \`${base}\``);
    let headParent = "";
    try {
      headParent = git(repo, ["rev-parse", "--verify", "HEAD~1"]);
    } catch {
      headParent = "";
    }
    expect(headParent).toBe(base);
    orphanHead(repo);
    try {
      git(repo, ["rev-parse", "--verify", "HEAD~1"]);
      throw new Error("HEAD~1 still resolved");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toBe(
        "HEAD~1 still resolved",
      );
    }

    const { lines, calls } = await rerun(home, bin, runId);
    const text = lines.join("\n");
    expect(text).not.toContain("cannot resolve local target ref");
    expect(text).not.toContain("SPEC_REQUIRED");
    expect(text).not.toContain("DRIVER_SPAWN_FAILED");
    expect(text).not.toContain("empty diff");
    expect(calls.some((call) => call.prompt !== DRIVER_PROBE_PROMPT)).toBe(true);
    const followUps = readdirSync(join(home, "runs")).filter(
      (name) => name.startsWith("ck-review-") && name !== runId,
    );
    expect(followUps.length).toBeGreaterThan(0);
    const followContext = readFileSync(
      join(home, "runs", followUps[0] as string, "review-context.md"),
      "utf8",
    );
    expect(followContext).toContain(`- head: \`${head}\``);
    expect(followContext).toContain(`- base: \`${base}\``);
  });
});
