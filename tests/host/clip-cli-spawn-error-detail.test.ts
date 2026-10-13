import { describe, expect, it } from "vitest";
import { clipCliSpawnErrorDetail } from "@host/routes/cli-runs";

describe("clipCliSpawnErrorDetail", () => {
  it("does not split a surrogate pair at the 1024-unit truncation boundary", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);

    // emoji straddles index 1024: raw slice(0, 1024) leaves a lone high surrogate
    const long = `${"a".repeat(1023)}${emoji}${"x".repeat(20)}`;
    expect(long.length).toBeGreaterThan(1024);

    const rawSlice = long.slice(0, 1024);
    expect(rawSlice.endsWith("\uD83D")).toBe(true);
    expect(rawSlice.length).toBe(1024);

    const clipped = clipCliSpawnErrorDetail(long);
    expect(clipped.length).toBeLessThanOrEqual(1024);
    expect(clipped.endsWith("\uD83D")).toBe(false);
    // Keep the ASCII prefix intact; drop the straddling emoji rather than split it.
    expect(clipped).toBe("a".repeat(1023));
  });

  it("passes through short messages unchanged", () => {
    expect(clipCliSpawnErrorDetail("short")).toBe("short");
    expect(clipCliSpawnErrorDetail("failed to spawn councilkit")).toBe(
      "failed to spawn councilkit",
    );
  });
});
