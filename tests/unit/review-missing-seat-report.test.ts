import "./app-dom-install";
import { ContextBar } from "@/components/report/workbench/ContextBar";
import { OverviewView } from "@/components/report/workbench/OverviewView";
import { reviewSeatCount } from "@/components/report/workbench/SeatCount";
import { cliRunDetailResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { mountNode } from "./app-page-harness";

const COPY = "1/2 席位成功 · 1 路失败";

function attempt(role: "attempt" | "aggregator", status: string, attemptId: string) {
  return {
    attemptId,
    agentName: role === "aggregator" ? "review-security" : "review-kimi",
    driverId: "kimi-stream-json",
    modelId: "kimi-code/k3",
    role,
    status,
    durationMs: status === "success" ? 1000 : 0,
    lastActivity: null,
  };
}

function missingSeatRun() {
  const line = "缺席：review-kimi（kimi）：没有找到 kimi。";
  return {
    line,
    run: cliRunDetailResponseSchema.parse({
      runId: "ck-review-383",
      kind: "review",
      status: "completed",
      title: "x",
      startedAt: null,
      endedAt: null,
      hasReport: true,
      reportUrl: "/reports/ck-review-383",
      progress: {
        phase: "done",
        updatedAt: "2026-10-19T01:01:00.000Z",
        attempts: [
          attempt("attempt", "success", "attempt-0"),
          attempt("attempt", "failure", "attempt-1"),
          attempt("aggregator", "success", "aggregator"),
        ],
      },
      markdown: `# Autonomous Review Report\n\n## 缺席的审查者\n\n${line}\n`,
      truncated: false,
    }),
  };
}

function visibleCopy(node: ParentNode): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

it("#383 missing seat renders the exact absence line with circle-alert", async () => {
  const { line, run } = missingSeatRun();
  const mounted = await mountNode(
    createElement(OverviewView, {
      run,
      parsed: null,
      hasRepair: false,
      onOpenRepair() {},
    }),
  );
  try {
    const rows = mounted.container.querySelectorAll('[data-absence-icon="circle-alert"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe(line);
    expect(rows[0]?.querySelector("svg.ck-wb-icon.ck-wb-icon-state")).not.toBeNull();
  } finally {
    await mounted.unmount();
  }
});

it("#383 counts a missing seat as a failure, not as a completed seat", async () => {
  const { run } = missingSeatRun();
  expect(reviewSeatCount(run.progress?.attempts)?.text).toBe(COPY);
  expect(reviewSeatCount(run.progress?.attempts)?.text).not.toContain("席位已完成");

  const overview = await mountNode(
    createElement(OverviewView, {
      run,
      parsed: null,
      hasRepair: false,
      onOpenRepair() {},
    }),
  );
  const context = await mountNode(
    createElement(MemoryRouter, null, createElement(ContextBar, { run, hostStatus: "online" })),
  );
  try {
    for (const mounted of [overview, context]) {
      const counts = mounted.container.querySelectorAll(".ck-wb-seat-count");
      expect(counts).toHaveLength(1);
      expect(visibleCopy(counts[0] ?? mounted.container)).toBe(COPY);
      expect(mounted.container.textContent).not.toContain("席位已完成");
      const fail = counts[0]?.querySelector("[data-seat-fail-icon='circle-x']");
      expect(fail?.classList.contains("ck-wb-seat-fail")).toBe(true);
      expect(fail?.querySelector("svg.ck-wb-icon.ck-wb-icon-state")).not.toBeNull();
    }
  } finally {
    await overview.unmount();
    await context.unmount();
  }
});

it("#383 generalizes the seat tally for N seats", () => {
  expect(
    reviewSeatCount([attempt("attempt", "success", "a"), attempt("attempt", "success", "b")])?.text,
  ).toBe("2/2 席位成功");
  expect(
    reviewSeatCount([attempt("attempt", "failure", "a"), attempt("attempt", "failure", "b")])?.text,
  ).toBe("0/2 席位成功 · 2 路失败");
  expect(
    reviewSeatCount([
      attempt("attempt", "success", "a"),
      attempt("attempt", "failure", "b"),
      attempt("attempt", "cancelled", "c"),
      attempt("aggregator", "success", "aggregator"),
    ])?.text,
  ).toBe("1/3 席位成功 · 1 路失败 · 1 路中断");
  expect(reviewSeatCount([])).toBeNull();
  expect(reviewSeatCount([attempt("aggregator", "success", "aggregator")])).toBeNull();
});
