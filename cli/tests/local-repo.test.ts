import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRunCommand } from "../src/auto/checkout-pr";
import {
  projectFromRemote,
  projectKeyFromPr,
  remoteMatchesProject,
  resolveLocalRepo,
} from "../src/auto/local-repo";

describe("project keys", () => {
  it("parses GitHub and AntCode PR URLs", () => {
    expect(projectKeyFromPr("https://github.com/acme/repo/pull/9")).toBe("acme/repo");
    expect(projectKeyFromPr("https://code.alipay.com/paas-core/agentrun/pull_requests/126")).toBe(
      "paas-core/agentrun",
    );
  });

  it("matches gitlab/ssh remotes to an AntCode project key", () => {
    expect(projectFromRemote("git@gitlab.alipay-inc.com:paas-core/agentrun.git")).toBe(
      "paas-core/agentrun",
    );
    expect(
      remoteMatchesProject(
        "http://gitlab.alipay-inc.com/paas-core/agentrun.git",
        "paas-core/agentrun",
      ),
    ).toBe(true);
  });
});

describe("resolveLocalRepo", () => {
  let home: string;
  let repo: string;
  const oldHome = process.env.COUNCILKIT_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-repos-"));
    repo = join(home, "agentrun");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@gitlab.alipay-inc.com:paas-core/agentrun.git"],
      {
        cwd: repo,
      },
    );
    process.env.COUNCILKIT_HOME = home;
  });
  afterEach(() => {
    if (oldHome === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("--repo remembers the mapping", async () => {
    const first = await resolveLocalRepo({
      pr: "https://code.alipay.com/paas-core/agentrun/pull_requests/126",
      repoFlag: repo,
      runCommand: defaultRunCommand,
    });
    expect(first.source).toBe("flag");
    const second = await resolveLocalRepo({
      pr: "https://code.alipay.com/paas-core/agentrun/pull_requests/126",
      runCommand: defaultRunCommand,
      cwd: tmpdir(),
    });
    expect(second.source).toBe("config");
    expect(second.path).toBe(first.path);
  });
});
