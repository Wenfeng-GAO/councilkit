/**
 * #273 part 2 — SAFE-05 for PR reviews: the PR-mode fetch (head + target
 * branch) must never write objects or refs into the user's `.git/`.
 *
 * Real CLI orchestration and a REAL `git fetch` from a local "origin" repo;
 * only `gh pr view` and the agent subprocesses are fake. The user's clone does
 * not have the PR branch, so the review has to fetch it. Before #273 part 2
 * this landed in the user's .git (objects + a temporary ref).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewComparison } from "../../runtime-host/review-explainer/comparison";
import { readFrozenFile, readFrozenReview } from "../../runtime-host/review-explainer/workspace";
import {
  BUSY_REPORT_LINE,
  claudeEnvelope,
  fakeCliPath,
  makeSink,
  reportOutput,
  seedAgents,
} from "../../tests/review-explainer/cli-harness";
import { type RunCommand, defaultRunCommand } from "../src/auto/checkout-pr";
import { DRIVER_PROBE_PROMPT } from "../src/auto/driver-commands";
import { prepareIsolatedSource, stripUrlCredentials } from "../src/auto/git-worktree";
import type { SpawnImpl } from "../src/auto/runner";
import { ReviewExit, runReview } from "../src/commands/review";

const PR = "https://github.com/acme-safe05/fixture/pull/7";

function hashTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else
        out.set(relative(root, abs), createHash("sha256").update(readFileSync(abs)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let home: string;
const previous = { COUNCILKIT_HOME: process.env.COUNCILKIT_HOME, PATH: process.env.PATH };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-safe05-pr-"));
  process.env.COUNCILKIT_HOME = home;
  process.env.PATH = fakeCliPath(home, previous.PATH);
});
afterEach(() => {
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

/** origin (bare) has main + feature; the user's clone only has main. */
function makeOriginAndClone() {
  const seed = join(home, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "t@t");
  git(seed, "config", "user.name", "t");
  writeFileSync(join(seed, "sum.js"), "module.exports = (a, b) => a + b;\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "base");
  const baseSha = git(seed, "rev-parse", "HEAD");
  git(seed, "checkout", "-qb", "feature");
  writeFileSync(join(seed, "sum.js"), "module.exports = (a, b) => a - b;\n");
  git(seed, "commit", "-qam", "feature: break sum");
  const headSha = git(seed, "rev-parse", "HEAD");
  const origin = join(home, "origin.git");
  git(home, "clone", "-q", "--bare", seed, origin);
  const repo = join(home, "repo");
  git(home, "clone", "-q", "--no-local", "--single-branch", "-b", "main", origin, repo);
  expect(() => git(repo, "cat-file", "-e", headSha)).toThrow();
  return { repo, baseSha, headSha };
}

describe("#273 SAFE-05 PR-mode fetch uses an isolated clone", () => {
  it("fetches the PR head into the run dir; the user's .git is sha256-identical", async () => {
    const { repo, baseSha, headSha } = makeOriginAndClone();
    const gitBefore = hashTree(join(repo, ".git"));
    const filesBefore = git(repo, "status", "--porcelain");

    const runCommand: RunCommand = async (input) => {
      if (input.executable === "gh") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            headRefName: "feature",
            baseRefName: "main",
            headRefOid: headSha,
            baseRefOid: baseSha,
            headRepository: { name: "fixture" },
            headRepositoryOwner: { login: "acme-safe05" },
            isCrossRepository: false,
            url: PR,
            state: "OPEN",
          }),
          stderr: "",
        };
      }
      return defaultRunCommand(input);
    };
    const seatCwds: string[] = [];
    const spawn: SpawnImpl = async (spec) => {
      if (spec.prompt === DRIVER_PROBE_PROMPT) return claudeEnvelope("ok");
      seatCwds.push(spec.cwd);
      return claudeEnvelope(reportOutput([BUSY_REPORT_LINE], spec.prompt.includes("对比汇总")));
    };
    const agents = seedAgents();
    const sink = makeSink();
    try {
      await runReview(
        [
          PR,
          "--repo",
          repo,
          "--agents",
          JSON.stringify(agents.ids),
          "--aggregator",
          agents.reporter,
          "--no-require-spec",
        ],
        sink,
        { spawnImpl: spawn, runCommand },
      );
    } catch (error) {
      if (!(error instanceof ReviewExit) || error.exitCode !== 0) throw error;
    }
    const outcome = sink.finished as { exitCode: number; runId: string } | undefined;
    expect(outcome?.exitCode).toBe(0);

    // The seats reviewed the fetched PR head…
    const seat = seatCwds.find((cwd) => cwd.includes("workspaces"));
    expect(seat).toBeDefined();
    if (seat) expect(git(seat, "rev-parse", "HEAD")).toBe(headSha);
    // …but the user's repo never received it.
    expect(() => git(repo, "cat-file", "-e", headSha)).toThrow();
    expect(hashTree(join(repo, ".git"))).toEqual(gitBefore);
    expect(git(repo, "status", "--porcelain")).toBe(filesBefore);

    // Sweep (#273): the Host review explainer used to read the frozen head
    // from the user's repo. It must now find it in the run's source.git.
    if (!outcome) return;
    const frozen = readFrozenReview(outcome.runId);
    expect(frozen.repo).toMatch(/source\.git$/);
    const head = readFrozenFile(frozen, "sum.js", "new");
    expect(head.availability).toBe("available");
    expect(head.text).toContain("a - b");
    const comparison = reviewComparison(outcome.runId, "last-commit");
    expect(JSON.stringify(comparison)).not.toContain("repository_missing");
  });
});

/**
 * #305 — `prepareIsolatedSource` copies `remote.origin.url` into the run's
 * `source.git/config`. A user's origin can carry a PAT in its userinfo
 * (`https://x-access-token:ghp_…@github.com/…`), which would then sit in
 * cleartext inside `runs/<id>/` forever. It must be stripped first.
 */
describe("#305 the isolated source never persists credentials from origin", () => {
  it("stripUrlCredentials drops userinfo and leaves clean URLs alone", () => {
    expect(stripUrlCredentials("https://x-access-token:ghp_SECRET@github.com/acme/repo.git")).toBe(
      "https://github.com/acme/repo.git",
    );
    expect(stripUrlCredentials("https://user:pw@git.example.com:8443/a/b.git")).toBe(
      "https://git.example.com:8443/a/b.git",
    );
    // Already clean, or not a URL at all: untouched.
    for (const same of [
      "https://github.com/acme/repo.git",
      "git@github.com:acme/repo.git",
      "/abs/path/to/repo",
      "../relative/repo",
    ]) {
      expect(stripUrlCredentials(same)).toBe(same);
    }
  });

  it("a token in the user's origin never reaches the run's source.git config", async () => {
    const { repo } = makeOriginAndClone();
    const token = `ghp_${"T".repeat(36)}`;
    // Point the user's origin at itself with a credential in the userinfo.
    execFileSync(
      "git",
      [
        "remote",
        "set-url",
        "origin",
        `https://x-access-token:${token}@example.invalid/acme/fixture.git`,
      ],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );

    const runDir = mkdtempSync(join(tmpdir(), "ck-safe05-305-"));
    try {
      const sourceRepo = await prepareIsolatedSource({ repo, runDir });
      const config = readFileSync(join(sourceRepo, "config"), "utf8");
      expect(config).not.toContain(token);
      expect(config).not.toContain("x-access-token");
      // The URL is still usable and still points at the same host.
      expect(config).toContain("https://example.invalid/acme/fixture.git");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
