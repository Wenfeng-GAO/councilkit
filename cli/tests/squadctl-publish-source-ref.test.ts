import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SQUAD_BRIDGE_CONTRACT_VERSION,
  canonicalSha256,
} from "@shared/runtime/squad-bridge-contract";
import { type SquadPrProfile, buildFrozenPrProfile } from "@shared/runtime/squad-pr-profile";
import { afterEach, describe, expect, it } from "vitest";
import { privateCandidateRef } from "../src/auto/candidate-source-ref";
import { type RunCommand, defaultRunCommand } from "../src/auto/checkout-pr";
import { SquadctlBridge } from "../src/auto/squadctl-bridge";
import { clearSecrets, registerSecrets } from "../src/redact";

const FIXTURES = dirname(fileURLToPath(import.meta.url));
const FAKE_SQUADCTL = join(FIXTURES, "fixtures", "fake-squadctl-publish.mjs");
const AUTH = "c".repeat(64);
const POLICY = "d".repeat(64);

let roots: string[] = [];
afterEach(() => {
  clearSecrets();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initControllerWithIndependentWorktree(root: string): {
  repo: string;
  bare: string;
  sourceSha: string;
  candidateSha: string;
} {
  const repo = join(root, "workspace");
  const bare = join(root, "remote.git");
  const impl = join(root, "impl");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "feat-x"]);
  git(repo, ["config", "user.email", "squad@example.com"]);
  git(repo, ["config", "user.name", "squad"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  const sourceSha = git(repo, ["rev-parse", "HEAD"]);
  execFileSync("git", ["clone", "--bare", repo, bare], { encoding: "utf8" });
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["worktree", "add", "--detach", impl, sourceSha]);
  git(impl, ["config", "user.email", "squad@example.com"]);
  git(impl, ["config", "user.name", "squad"]);
  writeFileSync(join(impl, "README.md"), "candidate\n");
  git(impl, ["add", "."]);
  git(impl, ["commit", "-m", "candidate"]);
  const candidateSha = git(impl, ["rev-parse", "HEAD"]);
  return { repo, bare, sourceSha, candidateSha };
}

function seedFrozenTask(input: {
  repo: string;
  sourceSha: string;
  taskId: string;
  taskDir: string;
  remote?: string;
}): void {
  const profile = buildFrozenPrProfile({
    sourceBranch: "feat-x",
    sourceSha: input.sourceSha,
    expectedOldSha: input.sourceSha,
    remote: input.remote ?? "origin",
    authorityRef: AUTH,
  });
  writeFileSync(
    join(input.taskDir, "councilkit-pr-profile.json"),
    `${JSON.stringify(profile, null, 2)}\n`,
  );
  writeFileSync(
    join(input.taskDir, "councilkit-bridge.json"),
    `${JSON.stringify({
      taskId: input.taskId,
      squadTaskId: "20260921-repair-pin",
      taskDir: input.taskDir,
      workspaceCwd: input.repo,
      requestedRuntime: "grokb",
      actualRuntime: "fake-squadctl-publish.mjs",
      model: "grok-4.6",
      requestedSession: "native-session-1",
      nativeSession: "native-session-1",
      orchestratorPid: null,
      writerPids: [],
      skillVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      skillDir: null,
      squadctlPath: FAKE_SQUADCTL,
      packagePath: null,
      delivery: {
        grantHash: AUTH,
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        sourceSha: input.sourceSha,
        expectedOldSha: input.sourceSha,
        remote: input.remote ?? "origin",
        originUrl: git(input.repo, ["remote", "get-url", "origin"]),
        pushUrl: git(input.repo, ["remote", "get-url", "--push", "origin"]),
      },
      stopped: false,
      executionStatus: "running",
      failReason: null,
      process: null,
      processGroup: [],
      observedExitCode: null,
      observedSignal: null,
      executionId: null,
      toolVersion: null,
    })}\n`,
  );
}

function makeBridge(
  home: string,
  repo: string,
  extraEnv: NodeJS.ProcessEnv = {},
  runCommand?: RunCommand,
): SquadctlBridge {
  chmodSync(FAKE_SQUADCTL, 0o755);
  return new SquadctlBridge({
    home,
    workspaceCwd: repo,
    executable: FAKE_SQUADCTL,
    skipCliVerify: true,
    runCommand,
    env: {
      ...process.env,
      HOME: home,
      COUNCILKIT_HOME: home,
      FAKE_POLICY_HASH: POLICY,
      ...extraEnv,
    },
  });
}

describe("SquadctlBridge requestPublish source.ref binding", () => {
  it("pins the private candidate ref and publishes with source.ref resolving to C", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-publish-pin-"));
    roots.push(root);
    const { repo, sourceSha, candidateSha } = initControllerWithIndependentWorktree(root);
    const home = join(root, "ckhome");
    mkdirSync(home);
    const bridge = makeBridge(home, repo, { FAKE_CANDIDATE_SHA: candidateSha });
    const started = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("start failed");
    const taskDir = join(home, "squad-tasks", started.taskId);
    seedFrozenTask({
      repo,
      sourceSha,
      taskId: started.taskId,
      taskDir,
    });
    const published = await bridge.requestPublish({
      taskId: started.taskId,
      identity: {
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        expectedOldSha: sourceSha,
        candidateSha,
      },
    });
    expect(published.ok).toBe(true);
    if (!published.ok) throw new Error(published.message ?? published.code);
    const profile = JSON.parse(
      readFileSync(join(taskDir, "councilkit-pr-profile.json"), "utf8"),
    ) as SquadPrProfile;
    const privateRef = privateCandidateRef(started.taskId, candidateSha);
    expect(profile.source.ref).toBe(privateRef);
    expect(profile.source.sha).toBe(candidateSha);
    expect(git(repo, ["rev-parse", "--verify", profile.source.ref])).toBe(candidateSha);
    expect(profile.integration.base_ref).toBe("refs/heads/feat-x");
    expect(profile.integration.base_sha).toBe(sourceSha);
    expect(profile.target.remote).toBe("origin");
    expect(profile.target.ref).toBe("refs/heads/feat-x");
    expect(profile.target.sha).toBe(sourceSha);
    expect(profile.authorization.authority_ref).toBe(AUTH);
    expect(canonicalSha256(profile).length).toBe(64);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sourceSha);
    expect(git(repo, ["rev-parse", "refs/heads/feat-x"])).toBe(sourceSha);
    expect(git(repo, ["ls-remote", "--heads", "origin", "refs/heads/feat-x"]).split("\t")[0]).toBe(
      sourceSha,
    );

    const again = await bridge.requestPublish({
      taskId: started.taskId,
      identity: {
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        expectedOldSha: sourceSha,
        candidateSha,
      },
    });
    expect(again.ok).toBe(true);
    expect(git(repo, ["rev-parse", "--verify", privateRef ?? ""])).toBe(candidateSha);
  });

  it("refuses a requested candidate that differs from the publishable journal before pinning", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-publish-journal-"));
    roots.push(root);
    const { repo, sourceSha, candidateSha } = initControllerWithIndependentWorktree(root);
    const other = git(repo, [
      "commit-tree",
      `${candidateSha}^{tree}`,
      "-p",
      sourceSha,
      "-m",
      "other",
    ]);
    const home = join(root, "ckhome");
    mkdirSync(home);
    const bridge = makeBridge(home, repo, { FAKE_CANDIDATE_SHA: candidateSha });
    const started = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
    });
    if (!started.ok) throw new Error("start failed");
    const taskDir = join(home, "squad-tasks", started.taskId);
    seedFrozenTask({ repo, sourceSha, taskId: started.taskId, taskDir });
    const published = await bridge.requestPublish({
      taskId: started.taskId,
      identity: {
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        expectedOldSha: sourceSha,
        candidateSha: other,
      },
    });
    expect(published.ok).toBe(false);
    if (published.ok) throw new Error("expected refuse");
    expect(published.code).toBe("JOURNAL_GATES_INCOMPLETE");
    expect(published.stage).toBe("journal");
    expect(() =>
      git(repo, [
        "show-ref",
        "--verify",
        "--",
        privateCandidateRef(started.taskId, other) ?? "missing",
      ]),
    ).toThrow();
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sourceSha);
  });

  it("keeps bounded sanitized diagnostics when check-remote refuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-publish-diag-"));
    roots.push(root);
    const { repo, sourceSha, candidateSha } = initControllerWithIndependentWorktree(root);
    const home = join(root, "ckhome");
    mkdirSync(home);
    const secret = "ghp_notarealtokenDIAG";
    const bridge = makeBridge(home, repo, {
      FAKE_CANDIDATE_SHA: candidateSha,
      FAKE_INTEGRATE_STDERR: `integration refused before target update GH_TOKEN=${secret} ${"y".repeat(600)}`,
      FAKE_INTEGRATE_EXIT: "4",
    });
    const started = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
    });
    if (!started.ok) throw new Error("start failed");
    const taskDir = join(home, "squad-tasks", started.taskId);
    seedFrozenTask({ repo, sourceSha, taskId: started.taskId, taskDir });
    const published = await bridge.requestPublish({
      taskId: started.taskId,
      identity: {
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        expectedOldSha: sourceSha,
        candidateSha,
      },
    });
    expect(published.ok).toBe(false);
    if (published.ok) throw new Error("expected refuse");
    expect(published.code).toBe("UNTRUSTED_RECEIPT");
    expect(published.stage).toBe("check-remote");
    expect(published.exitCode).toBe(4);
    expect(published.message).toMatch(/integration refused before target update/);
    expect(published.message).not.toContain(secret);
    expect(published.message).toContain("[redacted]");
    expect((published.message ?? "").length).toBeLessThanOrEqual(512);

    const boundary = "CanaryBoundary12345";
    registerSecrets({ cookie: boundary, csrfToken: "csrf-not-used" });
    const straddle = makeBridge(home, repo, {
      FAKE_CANDIDATE_SHA: candidateSha,
      FAKE_INTEGRATE_STDERR: `integration refused before target update ${"x".repeat(500)}${boundary}`,
      FAKE_INTEGRATE_EXIT: "4",
    });
    const straddleStarted = straddle.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
    });
    if (!straddleStarted.ok) throw new Error("start failed");
    const straddleDir = join(home, "squad-tasks", straddleStarted.taskId);
    seedFrozenTask({ repo, sourceSha, taskId: straddleStarted.taskId, taskDir: straddleDir });
    const leaked = await straddle.requestPublish({
      taskId: straddleStarted.taskId,
      identity: {
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        expectedOldSha: sourceSha,
        candidateSha,
      },
    });
    expect(leaked.ok).toBe(false);
    if (leaked.ok) throw new Error("expected refuse");
    expect(leaked.message).toMatch(/integration refused before target update/);
    expect(leaked.message).not.toContain(boundary);
    expect(leaked.message).not.toContain(boundary.slice(0, 12));
  });

  it("passes a replace/graft-free Git view to native check-remote and push-remote", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-publish-env-"));
    roots.push(root);
    const { repo, sourceSha, candidateSha } = initControllerWithIndependentWorktree(root);
    const home = join(root, "ckhome");
    mkdirSync(home);
    const integrateEnv: NodeJS.ProcessEnv[] = [];
    const runCommand: RunCommand = async (input) => {
      if (input.argv[0] === "integrate") integrateEnv.push(input.env ?? {});
      return defaultRunCommand(input);
    };
    const bridge = makeBridge(
      home,
      repo,
      {
        FAKE_CANDIDATE_SHA: candidateSha,
        GIT_GRAFT_FILE: join(root, "caller-grafts"),
        GIT_NO_REPLACE_OBJECTS: "0",
      },
      runCommand,
    );
    const started = bridge.start({
      requestedVersion: SQUAD_BRIDGE_CONTRACT_VERSION,
      packageFields: {},
    });
    if (!started.ok) throw new Error("start failed");
    seedFrozenTask({
      repo,
      sourceSha,
      taskId: started.taskId,
      taskDir: join(home, "squad-tasks", started.taskId),
    });
    const published = await bridge.requestPublish({
      taskId: started.taskId,
      identity: {
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        expectedOldSha: sourceSha,
        candidateSha,
      },
    });
    expect(published.ok).toBe(true);
    expect(integrateEnv.length).toBe(2);
    for (const env of integrateEnv) {
      expect(env.GIT_NO_REPLACE_OBJECTS).toBe("1");
      expect(env.GIT_GRAFT_FILE).toBe("/dev/null");
    }
  });
});
