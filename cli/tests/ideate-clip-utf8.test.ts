import { clipUtf16 } from "@shared/text/clip-utf16";
import { describe, expect, it } from "vitest";
import { clipUtf8, extractSuccessfulProposal } from "../src/auto/templates/ideate";

const IDEA = `a${"👍".repeat(40)}`;

function keptBody(clipped: string): string {
  return clipped.split("\n\n[…")[0] ?? clipped;
}

describe("clipUtf8", () => {
  it("keeps a whole emoji when the byte budget lands inside one", () => {
    const clipped = clipUtf8(IDEA, 48, "idea");
    expect(clipped.truncated).toBe(true);
    expect(keptBody(clipped.text)).toBe("a");
    expect(clipped.bytes).toBeLessThanOrEqual(48);
    expect(Buffer.from(clipped.text, "utf8").toString("utf8")).toBe(clipped.text);
  });

  it("keeps an emoji that still fits in the remaining budget", () => {
    const clipped = clipUtf8(IDEA, 49, "idea");
    expect(clipped.truncated).toBe(true);
    expect(clipped.bytes).toBeLessThanOrEqual(49);
    expect(keptBody(clipped.text)).toBe("a👍");
  });
});

describe("extractSuccessfulProposal UTF-16 boundary", () => {
  it("does not split a surrogate pair at the 600-unit summary truncation boundary", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);

    // emoji straddles index 600: raw slice(0, 600) leaves a lone high surrogate
    const firstParagraph = `${"a".repeat(599)}${emoji}${"x".repeat(20)}`;
    expect(firstParagraph.length).toBeGreaterThan(600);

    const rawSlice = firstParagraph.split("\n").slice(0, 8).join("\n").slice(0, 600);
    expect(rawSlice.endsWith("\uD83D")).toBe(true);
    expect(rawSlice.length).toBe(600);

    const result = extractSuccessfulProposal(firstParagraph, "proposal-1");
    expect(result).not.toBeNull();
    const summary = result!.summary;
    expect(summary.length).toBeLessThanOrEqual(600);
    expect(summary.includes("\uD83D")).toBe(false);
    expect(summary.endsWith("\uD83D")).toBe(false);
    // Keep the ASCII prefix; drop the straddling emoji rather than split it.
    expect(summary).toBe(clipUtf16(firstParagraph, 600));
    expect(summary).toBe("a".repeat(599));
  });

  it("still keeps the first eight lines before the UTF-16 clip", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line-${i}`);
    const body = lines.join("\n");
    const result = extractSuccessfulProposal(body, "proposal-2");
    expect(result).not.toBeNull();
    expect(result!.summary).toBe(lines.slice(0, 8).join("\n"));
  });
});
