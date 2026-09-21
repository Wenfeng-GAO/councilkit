import type { LedgerFinding } from "@shared/runtime/cli-ledger";
import {
  appendCounterExample,
  gateAcceptanceView,
  notEvaluatedIsNotCounterEvidence,
  projectAdjudication,
} from "@shared/runtime/repair-adjudication";
import { describe, expect, it } from "vitest";

const SHA = "a".repeat(40);
const REVIEW = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4";

function finding(id: string, extra: Partial<LedgerFinding> = {}): LedgerFinding {
  return {
    id,
    severity: "major",
    status: "open",
    title: id,
    text: `text-${id}`,
    source: "consensus",
    reviewer: "review-correctness",
    files: ["src/a.ts"],
    ...extra,
  };
}

function verified(id: string): LedgerFinding {
  return finding(id, {
    status: "closed",
    verification: {
      outcome: "verified_closed",
      candidateSha: SHA,
      runId: REVIEW,
      attemptId: "attempt-0",
      reviewer: "review-correctness",
      method: "code_trace",
      reason: "gone",
      evidence: "src/a.ts:1",
      locations: ["src/a.ts:1"],
      runComplete: true,
    },
  });
}

describe("adjudication projection", () => {
  it("keeps four verified_closed plus one not_evaluated from becoming a fake conflict", () => {
    const projection = projectAdjudication({
      sourceRunId: REVIEW,
      candidateSha: SHA,
      findings: [
        verified("E1"),
        verified("E2"),
        verified("E3"),
        verified("E4"),
        finding("E5", {
          reviewer: null,
          verification: {
            outcome: "not_evaluated",
            candidateSha: SHA,
            runId: REVIEW,
            attemptId: "attempt-1",
            reviewer: "review-cursor",
            method: "not_evaluated",
            reason: "seat skipped this item",
            evidence: "none",
            runComplete: true,
          },
        }),
      ],
    });
    const view = gateAcceptanceView(projection);
    expect(view.verifiedClosedIds).toHaveLength(4);
    expect(view.notEvaluatedIds).toEqual(["E5"]);
    expect(view.openIds).toEqual([]);
    expect(view.conflict).toBe(false);
    expect(notEvaluatedIsNotCounterEvidence(view)).toBe(true);
  });

  it("treats required responsibility without evidence as a coverage gap, not a pass", () => {
    const projection = projectAdjudication({
      sourceRunId: REVIEW,
      candidateSha: SHA,
      findings: [
        finding("REQ", {
          verification: {
            outcome: "not_evaluated",
            candidateSha: SHA,
            runId: REVIEW,
            attemptId: "attempt-0",
            reviewer: "review-correctness",
            method: "not_evaluated",
            reason: "assigned but not evaluated",
            evidence: "missing",
            runComplete: false,
          },
        }),
      ],
    });
    const view = gateAcceptanceView(projection);
    expect(view.coverageGaps).toContain("REQ");
    expect(view.notEvaluatedIds).not.toContain("REQ");
  });

  it("records E2 as a new assertion without rewriting closed E1", () => {
    const closed = projectAdjudication({
      sourceRunId: REVIEW,
      candidateSha: SHA,
      findings: [verified("E1")],
    });
    expect(closed.items[0]?.disposition).toBe("verified_closed");
    const next = appendCounterExample(closed, {
      fromAssertionId: "A-E1-v1",
      newFindingId: "E2",
      evidence: "new counterexample on the same invariant",
      invariant: "ready stays ready",
    });
    const e1 = next.items.find((item) => item.assertion.sourceFindingId === "E1");
    const e2 = next.items.find((item) => item.assertion.sourceFindingId === "E2");
    expect(e1?.disposition).toBe("verified_closed");
    expect(e1?.assertion.assertionVersion).toBe(1);
    expect(e2?.disposition).toBe("still_open");
    expect(e2?.assertion.assertionId).toBe("A-E2-v2");
    expect(e2?.relatedAssertionIds).toContain("A-E1-v1");
  });

  it("merges aliases without inflating root-cause count", () => {
    const projection = projectAdjudication({
      sourceRunId: REVIEW,
      candidateSha: SHA,
      findings: [finding("F-main"), finding("F-dup")],
      aliases: [{ fromId: "F-dup", toId: "F-main", evidence: "same stack trace hash" }],
    });
    expect(projection.rootCauseIds).toEqual(["F-main"]);
    expect(
      projection.items.find((item) => item.assertion.sourceFindingId === "F-dup")?.disposition,
    ).toBe("aliased");
  });

  it("does not treat two distinct root causes as a repeat stop", () => {
    const projection = projectAdjudication({
      sourceRunId: REVIEW,
      candidateSha: SHA,
      findings: [finding("R1"), finding("R2")],
    });
    expect(projection.rootCauseIds).toEqual(["R1", "R2"]);
  });
});
