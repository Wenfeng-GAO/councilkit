import {
  branchesFromAntCodePrShow,
  branchesFromGhPrView,
  mergeRepairBranchHints,
  uniqueFeatureWorktreeBranch,
} from "@shared/runtime/pr-inspect";
import { describe, expect, it } from "vitest";

describe("PR branch parsers", () => {
  it("reads GitHub head and base refs", () => {
    expect(
      branchesFromGhPrView({
        headRefName: "hengzhuo/fix/session-replay-performance",
        baseRefName: "sprint_independent-pre_S090011901586_20260911",
      }),
    ).toEqual({
      sourceBranch: "hengzhuo/fix/session-replay-performance",
      base: "sprint_independent-pre_S090011901586_20260911",
    });
  });

  it("reads AntCode source_branch and target_branch", () => {
    expect(
      branchesFromAntCodePrShow({
        source_branch: "feat/live",
        target_branch: "master",
      }),
    ).toEqual({ sourceBranch: "feat/live", base: "master" });
  });
});

describe("uniqueFeatureWorktreeBranch", () => {
  it("returns the only named feature worktree", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/feat",
      "HEAD def",
      "branch refs/heads/feat/foo",
      "",
    ].join("\n");
    expect(uniqueFeatureWorktreeBranch(porcelain)).toBe("feat/foo");
  });

  it("returns null when several feature worktrees exist", () => {
    const porcelain = [
      "worktree /repo/.codex/a",
      "HEAD abc",
      "branch refs/heads/hengzhuo/fix/a",
      "",
      "worktree /repo/.worktrees/b",
      "HEAD def",
      "branch refs/heads/hengzhuo/fix/b",
      "",
    ].join("\n");
    expect(uniqueFeatureWorktreeBranch(porcelain)).toBeNull();
  });

  it("ignores detached, sprint, and squad worktrees", () => {
    const porcelain = [
      "worktree /repo/workspaces/attempt-0",
      "HEAD abc",
      "detached",
      "",
      "worktree /repo/.worktrees/squad",
      "HEAD abc",
      "branch refs/heads/squad/20260920-pr413",
      "",
      "worktree /repo",
      "HEAD def",
      "branch refs/heads/sprint_independent-pre_S090011901586_20260911",
      "",
    ].join("\n");
    expect(uniqueFeatureWorktreeBranch(porcelain)).toBeNull();
  });
});

describe("mergeRepairBranchHints", () => {
  it("prefers live PR inspect over frozen review context", () => {
    expect(
      mergeRepairBranchHints([
        { sourceBranch: "feat-live", base: "master", source: "pr" },
        { sourceBranch: "feat-old", base: "main", source: "review" },
      ]),
    ).toEqual({ sourceBranch: "feat-live", base: "master", hintSource: "pr" });
  });

  it("fills missing inspect fields from frozen context", () => {
    expect(
      mergeRepairBranchHints([
        { sourceBranch: null, base: null, source: "pr" },
        { sourceBranch: "feat-x", base: "main", source: "review" },
      ]),
    ).toEqual({ sourceBranch: "feat-x", base: "main", hintSource: "review" });
  });
});
