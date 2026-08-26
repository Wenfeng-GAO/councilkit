import {
  type LedgerFinding,
  countLedgerFindings,
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
