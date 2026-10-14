import { squadDecision } from "@/lib/squad-workspace";
import type { SquadWorkspaceRun } from "@/lib/squad-workspace";
import { describe, expect, it } from "vitest";

function run(partial: Partial<SquadWorkspaceRun>): SquadWorkspaceRun {
  return {
    title: "task",
    status: "running",
    progress: {
      phase: "planning",
      updatedAt: "2026-09-07T07:03:00.000Z",
      attempts: [],
    },
    handoff: null,
    documents: [],
    ...partial,
  };
}

describe("squadDecision remaining states", () => {
  it("says the flow is finished when an approved run is in phase done", () => {
    expect(
      squadDecision(
        run({
          progress: {
            phase: "done",
            updatedAt: "2026-09-07T07:03:00.000Z",
            attempts: [],
          },
          handoff: { approved: true },
        }),
      ),
    ).toEqual({
      label: "验收已通过",
      detail: "流程已结束，交付内容以最终记录为准。",
      tone: "success",
    });
  });

  it("asks the orchestrator to continue when the run is awaiting", () => {
    expect(squadDecision(run({ status: "awaiting_orchestrator", handoff: null }))).toEqual({
      label: "等待编排者接续",
      detail: "席位执行与整体验收分别记录；请核对结果后继续流程。",
      tone: "warn",
    });
  });

  it("says the candidate is still being prepared when nothing has been handed off", () => {
    expect(squadDecision(run({ status: "running", handoff: {}, progress: null }))).toEqual({
      label: "准备候选中",
      detail: "完成规划、实现与审计后，进入独立验收。",
      tone: "muted",
    });
  });
});
