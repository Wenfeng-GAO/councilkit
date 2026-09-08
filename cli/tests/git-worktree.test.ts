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

  it("refuses to use a local ref when git fetch fails", async () => {
    await expect(
      resolveLocalPrSha({
        repo,
        branch: "feature",
        runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "denied" }),
      }),
    ).rejects.toThrow(/stale local ref/);
  });

  it("reads FETCH_HEAD from this fetch, not a stale origin tracking ref", async () => {
    const calls: string[][] = [];
    const sha = "b".repeat(40);
    const destRefs: string[] = [];
    const result = await resolveLocalPrSha({
      repo,
      branch: "feature",
      runCommand: async (input) => {
        calls.push(input.argv);
        if (input.argv[0] === "fetch") {
          const spec = input.argv.find((arg) => String(arg).includes("refs/councilkit/fetch/"));
          if (spec) destRefs.push(String(spec).split(":")[1] ?? "");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.argv[0] === "update-ref") return { exitCode: 0, stdout: "", stderr: "" };
        if (input.argv.includes("FETCH_HEAD"))
          return { exitCode: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
        if (destRefs.some((ref) => input.argv.includes(ref))) {
          return { exitCode: 0, stdout: `${sha}\n`, stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "missing" };
      },
    });
    expect(result).toBe(sha);
    expect(calls.some((argv) => argv.includes("FETCH_HEAD"))).toBe(false);
    expect(destRefs).toHaveLength(1);
  });

  it("does not let a concurrent fetch overwrite this review's exclusive ref", async () => {
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    const shas = new Map<string, string>();
    const runCommand: Parameters<typeof resolveLocalPrSha>[0]["runCommand"] = async (input) => {
      if (input.argv[0] === "fetch") {
        const spec = input.argv.find((arg) => String(arg).includes("refs/councilkit/fetch/"));
        const dest = String(spec ?? "").split(":")[1] ?? "";
        const src =
          String(spec ?? "")
            .split(":")[0]
            ?.replace(/^\+/, "") ?? "";
        shas.set(dest, src === "feature-a" ? shaA : shaB);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (input.argv[0] === "update-ref") return { exitCode: 0, stdout: "", stderr: "" };
      const ref = input.argv[input.argv.length - 1] ?? "";
      const sha = shas.get(ref);
      if (sha) return { exitCode: 0, stdout: `${sha}\n`, stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "missing" };
    };
    const [gotA, gotB] = await Promise.all([
      resolveLocalPrSha({ repo, branch: "feature-a", runCommand }),
      resolveLocalPrSha({ repo, branch: "feature-b", runCommand }),
    ]);
    expect(gotA).toBe(shaA);
    expect(gotB).toBe(shaB);
  });
});
