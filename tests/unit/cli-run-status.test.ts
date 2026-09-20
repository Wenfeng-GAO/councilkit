import {
  cliRunNeedsPoll,
  cliRunPhaseHeading,
  cliRunStatusPill,
  primaryRunStatus,
} from "@/lib/cli-run-status";
import { describe, expect, it } from "vitest";

describe("cliRunStatusPill", () => {
  it("labels squad awaiting / closed without using review interrupted copy", () => {
    expect(cliRunStatusPill("squad", "awaiting_orchestrator")).toEqual({
      tone: "warn",
      text: "等待编排",
    });
    expect(cliRunStatusPill("squad", "interrupted")).toEqual({
      tone: "warn",
      text: "等待编排",
    });
    expect(cliRunStatusPill("squad", "closed")).toEqual({ tone: "success", text: "已收工" });
    expect(cliRunStatusPill("squad", "completed")).toEqual({ tone: "success", text: "已收工" });
    expect(cliRunStatusPill("review", "interrupted")).toEqual({ tone: "warn", text: "中断" });
    expect(cliRunStatusPill("review", "completed")).toEqual({ tone: "success", text: "已完成" });
  });
});

describe("cliRunPhaseHeading", () => {
  it("uses 等待编排 for k4p2-shaped squad status, not 已结束", () => {
    expect(cliRunPhaseHeading("squad", "interrupted", "snapshotting")).toBe("等待编排");
    expect(cliRunPhaseHeading("squad", "awaiting_orchestrator", "snapshotting")).toBe("等待编排");
    expect(cliRunPhaseHeading("squad", "closed", "snapshotting")).toBe("已收工");
    expect(cliRunPhaseHeading("review", "interrupted", "attempts")).toBe("已中断");
  });

  it("labels ideate proposing and debating while running", () => {
    expect(cliRunPhaseHeading("ideate", "running", "proposing")).toBe("独立提案中");
    expect(cliRunPhaseHeading("ideate", "running", "debating")).toBe("交叉辩论中");
    expect(cliRunPhaseHeading("ideate", "completed", "done")).toBe("已结束");
  });
});

describe("primaryRunStatus", () => {
  it("prefers pipeline and apply failure over stacked pills", () => {
    expect(
      primaryRunStatus({
        kind: "review",
        status: "running",
        pipeline: { phase: "re-reviewing", applyStatus: null },
      }),
    ).toEqual({ tone: "info", text: "正在复审" });
    expect(
      primaryRunStatus({
        kind: "review",
        status: "completed",
        pipeline: { phase: "done", applyStatus: "failure" },
      }),
    ).toEqual({ tone: "error", text: "修复失败" });
    expect(
      primaryRunStatus({
        kind: "review",
        status: "completed",
        pipeline: {
          phase: "done",
          applyStatus: "failure",
          planVerdict: null,
          followUpRunId: "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        },
      }),
    ).toEqual({ tone: "error", text: "复审失败" });
    expect(
      primaryRunStatus({
        kind: "review",
        status: "running",
        progress: { phase: "aggregating" },
      }),
    ).toEqual({ tone: "info", text: "正在汇总" });
  });
});

describe("cliRunNeedsPoll", () => {
  it("keeps polling awaiting_orchestrator", () => {
    expect(cliRunNeedsPoll("awaiting_orchestrator", null)).toBe(true);
    expect(cliRunNeedsPoll("closed", null)).toBe(false);
    expect(cliRunNeedsPoll("completed", { phase: "done" })).toBe(false);
    expect(cliRunNeedsPoll("running", null, "repair")).toBe(true);
    expect(cliRunNeedsPoll("completed", { phase: "planning" }, "repair")).toBe(false);
  });
});
