import { describe, expect, it } from "vitest";
import { FINDING, MODULES } from "../../review-explainer/contract";
import { importFeature, requireExport } from "../../review-explainer/load-feature";

const sha = "a".repeat(40);
const runId = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01";

function ledger() {
  return {
    version: 1 as const,
    runId,
    extractedAt: "2026-09-23T00:00:00.000Z",
    sha,
    againstRunId: null,
    againstRange: null,
    findings: [
      {
        id: FINDING.busy,
        title: "prompt accepted then busy",
        severity: "major" as const,
        status: "open" as const,
        text: "Accept then busy. Counterexample: one request.",
        source: "consensus" as const,
        reviewer: "R",
        files: ["src/busy.go"],
      },
      {
        id: FINDING.stale,
        title: "stale generation",
        severity: "major" as const,
        status: "open" as const,
        text: "check-time != commit-time",
        source: "consensus" as const,
        reviewer: "R",
        files: ["src/recovery.go"],
      },
      {
        id: FINDING.dup,
        title: "duplicate string",
        severity: "nit" as const,
        status: "open" as const,
        text: "optional extract",
        source: "unique" as const,
        reviewer: "R",
        files: ["src/recovery.go"],
      },
    ],
  };
}

describe("A06 buildRepairPackageFromSelection", () => {
  it("exports only will_fix items and keeps undecided out of the package", async () => {
    const mod = await importFeature<Record<string, unknown>>(MODULES.repairSelection);
    const build = requireExport<
      (input: Record<string, unknown>) => {
        findings: Array<{ id: string; evidence: string }>;
        constraints: { deferred: Array<{ id: string }> };
      }
    >(mod, "buildRepairPackageFromSelection", MODULES.repairSelection);
    const pkg = build({
      runId,
      complete: true,
      prUrl: "https://github.com/acme-explainer/fixture/pull/1",
      ledger: ledger(),
      selectedFindingIds: [FINDING.busy],
      decisions: {
        [FINDING.busy]: "will_fix",
        [FINDING.stale]: "wont_fix",
        [FINDING.dup]: "undecided",
      },
    });
    expect(pkg.findings.map((row) => row.id)).toEqual([FINDING.busy]);
    expect(pkg.findings[0]?.evidence).toContain("Counterexample");
    expect(pkg.constraints.deferred.some((row) => row.id === FINDING.dup)).toBe(true);
    expect(pkg.findings.some((row) => row.id === FINDING.stale)).toBe(false);
    expect(pkg.findings.some((row) => row.id === FINDING.dup)).toBe(false);
  });

  it("refuses to mark will_fix or a builder claim as verified_closed", async () => {
    const mod = await importFeature<Record<string, unknown>>(MODULES.repairSelection);
    const build = requireExport<(input: Record<string, unknown>) => Record<string, unknown>>(
      mod,
      "buildRepairPackageFromSelection",
      MODULES.repairSelection,
    );
    const pkg = build({
      runId,
      complete: true,
      prUrl: "https://github.com/acme-explainer/fixture/pull/1",
      ledger: ledger(),
      selectedFindingIds: [FINDING.busy],
      decisions: { [FINDING.busy]: "will_fix" },
      builderClaimedIds: [FINDING.busy],
    });
    expect(JSON.stringify(pkg)).not.toContain("verified_closed");
  });
});
