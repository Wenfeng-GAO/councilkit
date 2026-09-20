import {
  type LedgerFinding,
  countLedgerFindings,
  findingStatusLabel,
  isFindingBlocking,
  isFindingVerifiedClosed,
  parseFindingsFile,
  sortLedgerFindings,
} from "@shared/runtime/cli-ledger";
import { describe, expect, it } from "vitest";

function finding(
  partial: Partial<LedgerFinding> & Pick<LedgerFinding, "id" | "title" | "severity">,
): LedgerFinding {
  return {
    status: "open",
    text: partial.title,
    source: "unique",
    reviewer: null,
    files: [],
    ...partial,
  };
}

describe("sortLedgerFindings", () => {
  it("orders by severity, then status, then source", () => {
    const sorted = sortLedgerFindings([
      finding({ id: "n1", title: "nit unique", severity: "nit" }),
      finding({
        id: "m-closed",
        title: "major closed",
        severity: "major",
        status: "closed",
        source: "consensus",
      }),
      finding({
        id: "m-open-u",
        title: "major unique",
        severity: "major",
        source: "unique",
      }),
      finding({
        id: "m-open-c",
        title: "major consensus",
        severity: "major",
        source: "consensus",
      }),
      finding({
        id: "c-regress",
        title: "critical regress",
        severity: "critical",
        status: "regress",
      }),
    ]);
    expect(sorted.map((row) => row.id)).toEqual([
      "c-regress",
      "m-open-c",
      "m-open-u",
      "m-closed",
      "n1",
    ]);
  });
});

describe("trusted resolution", () => {
  const historical = finding({
    id: "legacy",
    title: "lost content",
    severity: "critical",
    status: "closed",
  });
  it("reads old files without turning historical closure into proof", () => {
    const file = parseFindingsFile(
      JSON.stringify({
        version: 1,
        runId: "legacy",
        extractedAt: "now",
        sha: null,
        againstRunId: null,
        againstRange: null,
        findings: [historical],
      }),
    );
    expect(file?.findings[0]).toEqual(historical);
    expect(isFindingVerifiedClosed(historical)).toBe(false);
    expect(isFindingBlocking(historical)).toBe(true);
    expect(findingStatusLabel(historical)).toBe("历史未验证");
  });
  it("distinguishes repair claims, exact-SHA resolution and accepted tradeoffs", () => {
    const claimed = {
      ...historical,
      status: "open" as const,
      repairClaim: { candidateSha: "a".repeat(40), runId: "apply", at: "now" },
    };
    expect(findingStatusLabel(claimed)).toBe("声明已修复 · 待验证");
    expect(isFindingBlocking(claimed)).toBe(true);
    const verified = {
      ...historical,
      verification: {
        outcome: "verified_closed" as const,
        candidateSha: "a".repeat(40),
        runId: "review",
        attemptId: "attempt-0",
        reviewer: "reviewer",
        method: "code_trace" as const,
        reason: "The write error retains the only copy",
        evidence: "The error branch returns before clearing pending text",
        locations: ["pkg/log.go:42"],
        runComplete: true,
      },
    };
    expect(findingStatusLabel(verified)).toBe("已验证解决");
    expect(isFindingVerifiedClosed(verified, "a".repeat(40))).toBe(true);
    expect(isFindingBlocking(verified, "b".repeat(40))).toBe(true);
    expect(isFindingBlocking({ ...historical, status: "accepted" })).toBe(false);
    expect(
      findingStatusLabel({
        ...historical,
        status: "accepted",
        acceptedReason: "product contract",
      }),
    ).toBe("接受不修 · product contract");
    expect(
      isFindingVerifiedClosed({
        ...verified,
        verification: { ...verified.verification, runComplete: false },
      }),
    ).toBe(false);
  });
});

describe("countLedgerFindings", () => {
  it("counts status and severity independently", () => {
    const counts = countLedgerFindings([
      finding({ id: "a", title: "a", severity: "major" }),
      finding({ id: "b", title: "b", severity: "major", status: "closed" }),
      finding({ id: "c", title: "c", severity: "nit" }),
    ]);
    expect(counts.total).toBe(3);
    expect(counts.byStatus).toEqual({ open: 2, closed: 1, accepted: 0, regress: 0 });
    expect(counts.bySeverity).toEqual({ critical: 0, major: 2, minor: 0, nit: 1 });
  });
});
