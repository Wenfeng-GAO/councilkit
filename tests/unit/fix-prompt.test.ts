import { buildFixFromReviewPrompt, buildReviewResumeCommand, extractPrUrl } from "@/lib/fix-prompt";
import { describe, expect, it } from "vitest";

describe("extractPrUrl", () => {
  it("picks an AntCode pull request URL out of task text", () => {
    expect(
      extractPrUrl("review PR https://code.alipay.com/paas-core/agentrun/pull_requests/126"),
    ).toBe("https://code.alipay.com/paas-core/agentrun/pull_requests/126");
  });

  it("strips a trailing period", () => {
    expect(extractPrUrl("see https://github.com/acme/repo/pull/3.")).toBe(
      "https://github.com/acme/repo/pull/3",
    );
  });
});

describe("buildReviewResumeCommand", () => {
  it("includes the PR URL and --resume", () => {
    expect(
      buildReviewResumeCommand(
        "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        "https://code.alipay.com/paas-core/agentrun/pull_requests/126",
      ),
    ).toBe(
      "councilkit review https://code.alipay.com/paas-core/agentrun/pull_requests/126 --resume ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
    );
  });
});

describe("buildFixFromReviewPrompt", () => {
  const markdown = [
    "# Autonomous Review Report",
    "",
    "- Task: review PR https://code.alipay.com/paas-core/agentrun/pull_requests/126",
    "",
    "## 结论",
    "",
    "changes-requested",
  ].join("\n");

  it("embeds the markdown report and tells the agent to update the same PR", () => {
    const prompt = buildFixFromReviewPrompt({
      markdown,
      title: "https://code.alipay.com/paas-core/agentrun/pull_requests/126",
      kind: "review",
      truncated: false,
      verdict: "changes-requested",
    });
    expect(prompt).toContain("----- BEGIN REVIEW REPORT -----");
    expect(prompt).toContain(markdown);
    expect(prompt).toContain("----- END REVIEW REPORT -----");
    expect(prompt).toContain("不要另开 PR");
    expect(prompt).toContain("https://code.alipay.com/paas-core/agentrun/pull_requests/126");
    expect(prompt).toContain("antcode pr diff 126 -P paas-core/agentrun");
    expect(prompt).toContain("必须处理完所有 critical / major");
  });

  it("notes truncation and approve-only follow-up", () => {
    const prompt = buildFixFromReviewPrompt({
      markdown: "# Autonomous Review Report\n",
      title: "fixture",
      kind: "review",
      truncated: true,
      verdict: "approve",
    });
    expect(prompt).toContain("截断");
    expect(prompt).toContain("不要空提交");
  });
});
