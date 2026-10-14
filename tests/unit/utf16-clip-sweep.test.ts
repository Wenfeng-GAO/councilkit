import { reportFilename } from "@/components/room/ReportView";
import { clipLiveSummary } from "@shared/runtime/attempt-live-events";
import type { LedgerFinding } from "@shared/runtime/cli-ledger";
import type { DecisionsFile } from "@shared/runtime/review-explainer/contracts";
import { clipUtf16TailCodeUnits } from "@shared/runtime/seat-result";
import { describe, expect, it } from "vitest";
import { separateChangedAssertions } from "../../cli/src/auto/pr-decisions";

const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

function finding(
  partial: Partial<LedgerFinding> & Pick<LedgerFinding, "id" | "text">,
): LedgerFinding {
  return {
    severity: "major",
    status: "open",
    title: "title",
    source: "unique",
    reviewer: null,
    files: [],
    ...partial,
  };
}

describe("clipUtf16TailCodeUnits", () => {
  it("leaves a short string unchanged", () => {
    expect(clipUtf16TailCodeUnits("hello", 8)).toBe("hello");
  });

  it("drops a leading lone low surrogate when the cut lands inside an emoji", () => {
    expect(clipUtf16TailCodeUnits("a😀b", 2)).toBe("b");
    expect(clipUtf16TailCodeUnits("a😀b", 3)).toBe("😀b");
  });

  it("returns empty for max 0", () => {
    expect(clipUtf16TailCodeUnits("hello", 0)).toBe("");
  });
});

describe("reportFilename", () => {
  it("does not keep a lone surrogate when an emoji straddles char 50", () => {
    const name = reportFilename(`${"a".repeat(49)}😀bbbb`);
    expect(hasLoneSurrogate(name)).toBe(false);
    expect(name).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-report.md");
  });
});

describe("clipLiveSummary", () => {
  it("trims and drops a trailing lone high surrogate at the 240-unit cap", () => {
    expect(clipLiveSummary("  hi  ")).toBe("hi");
    const clipped = clipLiveSummary(`${"a".repeat(239)}😀`);
    expect(hasLoneSurrogate(clipped)).toBe(false);
    expect(clipped).toBe("a".repeat(239));
  });
});

describe("separateChangedAssertions", () => {
  it("does not keep a lone surrogate when the 140th unit is an emoji high half", () => {
    const id = `${"a".repeat(139)}😀x`;
    expect(id.length).toBeGreaterThan(140);
    expect(id.charCodeAt(139)).toBeGreaterThanOrEqual(0xd800);
    expect(id.charCodeAt(139)).toBeLessThanOrEqual(0xdbff);

    const decisions: DecisionsFile = {
      version: 1,
      revision: 1,
      items: {
        [id]: {
          findingId: id,
          decision: "wont_fix",
          originalAssertion: "old hole",
        },
      },
    };
    const row = separateChangedAssertions(
      [finding({ id, text: "old hole" })],
      [finding({ id, text: "new hole" })],
      decisions,
    )[0];
    if (row === undefined) throw new Error("expected a remapped finding");
    expect(hasLoneSurrogate(row.id)).toBe(false);
    expect(
      row.id.startsWith(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-new-",
      ),
    ).toBe(true);
  });
});
