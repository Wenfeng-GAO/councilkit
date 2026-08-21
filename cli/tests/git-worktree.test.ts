import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRunCommand } from "../src/auto/checkout-pr";
import { addDetachedWorktree, gitRevParse, resolveLocalPrSha } from "../src/auto/git-worktree";
import { bindTrustedRoot } from "../src/fs-safe";

describe("git worktree helpers", () => {
  let root: string;
  let repo: string;
  let destRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ck-wt-"));
    repo = join(root, "repo");
    destRoot = join(root, "runs");
    mkdirSync(repo);
    mkdirSync(destRoot);
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repo });
  });
  afterEach(() => {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: repo });
    } catch {
      // ignore
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("adds a detached worktree of HEAD under the runs root", async () => {
    const sha = await gitRevParse(repo, "HEAD", defaultRunCommand, process.env);
    expect(sha).toBeTruthy();
    const bound = bindTrustedRoot(destRoot);
    expect(bound).not.toBeNull();
    if (bound === null || sha === null) return;
    const dest = join(destRoot, "attempt-0");
    await addDetachedWorktree({
      repo,
      dest,
      sha,
      runDir: destRoot,
      root: bound,
      runCommand: defaultRunCommand,
    });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dest, encoding: "utf8" }).trim();
    expect(head).toBe(sha);
    const pinned = await resolveLocalPrSha({
      repo,
      branch: "unused",
      pinnedRef: "HEAD",
      runCommand: defaultRunCommand,
    });
    expect(pinned).toBe(sha);
  });
});
