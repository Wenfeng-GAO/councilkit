import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalSha256 } from "@shared/runtime/squad-bridge-contract";
import { buildFrozenPrProfile, withPinnedCandidateSource } from "@shared/runtime/squad-pr-profile";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindPublishableCandidateProfile,
  pinPrivateCandidateRef,
  privateCandidateRef,
  protectedGitEnv,
} from "../src/auto/candidate-source-ref";
import { defaultRunCommand } from "../src/auto/checkout-pr";
import { HAS_LIVE_SQUADCTL, LIVE_SKILL_DIR, LIVE_SQUADCTL } from "./helpers/live-squadctl";

const AUTH = "c".repeat(64);
const POLICY = "d".repeat(64);
const TASK_ID = "squad-task-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initControllerWithIndependentWorktree(root: string): {
  repo: string;
  bare: string;
  impl: string;
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
  return { repo, bare, impl, sourceSha, candidateSha };
}

function gatedEvent(candidateSha: string) {
  return {
    kind: "candidate_ready" as const,
    journal: {
      candidateSha,
      invalidated: false,
      independentReview: true,
      independentVerify: true,
      requiredGatesPassed: true,
      gatePolicyHash: POLICY,
    },
  };
}

describe("private candidate source ref pinning", () => {
  it("pins C without moving workspace HEAD, source branch, or target remote", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-pin-"));
    roots.push(root);
    const { repo, bare, sourceSha, candidateSha } = initControllerWithIndependentWorktree(root);
    const first = await pinPrivateCandidateRef({
      repo,
      taskId: TASK_ID,
      candidateSha,
      expectedOldSha: sourceSha,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected pin");
    expect(first.ref).toBe(privateCandidateRef(TASK_ID, candidateSha));
    expect(git(repo, ["rev-parse", "--verify", first.ref])).toBe(candidateSha);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sourceSha);
    expect(git(repo, ["rev-parse", "refs/heads/feat-x"])).toBe(sourceSha);
    expect(git(repo, ["symbolic-ref", "HEAD"])).toBe("refs/heads/feat-x");
    expect(git(repo, ["ls-remote", "--heads", "origin", "refs/heads/feat-x"]).split("\t")[0]).toBe(
      sourceSha,
    );
    expect(bare.endsWith("remote.git")).toBe(true);

    const again = await pinPrivateCandidateRef({
      repo,
      taskId: TASK_ID,
      candidateSha,
      expectedOldSha: sourceSha,
    });
    expect(again).toEqual(first);
    expect(git(repo, ["rev-parse", "--verify", first.ref])).toBe(candidateSha);
  });

  it("refuses a different existing private value, symref, dangling, and invalid input without movement", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-pin-refuse-"));
    roots.push(root);
    const { repo, sourceSha, candidateSha } = initControllerWithIndependentWorktree(root);
    const ref = privateCandidateRef(TASK_ID, candidateSha);
    if (!ref) throw new Error("expected ref");

    git(repo, ["update-ref", "--no-deref", ref, sourceSha, "0".repeat(40)]);
    const moved = await pinPrivateCandidateRef({
      repo,
      taskId: TASK_ID,
      candidateSha,
      expectedOldSha: sourceSha,
    });
    expect(moved.ok).toBe(false);
    if (moved.ok) throw new Error("expected refuse");
    expect(moved.reason).toBe("ref-exists-with-different-value");
    expect(git(repo, ["rev-parse", "--verify", ref])).toBe(sourceSha);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sourceSha);
    git(repo, ["update-ref", "--no-deref", "-d", ref]);

    git(repo, ["symbolic-ref", ref, "refs/heads/feat-x"]);
    const symbolic = await pinPrivateCandidateRef({
      repo,
      taskId: TASK_ID,
      candidateSha,
      expectedOldSha: sourceSha,
    });
    expect(symbolic.ok).toBe(false);
    if (symbolic.ok) throw new Error("expected refuse");
    expect(symbolic.reason).toBe("symbolic-ref");
    expect(git(repo, ["symbolic-ref", "--quiet", ref])).toBe("refs/heads/feat-x");
    expect(git(repo, ["rev-parse", "refs/heads/feat-x"])).toBe(sourceSha);
    git(repo, ["update-ref", "--no-deref", "-d", ref]);

    const missing = "e".repeat(40);
    const danglingPath = git(repo, ["rev-parse", "--git-path", ref]);
    const danglingAbs = danglingPath.startsWith("/") ? danglingPath : join(repo, danglingPath);
    mkdirSync(dirname(danglingAbs), { recursive: true });
    writeFileSync(danglingAbs, `${missing}\n`);
    const dangling = await pinPrivateCandidateRef({
      repo,
      taskId: TASK_ID,
      candidateSha,
      expectedOldSha: sourceSha,
    });
    expect(dangling.ok).toBe(false);
    if (dangling.ok) throw new Error("expected refuse");
    expect(dangling.reason).toBe("dangling-ref");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sourceSha);
    git(repo, ["update-ref", "--no-deref", "-d", ref]);

    const invalidTask = await pinPrivateCandidateRef({
      repo,
      taskId: "../evil",
      candidateSha,
      expectedOldSha: sourceSha,
    });
    expect(invalidTask.ok).toBe(false);
    if (invalidTask.ok) throw new Error("expected refuse");
    expect(invalidTask.reason).toBe("invalid-task-id");
  });

  it("does not treat a descendant child ref as the exact private candidate ref", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-pin-child-"));
    roots.push(root);
    const { repo, sourceSha, candidateSha } = initControllerWithIndependentWorktree(root);
    const ref = privateCandidateRef(TASK_ID, candidateSha);
    if (!ref) throw new Error("expected ref");
    const child = `${ref}/child`;
    git(repo, ["update-ref", "--no-deref", child, candidateSha, "0".repeat(40)]);
    const pin = await pinPrivateCandidateRef({
      repo,
      taskId: TASK_ID,
      candidateSha,
      expectedOldSha: sourceSha,
    });
    expect(pin.ok).toBe(false);
    if (pin.ok) throw new Error("descendant must not count as the exact private ref");
    expect(() => git(repo, ["show-ref", "--verify", "--", ref])).toThrow();
    expect(git(repo, ["rev-parse", "--verify", child])).toBe(candidateSha);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sourceSha);
    expect(git(repo, ["rev-parse", "refs/heads/feat-x"])).toBe(sourceSha);
    expect(git(repo, ["ls-remote", "--heads", "origin", "refs/heads/feat-x"]).split("\t")[0]).toBe(
      sourceSha,
    );
  });

  it("refuses absent, non-commit, and unrelated candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-pin-objects-"));
    roots.push(root);
    const { repo, sourceSha, candidateSha } = initControllerWithIndependentWorktree(root);
    const absent = await pinPrivateCandidateRef({
      repo,
      taskId: TASK_ID,
      candidateSha: "f".repeat(40),
      expectedOldSha: sourceSha,
    });
    expect(absent.ok).toBe(false);
    if (absent.ok) throw new Error("expected refuse");
    expect(absent.reason).toBe("candidate-missing");

    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: "not-a-commit\n",
      encoding: "utf8",
    }).trim();
    const noncommit = await pinPrivateCandidateRef({
      repo,
      taskId: TASK_ID,
      candidateSha: blob,
      expectedOldSha: sourceSha,
    });
    expect(noncommit.ok).toBe(false);
    if (noncommit.ok) throw new Error("expected refuse");
    expect(noncommit.reason).toBe("candidate-not-commit");

    const unrelated = git(repo, ["commit-tree", `${sourceSha}^{tree}`, "-m", "orphan"]);
    const notFf = await pinPrivateCandidateRef({
      repo,
      taskId: TASK_ID,
      candidateSha: unrelated,
      expectedOldSha: sourceSha,
    });
    expect(notFf.ok).toBe(false);
    if (notFf.ok) throw new Error("expected refuse");
    expect(notFf.reason).toBe("not-fast-forward");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sourceSha);
    expect(candidateSha).not.toBe(unrelated);
  });

  it("ignores replace-refs and graft overlays when proving ancestry", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-pin-replace-"));
    roots.push(root);
    const { repo, sourceSha, candidateSha } = initControllerWithIndependentWorktree(root);
    const orphan = git(repo, ["commit-tree", `${sourceSha}^{tree}`, "-m", "orphan"]);
    git(repo, ["replace", orphan, candidateSha]);
    execFileSync("git", ["merge-base", "--is-ancestor", sourceSha, orphan], {
      cwd: repo,
      encoding: "utf8",
    });
    const protectedEnv = protectedGitEnv({
      ...process.env,
      GIT_GRAFT_FILE: join(root, "forged-grafts"),
      GIT_NO_REPLACE_OBJECTS: "0",
    });
    expect(protectedEnv.GIT_NO_REPLACE_OBJECTS).toBe("1");
    expect(protectedEnv.GIT_GRAFT_FILE).toBe("/dev/null");
    expect(() =>
      execFileSync("git", ["merge-base", "--is-ancestor", sourceSha, orphan], {
        cwd: repo,
        encoding: "utf8",
        env: protectedEnv,
      }),
    ).toThrow();

    const seenMergeBaseEnv: NodeJS.ProcessEnv[] = [];
    const runCommand = async (input: Parameters<typeof defaultRunCommand>[0]) => {
      if (input.argv[0] === "merge-base") seenMergeBaseEnv.push(input.env ?? {});
      return defaultRunCommand(input);
    };
    const replaced = await pinPrivateCandidateRef({
      repo,
      taskId: TASK_ID,
      candidateSha: orphan,
      expectedOldSha: sourceSha,
      runCommand,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "0" },
    });
    expect(replaced.ok).toBe(false);
    if (replaced.ok) throw new Error("replace overlay must not mint ancestry");
    expect(replaced.reason).toBe("not-fast-forward");
    expect(seenMergeBaseEnv[0]?.GIT_NO_REPLACE_OBJECTS).toBe("1");
    expect(seenMergeBaseEnv[0]?.GIT_GRAFT_FILE).toBe("/dev/null");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sourceSha);

    git(repo, ["replace", "-d", orphan]);
    const gitDir = git(repo, ["rev-parse", "--git-dir"]);
    const gitAbs = gitDir.startsWith("/") ? gitDir : join(repo, gitDir);
    mkdirSync(join(gitAbs, "info"), { recursive: true });
    writeFileSync(join(gitAbs, "info", "grafts"), `${orphan} ${sourceSha}\n`);
    const callerGraft = join(root, "caller-grafts");
    writeFileSync(callerGraft, `${orphan} ${sourceSha}\n`);
    const grafted = await pinPrivateCandidateRef({
      repo,
      taskId: TASK_ID,
      candidateSha: orphan,
      expectedOldSha: sourceSha,
      env: { ...process.env, GIT_GRAFT_FILE: callerGraft },
    });
    expect(grafted.ok).toBe(false);
    if (grafted.ok) throw new Error("graft overlay must not mint ancestry");
    expect(grafted.reason).toBe("not-fast-forward");

    const honest = await pinPrivateCandidateRef({
      repo,
      taskId: TASK_ID,
      candidateSha,
      expectedOldSha: sourceSha,
      env: { ...process.env, GIT_GRAFT_FILE: callerGraft, GIT_NO_REPLACE_OBJECTS: "0" },
    });
    expect(honest.ok).toBe(true);
    if (!honest.ok) throw new Error("true S→C ancestry must still pin");
    expect(git(repo, ["rev-parse", "--verify", honest.ref])).toBe(candidateSha);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sourceSha);
  });

  it("refuses a requested candidate that is not the publishable journal SHA before pinning", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-pin-journal-"));
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
    const profile = buildFrozenPrProfile({
      sourceBranch: "feat-x",
      sourceSha,
      expectedOldSha: sourceSha,
      remote: "origin",
      authorityRef: AUTH,
    });
    const bound = await bindPublishableCandidateProfile({
      event: gatedEvent(candidateSha),
      identity: {
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        expectedOldSha: sourceSha,
        candidateSha: other,
      },
      delivery: {
        grantHash: AUTH,
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        sourceSha,
        expectedOldSha: sourceSha,
        remote: "origin",
      },
      frozenProfile: profile,
      workspaceCwd: repo,
      taskId: TASK_ID,
    });
    expect(bound.ok).toBe(false);
    if (bound.ok) throw new Error("expected refuse");
    expect(bound.code).toBe("JOURNAL_GATES_INCOMPLETE");
    const ref = privateCandidateRef(TASK_ID, other);
    expect(() => git(repo, ["show-ref", "--verify", "--", ref ?? "refs/heads/missing"])).toThrow();
  });

  it("refuses frozen target identity drift before pinning", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-pin-drift-"));
    roots.push(root);
    const { repo, sourceSha, candidateSha } = initControllerWithIndependentWorktree(root);
    const profile = buildFrozenPrProfile({
      sourceBranch: "feat-x",
      sourceSha,
      expectedOldSha: sourceSha,
      remote: "origin",
      authorityRef: AUTH,
    });
    const bound = await bindPublishableCandidateProfile({
      event: gatedEvent(candidateSha),
      identity: {
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        expectedOldSha: sourceSha,
        candidateSha,
      },
      delivery: {
        grantHash: AUTH,
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        sourceSha,
        expectedOldSha: sourceSha,
        remote: "upstream",
      },
      frozenProfile: profile,
      workspaceCwd: repo,
      taskId: TASK_ID,
    });
    expect(bound.ok).toBe(false);
    if (bound.ok) throw new Error("expected refuse");
    expect(bound.code).toBe("UNTRUSTED_RECEIPT");
    expect(bound.stage).toBe("identity");
    const ref = privateCandidateRef(TASK_ID, candidateSha);
    expect(() => git(repo, ["show-ref", "--verify", "--", ref ?? "missing"])).toThrow();
  });

  it("binds source.ref and source.sha to the private ref while preserving target identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-pin-bind-"));
    roots.push(root);
    const { repo, sourceSha, candidateSha } = initControllerWithIndependentWorktree(root);
    const profile = buildFrozenPrProfile({
      sourceBranch: "feat-x",
      sourceSha,
      expectedOldSha: sourceSha,
      remote: "origin",
      authorityRef: AUTH,
    });
    const bound = await bindPublishableCandidateProfile({
      event: gatedEvent(candidateSha),
      identity: {
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        expectedOldSha: sourceSha,
        candidateSha,
      },
      delivery: {
        grantHash: AUTH,
        repo: "github.com/acme/repo",
        sourceBranch: "feat-x",
        sourceSha,
        expectedOldSha: sourceSha,
        remote: "origin",
      },
      frozenProfile: profile,
      workspaceCwd: repo,
      taskId: TASK_ID,
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error("expected bind");
    expect(bound.sourceRef).toBe(privateCandidateRef(TASK_ID, candidateSha));
    expect(bound.profile.source.ref).toBe(bound.sourceRef);
    expect(bound.profile.source.sha).toBe(candidateSha);
    expect(bound.profile.integration.base_ref).toBe("refs/heads/feat-x");
    expect(bound.profile.integration.base_sha).toBe(sourceSha);
    expect(bound.profile.target.remote).toBe("origin");
    expect(bound.profile.target.ref).toBe("refs/heads/feat-x");
    expect(bound.profile.target.sha).toBe(sourceSha);
    expect(bound.profile.authorization.authority_ref).toBe(AUTH);
    expect(bound.profileHash).toBe(canonicalSha256(bound.profile));
    expect(git(repo, ["rev-parse", bound.sourceRef])).toBe(candidateSha);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sourceSha);
  });
});

