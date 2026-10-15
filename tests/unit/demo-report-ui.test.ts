/**
 * Sample-report chrome. renderToStaticMarkup matches the existing header tests.
 * A full workbench mount needs the app jsdom harness; the banner and the hidden
 * repair cards are the DM-02 / DM-06 surfaces covered here.
 */
import { FixPipeline } from "@/components/report/FixPipeline";
import { RepairExportCard } from "@/components/report/RepairExportCard";
import { RepairRunPanel } from "@/components/report/RepairRunPanel";
import { ReviewRunHeader } from "@/components/report/ReviewRunHeader";
import { SquadHandoffCard } from "@/components/report/SquadHandoffCard";
import { cliRunDetailResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const DEMO_ID = "ck-review-demo-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9";

function detail(overrides: Record<string, unknown> = {}) {
  return cliRunDetailResponseSchema.parse({
    runId: DEMO_ID,
    kind: "review",
    status: "completed",
    title: "示例 PR：给登录接口加限流",
    startedAt: "2026-10-15T00:00:00.000Z",
    endedAt: "2026-10-15T00:01:00.000Z",
    hasReport: true,
    reportUrl: `http://127.0.0.1:43127/reports/${DEMO_ID}`,
    markdown: "# 示例\n",
    truncated: false,
    progress: { phase: "done", attempts: [], updatedAt: "2026-10-15T00:01:00.000Z" },
    ...overrides,
  });
}

describe("DM-02 demo report banner", () => {
  it("shows the amber sample tag and the locked banner copy", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewRunHeader, { run: detail({ demo: true }), verdict: null }),
    );
    expect(html).toContain("◆ 示例数据");
    // Designer (#295): Chinese UI shows only Chinese copy.
    expect(html).not.toContain("Sample data");
    expect(html).not.toContain("Sample report");
    expect(html).toContain(
      "<strong>这是示例报告。</strong>内容由内置示例 AI 生成，不代表真实模型的判断，也没有读取你的代码。",
    );
    expect(html).toContain("🔒 只读审查");
  });

  it("CMP-D1: the CTA only opens the Settings tool list", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewRunHeader, { run: detail({ demo: true }), verdict: null }),
    );
    expect(html).toMatch(
      /<a class="ck-demo-banner-cta" href="\/settings">接入真实 AI，审我自己的 PR →<\/a>/,
    );
  });

  it("leaves the banner off a real review", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewRunHeader, { run: detail({ demo: false }), verdict: null }),
    );
    expect(html).not.toContain("◆ 示例数据");
    expect(html).not.toContain("Sample data");
  });
});

describe("DM-06 demo reports hide fix, export, and Squad repair", () => {
  it("renders nothing for a demo run and keeps the controls for a real run", () => {
    const demo = detail({ demo: true });
    const real = detail({ demo: false });
    const squad = detail({
      demo: true,
      kind: "squad",
      runId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
    });
    const realSquad = detail({
      demo: false,
      kind: "squad",
      runId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4",
    });

    expect(
      renderToStaticMarkup(
        createElement(FixPipeline, {
          run: demo,
          busy: false,
          pendingAction: null,
          error: null,
          onFix: () => {},
          onReReview: () => {},
        }),
      ),
    ).toBe("");
    expect(renderToStaticMarkup(createElement(RepairExportCard, { run: demo }))).toBe("");
    expect(renderToStaticMarkup(createElement(RepairRunPanel, { run: demo }))).toBe("");
    expect(renderToStaticMarkup(createElement(SquadHandoffCard, { run: squad }))).toBe("");

    expect(
      renderToStaticMarkup(
        createElement(FixPipeline, {
          run: real,
          busy: false,
          pendingAction: null,
          error: null,
          onFix: () => {},
          onReReview: () => {},
        }),
      ),
    ).toContain("修复闭环");
    expect(renderToStaticMarkup(createElement(RepairExportCard, { run: real }))).toContain(
      "高级：手工导出任务包",
    );
    expect(renderToStaticMarkup(createElement(RepairRunPanel, { run: real }))).toContain(
      "Squad 自动修复",
    );
    expect(renderToStaticMarkup(createElement(SquadHandoffCard, { run: realSquad }))).toContain(
      "班组",
    );
  });
});

describe("#295 designer: blocking rule folded in the sample report", () => {
  const majorOpen = (id: string) => ({
    id,
    severity: "major",
    status: "open",
    title: `示例发现 ${id}`,
    text: "示例正文",
    source: "consensus",
    reviewer: "示例 AI",
    files: ["internal/auth/login_limiter.go"],
  });

  it("sample report: one collapsed line 「阻塞是怎么判的 ▸」", async () => {
    const { FindingLedger } = await import("@/components/report/FindingLedger");
    const html = renderToStaticMarkup(
      createElement(FindingLedger, {
        run: detail({ demo: true, findings: [majorOpen("demo-a"), majorOpen("demo-b")] }),
      }),
    );
    expect(html).toMatch(
      /<details class="ck-finding-list-note ck-blocking-rule"><summary>阻塞是怎么判的 ▸<\/summary>/,
    );
    expect(html).not.toMatch(/<details[^>]* open/);
  });

  it("real report keeps the rule text inline", async () => {
    const { FindingLedger } = await import("@/components/report/FindingLedger");
    const html = renderToStaticMarkup(
      createElement(FindingLedger, {
        run: detail({ findings: [majorOpen("real-a")] }),
      }),
    );
    expect(html).not.toContain("阻塞是怎么判的");
    expect(html).toContain("阻塞依据（规格合同减法）");
  });
});
