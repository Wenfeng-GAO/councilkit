import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRunCommand } from "../src/auto/checkout-pr";
import {
  freezeReviewContext,
  hashColorlessDiff,
  persistFrozenContext,
  stripAnsi,
  verifiedCliUsage,
} from "../src/auto/review-context";

describe("review-context colorless snapshot", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ck-ctx-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "one\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "two\n");
    execFileSync("git", ["commit", "-am", "head"], { cwd: repo });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("strips ANSI before hashing so a colored dump is not the stored snapshot", () => {
    const colored = "\u001b[31mdiff --git a/a.txt b/a.txt\u001b[0m\n";
    const plain = "diff --git a/a.txt b/a.txt\n";
    expect(stripAnsi(colored)).toBe(plain);
    expect(hashColorlessDiff(colored)).toBe(hashColorlessDiff(plain));
  });

  it("freezes head SHA and a colorless diff hash", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const ctx = await freezeReviewContext({
      repo,
      headSha: head,
      sourceRef: "HEAD",
      targetRef: null,
      host: "github",
      runCommand: defaultRunCommand,
    });
    expect(ctx.headSha).toBe(head);
    expect(ctx.colorlessDiff.includes(String.fromCharCode(27))).toBe(false);
    expect(ctx.diffHash).toBe(hashColorlessDiff(ctx.colorlessDiff));
    expect(ctx.verifiedCli).toBe(verifiedCliUsage("github"));
    persistFrozenContext(root, ctx);
    expect(readFileSync(join(root, "review-context.md"), "utf8")).toContain(head);
    expect(readFileSync(join(root, "review-context.diff"), "utf8")).toBe(ctx.colorlessDiff);
  });
});
