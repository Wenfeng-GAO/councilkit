import type { FindingsFile } from "@shared/runtime/cli-ledger";
import {
  type ReviewCaseRun,
  summarizePrCase,
  summarizeReviewEvidence,
} from "@shared/runtime/review-case";
import { describe, expect, it } from "vitest";
const pr = "https://github.com/acme/repo/pull/1";
function run(id: string, against: string | null, complete = true, url = pr): ReviewCaseRun {
  return {
    runId: id,
    kind: "review",
    status: complete ? "completed" : "failed",
    startedAt: `2026-09-0${id}`,
    reviewEvidence: {
      complete,
      sha: id.repeat(40),
      prUrl: url,
      againstRunId: against,
      blockingIds: ["F-1"],
      openIds: ["F-1"],
      unverifiedFixIds: [],
    },
  };
}
describe("PR case evidence", () => {
  it("preserves last complete baseline when a newer run fails", () => {
    const summary = summarizePrCase([run("1", null), run("2", "1", false)]);
    expect(summary.baseline?.runId).toBe("1");
    expect(summary.latest?.runId).toBe("2");
    expect(summary.needsRecovery).toBe(true);
    expect(summary.nextAction).toContain("当前 PR SHA");
  });
  it("rejects contradictory complete evidence on failed or interrupted runs", () => {
    for (const status of ["failed", "interrupted", "running", "unknown"]) {
      const newer = { ...run("2", "1"), status };
      expect(summarizePrCase([run("1", null), newer]).baseline?.runId).toBe("1");
      expect(summarizePrCase([run("1", null), newer]).needsRecovery).toBe(true);
      expect(summarizePrCase([{ ...run("1", null), status }, run("2", "1")]).comparison).toBeNull();
      expect(summarizePrCase([{ ...run("1", null), status }, run("2", "1")]).repeatedIds).toEqual(
        [],
      );
    }
  });
  it("compares and counts repeated identity only through same-PR against ancestry", () => {
    const summary = summarizePrCase([run("1", null), run("2", null), run("3", "1")]);
    expect(summary.comparison).toEqual({ current: "3", previous: "1" });
    expect(summary.repeatedIds).toEqual(["F-1"]);
    expect(summarizePrCase([run("1", null, true, `${pr}2`), run("3", "1")]).comparison).toBeNull();
    expect(summarizePrCase([run("1", null), run("3", null)]).repeatedIds).toEqual([]);
  });
  it("terminates cyclic ancestry without counting a run twice", () => {
    expect(summarizePrCase([run("1", "3"), run("3", "1")]).repeatedIds).toEqual(["F-1"]);
  });
  it("does not treat completed or legacy closed as approved/verified", () => {
    const ledger: FindingsFile = {
      version: 1,
      runId: "r",
      extractedAt: "today",
      sha: "a".repeat(40),
      againstRunId: null,
      againstRange: null,
      findings: [
        {
          id: "F-1",
          title: "Legacy",
          severity: "major",
          status: "closed",
          text: "evidence",
          files: [],
          source: "unknown",
          reviewer: null,
        },
      ],
    };
    expect(
      summarizeReviewEvidence({
        runId: "r",
        complete: true,
        prUrl: pr,
        againstRunId: null,
        ledger,
      }),
    ).toMatchObject({ blockingIds: ["F-1"], unverifiedFixIds: ["F-1"] });
    expect(summarizePrCase([{ ...run("1", null), reviewEvidence: null }]).baseline).toBeNull();
  });
});
