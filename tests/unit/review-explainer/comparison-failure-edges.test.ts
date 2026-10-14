import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reviewComparison } from "../../../runtime-host/review-explainer/comparison";
import { RUN_ID } from "../../review-explainer/contract";
import { seedReviewRun } from "../../review-explainer/fixtures/seed-run";

const homes: string[] = [];
const oldHome = process.env.COUNCILKIT_HOME;

afterEach(() => {
  if (oldHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = oldHome;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function git(repo: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: repo,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ck-cmp-edge-"));
  homes.push(home);
  process.env.COUNCILKIT_HOME = home;
  return seedReviewRun(home);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function retargetHead(runDir: string, headSha: string): void {
  const mdPath = join(runDir, "review-context.md");
  writeFileSync(
    mdPath,
    readFileSync(mdPath, "utf8").replace(/^- head: `[a-f0-9]{40}`$/m, `- head: \`${headSha}\``),
  );
  const manifestPath = join(runDir, "invocation-manifest.v1.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { reviewedSha: string };
  manifest.reviewedSha = headSha;
  writeJson(manifestPath, manifest);
  const identityPath = join(runDir, "review-explainer", "identity.json");
  const identity = JSON.parse(readFileSync(identityPath, "utf8")) as { headSha: string };
  identity.headSha = headSha;
  writeJson(identityPath, identity);
  const ledgerPath = join(runDir, "findings.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { sha: string };
  ledger.sha = headSha;
  writeJson(ledgerPath, ledger);
}

function pointRepo(runDir: string, repoPath: string): void {
  const manifestPath = join(runDir, "invocation-manifest.v1.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { repoRealpath: string };
  manifest.repoRealpath = repoPath;
  writeJson(manifestPath, manifest);
  const identityPath = join(runDir, "review-explainer", "identity.json");
  const identity = JSON.parse(readFileSync(identityPath, "utf8")) as { repoPath: string };
  identity.repoPath = repoPath;
  writeJson(identityPath, identity);
}

function unavailable(
  reason: "repository_missing" | "commit_missing" | "parent_missing" | "diff_unavailable",
  notice: string,
  toSha: string,
  fromSha: string | null,
) {
  return {
    mode: "last-commit" as const,
    fromSha,
    toSha,
    availability: "unavailable" as const,
    reason,
    notice,
    files: [],
    totals: { files: 0, hunks: 0, additions: 0, deletions: 0 },
  };
}

const FROZEN_FILES = [
  {
    path: "README.md",
    oldPath: "README.md",
    newPath: "README.md",
    status: "modified",
    binary: false,
  },
  {
    path: "assets/icon.bin",
    oldPath: null,
    newPath: "assets/icon.bin",
    status: "added",
    binary: true,
  },
  {
    path: "src/busy.go",
    oldPath: "src/busy.go",
    newPath: "src/busy.go",
    status: "modified",
    binary: false,
  },
  {
    path: "src/deleted.go",
    oldPath: "src/deleted.go",
    newPath: null,
    status: "deleted",
    binary: false,
  },
  {
    path: "src/recovery.go",
    oldPath: null,
    newPath: "src/recovery.go",
    status: "added",
    binary: false,
  },
  {
    path: "src/renamed.go",
    oldPath: "src/old_name.go",
    newPath: "src/renamed.go",
    status: "renamed",
    binary: false,
  },
  {
    path: "tests/WideCoverage.java",
    oldPath: "tests/WideCoverage.java",
    newPath: "tests/WideCoverage.java",
    status: "modified",
    binary: false,
  },
];

describe("last-commit comparison failures", () => {
  it("keeps the frozen full diff when the last commit tree object is missing", () => {
    const seeded = setup();
    const before = reviewComparison(RUN_ID, "last-commit");
    expect(before.fromSha).toBe(seeded.repo.baseSha);
    expect(before.toSha).toBe(seeded.repo.headSha);
    expect(before.availability).toBe("available");
    expect(
      before.files.map((file) => ({
        path: file.path,
        oldPath: file.oldPath,
        newPath: file.newPath,
        status: file.status,
        binary: file.binary,
      })),
    ).toEqual(FROZEN_FILES);

    const tree = git(seeded.repo.repo, ["rev-parse", `${seeded.repo.headSha}^{tree}`]);
    rmSync(join(seeded.repo.repo, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
    expect(reviewComparison(RUN_ID, "last-commit")).toEqual(
      unavailable(
        "diff_unavailable",
        "冻结提交 diff 不可用或超过读取限制，请查看全量变更。",
        seeded.repo.headSha,
        seeded.repo.baseSha,
      ),
    );
    const full = reviewComparison(RUN_ID, "full");
    expect(full.availability).toBe("available");
    expect(full.fromSha).toBe(seeded.repo.mergeBaseSha);
    expect(full.toSha).toBe(seeded.repo.headSha);
    expect(full.reason).toBeUndefined();
    expect(full.files.map((file) => file.path)).toEqual(FROZEN_FILES.map((file) => file.path));
  });

  it("reports a first parent that exists but is not a commit", () => {
    const seeded = setup();
    const blob = git(seeded.repo.repo, ["hash-object", "-w", "--stdin"], "not-a-commit\n");
    const tree = git(seeded.repo.repo, ["rev-parse", "HEAD^{tree}"]);
    const commit = git(
      seeded.repo.repo,
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      [
        `tree ${tree}`,
        `parent ${blob}`,
        "author Explainer Fixture <explainer@test> 1700000000 +0000",
        "committer Explainer Fixture <explainer@test> 1700000000 +0000",
        "",
        "parent is a blob",
        "",
      ].join("\n"),
    );
    retargetHead(seeded.runDir, commit);
    expect(reviewComparison(RUN_ID, "last-commit")).toEqual(
      unavailable(
        "parent_missing",
        "冻结提交的第一父提交对象缺失，无法显示最后一次提交。",
        commit,
        blob,
      ),
    );
  });

  it("does not substitute a tree object for the frozen commit", () => {
    const seeded = setup();
    const tree = git(seeded.repo.repo, ["rev-parse", `${seeded.repo.headSha}^{tree}`]);
    retargetHead(seeded.runDir, tree);
    expect(reviewComparison(RUN_ID, "last-commit")).toEqual(
      unavailable("commit_missing", "冻结提交对象不可用，不会使用当前 HEAD 替代。", tree, null),
    );
  });

  it.each([
    {
      name: "symlink",
      locate: (repo: string, home: string) => {
        const link = join(home, "repo-link");
        symlinkSync(repo, link);
        return link;
      },
    },
    {
      name: "file",
      locate: (repo: string) => join(repo, "README.md"),
    },
    {
      name: "subdirectory",
      locate: (repo: string) => join(repo, "src"),
    },
  ])("reports a $name repository path as unavailable", ({ locate }) => {
    const seeded = setup();
    pointRepo(seeded.runDir, locate(seeded.repo.repo, seeded.home));
    expect(reviewComparison(RUN_ID, "last-commit")).toEqual(
      unavailable(
        "repository_missing",
        "冻结仓库不可用，无法读取最后一次提交。",
        seeded.repo.headSha,
        null,
      ),
    );
  });

  it("reports a missing object directory as an unavailable repository", () => {
    const seeded = setup();
    const objects = join(seeded.repo.repo, ".git", "objects");
    rmSync(objects, { recursive: true, force: true });
    writeFileSync(objects, "not-a-directory");
    expect(reviewComparison(RUN_ID, "last-commit")).toEqual(
      unavailable(
        "repository_missing",
        "冻结仓库不可用，无法读取最后一次提交。",
        seeded.repo.headSha,
        null,
      ),
    );
  });
});
