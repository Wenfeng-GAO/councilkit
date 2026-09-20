import { fixPipelineLiveStatus } from "@/components/report/FixPipeline";
import type { CliRunPipelineDto } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

function pipeline(input: {
  applyStatus: CliRunPipelineDto["applyStatus"];
  planVerdict: CliRunPipelineDto["planVerdict"];
  followUpRunId: string | null;
  summary: string;
}): CliRunPipelineDto {
  return {
    phase: "done",
    round: 0,
    maxRounds: 2,
    planVerdict: input.planVerdict,
    applyStatus: input.applyStatus,
    followUpRunId: input.followUpRunId,
    summary: input.summary,
    updatedAt: "2026-09-17T12:38:19.258Z",
  };
}

describe("fixPipelineLiveStatus", () => {
  it("does not call a failed re-review a failed repair", () => {
    const hint = fixPipelineLiveStatus({
      busy: false,
      pendingAction: null,
      pipeline: pipeline({
        applyStatus: "failure",
        planVerdict: null,
        followUpRunId: "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        summary: 'executable "kimi" not found on PATH (review needs it installed)',
      }),
      error: null,
      failed: true,
      followUpFailed: false,
      followUpRunning: false,
    });
    expect(hint).toEqual({
      tone: "error",
      text: '复审没有完成：executable "kimi" not found on PATH (review needs it installed)',
    });
  });

  it("does not say code was unchanged when apply already landed", () => {
    const hint = fixPipelineLiveStatus({
      busy: false,
      pendingAction: null,
      pipeline: pipeline({
        applyStatus: "success",
        planVerdict: "approve",
        followUpRunId: "ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
        summary: "applied; follow-up ck-review-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeee2",
      }),
      error: null,
      failed: false,
      followUpFailed: true,
      followUpRunning: false,
    });
    expect(hint).toEqual({
      tone: "error",
      text: "落地已完成，但复审没有通过。",
    });
  });

  it("still labels an apply failure as a failed repair", () => {
    const hint = fixPipelineLiveStatus({
      busy: false,
      pendingAction: null,
      pipeline: pipeline({
        applyStatus: "failure",
        planVerdict: "approve",
        followUpRunId: null,
        summary: "apply did not complete",
      }),
      error: null,
      failed: true,
      followUpFailed: false,
      followUpRunning: false,
    });
    expect(hint).toEqual({
      tone: "error",
      text: "修复没有完成：apply did not complete",
    });
  });
});
