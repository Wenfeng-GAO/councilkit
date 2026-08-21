/**
 * Unit tests for the review prompt templates (plan §测试). Verifies the
 * three-section soft contract in the Attempt prompt and the five-section
 * aggregation directive, plus the boundary rules: failed Attempts are named as
 * absent only, and no workspace path is ever injected into the aggregate prompt.
 */
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { buildApplyPrompt } from "../src/auto/templates/apply";
import {
  buildPlanDraftPrompt,
  buildPlanReviewPrompt,
  extractConsensusPlan,
  extractVerdictToken,
  looksLikePlanDocument,
} from "../src/auto/templates/plan";
import {
  AGGREGATE_PROMPT_BUDGET,
  MAX_ATTEMPT_OUTPUT_IN_PROMPT,
  buildAccessHint,
  buildAggregatePrompt,
  buildAttemptPrompt,
  parseAntCodePrUrl,
  truncateForPrompt,
} from "../src/auto/templates/review";

describe("cli auto templates — attempt prompt", () => {
  const task = { pr: "https://example.com/pr/1" };

  it("contains the three-section soft contract (Chinese, English verdict token)", () => {
    const prompt = buildAttemptPrompt({ agentName: "A", personaPrompt: "be thorough", task });
    expect(prompt).toContain("## 发现");
    expect(prompt).toContain("## 验证");
    expect(prompt).toContain("## 结论");
    expect(prompt).toContain("approve | changes-requested | comment");
  });

  it("states the PR task and that the final message is the deliverable", () => {
    const prompt = buildAttemptPrompt({ agentName: "A", personaPrompt: "", task });
    expect(prompt).toContain("https://example.com/pr/1");
    expect(prompt).toMatch(/最终消息即交付物/);
  });

  it("injects a finding ledger for --against reviews", () => {
    const prompt = buildAttemptPrompt({
      agentName: "A",
      personaPrompt: "",
      task: {
        pr: "https://example.com/pr/1",
        against: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
        againstLedger: "open (1)\n- foo--bar [major] still open",
      },
    });
    expect(prompt).toContain("## Finding 账本");
    expect(prompt).toContain("foo--bar");
  });

  it("injects focus and council topic when provided", () => {
    const prompt = buildAttemptPrompt({
      agentName: "A",
      personaPrompt: "",
      task: { task: "do x", focus: "security", councilTopic: "auth redesign" },
    });
    expect(prompt).toContain("security");
    expect(prompt).toContain("auth redesign");
  });

  it("worktree mode tells the agent not to clone", () => {
    const prompt = buildAttemptPrompt({
      agentName: "A",
      personaPrompt: "",
      task: { pr: "https://github.com/acme/repo/pull/1" },
      workspaceMode: "worktree",
    });
    expect(prompt).toContain("隔离 git worktree");
    expect(prompt).toContain("不要再 clone");
    expect(prompt).not.toContain("空目录中完全自主工作");
  });

  it("uses --task free text when no --pr", () => {
    const prompt = buildAttemptPrompt({
      agentName: "A",
      personaPrompt: "",
      task: { task: "audit deps" },
    });
    expect(prompt).toContain("audit deps");
  });

  it("describes full autonomy (fetch/clone/checkout/test/lint)", () => {
    const prompt = buildAttemptPrompt({ agentName: "A", personaPrompt: "", task });
    expect(prompt).toMatch(/完全自主/);
    expect(prompt).toMatch(/fetch\/clone\/checkout/);
  });

  it("advises timing-aware targeted testing and diff-to-file before exploring", () => {
    const prompt = buildAttemptPrompt({ agentName: "A", personaPrompt: "", task });
    expect(prompt).toContain("全量 build 前先评估时长，优先定向测试。");
    expect(prompt).toContain(
      "先用 gh pr diff / antcode pr diff 落盘到文件再分段读取，避免盲目目录探索。",
    );
  });

  it("does NOT inject the diff-to-file hint in --task mode (no PR target)", () => {
    // Reviewer finding: the gh/antcode pr-diff-to-file guidance was injected
    // unconditionally, so a --task run with no PR target was still told to land
    // a PR diff first. It must only appear under --pr.
    const prompt = buildAttemptPrompt({
      agentName: "A",
      personaPrompt: "",
      task: { task: "audit the dependencies for known CVEs" },
    });
    expect(prompt).not.toContain("先用 gh pr diff / antcode pr diff 落盘到文件");
    // The general autonomy guidance is still present in --task mode.
    expect(prompt).toContain("全量 build 前先评估时长，优先定向测试。");
    expect(prompt).toContain("audit the dependencies for known CVEs");
  });
});

