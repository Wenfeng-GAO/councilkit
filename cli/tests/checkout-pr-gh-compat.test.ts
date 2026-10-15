import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunCommand, inspectPullRequest } from "../src/auto/checkout-pr";

describe("PR-GH-01/02 old gh without baseRefOid", () => {
  let bin: string;
  const oldPath = process.env.PATH;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "ck-gh-old-"));
    for (const name of ["gh", "git"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, name), 0o755);
    }
    process.env.PATH = bin;
  });
  afterEach(() => {
    if (oldPath === undefined) process.env.PATH = undefined;
    else process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  });

  it("PR-GH-01 old gh without baseRefOid: inspect still resolves baseSha via ls-remote", async () => {
    const fields: string[] = [];
    const runCommand: RunCommand = async (input) => {
      if (input.executable === "gh" && input.argv[0] === "pr" && input.argv[1] === "view") {
        const jsonFlag = input.argv.indexOf("--json");
        const list = jsonFlag >= 0 ? (input.argv[jsonFlag + 1] ?? "") : "";
        fields.push(list);
        if (list.includes("baseRefOid")) {
          return {
            stdout: "",
            stderr:
              'Unknown JSON field: "baseRefOid"\nAvailable fields:\n  baseRefName\n  headRefOid\n',
            exitCode: 1,
          };
        }
        return {
          stdout: JSON.stringify({
            headRefName: "feat-x",
            baseRefName: "main",
            headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            headRepository: { nameWithOwner: "acme/repo" },
            headRepositoryOwner: { login: "acme" },
            state: "OPEN",
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (input.executable === "git" && input.argv[0] === "ls-remote") {
        return {
          stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/main\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    };
    const meta = await inspectPullRequest(
      "https://github.com/acme/repo/pull/9",
      runCommand,
      process.env,
      bin,
    );
    expect(fields[0]).toContain("baseRefOid");
    expect(fields[1]).not.toContain("baseRefOid");
    expect(meta.baseBranch).toBe("main");
    expect(meta.baseSha).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(meta.headSha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("PR-GH-02 gh with baseRefOid keeps the single call", async () => {
    let views = 0;
    const runCommand: RunCommand = async (input) => {
      if (input.executable === "gh" && input.argv[0] === "pr" && input.argv[1] === "view") {
        views += 1;
        return {
          stdout: JSON.stringify({
            headRefName: "feat-x",
            baseRefName: "main",
            headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            baseRefOid: "cccccccccccccccccccccccccccccccccccccccc",
            headRepository: { nameWithOwner: "acme/repo" },
            headRepositoryOwner: { login: "acme" },
            state: "OPEN",
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "no ls-remote", exitCode: 1 };
    };
    const meta = await inspectPullRequest(
      "https://github.com/acme/repo/pull/9",
      runCommand,
      process.env,
      bin,
    );
    expect(views).toBe(1);
    expect(meta.baseSha).toBe("cccccccccccccccccccccccccccccccccccccccc");
  });
});
