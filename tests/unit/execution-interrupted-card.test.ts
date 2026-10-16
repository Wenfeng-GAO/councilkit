import { ExecutionInterruptedCard } from "@/components/report/ExecutionInterruptedCard";
import { OverviewView } from "@/components/report/workbench/OverviewView";
import { EXECUTION_SERVICE_INTERRUPTION } from "@shared/runtime/interruption-copy";
import { cliRunDetailResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

function render(node: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, node));
}

describe("ExecutionInterruptedCard", () => {
  it("uses the shared copy and a solid primary action", () => {
    const html = render(
      createElement(ExecutionInterruptedCard, {
        heading: "h1",
        busy: false,
        onReReview: () => {},
      }),
    );
    expect(html).toContain(EXECUTION_SERVICE_INTERRUPTION.title);
    expect(html).toContain('data-interrupt-icon="circle-pause"');
    expect(html).toContain('data-interrupt-token="--ck-interrupt"');
    expect(html).not.toContain(`<h1>${EXECUTION_SERVICE_INTERRUPTION.title}</h1>`);
    expect(html).toContain(EXECUTION_SERVICE_INTERRUPTION.detail);
    expect(html).toContain(`data-variant="primary"`);
    expect(html).toContain(EXECUTION_SERVICE_INTERRUPTION.primaryAction);
    expect(html).toContain(`data-variant="ghost"`);
    expect(html).toContain(EXECUTION_SERVICE_INTERRUPTION.secondaryAction);
    expect(html).toContain('href="/reports"');
  });
});

describe("OverviewView interruption", () => {
  it("shows the interruption card instead of a running or failed heading", () => {
    const run = cliRunDetailResponseSchema.parse({
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4",
      kind: "review",
      status: "interrupted",
      title: "acme/payments #348",
      startedAt: "2026-10-16T11:00:00.000Z",
      endedAt: null,
      hasReport: false,
      reportUrl: "/reports/ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4",
      progress: null,
      markdown: "",
      truncated: false,
      findings: [
        {
          id: "pay-timeout",
          title: "支付回调超时后仍把订单标成已支付",
          text: "超时分支写了 paid。",
          severity: "major",
          status: "open",
          source: "consensus",
          reviewer: "review-security",
          files: ["src/pay.ts"],
        },
      ],
    });
    const html = render(
      createElement(OverviewView, {
        run,
        parsed: null,
        hasRepair: false,
        onOpenRepair: () => {},
        onReReview: () => {},
      }),
    );
    expect(html).toContain(EXECUTION_SERVICE_INTERRUPTION.title);
    expect(html).toContain(EXECUTION_SERVICE_INTERRUPTION.detail);
    expect(html).not.toContain("席位审查中");
    expect(html).not.toContain(">失败<");
    expect(html).toContain("超时分支写了 paid");
    expect(html).toContain("pay-timeout");
  });

  it("keeps 审查已完成 for a finished review", () => {
    const run = cliRunDetailResponseSchema.parse({
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee5",
      kind: "review",
      status: "completed",
      title: "acme/payments #351",
      startedAt: "2026-10-15T11:00:00.000Z",
      endedAt: "2026-10-15T11:20:00.000Z",
      hasReport: true,
      reportUrl: "/reports/ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee5",
      progress: null,
      markdown: "# Autonomous Review Report\n\n## 概览\n\n完成。\n",
      truncated: false,
      findings: [],
    });
    const html = render(
      createElement(OverviewView, {
        run,
        parsed: null,
        hasRepair: false,
        onOpenRepair: () => {},
      }),
    );
    expect(html).toContain("审查已完成");
    expect(html).not.toContain(EXECUTION_SERVICE_INTERRUPTION.title);
  });
});
