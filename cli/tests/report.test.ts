/**
 * Report unit tests (plan-a §10 AC1, report bucket). Covers:
 *  - the Reporter instruction carries exactly nine `##` section headings;
 *  - the success report has the deterministic header (Run/Council/Reporter/
 *    Participants/Status) + the Reporter body, and names both agents;
 *  - the partial report is zero-model-call, carries the INCOMPLETE banner, the
 *    persisted speeches and the failure phase, and never fabricates consensus;
 *  - `assertNonEmptyMarkdown` rejects empty.
 */
import { describe, expect, it } from "vitest";
import { REPORT_SECTION_HEADINGS, reporterInstruction } from "../src/report/instruction";
import {
  assertNonEmptyMarkdown,
  renderPartialReport,
  renderSuccessReport,
} from "../src/report/render";
import type { CompletedTurn, CouncilSnapshot, RunFailure } from "../src/run/types";

const council: CouncilSnapshot = {
  id: "c-1",
  name: "smoke-council",
  topic: "route local models",
  background: "cost pressure",
  targetOutput: "one-page recommendation",
  rounds: 2,
  reporterAgentId: "a-beta",
  agentIds: ["a-alpha", "a-beta"],
};

const agents = ["Alpha", "Beta"];

describe("cli report", () => {
  it("the Reporter instruction lists exactly nine level-2 section headings", () => {
    expect(REPORT_SECTION_HEADINGS).toHaveLength(9);
    for (const h of REPORT_SECTION_HEADINGS) {
      expect(h.startsWith("## ")).toBe(true);
    }
    // The exact nine (sync-point with src/orchestrator/discussion-instructions.ts).
    expect(REPORT_SECTION_HEADINGS.map((h) => h.slice(3))).toEqual([
      "Background（背景）",
      "Discussion goal（讨论目标）",
      "Participating agents（参与角色）",
      "Discussion summary（讨论摘要）",
      "Key consensus（关键共识）",
      "Remaining disagreements（未决分歧）",
      "Recommendation（推荐）",
      "Risks and objections（风险与异议）",
      "Next actions（下一步行动）",
    ]);
  });

  it("the Reporter instruction names every participating agent + the target output", () => {
    const text = reporterInstruction({
      council: {
        topic: council.topic,
        background: council.background,
        targetOutput: council.targetOutput,
      },
      agentNames: agents,
      reporterName: "Beta",
    });
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
    expect(text).toContain("Target output:");
    expect(text).toContain("## Background");
  });

  it("success report header names both agents and the reporter, then the body", () => {
    const md = renderSuccessReport({
      runId: "ck-run-1",
      startedAt: "2026-07-22T00:00:00.000Z",
      endedAt: "2026-07-22T00:01:00.000Z",
      council,
      reporterName: "Beta",
      participantNames: agents,
      reporterOutput: "## Background\n\nsome model output\n\n## Next actions\n\nship it",
    });
    expect(md).toContain("# Council Report");
    expect(md).toContain("- Reporter: Beta");
    expect(md).toContain("- Participants: Alpha, Beta");
    expect(md).toContain("- Status: complete");
    expect(md).toContain("some model output");
    expect(assertNonEmptyMarkdown(md)).toBeUndefined();
  });

  it("partial report carries the INCOMPLETE banner + speeches + failure, no fabricated consensus", () => {
    const completed: CompletedTurn[] = [
      {
        agentId: "a-alpha",
        agentName: "Alpha",
        participantId: "p-alpha",
        executionId: "e1",
        output: "I think route A.",
        round: 1,
        turnIndex: 0,
      },
    ];
    const failure: RunFailure = { phase: "turn", code: "DRIVER_CRASH", message: "beta crashed" };
    const md = renderPartialReport({
      runId: "ck-run-1",
      startedAt: "2026-07-22T00:00:00.000Z",
      endedAt: "2026-07-22T00:01:00.000Z",
      council,
      reporterName: "Beta",
      participantNames: agents,
      completedTurns: completed,
      failure,
    });
    expect(md).toContain("INCOMPLETE RUN");
    expect(md).toContain("- Status: incomplete");
    expect(md).toContain("Alpha");
    expect(md).toContain("I think route A.");
    expect(md).toContain("DRIVER_CRASH");
    expect(md).not.toContain("## Recommendation"); // no fabricated Reporter conclusion
  });

  it("partial report with zero completed turns still renders a non-empty diagnostic body", () => {
    const md = renderPartialReport({
      runId: "ck-run-1",
      startedAt: "2026-07-22T00:00:00.000Z",
      endedAt: "2026-07-22T00:01:00.000Z",
      council,
      reporterName: "Beta",
      participantNames: agents,
      completedTurns: [],
      failure: { phase: "scope", code: "SCOPE_CREATE_FAILED", message: "host gone" },
    });
    expect(md).toContain("INCOMPLETE RUN");
    expect(md).toContain("No ordinary turn completed");
    expect(() => assertNonEmptyMarkdown(md)).not.toThrow();
  });

  it("assertNonEmptyMarkdown throws on empty", () => {
    expect(() => assertNonEmptyMarkdown("   ")).toThrow();
  });
});
