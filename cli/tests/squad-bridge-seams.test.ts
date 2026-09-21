import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQUAD_BRIDGE_CONTRACT_VERSION } from "@shared/runtime/squad-bridge-contract";
import { afterEach, describe, expect, it } from "vitest";
import { materializeRepairWorkspace } from "../src/auto/repair-workspace";
import { SquadctlBridge } from "../src/auto/squadctl-bridge";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FAKE_GROKB = join(FIXTURES, "fake-grokb.mjs");
const FAKE_SQUADCTL = join(FIXTURES, "fake-squadctl.mjs");

let roots: string[] = [];
const pids = new Set<number>();

afterEach(() => {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  pids.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

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

function makeBridge(
  home: string,
  workspace: string,
  extraEnv: NodeJS.ProcessEnv = {},
): SquadctlBridge {
  chmodSync(FAKE_GROKB, 0o755);
  chmodSync(FAKE_SQUADCTL, 0o755);
  return new SquadctlBridge({
    home,
    workspaceCwd: workspace,
    executable: FAKE_SQUADCTL,
    orchestratorExecutable: FAKE_GROKB,
    env: {
      ...process.env,
      HOME: home,
      COUNCILKIT_HOME: home,
      ...extraEnv,
    },
  });
}

function identityOf(
  home: string,
  taskId: string,
): {
  nativeSession: string | null;
  requestedSession: string | null;
  orchestratorPid: number | null;
  writerPids: number[];
  executionStatus: string;
} {
  return JSON.parse(
    readFileSync(join(home, "squad-tasks", taskId, "councilkit-bridge.json"), "utf8"),
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("squad bridge seams from independent review probes", () => {
  it("freezes the trusted origin URL and does not reset a candidate on resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-seam-ws-"));
    roots.push(root);
    const { repo, sha, bare } = initRepo(root);
    const dest = join(root, "isolated");
    const first = await materializeRepairWorkspace({
      dest,
      sourceRepo: repo,
      sourceBranch: "feat-x",
      sourceSha: sha,
    });
    expect(first.originUrl).toBe(bare);
    expect(git(dest, ["remote", "get-url", "origin"])).toBe(bare);
    git(dest, ["config", "user.email", "squad@example.com"]);
    git(dest, ["config", "user.name", "squad"]);
    writeFileSync(join(dest, "README.md"), "candidate\n");
    git(dest, ["add", "."]);
    git(dest, ["commit", "-m", "candidate"]);
    const candidate = git(dest, ["rev-parse", "HEAD"]);
    const resumed = await materializeRepairWorkspace({
      dest,
      sourceRepo: repo,
      sourceBranch: "feat-x",
      sourceSha: sha,
      expectedOriginUrl: bare,
    });
    expect(resumed.originUrl).toBe(bare);
    expect(resumed.headSha).toBe(candidate);
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(candidate);
  });

  it("captures --session-id, rejects a mismatched resume, and fails exit 17", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-seam-session-"));
    roots.push(root);
    const { repo, sha } = initRepo(root);
    const home = join(root, "ckhome");
    mkdirSync(home);
    const pkg = join(root, "pkg.json");
    writeFileSync(pkg, `${JSON.stringify(packageBody(sha))}\n`);
    const modePath = join(root, "mode");
    const argvLog = join(root, "argv.log");
    const bridge = makeBridge(home, repo, { MODE_FILE: modePath, FAKE_SQUADCTL_ARGV: argvLog });
    writeFileSync(modePath, "");
    const delivery = {
      grantHash: "a".repeat(64),
      repo: "github.com/acme/repo",
      sourceBranch: "feat-x",
      sourceSha: sha,
      expectedOldSha: sha,
      remote: "origin",
      parentRunId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      newRepairChain: true,
    };
    const first = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      delivery,
      baseSha: sha,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("start failed");
    await bridge.prepare({
      taskId: first.taskId,
      baseSha: sha,
      packagePath: pkg,
      delivery,
    });
    const id1 = identityOf(home, first.taskId);
    expect(id1.nativeSession).toBe(id1.requestedSession);
    expect(id1.nativeSession).toBeTruthy();
    if (id1.orchestratorPid) pids.add(id1.orchestratorPid);
    const intake = readFileSync(argvLog, "utf8");
    expect(intake).toMatch(/intake .*--new-repair-chain/);
    expect(intake).toMatch(/--project-id github.com\/acme\/repo/);
    expect(intake).toMatch(/--repair-chain-id ck-repair-/);
    bridge.stop({ taskId: first.taskId });
    writeFileSync(modePath, "native-B");
    await expect(bridge.resume({ taskId: first.taskId })).rejects.toThrow(/native session_id/);
    const afterMismatch = identityOf(home, first.taskId);
    expect(afterMismatch.executionStatus).toBe("failed");
    expect(afterMismatch.orchestratorPid).toBeNull();
    writeFileSync(modePath, "exit");
    const third = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      delivery,
      baseSha: sha,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error("start failed");
    await expect(
      bridge.prepare({ taskId: third.taskId, baseSha: sha, packagePath: pkg, delivery }),
    ).rejects.toThrow(/exited before native session/);
    const early = identityOf(home, third.taskId);
    expect(early.nativeSession).toBeNull();
    expect(early.executionStatus).toBe("failed");
    expect(bridge.status({ taskId: third.taskId }).event.kind).toBe("failed");
    if (early.orchestratorPid) expect(alive(early.orchestratorPid)).toBe(false);
  }, 20_000);

  it("TERM then KILL the process group so a SIGTERM-ignoring grandchild stops writing", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-seam-stop-"));
    roots.push(root);
    const { repo, sha } = initRepo(root);
    const home = join(root, "ckhome");
    mkdirSync(home);
    const pkg = join(root, "pkg.json");
    writeFileSync(pkg, `${JSON.stringify(packageBody(sha))}\n`);
    const canary = join(root, "canary");
    writeFileSync(canary, "");
    const pidfile = join(root, "grand.pid");
    const bridge = makeBridge(home, repo, { CANARY: canary, PIDFILE: pidfile });
    const started = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
      baseSha: sha,
      delivery: {
        grantHash: "a".repeat(64),
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        sourceSha: sha,
        expectedOldSha: sha,
        remote: "origin",
        newRepairChain: true,
        parentRunId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    await bridge.prepare({
      taskId: started.taskId,
      baseSha: sha,
      packagePath: pkg,
      delivery: {
        grantHash: "a".repeat(64),
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        sourceSha: sha,
        expectedOldSha: sha,
        remote: "origin",
        newRepairChain: true,
        parentRunId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      },
    });
    await sleep(200);
    const grand = Number(readFileSync(pidfile, "utf8"));
    pids.add(grand);
    const id = identityOf(home, started.taskId);
    if (id.orchestratorPid) pids.add(id.orchestratorPid);
    expect(alive(grand)).toBe(true);
    expect(bridge.stop({ taskId: started.taskId })).toEqual({ kind: "stopped" });
    const bytesImmediately = readFileSync(canary).length;
    await sleep(300);
    const bytesLater = readFileSync(canary).length;
    expect(bytesLater).toBe(bytesImmediately);
    expect(alive(grand)).toBe(false);
    expect(bridge.status({ taskId: started.taskId }).event.kind).toBe("stopped");
  }, 20_000);
});
