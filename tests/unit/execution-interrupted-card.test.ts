import { ExecutionInterruptedCard } from "@/components/report/ExecutionInterruptedCard";
import { formatReReviewStartError } from "@/components/report/FixPipeline";
import { OverviewView } from "@/components/report/workbench/OverviewView";
import { RuntimeClientError } from "@/runtime/client";
import {
  EXECUTION_SERVICE_INTERRUPTION,
  RE_REVIEW_STARTING_LABEL,
  reReviewStartFailure,
  specOriginalMissingDetail,
  specOriginalMissingLine,
  specOriginalMissingLineFrom,
} from "@shared/runtime/interruption-copy";
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

  it("puts the start-failure line immediately after the primary button and disables it while starting", () => {
    const failure = reReviewStartFailure("上一次审查还在运行");
    const html = render(
      createElement(ExecutionInterruptedCard, {
        heading: "h2",
        busy: true,
        error: failure,
        onReReview: () => {},
      }),
    );
    const button = new RegExp(`<button\\b[^>]*>${RE_REVIEW_STARTING_LABEL}</button>`).exec(html);
    expect(button?.[0]).toContain("disabled");
    const rest = html.slice((button?.index ?? 0) + (button?.[0].length ?? 0)).trimStart();
    expect(rest.startsWith('<p class="ck-action-error" role="alert">')).toBe(true);
    expect(rest.indexOf(failure)).toBeLessThan(
      rest.indexOf(EXECUTION_SERVICE_INTERRUPTION.secondaryAction),
    );
    expect(html).toContain(failure);
    expect(html).not.toContain("<details");
  });

  it("puts the missing-spec sentence under the button and the raw error inside 详情", () => {
    const stored = "../rs-spec.md";
    const failure = specOriginalMissingLine(stored);
    const detail = specOriginalMissingDetail(
      { detail: { raw: `SPEC_ORIGINAL_UNPROVEN: relative spec "${stored}" has no recorded cwd` } },
      failure,
    );
    const html = render(
      createElement(ExecutionInterruptedCard, {
        heading: "h1",
        busy: false,
        error: failure,
        errorDetail: detail,
        onReReview: () => {},
      }),
    );
    const button = new RegExp(
      `<button\\b[^>]*>${EXECUTION_SERVICE_INTERRUPTION.primaryAction}</button>`,
    ).exec(html);
    const rest = html.slice((button?.index ?? 0) + (button?.[0].length ?? 0)).trimStart();
    expect(rest.startsWith('<p class="ck-action-error" role="alert">')).toBe(true);
    expect(rest.indexOf(failure)).toBeLessThan(rest.indexOf("<details"));
    expect(rest.indexOf("<summary>详情</summary>")).toBeLessThan(
      rest.indexOf(EXECUTION_SERVICE_INTERRUPTION.secondaryAction),
    );
    expect(html).toContain(failure);
    expect(html).not.toContain("可以再试一次");
    expect(html.slice(html.indexOf('role="alert"'), html.indexOf("<details"))).not.toContain(
      "DRIVER_SPAWN_FAILED",
    );
    expect(html).toContain("DRIVER_SPAWN_FAILED");
    expect(html).toContain("SPEC_ORIGINAL_UNPROVEN");
  });
});

describe("missing original spec copy", () => {
  it("keeps the sentence when a log tail wraps it, and hides the raw code from the alert", () => {
    const stored = "docs/plans/ck-legacy-plan.md";
    const sentence = specOriginalMissingLine(stored);
    const log = `error[2]: ${sentence}\n  detail: ${JSON.stringify({
      code: "SPEC_ORIGINAL_UNPROVEN",
      raw: `SPEC_ORIGINAL_UNPROVEN: relative spec "${stored}" has no recorded cwd`,
      spec: stored,
    })}`;
    expect(specOriginalMissingLineFrom(log)).toBe(sentence);
    expect(sentence).not.toContain("可以再试一次");
    expect(sentence).not.toContain("DRIVER_SPAWN_FAILED");
    expect(sentence).not.toContain("SPEC_VERIFY_UNBOUND");
    const detail = specOriginalMissingDetail(new Error(log), log);
    expect(detail).toContain("DRIVER_SPAWN_FAILED");
    expect(detail).toContain("SPEC_ORIGINAL_UNPROVEN: relative spec");
    expect(detail.startsWith("DRIVER_SPAWN_FAILED\n")).toBe(true);
    const shown = formatReReviewStartError(
      new RuntimeClientError(500, "DRIVER_SPAWN_FAILED", log, detail),
    );
    expect(shown).toBe(sentence);
    expect(shown).not.toContain("可以再试一次");
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
