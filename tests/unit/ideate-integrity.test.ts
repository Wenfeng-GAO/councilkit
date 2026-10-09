import { ideateStageLabel, oneLineIdeateMessage } from "@/lib/ideate-integrity";
import { describe, expect, it } from "vitest";

describe("ideate integrity display", () => {
  it("labels failed seats and collapses smoke messages", () => {
    expect(ideateStageLabel("proposal")).toBe("提案");
    expect(ideateStageLabel("debate")).toBe("辩论");
    expect(
      oneLineIdeateMessage("non-zero exit 1\nerror: Cannot combine --prompt with --plan."),
    ).toBe("non-zero exit 1 error: Cannot combine --prompt with --plan.");
  });

  it("does not split a surrogate pair at the one-line truncation boundary", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);

    // emoji straddles max-1 (159): raw slice leaves a lone high surrogate before …
    const over = `${"a".repeat(158)}${emoji}tail`;
    expect(over.length).toBeGreaterThan(160);
    const clipped = oneLineIdeateMessage(over, 160);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped.length).toBeLessThanOrEqual(160);
    const beforeEllipsis = clipped.slice(0, -1);
    const last = beforeEllipsis.charCodeAt(beforeEllipsis.length - 1);
    expect(last < 0xd800 || last > 0xdbff).toBe(true);
    expect(clipped).toBe(`${"a".repeat(158)}…`);
  });
});
