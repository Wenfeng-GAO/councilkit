import { describe, expect, it } from "vitest";
import { clipFailureMessage } from "../src/run/orchestrator";

describe("clipFailureMessage", () => {
  it("does not split a surrogate pair at the 512-unit truncation boundary", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);

    // emoji straddles index 512: raw slice(0, 512) leaves a lone high surrogate
    const long = `${"a".repeat(511)}${emoji}${"x".repeat(20)}`;
    expect(long.length).toBeGreaterThan(512);

    const rawSlice = long.slice(0, 512);
    expect(rawSlice.endsWith("\uD83D")).toBe(true);
    expect(rawSlice.length).toBe(512);

    const clipped = clipFailureMessage(new Error(long));
    expect(clipped.length).toBeLessThanOrEqual(512);
    expect(clipped.includes("\uD83D")).toBe(false);
    expect(clipped.endsWith("\uD83D")).toBe(false);
    // Keep the ASCII prefix intact; drop the straddling emoji rather than split it.
    expect(clipped).toBe("a".repeat(511));
  });

  it("clips non-Error values the same way", () => {
    const emoji = "😀";
    const long = `${"b".repeat(511)}${emoji}${"y".repeat(20)}`;
    const rawSlice = String(long).slice(0, 512);
    expect(rawSlice.endsWith("\uD83D")).toBe(true);

    const clipped = clipFailureMessage(long);
    expect(clipped).toBe("b".repeat(511));
    expect(clipped.endsWith("\uD83D")).toBe(false);
  });

  it("passes through short messages unchanged", () => {
    expect(clipFailureMessage(new Error("short"))).toBe("short");
    expect(clipFailureMessage("also short")).toBe("also short");
  });
});
