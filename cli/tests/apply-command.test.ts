import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunCommand } from "../src/auto/checkout-pr";
import { DRIVER_PROBE_PROMPT } from "../src/auto/driver-commands";
import type { SpawnImpl, SpawnInput, SpawnOutput } from "../src/auto/runner";
import { ApplyExit, runApply } from "../src/commands/apply";
import { CliError } from "../src/errors";
import { Store } from "../src/store/store";

const RUN_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const PR_URL = "https://github.com/acme/repo/pull/9";

interface FakeSink {
  json: boolean;
  lines: string[];
  finished: unknown;
  progress(m: string): void;
  diag(m: string): void;
  finish(d: unknown): Promise<void>;
}

function makeSink(): FakeSink {
  const sink: FakeSink = {
    json: false,
    lines: [],
    finished: undefined,
    progress: (m) => sink.lines.push(m),
    diag: () => {},
    finish: (d) => {
      sink.finished = d;
      return Promise.resolve();
    },
  };
  return sink;
}

function grokEnvelope(text: string): SpawnOutput {
  return {
    stdout: JSON.stringify({ text }),
    exitCode: 0,
    timedOut: false,
    aborted: false,
  };
}

describe("cli apply command", () => {
  let home: string;
  let bin: string;
  const oldHome = process.env.COUNCILKIT_HOME;
  const oldPath = process.env.PATH;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-apply-"));
    bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["grok", "gh", "git", "antcode"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, name), 0o755);
    }
    process.env.COUNCILKIT_HOME = home;
    process.env.PATH = bin;
  });

  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    if (oldPath === undefined) process.env.PATH = undefined;
    else process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
  });

  function seedGrok(name = "review-adversarial"): { id: string; name: string } {
    const store = new Store();
    const agent = store.createAgent({
      name,
      personaPrompt: "fix the PR",
      modelId: "grok-4.6",
      color: "#a78bfa",
      driverSelection: { driverId: "grok-stream-json", options: {} },
    });
    return { id: agent.id, name: agent.name };
  }

  function seedReviewRun(opts: { pr?: string; finished?: boolean } = {}): void {
    const dir = join(home, "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "report.md"),
      "# Autonomous Review Report\n\n## 结论\nchanges-requested\n",
    );
    const started = {
      kind: "review.started",
      version: 1,
      runId: RUN_ID,
      startedAt: "2026-08-01T00:00:00.000Z",
      task: { pr: opts.pr ?? PR_URL },
      attempts: [
        {
          attemptId: "attempt-0",
          agentId: "a",
          agentName: "review-security",
          driverId: "claude-stream-json",
          modelId: "m",
        },
      ],
      aggregator: {
        attemptId: "aggregator",
        agentId: "a",
        agentName: "review-security",
        driverId: "claude-stream-json",
        modelId: "m",
      },
    };
    const lines = [`${JSON.stringify(started)}`];
    if (opts.finished !== false) {
      lines.push(
        JSON.stringify({
          kind: "review.finished",
          version: 1,
          status: "completed",
          endedAt: "2026-08-01T01:00:00.000Z",
          incomplete: false,
          reportPath: join(dir, "report.md"),
        }),
      );
    }
    writeFileSync(join(dir, "transcript.jsonl"), `${lines.join("\n")}\n`);
  }

  function fakeSpawn(): SpawnImpl {
    return async (input: SpawnInput) => {
      if (input.prompt === DRIVER_PROBE_PROMPT) return grokEnvelope("ok");
      return grokEnvelope("已按报告修改并提交。");
    };
  }

  function fakeGit(opts: { failPush?: boolean } = {}): {
    runCommand: RunCommand;
    calls: Array<{ executable: string; argv: string[] }>;
  } {
    const calls: Array<{ executable: string; argv: string[] }> = [];
    const runCommand: RunCommand = async (input) => {
      calls.push({ executable: input.executable, argv: input.argv });
      if (input.executable === "gh" && input.argv[0] === "pr" && input.argv[1] === "view") {
        return {
          stdout: JSON.stringify({
            headRefName: "feat-x",
            headRepository: { nameWithOwner: "acme/repo", name: "repo" },
            headRepositoryOwner: { login: "acme" },
            url: PR_URL,
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (input.executable === "git" && input.argv[0] === "rev-parse" && input.argv[1] === "HEAD") {
        return { stdout: "abc1234deadbeef\n", stderr: "", exitCode: 0 };
      }
      if (
        input.executable === "git" &&
        input.argv[0] === "rev-parse" &&
        input.argv.includes("--abbrev-ref")
      ) {
        return { stdout: "feat-x\n", stderr: "", exitCode: 0 };
      }
      if (input.executable === "git" && input.argv[0] === "status") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (input.executable === "git" && input.argv[0] === "push") {
        if (opts.failPush) {
          return { stdout: "", stderr: "rejected", exitCode: 1 };
        }
        return { stdout: "ok\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    return { runCommand, calls };
  }

  async function runCapturing(
    args: string[],
    sink: FakeSink,
    deps: { spawnImpl?: SpawnImpl; runCommand?: RunCommand } = {},
  ): Promise<number> {
    try {
      await runApply(args, sink, {
        spawnImpl: deps.spawnImpl ?? fakeSpawn(),
        runCommand: deps.runCommand,
      });
      throw new Error("expected ApplyExit");
    } catch (error) {
      if (error instanceof ApplyExit) return error.exitCode;
      throw error;
    }
  }

  it("rejects a missing run id", async () => {
    try {
      await runApply([], makeSink(), { spawnImpl: fakeSpawn() });
      throw new Error("expected usage");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).exitCode).toBe(2);
      expect((error as CliError).message).toContain("--run");
    }
  });

  it("rejects apply while the review is still running", async () => {
    seedGrok();
    seedReviewRun({ finished: false });
    try {
      await runApply(["--run", RUN_ID], makeSink(), { spawnImpl: fakeSpawn() });
      throw new Error("expected usage");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain("still running");
    }
  });

  it("follows plan.md when the consensus plan is present", async () => {
    seedGrok();
    seedReviewRun();
    writeFileSync(
      join(home, "runs", RUN_ID, "plan.md"),
      "# 修复方案\n\n## 落地顺序\n\n### 集群 1: log\n",
    );
    const prompts: string[] = [];
    const spawnImpl: SpawnImpl = async (input) => {
      prompts.push(input.prompt);
      if (input.prompt === DRIVER_PROBE_PROMPT) return grokEnvelope("ok");
      return grokEnvelope("已按方案修改并提交。");
    };
    const git = fakeGit();
    const sink = makeSink();
    const code = await runCapturing(["--run", RUN_ID, "--no-push"], sink, {
      runCommand: git.runCommand,
      spawnImpl,
    });
    expect(code).toBe(0);
    expect(prompts.some((p) => p.includes("COUNCILKIT-PLAN.md") && p.includes("只落地集群"))).toBe(
      true,
    );
    const landings = readFileSync(join(home, "runs", RUN_ID, "landings.jsonl"), "utf8");
    expect(landings).toContain('"clusterId":"log"');
  });

  it("defaults to review-adversarial, checks out the PR, and pushes", async () => {
    seedGrok();
    seedReviewRun();
    const git = fakeGit();
    const sink = makeSink();
    const code = await runCapturing(["--run", RUN_ID], sink, { runCommand: git.runCommand });
    expect(code).toBe(0);
    const outcome = sink.finished as {
      status: string;
      pushed: boolean;
      branch: string;
      agent: { name: string; driverId: string };
      pr: string;
    };
    expect(outcome.status).toBe("completed");
    expect(outcome.pushed).toBe(true);
    expect(outcome.branch).toBe("feat-x");
    expect(outcome.agent.name).toBe("review-adversarial");
    expect(outcome.agent.driverId).toBe("grok-stream-json");
    expect(outcome.pr).toBe(PR_URL);
    expect(git.calls.some((c) => c.executable === "git" && c.argv[0] === "push")).toBe(true);
    expect(git.calls.some((c) => c.executable === "gh" && c.argv.includes("checkout"))).toBe(true);
    const applyJson = JSON.parse(
      readFileSync(join(home, "runs", RUN_ID, "apply.json"), "utf8"),
    ) as {
      pushed: boolean;
    };
    expect(applyJson.pushed).toBe(true);
  });

  it("refuses a second default apply after the only cluster landed", async () => {
    seedGrok();
    seedReviewRun();
    writeFileSync(
      join(home, "runs", RUN_ID, "plan.md"),
      "# 修复方案\n\n## 落地顺序\n\n### 集群 1: log\n",
    );
    const git = fakeGit();
    const first = await runCapturing(["--run", RUN_ID, "--no-push"], makeSink(), {
      runCommand: git.runCommand,
    });
    expect(first).toBe(0);
    try {
      await runApply(["--run", RUN_ID, "--no-push"], makeSink(), {
        spawnImpl: fakeSpawn(),
        runCommand: git.runCommand,
      });
      throw new Error("expected usage");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain("already landed");
    }
  });

  it("--no-push skips git push", async () => {
    seedGrok();
    seedReviewRun();
    const git = fakeGit();
    const sink = makeSink();
    const code = await runCapturing(["--run", RUN_ID, "--no-push"], sink, {
      runCommand: git.runCommand,
    });
    expect(code).toBe(0);
    const outcome = sink.finished as { pushed: boolean };
    expect(outcome.pushed).toBe(false);
    expect(git.calls.some((c) => c.executable === "git" && c.argv[0] === "push")).toBe(false);
  });

  it("errors when no grok agent exists and --agent is omitted", async () => {
    const store = new Store();
    store.createAgent({
      name: "review-security",
      personaPrompt: "p",
      modelId: "m",
      color: "#111111",
      driverSelection: { driverId: "claude-stream-json", options: { route: "cfuse" } },
    });
    seedReviewRun();
    try {
      await runApply(["--run", RUN_ID], makeSink(), { spawnImpl: fakeSpawn() });
      throw new Error("expected usage");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain("grok-stream-json");
    }
  });
});
