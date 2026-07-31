/**
 * Unit tests for the review report renderer (plan §测试 / §"报告重排"). Covers the
 * attempts summary table, the section ordering (table → five chapters → 过程对比
 * → 附录), fence-aware ATX heading demotion, proxy-prefix stripping with
 * adjacent ×N run-length encoding, and the transient-retry appendix mark.
 */
import { describe, expect, it } from "vitest";
import { type ReviewReportInput, renderReviewReport } from "../src/auto/aggregate";
import type { AttemptResult } from "../src/auto/runner";

function attempt(partial: Partial<AttemptResult> & { agentName: string }): AttemptResult {
  return {
    attemptId: partial.attemptId ?? "attempt-0",
    agentId: partial.agentId ?? "a",
    agentName: partial.agentName,
    driverId: partial.driverId ?? "claude-stream-json",
    modelId: partial.modelId ?? "m",
    status: partial.status ?? "success",
    output: partial.output ?? "",
    exitCode: partial.exitCode ?? 0,
    durationMs: partial.durationMs ?? 0,
    workspace: partial.workspace ?? "/ws",
    failure: partial.failure,
    activity: partial.activity,
    reused: partial.reused,
    attemptNumber: partial.attemptNumber,
    retryOf: partial.retryOf,
  };
}

const AGGREGATOR_BODY = [
  "## 概览",
  "summary",
  "## 共识发现",
  "- shared",
  "## 独有发现",
  "- unique",
  "## 分歧",
  "none",
  "## 结论",
  "approve",
].join("\n");

function buildInput(
  attempts: AttemptResult[],
  overrides: Partial<ReviewReportInput> = {},
): ReviewReportInput {
  return {
    runId: "ck-review-test",
    startedAt: "2026-07-31T00:00:00.000Z",
    endedAt: "2026-07-31T00:05:00.000Z",
    task: { pr: "https://github.com/a/b/pull/1" },
    attempts,
    aggregator: {
      attemptId: "aggregator",
      agentId: "agg",
      agentName: "Agg",
      driverId: "claude-stream-json",
      modelId: "m",
    },
    aggregation: attempt({ agentName: "Agg", output: AGGREGATOR_BODY }),
    status: "completed",
    incomplete: false,
    ...overrides,
  };
}

describe("cli auto aggregate — attempts table", () => {
  it("renders the fixed five-column header", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({
          agentName: "Alice",
          durationMs: 48_000,
          activity: { toolCalls: 3, commands: [] },
        }),
      ]),
    );
    expect(md).toContain("| Attempt | Driver/Model | 结果 | 耗时 | 工具调用 |");
    expect(md).toContain("| Alice | claude-stream-json/m | ok | 48s | 3 |");
  });

  it("shows 无过程数据 in the 工具调用 column when activity is absent", () => {
    const md = renderReviewReport(buildInput([attempt({ agentName: "Bob", activity: undefined })]));
    expect(md).toContain("| Bob | claude-stream-json/m | ok | 0s | 无过程数据 |");
  });

  it("formats 耗时 via formatDurationMs and shows failed:code for failures", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({
          agentName: "A",
          status: "failure",
          exitCode: 1,
          durationMs: 1_250_000,
          failure: { code: "EXIT", message: "non-zero exit 1" },
          activity: { toolCalls: 0, commands: [] },
        }),
      ]),
    );
    expect(md).toContain("| A | claude-stream-json/m | failed:EXIT | 20m50s | 0 |");
  });
});

