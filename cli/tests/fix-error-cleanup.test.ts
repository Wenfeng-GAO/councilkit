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
import { writerLeaseKey, writerLeasePath } from "@shared/runtime/repair-lease";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunCommand } from "../src/auto/checkout-pr";
import { acquireWriterLease } from "../src/auto/repair-lease";
import type { SpawnImpl } from "../src/auto/runner";
import { FixExit, runFix } from "../src/commands/fix";
import { CliError } from "../src/errors";
import { Store } from "../src/store/store";

const applyState = vi.hoisted(() => ({
  failMessage: null as string | null,
  calls: 0,
  exitCode: null as number | null,
  onCall: null as (() => void) | null,
}));

vi.mock("../src/commands/apply", async () => {
  const actual =
    await vi.importActual<typeof import("../src/commands/apply")>("../src/commands/apply");
  return {
    ...actual,
    runApply: async () => {
      applyState.calls += 1;
      applyState.onCall?.();
      if (applyState.failMessage !== null) {
        const { errors } = await import("../src/errors");
        throw errors.io(applyState.failMessage);
      }
      if (applyState.exitCode !== null) {
        throw new actual.ApplyExit(applyState.exitCode);
      }
      throw new Error("unexpected runApply");
    },
  };
});

const RUN_ID = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";
const PR_URL = "https://github.com/acme/repo/pull/9";
const REPO = "github.com/acme/repo";
const BRANCH = "feat-x";
const FOREIGN_RUN = "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3";

function makeSink(onFinish?: () => void) {
  return {
    json: false,
    lines: [] as string[],
    finished: undefined as unknown,
    progress(message: string) {
      this.lines.push(message);
    },
    diag() {},
    finish(data: unknown) {
      this.finished = data;
      onFinish?.();
      return Promise.resolve();
    },
  };
}

