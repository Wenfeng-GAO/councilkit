import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeRepairWorkspace, originMatchesRepo } from "../src/auto/repair-workspace";

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
    expect(frozen.originUrl).toBe(bare);
    expect(git(dest, ["remote", "get-url", "origin"])).toBe(bare);
    expect(git(source, ["rev-parse", "HEAD"])).toBe(sha);
    git(dest, ["config", "user.email", "squad@example.com"]);
    git(dest, ["config", "user.name", "squad"]);
    writeFileSync(join(dest, "README.md"), "candidate\n");
    git(dest, ["add", "."]);
    git(dest, ["commit", "-m", "candidate"]);
    const candidate = git(dest, ["rev-parse", "HEAD"]);
    const resumed = await materializeRepairWorkspace({
      dest,
      sourceRepo: source,
      sourceBranch: "feat-x",
      sourceSha: sha,
      expectedOriginUrl: bare,
    });
    expect(resumed.headSha).toBe(candidate);
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(candidate);
    expect(resumed.pushUrl).toBe(bare);
    expect(git(dest, ["remote", "get-url", "--push", "origin"])).toBe(bare);
    git(dest, ["config", "remote.origin.pushurl", join(root, "unexpected.git")]);
    await expect(
      materializeRepairWorkspace({
        dest,
        sourceRepo: source,
        sourceBranch: "feat-x",
        sourceSha: sha,
        expectedOriginUrl: bare,
        expectedPushUrl: bare,
      }),
    ).rejects.toThrow(/push/i);
  });

  it("matches host+path for SCP, ssh://, HTTPS and rejects substring spoofs", () => {
    const repo = "github.com/acme/repo";
    expect(originMatchesRepo("https://github.com/acme/repo.git", repo)).toBe(true);
    expect(originMatchesRepo("https://github.com/acme/repo", repo)).toBe(true);
    expect(originMatchesRepo("git@github.com:acme/repo.git", repo)).toBe(true);
    expect(originMatchesRepo("git@github.com:acme/repo", repo)).toBe(true);
    expect(originMatchesRepo("ssh://git@github.com:22/acme/repo.git", repo)).toBe(true);
    expect(originMatchesRepo("ssh://git@github.com/acme/repo.git", repo)).toBe(true);
    expect(
      originMatchesRepo("git@code.alipay.com:group/proj.git", "code.alipay.com/group/proj"),
    ).toBe(true);
    expect(
      originMatchesRepo(
        "ssh://git@code.alipay.com:2222/group/proj.git",
        "code.alipay.com/group/proj",
      ),
    ).toBe(true);
    expect(originMatchesRepo("https://wrong.example/github.com/acme/repo.git", repo)).toBe(false);
    expect(originMatchesRepo("git@github.com:acme/repo-extra.git", repo)).toBe(false);
    expect(originMatchesRepo("git@github.com:prefix/acme/repo.git", repo)).toBe(false);
    expect(originMatchesRepo("git@evil.com:github.com/acme/repo.git", repo)).toBe(false);
    expect(originMatchesRepo("https://github.com/acme/other.git", repo)).toBe(false);
  });
});