describe("cli auto aggregate — section ordering", () => {
  it("renders table → five chapters → 过程对比 → 附录:各审查者交付物", () => {
    const md = renderReviewReport(
      buildInput([attempt({ agentName: "Alice", output: "## 发现\n- x" })]),
    );
    const tableIdx = md.indexOf("| Attempt | Driver/Model");
    const bodyIdx = md.indexOf("## 概览");
    const procIdx = md.indexOf("## 过程对比");
    const appIdx = md.indexOf("## 附录:各审查者交付物");
    expect(tableIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(tableIdx);
    expect(procIdx).toBeGreaterThan(bodyIdx);
    expect(appIdx).toBeGreaterThan(procIdx);
    expect(md).toContain("## 共识发现");
    expect(md).toContain("## 结论");
  });
});

describe("cli auto aggregate — fence-aware heading demotion", () => {
  it("demotes ATX H1–H6 by two levels outside a fence", () => {
    const output = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\nbody under the headings";
    const md = renderReviewReport(buildInput([attempt({ agentName: "Alice", output })]));
    const appendix = md.slice(md.indexOf("## 附录:各审查者交付物"));
    // H1→### H1 … H6→######## H6 (two hashes added, under the `### Alice` heading).
    expect(appendix).toContain("### H1\n");
    expect(appendix).toContain("#### H2\n");
    expect(appendix).toContain("##### H3\n");
    expect(appendix).toContain("###### H4\n");
    expect(appendix).toContain("####### H5\n");
    expect(appendix).toContain("######## H6\n");
  });

  it("leaves `#` inside a backtick fence untouched", () => {
    const output = "# Outside\n```\n# not demoted\n## also inside\n```\n# After";
    const md = renderReviewReport(buildInput([attempt({ agentName: "Alice", output })]));
    const appendix = md.slice(md.indexOf("### Alice"));
    expect(appendix).toContain("### Outside\n");
    expect(appendix).toContain("\n# not demoted\n");
    expect(appendix).toContain("\n## also inside\n");
    expect(appendix).toContain("### After");
  });

  it("leaves `#` inside a tilde fence untouched", () => {
    const output = "# Outside\n~~~bash\n# inside tildes\n~~~\n# After";
    const md = renderReviewReport(buildInput([attempt({ agentName: "Alice", output })]));
    const appendix = md.slice(md.indexOf("### Alice"));
    expect(appendix).toContain("\n# inside tildes\n");
    expect(appendix).toContain("### After");
  });

  it("does not process Setext headings (left verbatim)", () => {
    const output = "A title\n======\n\nA section\n------\n";
    const md = renderReviewReport(buildInput([attempt({ agentName: "Alice", output })]));
    const appendix = md.slice(md.indexOf("### Alice"));
    expect(appendix).toContain("A title\n======");
    expect(appendix).toContain("A section\n------");
    // No `##` prefix was added before "A title".
    expect(appendix).not.toContain("##A title");
    expect(appendix).not.toContain("## A title");
  });
});

describe("cli auto aggregate — process comparison command normalization", () => {
  it("strips the proxy env prefix and run-length encodes adjacent dupes as ×N", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({
          agentName: "Alice",
          activity: {
            toolCalls: 5,
            commands: [
              "NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY='' git diff",
              "NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY='' git diff",
              "NO_PROXY='*' HTTPS_PROXY='' HTTP_PROXY='' git diff",
              "ls -la",
            ],
          },
        }),
      ]),
    );
    const proc = md.slice(md.indexOf("## 过程对比"), md.indexOf("## 附录:各审查者交付物"));
    expect(proc).toContain("已省略命令前的 NO_PROXY/HTTPS_PROXY/HTTP_PROXY 等代理前缀");
    expect(proc).toContain("`git diff ×3`");
    expect(proc).toContain("`ls -la`");
    // The raw proxy prefix never reaches the report.
    expect(proc).not.toContain("NO_PROXY='*'");
  });

  it("does NOT merge non-adjacent duplicates", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({
          agentName: "Alice",
          activity: { toolCalls: 3, commands: ["git diff", "ls", "git diff"] },
        }),
      ]),
    );
    const proc = md.slice(md.indexOf("## 过程对比"), md.indexOf("## 附录:各审查者交付物"));
    expect(proc).not.toContain("git diff ×2");
    // Both occurrences are kept as separate command lines.
    const matches = proc.match(/`git diff`/g);
    expect(matches).toHaveLength(2);
  });

  it("omits the proxy note when no command carried a proxy prefix", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({ agentName: "Alice", activity: { toolCalls: 1, commands: ["make test"] } }),
      ]),
    );
    const proc = md.slice(md.indexOf("## 过程对比"), md.indexOf("## 附录:各审查者交付物"));
    expect(proc).not.toContain("已省略命令前的");
  });
});

describe("cli auto aggregate — transient retry mark", () => {
  it("marks a retried attempt in the appendix and keeps only the final result", () => {
    const md = renderReviewReport(
      buildInput([
        attempt({ agentName: "Alice", output: "## 发现\n- x", attemptNumber: 2, retryOf: 1 }),
      ]),
    );
    const appendix = md.slice(md.indexOf("### Alice"));
    expect(appendix).toContain("第 1 次尝试（失败，已重试）");
  });

  it("does not mark a non-retried attempt", () => {
    const md = renderReviewReport(
      buildInput([attempt({ agentName: "Alice", output: "## 发现\n- x", attemptNumber: 1 })]),
    );
    const appendix = md.slice(md.indexOf("### Alice"));
    expect(appendix).not.toContain("第 1 次尝试");
  });
});
