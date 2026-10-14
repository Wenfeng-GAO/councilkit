import { cliRunStatusPill, primaryRunStatus } from "@/lib/cli-run-status";
import { describe, expect, it } from "vitest";

describe("cliRunStatusPill remaining statuses", () => {
  it("labels unknown, non-squad awaiting, and non-squad closed", () => {
    expect(cliRunStatusPill("review", "unknown")).toEqual({ tone: "muted", text: "未知" });
    expect(cliRunStatusPill("ideate", "awaiting_orchestrator")).toEqual({
      tone: "warn",
      text: "等待编排",
    });
    expect(cliRunStatusPill("discuss", "closed")).toEqual({ tone: "success", text: "已收工" });
  });
});

describe("primaryRunStatus remaining headings", () => {
  it("says 进行中 when a running review has no live phase", () => {
    expect(primaryRunStatus({ kind: "review", status: "running" })).toEqual({
      tone: "info",
      text: "进行中",
    });
    expect(
      primaryRunStatus({ kind: "review", status: "running", progress: { phase: "done" } }),
    ).toEqual({ tone: "info", text: "进行中" });
  });

  it("says 降级 for a completed ideate run whose integrity is incomplete", () => {
    expect(
      primaryRunStatus({
        kind: "ideate",
        status: "completed",
        ideateIntegrity: { incomplete: true },
      }),
    ).toEqual({ tone: "warn", text: "降级" });
    expect(
      primaryRunStatus({
        kind: "ideate",
        status: "completed",
        ideateIntegrity: { incomplete: false },
      }),
    ).toEqual({ tone: "success", text: "已完成" });
  });
});
