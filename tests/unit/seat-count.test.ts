import { ContextBar } from "@/components/report/workbench/ContextBar";
import { OverviewView } from "@/components/report/workbench/OverviewView";
import { SeatCount } from "@/components/report/workbench/SeatCount";
import { formatSeatCount } from "@/lib/seat-count";
import { cliRunDetailResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

function attempt(
  attemptId: string,
  status: "success" | "failure" | "cancelled" | "running",
  role: "attempt" | "aggregator" = "attempt",
) {
  return {
    attemptId,
    agentName: attemptId,
    driverId: "grok-stream-json",
    modelId: "grok-4.6",
    role,
    status,
    durationMs: 1000,
    lastActivity: null,
  };
}

function reviewRun(
  attempts: ReturnType<typeof attempt>[],
  status: "completed" | "running" | "failed" = "completed",
) {
  return cliRunDetailResponseSchema.parse({
    runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee5",
    kind: "review",
    status,
    title: "failover",
    startedAt: "2026-10-17T00:00:00.000Z",
    endedAt: "2026-10-17T00:01:00.000Z",
    hasReport: true,
    reportUrl: "/reports/ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee5",
    markdown: "# Autonomous Review Report\n\n---\n\n## 结论\n\napprove\n",
    truncated: false,
    progress: {
      phase: "done",
      updatedAt: "2026-10-17T00:01:00.000Z",
      attempts,
    },
  });
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

describe("formatSeatCount", () => {
  it("counts only successful seats and names failures and interruptions", () => {
    expect(formatSeatCount([attempt("a", "success"), attempt("b", "success")])).toBe(
      "2/2 席位成功",
    );
    expect(formatSeatCount([attempt("a", "success"), attempt("b", "failure")])).toBe(
      "1/2 席位成功 · 1 路失败",
    );
    expect(formatSeatCount([attempt("a", "failure"), attempt("b", "failure")])).toBe(
      "0/2 席位成功 · 2 路失败",
    );
    expect(formatSeatCount([attempt("a", "success"), attempt("b", "cancelled")])).toBe(
      "1/2 席位成功 · 1 路中断",
    );
    expect(
      formatSeatCount([
        attempt("a", "success"),
        attempt("b", "failure"),
        attempt("c", "cancelled"),
      ]),
    ).toBe("1/3 席位成功 · 1 路失败 · 1 路中断");
    expect(formatSeatCount([attempt("a", "success"), attempt("b", "failure", "aggregator")])).toBe(
      "1/1 席位成功",
    );
    expect(formatSeatCount([attempt("a", "success"), attempt("b", "running")])).toBe(
      "1/2 席位成功",
    );
  });
});

describe("seat count on the report header", () => {
  it("shows 1/2 席位成功 · 1 路失败 when the reporter probe failed", () => {
    const run = reviewRun([attempt("alice", "success"), attempt("bob", "failure")]);
    const header = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(ContextBar, { run, hostStatus: "online" })),
    );
    const overview = renderToStaticMarkup(
      createElement(OverviewView, {
        run,
        parsed: null,
        hasRepair: false,
        onOpenRepair: () => undefined,
      }),
    );
    for (const html of [header, overview]) {
      expect(textOf(html)).toContain("1/2 席位成功 · 1 路失败");
      expect(html).toContain("ck-wb-seat-count-fail");
      expect(html).not.toContain("席位已完成");
    }
    expect(header).toContain("ck-wb-seat-count-main");
  });

  it("omits the failure clause when every seat succeeded", () => {
    const html = renderToStaticMarkup(
      createElement(SeatCount, {
        attempts: [attempt("a", "success"), attempt("b", "success")],
      }),
    );
    expect(textOf(html)).toContain("2/2 席位成功");
    expect(html).not.toContain("路失败");
    expect(html).not.toContain("席位已完成");
  });
});