describe("cli auto templates — aggregate prompt", () => {
  const task = { pr: "https://example.com/pr/1" };

  it("contains the five aggregation sections (Chinese) and cites attempt names", () => {
    const prompt = buildAggregatePrompt({
      aggregatorName: "R",
      task,
      attempts: [
        { attemptId: "a", name: "A", status: "success", output: "## 发现\n- foo" },
        { attemptId: "b", name: "B", status: "success", output: "## 发现\n- bar" },
      ],
    });
    expect(prompt).toContain("## 概览");
    expect(prompt).toContain("## 共识发现");
    expect(prompt).toContain("## 独有发现");
    expect(prompt).toContain("## 分歧");
    expect(prompt).toContain("## 结论");
    // English-titled reviewer output is understood by semantics, not an error.
    expect(prompt).toContain("Findings/Verification/Verdict");
    expect(prompt).toContain("A");
    expect(prompt).toContain("B");
  });

  it("names failed attempts as absent and forbids citing them as consensus", () => {
    const prompt = buildAggregatePrompt({
      aggregatorName: "R",
      task,
      attempts: [
        { attemptId: "a", name: "A", status: "success", output: "ok" },
        { attemptId: "b", name: "Broken", status: "failure", output: "" },
      ],
    });
    expect(prompt).toContain("Broken");
    expect(prompt).toMatch(/不可作为共识来源/);
    // The failed attempt's empty output must not be embedded as a deliverable.
    expect(prompt).not.toContain("### Broken\n");
  });

  it("never embeds a workspace path", () => {
    const prompt = buildAggregatePrompt({
      aggregatorName: "R",
      task,
      attempts: [
        {
          attemptId: "a",
          name: "A",
          status: "success",
          output: "finding",
        },
      ],
    });
    // The directive forbids paths, but no actual path token may be injected.
    expect(prompt).not.toMatch(/\/workspaces\//);
    expect(prompt).not.toMatch(/runs\/ck-review-/);
  });

  it("truncates a single attempt's output to the prompt cap with a marker", () => {
    const big = "x".repeat(MAX_ATTEMPT_OUTPUT_IN_PROMPT + 500);
    const prompt = buildAggregatePrompt({
      aggregatorName: "R",
      task,
      attempts: [{ attemptId: "a", name: "A", status: "success", output: big }],
    });
    expect(prompt).toContain("[truncated at");
    // The full oversized output must not appear verbatim.
    expect(prompt).not.toContain(big);
  });

  it("truncateForPrompt passes short text through unchanged", () => {
    expect(truncateForPrompt("short")).toBe("short");
  });

  it("enforces a total byte budget by proportionally truncating large outputs", () => {
    const big = "x".repeat(MAX_ATTEMPT_OUTPUT_IN_PROMPT);
    const prompt = buildAggregatePrompt({
      aggregatorName: "R",
      task,
      attempts: [
        { attemptId: "a", name: "A", status: "success", output: big },
        { attemptId: "b", name: "B", status: "success", output: big },
        { attemptId: "c", name: "C", status: "success", output: big },
      ],
    });
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(AGGREGATE_PROMPT_BUDGET);
    // At least one retained output was shrunk (budget-driven, not just per-attempt cap).
    expect(prompt).toContain("[truncated at");
  });

  it("drops the oldest outputs (omitted) when the budget still cannot fit all", () => {
    const attempts = Array.from({ length: 400 }, (_, i) => ({
      attemptId: `a${i}`,
      name: `Agent${i}`,
      status: "success" as const,
      output: `${i}:`.padEnd(1024, "x"),
    }));
    const prompt = buildAggregatePrompt({ aggregatorName: "R", task, attempts });
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(AGGREGATE_PROMPT_BUDGET);
    expect(prompt).toContain("因聚合预算省略");
    // Oldest dropped from the deliverables section ...
    expect(prompt).not.toContain("### Agent0\n");
    // ... while the newest is retained as a deliverable.
    expect(prompt).toContain("### Agent399");
  });
});

describe("cli auto templates — access hint (P1-2)", () => {
  it("github.com PR URL → gh hint + proxy rule", () => {
    const hint = buildAccessHint("https://github.com/Wenfeng-GAO/councilkit/pull/1");
    expect(hint).not.toBeNull();
    expect(hint).toContain("gh pr diff 'https://github.com/Wenfeng-GAO/councilkit/pull/1'");
    expect(hint).toContain("gh pr view 'https://github.com/Wenfeng-GAO/councilkit/pull/1'");
    expect(hint).toContain("NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY=''");
    expect(hint).toContain("模型 API 调用不要改代理设置");
    expect(hint).toContain("建议先用 `gh pr diff` 把 diff 落盘到文件");
  });

  it("code.alipay.com PR URL → antcode hint with parsed project/iid + proxy rule", () => {
    const hint = buildAccessHint(
      "https://code.alipay.com/agent-sandbox/arcaagenttunnel/pull_requests/1443",
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("antcode pr diff 1443 -P agent-sandbox/arcaagenttunnel --no-pager");
    expect(hint).toContain("NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY=''");
    expect(hint).toContain("模型 API 调用不要改代理设置");
    expect(hint).toContain("建议先用 `antcode pr diff` 把 diff 落盘到文件");
  });

  it("parseAntCodePrUrl handles multi-level group/project paths", () => {
    const parsed = parseAntCodePrUrl(
      new URL("https://code.alipay.com/group/sub/team/project/pull_requests/42"),
    );
    expect(parsed).toEqual({ project: "group/sub/team/project", iid: "42" });
  });

  it("parseAntCodePrUrl rejects malformed paths and unsafe characters", () => {
    expect(parseAntCodePrUrl(new URL("https://code.alipay.com/pull_requests/42"))).toBeNull();
    expect(parseAntCodePrUrl(new URL("https://code.alipay.com/a/b/pull_requests/abc"))).toBeNull();
    expect(
      parseAntCodePrUrl(new URL("https://code.alipay.com/a/b/pull_requests/42/files")),
    ).toBeNull();
    expect(parseAntCodePrUrl(new URL("https://code.alipay.com/a;b/pull_requests/42"))).toBeNull();
  });

  it("other hosts, PR numbers and non-URLs → no hint", () => {
    expect(buildAccessHint("https://gitlab.com/a/b/merge_requests/1")).toBeNull();
    expect(buildAccessHint("1443")).toBeNull();
    expect(buildAccessHint("not a url at all")).toBeNull();
    expect(buildAccessHint(undefined)).toBeNull();
  });

  it("a URL containing a single quote → no hint (never an injectable shell command)", () => {
    expect(buildAccessHint("https://github.com/a/b/pull/1'$(rm -rf ~)")).toBeNull();
  });

  it("the attempt prompt embeds the hint; the aggregate prompt never does", () => {
    const task = { pr: "https://github.com/Wenfeng-GAO/councilkit/pull/1" };
    const attempt = buildAttemptPrompt({ agentName: "A", personaPrompt: "", task });
    expect(attempt).toContain("## 访问提示");
    expect(attempt).toContain("gh pr diff");
    const aggregate = buildAggregatePrompt({
      aggregatorName: "R",
      task,
      attempts: [{ attemptId: "a", name: "A", status: "success", output: "ok" }],
    });
    expect(aggregate).not.toContain("## 访问提示");
  });

  it("a non-URL --pr adds no hint to the attempt prompt", () => {
    const attempt = buildAttemptPrompt({ agentName: "A", personaPrompt: "", task: { pr: "1443" } });
    expect(attempt).not.toContain("## 访问提示");
  });
});

describe("cli auto templates — apply prompt", () => {
  it("asks the agent to commit locally and forbids PR comments / new PRs / push", () => {
    const prompt = buildApplyPrompt({
      agentName: "review-adversarial",
      prUrl: "https://github.com/acme/repo/pull/9",
      branch: "feat-x",
      reportFile: "COUNCILKIT-REVIEW.md",
    });
    expect(prompt).toContain("feat-x");
    expect(prompt).toContain("COUNCILKIT-REVIEW.md");
    expect(prompt).toContain("不要 `git push`");
    expect(prompt).toContain("不要在 PR 上发评论");
    expect(prompt).toContain("不要创建新 PR");
    expect(prompt).toContain("https://github.com/acme/repo/pull/9");
  });

  it("when a consensus plan is present, forbids extra mechanisms and follows 落地顺序", () => {
    const prompt = buildApplyPrompt({
      agentName: "review-adversarial",
      prUrl: "https://github.com/acme/repo/pull/9",
      branch: "feat-x",
      reportFile: "COUNCILKIT-REVIEW.md",
      planFile: "COUNCILKIT-PLAN.md",
    });
    expect(prompt).toContain("COUNCILKIT-PLAN.md");
    expect(prompt).toContain("落地顺序");
    expect(prompt).toContain("本轮不落地");
    expect(prompt).toContain("不要加方案没要求的重试、WaitGroup、新锁");
  });

  it("scopes an apply to one locked cluster", () => {
    const prompt = buildApplyPrompt({
      agentName: "review-adversarial",
      prUrl: "https://github.com/acme/repo/pull/9",
      branch: "feat-x",
      reportFile: "COUNCILKIT-REVIEW.md",
      planFile: "COUNCILKIT-PLAN.md",
      cluster: {
        id: "eventlog-short-write",
        files: ["pkg/eventlog/log.go"],
        closes: ["pkg.eventlog.log.go--torn-line"],
        gates: ["go test ./pkg/eventlog -run TestShortWrite"],
      },
    });
    expect(prompt).toContain("只落地集群 `eventlog-short-write`");
    expect(prompt).toContain("pkg/eventlog/log.go");
    expect(prompt).not.toContain("落地顺序");
  });
});

describe("cli auto templates — plan prompts", () => {
  it("draft prompt ranks delete / fail-closed over new locks", () => {
    const prompt = buildPlanDraftPrompt({
      agentName: "review-adversarial",
      prUrl: "https://github.com/acme/repo/pull/9",
      reportFile: "COUNCILKIT-REVIEW.md",
      round: 1,
    });
    expect(prompt).toContain("失败即停");
    expect(prompt).toContain("最后才");
    expect(prompt).toContain("## 落地顺序");
    expect(prompt).toContain("不要改业务代码");
  });

  it("plan-review prompt forbids re-reviewing the whole PR", () => {
    const prompt = buildPlanReviewPrompt({
      agentName: "review-correctness",
      personaPrompt: "找逻辑错误",
      prUrl: "https://github.com/acme/repo/pull/9",
      reportFile: "COUNCILKIT-REVIEW.md",
      planFile: "COUNCILKIT-PLAN.md",
    });
    expect(prompt).toContain("而不是重新审查整个 PR");
    expect(prompt).toContain("approve | changes-requested | comment");
    expect(prompt).toContain("找逻辑错误");
  });

  it("extracts the consensus plan and verdict from aggregator output", () => {
    const markdown = [
      "## 概览",
      "ok",
      "## 共识计划",
      "# 修复方案",
      "",
      "## 不变量",
      "1. jsonl never torn",
      "## 落地顺序",
      "### 集群 1: log",
      "## 结论",
      "approve",
    ].join("\n");
    expect(extractVerdictToken(markdown)).toBe("approve");
    expect(extractConsensusPlan(markdown)).toContain("jsonl never torn");
    expect(looksLikePlanDocument(extractConsensusPlan(markdown) ?? "")).toBe(true);
  });
});
