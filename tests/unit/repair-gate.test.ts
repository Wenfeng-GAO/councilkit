import type { LedgerFinding } from "@shared/runtime/cli-ledger";
import { evaluateRepairGate } from "@shared/runtime/repair-gate";
import { canExportRepairPackage } from "@shared/runtime/review-case";
import { describe, expect, it } from "vitest";

const SHA = "a".repeat(40);
const POLICY = "policy-hash-1";
const PR = "https://github.com/acme/repo/pull/1";
const SOURCE = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2";
const REVIEW = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4";

function verified(id: string, severity: LedgerFinding["severity"] = "nit"): LedgerFinding {
  return {
    id,
    severity,
    status: "closed",
    title: id,
    text: "closed with evidence",
    source: "consensus",
    reviewer: "review-correctness",
    files: ["src/a.ts"],
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
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    source: { runId: SOURCE, prUrl: PR, sha: SHA },
    candidateSha: SHA,
    publishedSha: SHA,
    remoteHead: SHA,
    baseUnchanged: true,
    prOpen: true,
    squad: {
      taskId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      invalidated: false,
      independentReview: true,
      independentVerify: true,
      requiredGatesPassed: true,
      sha: SHA,
      gatePolicyHash: POLICY,
    },
    review: {
      runId: REVIEW,
      incomplete: false,
      seatsAllSuccess: true,
      aggregatorComplete: true,
      artifactsOk: true,
      sha: SHA,
      evidenceComplete: true,
      uncoveredIds: [] as string[],
      aggregatorVerdict: "approve" as const,
      findings: [verified("F-nit")],
    },
    policyHash: POLICY,
    checkedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("evaluateRepairGate", () => {
  it("passes when identity, squad gates, coverage, and every finding are verified closed", () => {
    const result = evaluateRepairGate(baseInput());
    expect(result.passed).toBe(true);
    expect(result.candidateSha).toBe(SHA);
    expect(result.reasons).toEqual([]);
  });

  it("does not pass when evidenceComplete is omitted, unlike canExportRepairPackage", () => {
    const exportable = canExportRepairPackage({
      runId: SOURCE,
      kind: "review",
      status: "completed",
      startedAt: "t",
      reviewEvidence: {
        complete: true,
        sha: SHA,
        prUrl: PR,
        againstRunId: null,
        blockingIds: [],
        unverifiedFixIds: [],
        openIds: [],
      },
    });
    expect(exportable).toBe(true);
    const result = evaluateRepairGate(
      baseInput({
        review: {
          ...baseInput().review,
          evidenceComplete: undefined,
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.map((row) => row.code)).toContain("coverage_incomplete");
  });

  it("does not treat historical closed, repairClaim, or reasonless accepted as closed", () => {
    const historical: LedgerFinding = {
      id: "F-hist",
      severity: "major",
      status: "closed",
      title: "old",
      text: "legacy",
      source: "unknown",
      reviewer: null,
      files: [],
    };
    const claimed: LedgerFinding = {
      id: "F-claim",
      severity: "minor",
      status: "open",
      title: "claimed",
      text: "landed",
      source: "consensus",
      reviewer: null,
      files: ["a.ts"],
      repairClaim: { candidateSha: SHA, runId: "ck-apply-1", at: "t" },
    };
    const accepted: LedgerFinding = {
      id: "F-acc",
      severity: "nit",
      status: "accepted",
      title: "acc",
      text: "no reason",
      source: "unique",
      reviewer: null,
      files: [],
    };
    const result = evaluateRepairGate(
      baseInput({
        review: {
          ...baseInput().review,
          findings: [historical, claimed, accepted],
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.map((row) => row.code)).toContain("findings_open");
  });

  it("rejects aggregator changes-requested when the ledger claims everything is closed", () => {
    const result = evaluateRepairGate(
      baseInput({
        review: {
          ...baseInput().review,
          aggregatorVerdict: "changes-requested",
          findings: [verified("F-nit")],
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reasons.map((row) => row.code)).toContain("verdict_contradiction");
  });
});
