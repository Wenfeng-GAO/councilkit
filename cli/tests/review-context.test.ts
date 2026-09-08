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
    const base = execFileSync("git", ["rev-parse", "HEAD~1"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const destRefs: string[] = [];
    const ctx = await freezeReviewContext({
      repo,
      headSha: head,
      sourceRef: "HEAD",
      targetRef: "main",
      host: "github",
      runCommand: async (input) => {
        if (input.argv[0] === "fetch") {
          const spec = input.argv.find((arg) => String(arg).includes("refs/councilkit/fetch/"));
          if (spec) destRefs.push(String(spec).split(":")[1] ?? "");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.argv[0] === "update-ref") return { exitCode: 0, stdout: "", stderr: "" };
        if (destRefs.some((ref) => input.argv.includes(ref))) {
          return { exitCode: 0, stdout: `${base}\n`, stderr: "" };
        }
        return defaultRunCommand(input);
      },
    });
    expect(ctx.headSha).toBe(head);
    expect(ctx.baseSha).toBe(base);
    expect(ctx.targetRef).toBe("main");
    expect(ctx.colorlessDiff.includes(String.fromCharCode(27))).toBe(false);
    expect(ctx.diffHash).toBe(hashColorlessDiff(ctx.colorlessDiff));
    expect(ctx.verifiedCli).toBe(verifiedCliUsage("github"));
    persistFrozenContext(root, ctx);
    expect(readFileSync(join(root, "review-context.md"), "utf8")).toContain(head);
    expect(readFileSync(join(root, "review-context.diff"), "utf8")).toBe(ctx.colorlessDiff);
  });

  it("fails closed when target ref metadata is missing", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    await expect(
      freezeReviewContext({
        repo,
        headSha: head,
        sourceRef: "HEAD",
        targetRef: null,
        host: "github",
        runCommand: defaultRunCommand,
      }),
    ).rejects.toThrow(/target ref metadata is missing/);
  });

  it("fails closed when a provided target ref cannot be resolved", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    await expect(
      freezeReviewContext({
        repo,
        headSha: head,
        sourceRef: "HEAD",
        targetRef: "origin/main",
        host: "github",
        runCommand: defaultRunCommand,
      }),
    ).rejects.toThrow(/git fetch origin main failed|refusing a head\.\.\.head empty diff/);
  });

  it("resolves a local parent without fetching when skipRemoteFetch is set", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const parent = execFileSync("git", ["rev-parse", "HEAD~1"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const ctx = await freezeReviewContext({
      repo,
      headSha: head,
      sourceRef: "HEAD",
      targetRef: "HEAD~1",
      host: "github",
      skipRemoteFetch: true,
      runCommand: async (input) => {
        if (input.argv[0] === "fetch") {
          throw new Error("skipRemoteFetch must not fetch origin");
        }
        return defaultRunCommand(input);
      },
    });
    expect(ctx.baseSha).toBe(parent);
    expect(ctx.mergeBaseSha).toBe(parent);
    expect(ctx.targetRef).toBe("HEAD~1");
  });
});
