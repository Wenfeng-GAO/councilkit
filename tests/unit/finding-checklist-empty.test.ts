import { buildFindingChecklist } from "@/lib/finding-checklist";
import type { CliRunDetailResponse } from "@shared/runtime/schemas";
import { describe, expect, it } from "vitest";

describe("buildFindingChecklist empty filter", () => {
  it("returns the bare empty sentence when the header is omitted", () => {
    const run = {
      runId: "ck-review-empty",
      findings: [],
      findingGroups: null,
      reviewEvidence: null,
    } as unknown as CliRunDetailResponse;
    expect(buildFindingChecklist(run, { includeHeader: false, filter: "all" })).toBe(
      "当前筛选无问题。",
    );
  });
});
