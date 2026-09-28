import {
  findingDisplayStatus,
  findingMatchesFile,
  hasDiffLocation,
  initialReviewFilters,
  isActiveFinding,
  matchesFinding,
} from "@/components/report/explainer/view-model";
import type { DiffFile, ExplainerFinding } from "@shared/runtime/review-explainer/contracts";
import { describe, expect, it } from "vitest";

const finding: ExplainerFinding = {
  id: "stable-lease",
  title: "Lease cleanup is missing",
  text: "The lease may remain locked after a timeout.",
  severity: "major",
  status: "open",
  source: "consensus",
  reviewer: null,
  files: ["src/old.ts"],
  decision: "undecided",
  anchors: [{ status: "resolved", path: "src/old.ts", side: "old", line: 9 }],
};
const renamed: DiffFile = {
  path: "src/new.ts",
  oldPath: "src/old.ts",
  newPath: "src/new.ts",
  status: "renamed",
  binary: false,
  additions: 1,
  deletions: 1,
  hunks: [
    {
      oldStart: 9,
      oldLines: 1,
      newStart: 11,
      newLines: 1,
      header: "@@ -9 +11 @@",
      lines: [
        { type: "delete", oldLine: 9, newLine: null, text: "release();" },
        { type: "add", oldLine: null, newLine: 11, text: "return;" },
      ],
    },
  ],
};

describe("review workspace navigation semantics", () => {
  it("keeps regressions active but does not turn accepted issues into unresolved work", () => {
    expect(isActiveFinding(finding)).toBe(true);
    expect(isActiveFinding({ ...finding, status: "regress" })).toBe(true);
    expect(isActiveFinding({ ...finding, status: "accepted" })).toBe(false);
    expect(
      matchesFinding({ ...finding, status: "accepted" }, 7, "undecided", initialReviewFilters),
    ).toBe(false);
  });

  it("keeps historical closures actionable until evidence verifies the current frozen commit", () => {
    const headSha = "a".repeat(40);
    const legacy: ExplainerFinding = { ...finding, status: "closed" };
    const verified: ExplainerFinding = {
      ...legacy,
      verification: {
        outcome: "verified_closed",
        candidateSha: headSha,
        runId: "ck-review-fixture",
        attemptId: "attempt-1",
        reviewer: "review-correctness",
        method: "code_trace",
        reason: "Cleanup is restored",
        evidence: "The release call precedes return",
        locations: ["src/new.ts:11"],
        runComplete: true,
      },
    };
    expect(isActiveFinding(legacy, headSha)).toBe(true);
    expect(findingDisplayStatus(legacy, headSha)).toBe("历史未验证");
    expect(isActiveFinding(verified, headSha)).toBe(false);
    expect(matchesFinding(verified, 7, "undecided", initialReviewFilters, headSha)).toBe(false);
    expect(
      matchesFinding(
        legacy,
        7,
        "undecided",
        { ...initialReviewFilters, status: "closed" },
        headSha,
      ),
    ).toBe(false);
    expect(isActiveFinding(verified, "b".repeat(40))).toBe(true);
    expect(findingDisplayStatus(verified, "b".repeat(40))).toBe("待验证当前提交");
  });

  it("combines stable numbers, status, severity and persisted decision without conflating them", () => {
    const filters = { ...initialReviewFilters, query: "#7", decision: "will_fix" as const };
    expect(matchesFinding(finding, 7, "will_fix", filters)).toBe(true);
    expect(matchesFinding(finding, 7, "undecided", filters)).toBe(false);
    expect(matchesFinding(finding, 3, "will_fix", filters)).toBe(false);
    expect(matchesFinding(finding, 7, "will_fix", { ...filters, severity: "nit" })).toBe(false);
    expect(
      matchesFinding({ ...finding, status: "accepted" }, 7, "will_fix", {
        ...filters,
        status: "all",
      }),
    ).toBe(true);
  });

  it("counts old-path findings on a renamed file while retaining their old-side location", () => {
    expect(findingMatchesFile(finding, renamed)).toBe(true);
    expect(hasDiffLocation([renamed], { path: "src/old.ts", side: "old", line: 9 })).toBe(true);
    expect(hasDiffLocation([renamed], { path: "src/new.ts", side: "old", line: 9 })).toBe(false);
    expect(hasDiffLocation([renamed], { path: "src/new.ts", side: "new", line: 9 })).toBe(false);
    expect(hasDiffLocation([renamed], { path: "src/new.ts", side: "new", line: 11 })).toBe(true);
    expect(finding.anchors[0].path).toBe("src/old.ts");
  });
});
