import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQUAD_BRIDGE_CONTRACT_VERSION } from "@shared/runtime/squad-bridge-contract";
import { afterEach, describe, expect, it } from "vitest";
import { SquadctlBridge } from "../src/auto/squadctl-bridge";
import { HAS_LIVE_SQUADCTL, LIVE_SQUADCTL } from "./helpers/live-squadctl";

const FIXTURES = dirname(fileURLToPath(import.meta.url));
const FAKE_GROKB = join(FIXTURES, "fixtures", "fake-grokb.mjs");
const REAL_SQUADCTL = LIVE_SQUADCTL;
const AUTH = "a".repeat(64);

let homes: string[] = [];

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ck-squad-adapter-"));
  homes.push(home);
  chmodSync(FAKE_GROKB, 0o755);
  return home;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(root: string): { repo: string; sha: string; bare: string } {
  const repo = join(root, "src");
  const bare = join(root, "remote.git");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "feat-x"]);
  git(repo, ["config", "user.email", "squad@example.com"]);
  git(repo, ["config", "user.name", "squad"]);
  writeFileSync(join(repo, "README.md"), "ok\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  const sha = git(repo, ["rev-parse", "HEAD"]);
  execFileSync("git", ["clone", "--bare", repo, bare], { encoding: "utf8" });
  git(repo, ["remote", "add", "origin", bare]);
  return { repo, sha, bare };
}

function packageBody(sha: string) {
  return {
    schemaVersion: 1,
    kind: "councilkit-repair",
    source: {
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      sha,
      prUrl: "https://github.com/acme/repo/pull/1",
    },
    findings: [
      {
        id: "F-1",
        title: "example",
        severity: "major",
        rootCause: "F-1",
        invariant: "must hold",
        evidence: "src",
        files: ["README.md"],
      },
    ],
    constraints: { invariants: [], forbidden: [], acceptance: ["ok"], deferred: [] },
    convergence: { maxFixRounds: 3, repeatedRootCauseLimit: 2 },
  };
}

function makeBridge(home: string, workspace: string) {
  return new SquadctlBridge({
    home,
    workspaceCwd: workspace,
    executable: REAL_SQUADCTL,
    orchestratorExecutable: FAKE_GROKB,
    env: {
      ...process.env,
      HOME: home,
      COUNCILKIT_HOME: home,
      FAKE_GROK_SESSION: "native-session-1",
    },
  });
}

describe.skipIf(!HAS_LIVE_SQUADCTL)("production SquadctlBridge with real squadctl", () => {
  it("inits, captures a native grok session, stops with epoch, and resumes the same session", async () => {
    const home = tempHome();
    const { repo, sha } = initRepo(home);
    const pkg = join(home, "pkg.json");
    writeFileSync(pkg, `${JSON.stringify(packageBody(sha))}\n`);
    const instance = makeBridge(home, repo);
    const started = instance.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      history: {
        kind: "squad-repair-history",
        version: 1,
        source_hash: "b".repeat(64),
        project: "github.com/acme/repo",
      },
      delivery: {
        grantHash: AUTH,
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        sourceSha: sha,
        expectedOldSha: sha,
        remote: "origin",
      },
      baseSha: sha,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    await instance.prepare({
      taskId: started.taskId,
      baseSha: sha,
      packagePath: pkg,
      delivery: {
        grantHash: AUTH,
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        sourceSha: sha,
        expectedOldSha: sha,
        remote: "origin",
      },
    });
    const identity = JSON.parse(
      readFileSync(join(home, "squad-tasks", started.taskId, "councilkit-bridge.json"), "utf8"),
    ) as {
      nativeSession: string | null;
      requestedSession: string | null;
      actualRuntime: string | null;
    };
    expect(identity.nativeSession).toBe(identity.requestedSession);
    expect(identity.nativeSession).toBeTruthy();
    expect(identity.actualRuntime).toBe("fake-grokb.mjs");
    const snapshot = instance.status({ taskId: started.taskId });
    expect(["running", "blocked", "failed", "candidate_ready"]).toContain(snapshot.event.kind);
    instance.stop({ taskId: started.taskId });
    expect(instance.status({ taskId: started.taskId }).event.kind).toBe("stopped");
    const resumed = await instance.resume({ taskId: started.taskId });
    expect(resumed.taskId).toBe(started.taskId);
    const resumedIdentity = JSON.parse(
      readFileSync(join(home, "squad-tasks", started.taskId, "councilkit-bridge.json"), "utf8"),
    ) as { nativeSession: string | null };
    expect(resumedIdentity.nativeSession).toBe(identity.nativeSession);
    instance.stop({ taskId: started.taskId });
  }, 60_000);

  it("refuses a silent fresh resume without a native session", async () => {
    const home = tempHome();
    const { repo, sha } = initRepo(home);
    const pkg = join(home, "pkg.json");
    writeFileSync(pkg, `${JSON.stringify(packageBody(sha))}\n`);
    const instance = makeBridge(home, repo);
    const started = instance.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      history: {
        kind: "squad-repair-history",
        version: 1,
        source_hash: "b".repeat(64),
        project: "github.com/acme/repo",
      },
      baseSha: sha,
    });
    if (!started.ok) throw new Error("start failed");
    await instance.prepare({
      taskId: started.taskId,
      baseSha: sha,
      packagePath: pkg,
    });
    instance.stop({ taskId: started.taskId });
    const path = join(home, "squad-tasks", started.taskId, "councilkit-bridge.json");
    const identity = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(
      path,
      `${JSON.stringify({
        ...identity,
        nativeSession: null,
        orchestratorPid: null,
        writerPids: [],
        process: null,
        stopped: false,
        executionStatus: "running",
      })}\n`,
    );
    const snapshot = await instance.resume({ taskId: started.taskId });
    expect(snapshot.event.kind).toBe("stopped");
    const after = JSON.parse(readFileSync(path, "utf8")) as {
      nativeSession: string | null;
      orchestratorPid: number | null;
      executionStatus: string;
    };
    expect(after.nativeSession).toBeNull();
    expect(after.orchestratorPid).toBeNull();
    expect(instance.writerPids()).toEqual([]);
    try {
      instance.stop({ taskId: started.taskId });
    } catch {
      // writers may already be gone
    }
  }, 60_000);
});
