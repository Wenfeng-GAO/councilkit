import { LiveReviewProgress } from "@/components/report/LiveReviewProgress";
import { ReviewRunHeader } from "@/components/report/ReviewRunHeader";
import { cliRunDetailResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

function reviewRun(overrides: Record<string, unknown> = {}) {
  return cliRunDetailResponseSchema.parse({
    runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
    kind: "review",
    status: "running",
    title: "https://github.com/acme/repo/pull/7",
    startedAt: "2026-09-20T00:00:00.000Z",
    endedAt: null,
    hasReport: true,
    reportUrl: "/reports/x",
    markdown: "# Autonomous Review Report\n\n---\n\n## 结论\n\nchanges-requested\n",
    truncated: false,
    pipeline: {
      phase: "planning",
      round: 0,
      maxRounds: 2,
      planVerdict: null,
      applyStatus: "pending",
      followUpRunId: null,
      summary: null,
      updatedAt: "2026-09-20T00:10:00.000Z",
    },
    progress: {
      phase: "planning",
      updatedAt: "2026-09-20T00:10:00.000Z",
      attempts: [
        {
          attemptId: "attempt-0",
          agentName: "review-security",
          driverId: "claude-stream-json",
          modelId: "antchat/GLM-5.2[1m]",
          role: "attempt",
          status: "success",
          durationMs: 90_000,
          lastActivity: null,
          result: {
            parseStatus: "parsed",
            summary: "鉴权绕过仍可复现",
            findingCount: 2,
            blockingCount: 1,
          },
        },
        {
          attemptId: "attempt-1",
          agentName: "review-correctness",
          driverId: "kimi-stream-json",
          modelId: "kimi-code/k3",
          role: "attempt",
          status: "success",
          durationMs: 80_000,
          lastActivity: null,
          result: {
            parseStatus: "unparsed",
            summary: "still writing",
            findingCount: null,
            blockingCount: null,
          },
        },
        {
          attemptId: "aggregator",
          agentName: "review-adversarial",
          driverId: "grok-stream-json",
          modelId: "grok-4.6",
          role: "aggregator",
          status: "success",
          durationMs: 20_000,
          lastActivity: null,
        },
      ],
    },
    ...overrides,
  });
}

describe("LiveReviewProgress review seats", () => {
  it("separates execution complete from a pass, and prefers results", () => {
    const html = renderToStaticMarkup(
      createElement(LiveReviewProgress, { run: reviewRun(), onInspect: () => undefined }),
    );
    expect(html).toContain("本轮审查结果");
    expect(html).toContain("执行完成");
    expect(html).not.toMatch(/审查通过/);
    expect(html).toContain("查看结果");
    expect(html).toContain('aria-label="查看结果：安全审查"');
    expect(html).toContain("2 项发现");
    expect(html).toContain("结果待解析");
    expect(html).not.toContain("执行已完成，查看过程与交付物");
  });

  it("marks a finished seat as an independent opinion before aggregation", () => {
    const run = reviewRun();
    const aggregator = run.progress?.attempts.find((row) => row.role === "aggregator");
    if (aggregator) aggregator.status = "pending";
    const html = renderToStaticMarkup(
      createElement(LiveReviewProgress, { run, onInspect: () => undefined }),
    );
    expect(html).toContain("独立意见");
  });
});

describe("ReviewRunHeader dual status", () => {
  it("keeps review conclusions visible while a repair is in flight", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewRunHeader, { run: reviewRun(), verdict: "changes-requested" }),
    );
    expect(html).toContain("本轮审查结果");
    expect(html).toContain("需要修改");
    expect(html).toContain("当前修复进展");
    expect(html).toContain("正在起草修复方案");
  });
});
