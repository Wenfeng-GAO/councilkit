import { buildFixFromReviewPrompt, buildReviewResumeCommand, extractPrUrl } from "@/lib/fix-prompt";
import { describe, expect, it } from "vitest";

describe("buildReviewResumeCommand without a PR", () => {
  it("omits the URL when no text contains one", () => {
    expect(extractPrUrl(undefined, "", "no link here")).toBeNull();
    expect(buildReviewResumeCommand("ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1")).toBe(
      "councilkit review --resume ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
    );
  });
});

describe("buildFixFromReviewPrompt host hints", () => {
  it("uses the comment verdict, discuss framing, and the missing-PR sentence", () => {
    const prompt = buildFixFromReviewPrompt({
      markdown: "# Autonomous Review Report\n\nno url\n",
      title: "discussion notes",
      kind: "discuss",
      truncated: false,
      verdict: "comment",
    });
    expect(prompt).toContain("8. 裁决是 comment：只落实有复现路径的问题，不要把讨论项当成必须改。");
    expect(prompt).toContain(
      "报告里没有可解析的 PR URL。请在当前仓库找到对应的已打开 PR / 源分支，改完后更新那一条。",
    );
    expect(prompt).toContain(
      "这是讨论报告，不是并行审查。按「建议 / 后续行动」落地，不要把发言分歧当成必须全改。",
    );
    expect(prompt).toContain(
      "----- BEGIN REVIEW REPORT -----\n# Autonomous Review Report\n\nno url\n----- END REVIEW REPORT -----",
    );
  });

  it("prints GitHub gh commands for a github.com pull URL", () => {
    const prompt = buildFixFromReviewPrompt({
      markdown: "see https://github.com/acme/repo/pull/9",
      title: "review",
      kind: "review",
      truncated: false,
      verdict: "changes-requested",
    });
    expect(prompt).toContain("这是 GitHub PR。");
    expect(prompt).toContain("查看：`gh pr view 'https://github.com/acme/repo/pull/9'`");
    expect(prompt).toContain("差异：`gh pr diff 'https://github.com/acme/repo/pull/9'`");
    expect(prompt).toContain(
      "评论：`gh pr comment 'https://github.com/acme/repo/pull/9' --body \"...\"`",
    );
  });

  it("falls back to the generic AntCode spec when the path is not a numeric PR", () => {
    const prompt = buildFixFromReviewPrompt({
      markdown: "https://code.alipay.com/org/repo/pull_requests/nope",
      title: "review",
      kind: "review",
      truncated: false,
    });
    expect(prompt).toContain("查看：`antcode pr show <iid> -P <group/project> --no-pager`");
    expect(prompt).toContain("差异：`antcode pr diff <iid> -P <group/project> --no-pager`");
  });

  it("uses the repository CLI hint for a non-AntCode non-GitHub URL", () => {
    const prompt = buildFixFromReviewPrompt({
      markdown: "https://gitlab.com/acme/repo/pull/3",
      title: "review",
      kind: "review",
      truncated: false,
    });
    expect(prompt).toContain("用该仓库惯用的 CLI 查看 diff、推送源分支并在 PR 里评论。");
  });

  it("uses the short CLI hint when the matched URL cannot be parsed", () => {
    const prompt = buildFixFromReviewPrompt({
      markdown: "see https://[",
      title: "review",
      kind: "review",
      truncated: false,
    });
    expect(prompt).toContain("https://[");
    expect(prompt).toContain("用该仓库惯用的 CLI 查看 diff 并评论。");
  });
});
