import { describe, expect, it } from "vitest";
import { clipUtf8 } from "../src/auto/templates/ideate";

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
