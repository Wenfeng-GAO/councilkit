import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeRepairWorkspace } from "../src/auto/repair-workspace";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("materializeRepairWorkspace", () => {
  it("clones into an isolated git workspace without changing the source HEAD", async () => {
    const root = mkdtempSync(join(tmpdir(), "ck-ws-"));
    roots.push(root);
    const source = join(root, "source");
    mkdirSync(source);
    git(source, ["init", "-b", "feat-x"]);
    git(source, ["config", "user.email", "squad@example.com"]);
    git(source, ["config", "user.name", "squad"]);
    writeFileSync(join(source, "README.md"), "one\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "one"]);
    const sha = git(source, ["rev-parse", "HEAD"]);
    const bare = join(root, "remote.git");
    execFileSync("git", ["clone", "--bare", source, bare]);
    git(source, ["remote", "add", "origin", bare]);
    const dest = join(root, "isolated");
    const frozen = await materializeRepairWorkspace({
      dest,
      sourceRepo: source,
      sourceBranch: "feat-x",
      sourceSha: sha,
    });
    expect(frozen.headSha).toBe(sha);
    expect(frozen.sourceRef).toBe("refs/heads/feat-x");
    expect(git(source, ["rev-parse", "HEAD"])).toBe(sha);
  });
});
