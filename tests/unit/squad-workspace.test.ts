import { SquadWorkspace } from "@/components/report/SquadWorkspace";
import {
  squadBriefGoal,
  squadDecision,
  squadGateLabel,
  squadStageIndex,
} from "@/lib/squad-workspace";
import { cliRunDetailResponseSchema } from "@shared/runtime/schemas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

function run() {
  return cliRunDetailResponseSchema.parse({
    runId: "ck-squad-example",
    kind: "squad",
    title: "Squad example",
    status: "running",
    startedAt: "2026-09-07T07:00:00Z",
    endedAt: null,
    hasReport: true,
    reportUrl: "/reports/example",
    markdown: "# Observation",
    truncated: false,
    progress: {
      phase: "reviewing",
      updatedAt: "2026-09-07T07:03:00Z",
      attempts: [
        {
          attemptId: "coder-0",
          agentName: "coder",
          driverId: "host",
          modelId: "current",
          role: "attempt",
          status: "success",
          durationMs: 90000,
          lastActivity: null,
        },
        {
          attemptId: "review-0",
          agentName: "reviewer",
          driverId: "codex",
          modelId: "-",
          role: "attempt",
          status: "running",
          durationMs: 10000,
          lastActivity: "git diff",
        },
      ],
    },
    documents: [
      {
        id: "brief",
        title: "简报",
        markdown: "# Brief\n- goal: 修复 PR #7 的 null 字段。",
        truncated: false,
      },
    ],
    handoff: {
      approved: false,
      candidateSha: "a".repeat(40),
      candidateStatus: "completed",
      next: "approved=false and integrate is not authorized",
    },
  });
}

describe("Squad observation workspace", () => {
  it("does not treat successful coding or a completed candidate as accepted delivery", () => {
    const current = run();
    expect(squadDecision(current).label).toBe("等待独立验收");
    expect(squadGateLabel(undefined).passed).toBe(false);
    expect(squadGateLabel("unknown").passed).toBe(false);
    current.status = "closed";
    expect(squadDecision(current).label).toContain("验收待核实");
  });
  it("gives invalidation and blockers precedence over a stale approved flag", () => {
    const current = run();
    current.handoff = {
      approved: true,
      candidateStatus: "invalidated",
      invalidatedReason: "new candidate",
    };
    expect(squadDecision(current).tone).toBe("warn");
    current.handoff = { approved: true, remainingBlockers: ["F-1"] };
    expect(squadDecision(current).label).toContain("仍需处理");
    current.handoff = { approved: true };
    current.status = "failed";
    expect(squadDecision(current).label).toBe("执行需要处理");
  });
  it("separates approval from integration and handles missing phases", () => {
    const current = run();
    current.handoff = { approved: true };
    expect(squadDecision(current).detail).toContain("完成集成");
    expect(squadStageIndex(undefined)).toBe(-1);
    expect(squadStageIndex("fixing")).toBe(3);
  });
  it("does not let a historical failed attempt override current approval", () => {
    const current = run();
    if (!current.progress) throw new Error("fixture requires progress");
    current.progress.attempts[0].status = "failure";
    current.handoff = { approved: true };
    expect(squadDecision(current).tone).toBe("success");
    expect(squadGateLabel(undefined).text).toBe("暂无同步信息");
    expect(squadGateLabel("pending").passed).toBe(false);
    expect(squadGateLabel("pass").passed).toBe(true);
  });
  it("places working seats before long documents and exposes evidence without inventing models", () => {
    const html = renderToStaticMarkup(
      createElement(SquadWorkspace, { run: run(), onInspect: () => {} }),
    );
    expect(html.indexOf("席位与实时过程")).toBeLessThan(html.indexOf("任务文档"));
    expect(html.indexOf("查看过程：reviewer")).toBeLessThan(html.indexOf("查看过程：coder"));
    expect(html).toContain("模型待回执");
    expect(html).not.toContain("gpt-5.6");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("<details");
    expect(squadBriefGoal(run())).toBe("修复 PR #7 的 null 字段。");
  });
});
