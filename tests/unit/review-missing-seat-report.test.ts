import "./app-dom-install";
import { OverviewView } from "@/components/report/workbench/OverviewView";
import { cliRunDetailResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { expect, it } from "vitest";
import { mountNode } from "./app-page-harness";

it("#383 missing seat renders the exact absence line with circle-alert", async () => {
  const line = "缺席：review-kimi（kimi）：没有找到 kimi。";
  const run = cliRunDetailResponseSchema.parse({
    runId: "ck-review-383",
    kind: "review",
    status: "completed",
    title: "x",
    startedAt: null,
    endedAt: null,
    hasReport: true,
    reportUrl: "/reports/ck-review-383",
    progress: null,
    markdown: `# Autonomous Review Report\n\n## 缺席的审查者\n\n${line}\n`,
    truncated: false,
  });
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
    expect(rows[0].textContent).toBe(line);
    expect(rows[0].querySelector("svg.ck-wb-icon.ck-wb-icon-state")).not.toBeNull();
  } finally {
    await mounted.unmount();
  }
});
