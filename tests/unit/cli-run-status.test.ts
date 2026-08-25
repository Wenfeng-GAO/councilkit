import { cliRunNeedsPoll, cliRunPhaseHeading, cliRunStatusPill } from "@/lib/cli-run-status";
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
});

describe("cliRunNeedsPoll", () => {
  it("keeps polling awaiting_orchestrator", () => {
    expect(cliRunNeedsPoll("awaiting_orchestrator", null)).toBe(true);
    expect(cliRunNeedsPoll("closed", null)).toBe(false);
    expect(cliRunNeedsPoll("completed", { phase: "done" })).toBe(false);
  });
});
