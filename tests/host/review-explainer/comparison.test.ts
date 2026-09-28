import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewComparison } from "@host/review-explainer/comparison";
import type { ReviewComparison } from "@shared/runtime/review-explainer/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROUTES, RUN_ID } from "../../review-explainer/contract";
import { seedReviewRun } from "../../review-explainer/fixtures/seed-run";
import type { SyntheticRepo } from "../../review-explainer/fixtures/synthetic-repo";
import { type ExplainerHttpHost, createExplainerHttpHost } from "./http-helpers";

let home: string;
let host: ExplainerHttpHost | undefined;
const oldHome = process.env.COUNCILKIT_HOME;
const git = (repo: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ck-comparison-"));
  process.env.COUNCILKIT_HOME = home;
});
afterEach(async () => {
  await host?.close();
  host = undefined;
  if (oldHome === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
  else process.env.COUNCILKIT_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

function freeze(repo: SyntheticRepo, headSha: string) {
  const diff = execFileSync(
    "git",
    ["diff", "--no-color", "--no-ext-diff", repo.mergeBaseSha, headSha, "--"],
    { cwd: repo.repo, encoding: "utf8" },
  );
  return seedReviewRun(home, {
    repo: { ...repo, headSha, diff, diffHash: createHash("sha256").update(diff).digest("hex") },
  });
}

describe("frozen review comparisons", () => {
  it("keeps the full artifact and compares only the frozen last commit after HEAD/worktree change", () => {
    const initial = seedReviewRun(home);
    writeFileSync(join(initial.repo.repo, "README.md"), "LAST_COMMIT_ONLY\n");
    git(initial.repo.repo, ["add", "README.md"]);
    git(initial.repo.repo, ["commit", "-m", "last reviewed commit"]);
    const frozen = freeze(initial.repo, git(initial.repo.repo, ["rev-parse", "HEAD"]));
    const before = reviewComparison(RUN_ID, "last-commit");
    expect(before).toMatchObject({
      availability: "available",
      fromSha: initial.repo.headSha,
      toSha: frozen.repo.headSha,
      totals: { files: 1 },
    });
    expect(before.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(JSON.stringify(before)).toContain("LAST_COMMIT_ONLY");

    writeFileSync(join(initial.repo.repo, "README.md"), "LATER_HEAD_POISON\n");
    git(initial.repo.repo, ["add", "README.md"]);
    git(initial.repo.repo, ["commit", "-m", "unreviewed commit"]);
    writeFileSync(join(initial.repo.repo, "README.md"), "WORKTREE_POISON\n");
    writeFileSync(join(initial.repo.repo, ".gitattributes"), "README.md -diff\n");
    expect(reviewComparison(RUN_ID, "last-commit")).toEqual(before);
    const full = reviewComparison(RUN_ID, "full");
    expect(full.fromSha).toBe(initial.repo.mergeBaseSha);
    expect(full.toSha).toBe(frozen.repo.headSha);
    expect(full.files.length).toBeGreaterThan(before.files.length);
    expect(JSON.stringify(full)).not.toMatch(/LATER_HEAD_POISON|WORKTREE_POISON/);
    expect(readFileSync(join(frozen.runDir, "review-context.diff"), "utf8")).toBe(frozen.repo.diff);
  });

  it("uses the first parent of a merge commit", () => {
    const seeded = seedReviewRun(home);
    const repo = seeded.repo.repo;
    git(repo, ["checkout", "-b", "side", seeded.repo.baseSha]);
    writeFileSync(join(repo, "side.txt"), "SIDE_BRANCH_CHANGE\n");
    git(repo, ["add", "side.txt"]);
    git(repo, ["commit", "-m", "side"]);
    const secondParent = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "-b", "reviewed", seeded.repo.headSha]);
    git(repo, ["merge", "--no-ff", "side", "-m", "merge side"]);
    const frozen = freeze(seeded.repo, git(repo, ["rev-parse", "HEAD"]));
    const comparison = reviewComparison(RUN_ID, "last-commit");
    expect(comparison.fromSha).toBe(seeded.repo.headSha);
    expect(comparison.fromSha).not.toBe(secondParent);
    expect(comparison.toSha).toBe(frozen.repo.headSha);
    expect(comparison.files.map((file) => file.path)).toEqual(["side.txt"]);
  });

  it("ignores repository info/attributes and diff configuration without modifying them", () => {
    const seeded = seedReviewRun(home);
    const before = reviewComparison(RUN_ID, "last-commit");
    const infoAttributes = join(seeded.repo.repo, ".git", "info", "attributes");
    writeFileSync(infoAttributes, "README.md -diff\n");
    git(seeded.repo.repo, ["config", "diff.context", "0"]);
    git(seeded.repo.repo, ["config", "core.attributesFile", infoAttributes]);
    const config = readFileSync(join(seeded.repo.repo, ".git", "config"), "utf8");
    expect(reviewComparison(RUN_ID, "last-commit")).toEqual(before);
    expect(readFileSync(infoAttributes, "utf8")).toBe("README.md -diff\n");
    expect(readFileSync(join(seeded.repo.repo, ".git", "config"), "utf8")).toBe(config);
  });

  it.each(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"])(
    "ignores attributes and diff configuration inherited through %s",
    (configKey) => {
      seedReviewRun(home);
      const before = reviewComparison(RUN_ID, "last-commit");
      const attributes = join(home, "outside.attributes");
      const config = join(home, "outside.gitconfig");
      writeFileSync(attributes, "README.md -diff\n");
      writeFileSync(config, `[core]\n attributesFile = ${attributes}\n[diff]\n context = 0\n`);
      const previous = process.env[configKey];
      process.env[configKey] = config;
      try {
        expect(reviewComparison(RUN_ID, "last-commit")).toEqual(before);
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, configKey);
        else process.env[configKey] = previous;
      }
    },
  );

  it("still honors attributes committed at the frozen head", () => {
    const seeded = seedReviewRun(home);
    writeFileSync(join(seeded.repo.repo, ".gitattributes"), "README.md -diff\n");
    writeFileSync(join(seeded.repo.repo, "README.md"), "FROZEN_ATTRIBUTE_CHANGE\n");
    git(seeded.repo.repo, ["add", ".gitattributes", "README.md"]);
    git(seeded.repo.repo, ["commit", "-m", "freeze binary attribute"]);
    freeze(seeded.repo, git(seeded.repo.repo, ["rev-parse", "HEAD"]));
    writeFileSync(join(seeded.repo.repo, ".gitattributes"), "README.md diff\n");
    expect(
      reviewComparison(RUN_ID, "last-commit").files.find((file) => file.path === "README.md"),
    ).toMatchObject({ binary: true, hunks: [] });
  });

  it("includes a last-commit reversal even when that file is absent from the full PR diff", () => {
    const seeded = seedReviewRun(home);
    git(seeded.repo.repo, ["checkout", seeded.repo.baseSha, "--", "README.md"]);
    git(seeded.repo.repo, ["commit", "-m", "restore README to base"]);
    freeze(seeded.repo, git(seeded.repo.repo, ["rev-parse", "HEAD"]));
    expect(reviewComparison(RUN_ID, "full").files.some((file) => file.path === "README.md")).toBe(
      false,
    );
    expect(reviewComparison(RUN_ID, "last-commit").files.map((file) => file.path)).toEqual([
      "README.md",
    ]);
  });

  it("preserves additions, deletions, renames and binary files without fabricated hunks", () => {
    const seeded = seedReviewRun(home);
    const result = reviewComparison(RUN_ID, "last-commit");
    expect(result.availability).toBe("available");
    expect(result.files.find((file) => file.path === "src/recovery.go")?.oldPath).toBeNull();
    expect(result.files.find((file) => file.path === "src/deleted.go")?.newPath).toBeNull();
    expect(result.files.find((file) => file.path === "assets/icon.bin")).toMatchObject({
      binary: true,
      hunks: [],
    });
    const repo = seeded.repo;
    git(repo.repo, ["mv", "README.md", "RENAMED.md"]);
    git(repo.repo, ["commit", "-m", "pure rename"]);
    freeze(repo, git(repo.repo, ["rev-parse", "HEAD"]));
    expect(reviewComparison(RUN_ID, "last-commit").files).toMatchObject([
      { path: "RENAMED.md", oldPath: "README.md", newPath: "RENAMED.md", status: "renamed" },
    ]);
  });

  it("treats an empty commit as available with zero changes", () => {
    const seeded = seedReviewRun(home);
    git(seeded.repo.repo, ["commit", "--allow-empty", "-m", "empty"]);
    freeze(seeded.repo, git(seeded.repo.repo, ["rev-parse", "HEAD"]));
    expect(reviewComparison(RUN_ID, "last-commit")).toMatchObject({
      availability: "available",
      fromSha: seeded.repo.headSha,
      files: [],
      totals: { files: 0, hunks: 0, additions: 0, deletions: 0 },
    });
  });

  it("reads the parent of an empty commit with a 70 KB message without reporting it missing", () => {
    const seeded = seedReviewRun(home);
    const message = join(home, "long-message.txt");
    writeFileSync(message, "m".repeat(70 * 1024));
    git(seeded.repo.repo, ["commit", "--allow-empty", "-F", message]);
    const frozen = freeze(seeded.repo, git(seeded.repo.repo, ["rev-parse", "HEAD"]));
    expect(Number(git(seeded.repo.repo, ["cat-file", "-s", frozen.repo.headSha]))).toBeGreaterThan(
      70 * 1024,
    );
    expect(reviewComparison(RUN_ID, "last-commit")).toMatchObject({
      availability: "available",
      fromSha: seeded.repo.headSha,
      toSha: frozen.repo.headSha,
      files: [],
      totals: { files: 0, hunks: 0, additions: 0, deletions: 0 },
    });
  });

  it("ignores Git replacement refs", () => {
    const seeded = seedReviewRun(home);
    const before = reviewComparison(RUN_ID, "last-commit");
    git(seeded.repo.repo, ["replace", seeded.repo.headSha, seeded.repo.baseSha]);
    expect(reviewComparison(RUN_ID, "last-commit")).toEqual(before);
  });

  it("returns an explicit unavailable result for a root commit", () => {
    const seeded = seedReviewRun(home);
    freeze(seeded.repo, seeded.repo.baseSha);
    expect(reviewComparison(RUN_ID, "last-commit")).toMatchObject({
      availability: "unavailable",
      fromSha: null,
      toSha: seeded.repo.baseSha,
      reason: "parent_missing",
      files: [],
    });
  });

  it("reports a shallow clone's missing parent without fetching history", () => {
    const seeded = seedReviewRun(home);
    const shallow = join(home, "shallow");
    git(home, ["clone", "--depth=1", `file://${seeded.repo.repo}`, shallow]);
    seedReviewRun(home, { repo: { ...seeded.repo, repo: shallow } });
    expect(reviewComparison(RUN_ID, "last-commit")).toMatchObject({
      availability: "unavailable",
      fromSha: seeded.repo.baseSha,
      reason: "parent_missing",
    });
    expect(git(shallow, ["rev-parse", "--is-shallow-repository"])).toBe("true");
  });

  it("reports missing repositories and commits while keeping the full artifact usable", () => {
    const seeded = seedReviewRun(home);
    renameSync(seeded.repo.repo, `${seeded.repo.repo}-moved`);
    expect(reviewComparison(RUN_ID, "last-commit").reason).toBe("repository_missing");
    expect(reviewComparison(RUN_ID, "full").availability).toBe("available");
    renameSync(`${seeded.repo.repo}-moved`, seeded.repo.repo);
    seedReviewRun(home, { repo: { ...seeded.repo, headSha: "f".repeat(40) } });
    expect(reviewComparison(RUN_ID, "last-commit")).toMatchObject({
      reason: "commit_missing",
      availability: "unavailable",
      toSha: "f".repeat(40),
    });
  });

  it("reports missing full diff and rejects corrupt artifacts rather than substituting Git diff", () => {
    const seeded = seedReviewRun(home);
    const artifact = join(seeded.runDir, "review-context.diff");
    renameSync(artifact, `${artifact}.saved`);
    expect(reviewComparison(RUN_ID, "full")).toMatchObject({
      availability: "unavailable",
      reason: "diff_unavailable",
    });
    expect(reviewComparison(RUN_ID, "last-commit").availability).toBe("available");
    writeFileSync(artifact, "CORRUPTED_DIFF");
    expect(() => reviewComparison(RUN_ID, "full")).toThrow(/hash mismatch/);
  });

  it("requires a session, validates modes, and returns comparison through the existing HTTP envelope", async () => {
    const seeded = seedReviewRun(home);
    host = await createExplainerHttpHost({ home });
    const url = `${host.baseUrl}${ROUTES.workspace(RUN_ID)}/comparison`;
    expect((await fetch(`${url}?mode=last-commit`)).status).toBe(401);
    expect((await fetch(`${url}?mode=HEAD`, { headers: host.headers() })).status).toBe(400);
    const response = await fetch(`${url}?mode=last-commit`, { headers: host.headers() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: ReviewComparison };
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      mode: "last-commit",
      fromSha: seeded.repo.baseSha,
      toSha: seeded.repo.headSha,
      availability: "available",
    });
    const full = await fetch(url, { headers: host.headers() });
    const fullBody = (await full.json()) as { data: ReviewComparison };
    expect(fullBody.data.mode).toBe("full");
  });
});
