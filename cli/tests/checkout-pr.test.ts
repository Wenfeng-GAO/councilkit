import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RunCommand,
  checkoutPullRequest,
  parseApplyPrUrl,
  parseGitHubPrUrl,
} from "../src/auto/checkout-pr";

describe("checkout-pr URL parsing", () => {
  it("parses GitHub PR URLs", () => {
    const parsed = parseGitHubPrUrl(new URL("https://github.com/acme/repo/pull/9"));
    expect(parsed).toEqual({ owner: "acme", repo: "repo", number: "9" });
    expect(parseApplyPrUrl("https://github.com/acme/repo/pull/9")?.kind).toBe("github");
  });

  it("parses AntCode PR URLs", () => {
    expect(
      parseApplyPrUrl("https://code.alipay.com/paas-core/agentrun/pull_requests/126")?.kind,
    ).toBe("antcode");
  });

  it("rejects unknown hosts", () => {
    expect(parseApplyPrUrl("https://example.com/pr/1")).toBeNull();
  });
});

describe("checkoutPullRequest command sequence", () => {
  let bin: string;
  const oldPath = process.env.PATH;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "ck-co-bin-"));
    for (const name of ["gh", "git", "antcode"]) {
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

  it("GitHub: gh pr view, clone, checkout", async () => {
    const calls: string[][] = [];
    const runCommand: RunCommand = async (input) => {
      calls.push([input.executable, ...input.argv]);
      if (input.argv[0] === "pr" && input.argv[1] === "view") {
        return {
          stdout: JSON.stringify({
            headRefName: "feat-x",
            headRepository: { nameWithOwner: "acme/repo" },
            headRepositoryOwner: { login: "acme" },
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (input.argv.includes("--abbrev-ref")) {
        return { stdout: "feat-x\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const result = await checkoutPullRequest(
      "https://github.com/acme/repo/pull/9",
      "/tmp/ws",
      runCommand,
      { ...process.env, PATH: process.env.PATH },
    );
    expect(result.host).toBe("github");
    expect(result.branch).toBe("feat-x");
    expect(calls[0]?.[0]).toBe("gh");
    expect(calls[0]?.slice(1, 3)).toEqual(["pr", "view"]);
    expect(calls.some((c) => c[0] === "gh" && c.includes("clone"))).toBe(true);
    expect(calls.some((c) => c[0] === "gh" && c.includes("checkout"))).toBe(true);
  });

  it("AntCode: antcode pr show then git clone --branch", async () => {
    const calls: string[][] = [];
    const runCommand: RunCommand = async (input) => {
      calls.push([input.executable, ...input.argv]);
      if (input.executable === "antcode") {
        expect(input.env?.NO_PROXY).toBe("*");
        expect(input.env?.HTTPS_PROXY).toBe("");
        return {
          stdout: JSON.stringify({
            source_branch: "feat/live",
            source: { ssh_url: "git@gitlab.alipay-inc.com:paas-core/agentrun.git" },
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      if (input.argv.includes("--abbrev-ref")) {
        return { stdout: "feat/live\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const result = await checkoutPullRequest(
      "https://code.alipay.com/paas-core/agentrun/pull_requests/126",
      "/tmp/ws",
      runCommand,
    );
    expect(result.host).toBe("antcode");
    expect(result.branch).toBe("feat/live");
    const clone = calls.find((c) => c[0] === "git" && c[1] === "clone");
    expect(clone).toBeDefined();
    expect(clone).toContain("--branch");
    expect(clone).toContain("feat/live");
  });
});
