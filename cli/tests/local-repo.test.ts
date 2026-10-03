import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRunCommand } from "../src/auto/checkout-pr";
import {
  parseRemoteRepoIdentity,
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

  it("parses SCP, ssh:// with port, and HTTPS remotes as host+path", () => {
    expect(parseRemoteRepoIdentity("git@github.com:acme/repo.git")).toEqual({
      host: "github.com",
      path: "acme/repo",
    });
    expect(parseRemoteRepoIdentity("ssh://git@github.com:22/acme/repo.git")).toEqual({
      host: "github.com",
      path: "acme/repo",
    });
    expect(parseRemoteRepoIdentity("https://code.alipay.com/group/proj.git")).toEqual({
      host: "code.alipay.com",
      path: "group/proj",
    });
    expect(parseRemoteRepoIdentity("github.com/acme/repo")).toEqual({
      host: "github.com",
      path: "acme/repo",
    });
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

  it("matches a checkout when the remote path and the PR project differ only by case", async () => {
    expect(remoteMatchesProject("git@github.com:acme/repo.git", "Acme/Repo")).toBe(true);
    expect(remoteMatchesProject("https://github.com/Acme/Repo.git", "acme/repo")).toBe(true);
    expect(remoteMatchesProject("git@github.com:evil/Acme/Repo.git", "acme/repo")).toBe(false);

    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:acme/repo.git"], {
      cwd: repo,
    });
    const resolved = await resolveLocalRepo({
      pr: "https://github.com/Acme/Repo/pull/9",
      cwd: repo,
      runCommand: defaultRunCommand,
    });
    expect(resolved.source).toBe("cwd");
    expect(resolved.project).toBe("Acme/Repo");
    expect(resolved.path).toBe(repo);
  });

  it("reuses a remembered clone when a later PR only changes the project key case", async () => {
    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:acme/repo.git"], {
      cwd: repo,
    });
    const remembered = await resolveLocalRepo({
      pr: "https://github.com/Acme/Repo/pull/9",
      cwd: repo,
      runCommand: defaultRunCommand,
    });
    expect(remembered.source).toBe("cwd");

    const again = await resolveLocalRepo({
      pr: "https://github.com/acme/repo/pull/10",
      cwd: tmpdir(),
      runCommand: defaultRunCommand,
    });
    expect(again.source).toBe("config");
    expect(again.path).toBe(repo);
    expect(again.project).toBe("acme/repo");
  });

  it("refuses a cwd checkout whose remote path only suffixes the PR project", async () => {
    expect(remoteMatchesProject("git@github.com:acme/repo.git", "acme/repo")).toBe(true);
    expect(remoteMatchesProject("git@github.com:evil/acme/repo.git", "acme/repo")).toBe(false);
    expect(remoteMatchesProject("git@github.com:acme/repo.git", "repo")).toBe(false);

    execFileSync("git", ["remote", "set-url", "origin", "git@github.com:evil/acme/repo.git"], {
      cwd: repo,
    });
    await expect(
      resolveLocalRepo({
        pr: "https://github.com/acme/repo/pull/9",
        cwd: repo,
        runCommand: defaultRunCommand,
      }),
    ).rejects.toThrow("no local clone for acme/repo");
  });
});