describe("fix command error cleanup", () => {
  let home: string;
  let bin: string;
  const oldHome = process.env.COUNCILKIT_HOME;
  const oldPath = process.env.PATH;

  beforeEach(() => {
    applyState.failMessage = null;
    applyState.calls = 0;
    applyState.exitCode = null;
    applyState.onCall = null;
    home = mkdtempSync(join(tmpdir(), "ck-fix-cleanup-"));
    bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["grok", "cld", "codex", "kimi", "gh", "git"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, name), 0o755);
    }
    process.env.COUNCILKIT_HOME = home;
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
  });

  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    if (oldPath === undefined) process.env.PATH = undefined;
    else process.env.PATH = oldPath;
    rmSync(home, { recursive: true, force: true });
  });

  function seedRoster(): void {
    const store = new Store();
    const adversarial = store.createAgent({
      name: "review-adversarial",
      personaPrompt: "adversarial",
      modelId: "grok-4.6",
      color: "#444444",
      driverSelection: { driverId: "grok-stream-json", options: {} },
    });
    store.createCouncil({
      name: "pr-jury",
      topic: "jury",
      agentIds: [adversarial.id],
      rounds: 1,
      reporterAgentId: adversarial.id,
    });
  }

  function seedReview(): void {
    const dir = join(home, "runs", RUN_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "report.md"),
      "# Autonomous Review Report\n\n## 结论\nchanges-requested\n",
    );
    writeFileSync(
      join(dir, "transcript.jsonl"),
      `${JSON.stringify({
        kind: "review.started",
        version: 1,
        runId: RUN_ID,
        startedAt: "2026-08-01T00:00:00.000Z",
        task: { pr: PR_URL },
        attempts: [],
        aggregator: {
          attemptId: "aggregator",
          agentId: "a",
          agentName: "review-adversarial",
          driverId: "grok-stream-json",
          modelId: "grok-4.6",
        },
      })}\n${JSON.stringify({
        kind: "review.finished",
        version: 1,
        status: "completed",
        endedAt: "2026-08-01T01:00:00.000Z",
        incomplete: false,
        reportPath: join(dir, "report.md"),
      })}\n`,
    );
  }

  function seedApprovedPlan(): void {
    writeFileSync(
      join(home, "runs", RUN_ID, "plan.lock.json"),
      JSON.stringify({
        version: 1,
        sourceRunId: RUN_ID,
        approvedAt: "2026-08-01T00:00:00.000Z",
        verdict: "approve",
        clusters: [
          {
            id: "log",
            title: "log",
            closes: [],
            files: ["a.ts"],
            gates: [],
            policy: "",
            invariants: "",
            forbidden: "",
            tests: "",
            mentions: "",
            body: "",
          },
        ],
        deferred: [],
      }),
    );
  }

  function ghView(): RunCommand {
    return async (input) => {
      if (input.executable === "gh" && input.argv[0] === "pr" && input.argv[1] === "view") {
        return {
          stdout: JSON.stringify({
            headRefName: BRANCH,
            baseRefName: "main",
            headRepository: { nameWithOwner: "acme/repo", name: "repo" },
            headRepositoryOwner: { login: "acme" },
            url: PR_URL,
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
  }

  function leaseFile(): string {
    return writerLeasePath(home, writerLeaseKey({ repo: REPO, sourceBranch: BRANCH }));
  }

  const refuseSpawn: SpawnImpl = async () => {
    throw new Error("planner probe should not run when plan.lock.json is approved");
  };

  it("releases the writer lease and signal listeners when apply throws CliError", async () => {
    seedRoster();
    seedReview();
    seedApprovedPlan();
    applyState.failMessage = "disk full";
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");

    try {
      await runFix(["--run", RUN_ID, "--no-re-review"], makeSink(), {
        spawnImpl: refuseSpawn,
        runCommand: ghView(),
      });
      throw new Error("expected disk full");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toMatch(/disk full/);
      expect((error as CliError).exitCode).toBe(5);
    }

    expect({
      calls: applyState.calls,
      sigint: process.listenerCount("SIGINT") - sigint,
      sigterm: process.listenerCount("SIGTERM") - sigterm,
      leaseLeft: existsSync(leaseFile()),
    }).toEqual({ calls: 1, sigint: 0, sigterm: 0, leaseLeft: false });
    expect(() =>
      acquireWriterLease({
        repo: REPO,
        sourceBranch: BRANCH,
        holderKind: "repair",
        holderRunId: FOREIGN_RUN,
        pid: process.pid,
      }),
    ).not.toThrow();
  });

  it("keeps a foreign writer lease when acquire fails and still drops signal listeners", async () => {
    seedRoster();
    seedReview();
    seedApprovedPlan();
    acquireWriterLease({
      repo: REPO,
      sourceBranch: BRANCH,
      holderKind: "repair",
      holderRunId: FOREIGN_RUN,
      pid: process.pid,
    });
    const before = readFileSync(leaseFile(), "utf8");
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");

    try {
      await runFix(["--run", RUN_ID, "--no-re-review"], makeSink(), {
        spawnImpl: refuseSpawn,
        runCommand: ghView(),
      });
      throw new Error("expected lease conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toMatch(/writer already holds/i);
    }

    expect({
      calls: applyState.calls,
      sigint: process.listenerCount("SIGINT") - sigint,
      sigterm: process.listenerCount("SIGTERM") - sigterm,
      lease: readFileSync(leaseFile(), "utf8"),
    }).toEqual({ calls: 0, sigint: 0, sigterm: 0, lease: before });
  });

  it("drops signal listeners when a follow-up review completes", async () => {
    seedRoster();
    seedReview();
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");
    const followUpId = "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2";

    try {
      await runFix(["--run", RUN_ID, "--re-review-only"], makeSink(), {
        spawnImpl: refuseSpawn,
        reviewImpl: async (_argv, _out, deps) => {
          deps?.onRunCreated?.(followUpId);
          deps?.onSeatsStarted?.();
        },
      });
      throw new Error("expected FixExit");
    } catch (error) {
      expect(error).toBeInstanceOf(FixExit);
      expect((error as FixExit).exitCode).toBe(0);
    }

    expect(applyState.calls).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
    expect(existsSync(leaseFile())).toBe(false);
  });

  it("keeps a lease granted during stdout drain after the fix release returns", async () => {
    seedRoster();
    seedReview();
    seedApprovedPlan();
    applyState.exitCode = 0;
    let grantedDuringDrain = false;
    const sink = makeSink(() => {
      acquireWriterLease({
        repo: REPO,
        sourceBranch: BRANCH,
        holderKind: "apply",
        holderRunId: RUN_ID,
        pid: process.pid,
      });
      grantedDuringDrain = existsSync(leaseFile());
    });

    try {
      await runFix(["--run", RUN_ID, "--no-re-review"], sink, {
        spawnImpl: refuseSpawn,
        runCommand: ghView(),
      });
      throw new Error("expected FixExit");
    } catch (error) {
      expect(error).toBeInstanceOf(FixExit);
      expect((error as FixExit).exitCode).toBe(0);
    }

    const left = existsSync(leaseFile()) ? readFileSync(leaseFile(), "utf8") : "";
    expect({
      calls: applyState.calls,
      grantedDuringDrain,
      holderKind: left.includes('"holderKind": "apply"'),
      holderRunId: left.includes(RUN_ID),
    }).toEqual({
      calls: 1,
      grantedDuringDrain: true,
      holderKind: true,
      holderRunId: true,
    });
    expect(() =>
      acquireWriterLease({
        repo: REPO,
        sourceBranch: BRANCH,
        holderKind: "repair",
        holderRunId: FOREIGN_RUN,
        pid: process.pid,
      }),
    ).toThrow(/writer already holds/i);
  });

  it("retries a blocked lease release from finally once the extra writer pid is gone", async () => {
    seedRoster();
    seedReview();
    seedApprovedPlan();
    applyState.exitCode = 0;
    applyState.onCall = () => {
      const lease = JSON.parse(readFileSync(leaseFile(), "utf8")) as { writerPids?: number[] };
      lease.writerPids = [process.pid];
      writeFileSync(leaseFile(), `${JSON.stringify(lease, null, 2)}\n`);
    };
    const sink = makeSink(() => {
      const lease = JSON.parse(readFileSync(leaseFile(), "utf8")) as { writerPids?: number[] };
      delete lease.writerPids;
      writeFileSync(leaseFile(), `${JSON.stringify(lease, null, 2)}\n`);
    });

    try {
      await runFix(["--run", RUN_ID, "--no-re-review"], sink, {
        spawnImpl: refuseSpawn,
        runCommand: ghView(),
      });
      throw new Error("expected FixExit");
    } catch (error) {
      expect(error).toBeInstanceOf(FixExit);
      expect((error as FixExit).exitCode).toBe(0);
    }

    expect(applyState.calls).toBe(1);
    expect(existsSync(leaseFile())).toBe(false);
  });
});
