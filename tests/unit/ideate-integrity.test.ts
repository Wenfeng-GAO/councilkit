import { describe, expect, it } from "vitest";
import { ideateStageLabel, oneLineIdeateMessage } from "@/lib/ideate-integrity";

describe("ideate integrity display", () => {
  it("labels failed seats and collapses smoke messages", () => {
    expect(ideateStageLabel("proposal")).toBe("提案");
    expect(ideateStageLabel("debate")).toBe("辩论");
    expect(
      oneLineIdeateMessage("non-zero exit 1\nerror: Cannot combine --prompt with --plan."),
    ).toBe("non-zero exit 1 error: Cannot combine --prompt with --plan.");
  });
});