describe.skipIf(!HAS_LIVE_SQUADCTL)("real squadctl source.ref contract on disposable data", () => {
  it("proves _remote_request accepts the pinned private ref and check-remote reaches the receipt seam", () => {
    const root = mkdtempSync(join(tmpdir(), "ck-pin-remote-"));
    roots.push(root);
    const { repo, sourceSha, candidateSha } = initControllerWithIndependentWorktree(root);
    const ref = privateCandidateRef(TASK_ID, candidateSha);
    if (!ref) throw new Error("expected ref");
    git(repo, ["update-ref", "--no-deref", ref, candidateSha, "0".repeat(40)]);
    const profile = withPinnedCandidateSource(
      buildFrozenPrProfile({
        sourceBranch: "feat-x",
        sourceSha,
        expectedOldSha: sourceSha,
        remote: "origin",
        authorityRef: AUTH,
      }),
      { ref, sha: candidateSha },
    );
    const profilePath = join(root, "councilkit-pr-profile.json");
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    const scripts = join(LIVE_SKILL_DIR, "scripts");
    const remoteRequest = execFileSync(
      "python3",
      [
        "-c",
        "from squadlib.integration import _remote_request, load_pr_profile; import sys; p=load_pr_profile(sys.argv[1]); print('\\n'.join(_remote_request(sys.argv[2], profile=p, expected_old_sha=sys.argv[3], candidate_sha=sys.argv[4])))",
        profilePath,
        repo,
        sourceSha,
        candidateSha,
      ],
      { encoding: "utf8", env: { ...process.env, PYTHONPATH: scripts } },
    ).trim();
    const [remote, targetRef, sourceRef, profileHash] = remoteRequest.split("\n");
    expect(remote).toBe("origin");
    expect(targetRef).toBe("refs/heads/feat-x");
    expect(sourceRef).toBe(ref);
    expect(profileHash).toBe(canonicalSha256(profile));

    const taskDir = join(root, "task");
    const init = execFileSync(
      LIVE_SQUADCTL,
      [
        "init",
        "--task-dir",
        taskDir,
        "--task-id",
        "20260921-repair-pin1",
        "--base-sha",
        sourceSha,
        "--planning",
        "simple",
        "--owner",
        "councilkit",
        "--repo",
        repo,
        "--no-observe",
        "--allow-behind-origin",
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(init).toMatch(/epoch/);
    let checkStdout = "";
    let checkStderr = "";
    let checkStatus = 0;
    try {
      checkStdout = execFileSync(
        LIVE_SQUADCTL,
        [
          "integrate",
          "check-remote",
          "--task-dir",
          taskDir,
          "--repo-root",
          repo,
          "--profile",
          profilePath,
          "--expected-old-sha",
          sourceSha,
          "--candidate-sha",
          candidateSha,
          "--json",
        ],
        { encoding: "utf8" },
      );
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      checkStatus = err.status ?? 1;
      checkStdout = err.stdout ?? "";
      checkStderr = err.stderr ?? "";
    }
    const combined = `${checkStdout}\n${checkStderr}`;
    expect(combined).not.toMatch(/integration refused before target update/);
    if (checkStatus === 0) {
      const receipt = JSON.parse(checkStdout) as {
        action?: string;
        profile_hash?: string;
        remote_ref?: string;
      };
      expect(receipt.action).toBe("check-remote");
      expect(receipt.profile_hash).toBe(canonicalSha256(profile));
      expect(receipt.remote_ref).toBe("refs/heads/feat-x");
    } else {
      expect(combined).toMatch(/frozen modern brief and gate policy|gate policy/);
    }
    expect(git(repo, ["ls-remote", "--heads", "origin", "refs/heads/feat-x"]).split("\t")[0]).toBe(
      sourceSha,
    );
  });
});
