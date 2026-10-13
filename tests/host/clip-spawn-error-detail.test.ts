import { describe, expect, it } from "vitest";
import { clipSpawnErrorDetail } from "@host/process/process-supervisor";

describe("clipSpawnErrorDetail", () => {
  it("does not split a surrogate pair at the 512-unit truncation boundary", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);

    // emoji straddles index 512: raw slice(0, 512) leaves a lone high surrogate
    const long = `${"a".repeat(511)}${emoji}${"x".repeat(20)}`;
    expect(long.length).toBeGreaterThan(512);

    const rawSlice = long.slice(0, 512);
    expect(rawSlice.endsWith("\uD83D")).toBe(true);
    expect(rawSlice.length).toBe(512);

    const clipped = clipSpawnErrorDetail(long);
    expect(clipped.length).toBeLessThanOrEqual(512);
    expect(clipped.endsWith("\uD83D")).toBe(false);
    // Keep the ASCII prefix intact; drop the straddling emoji rather than split it.
    expect(clipped).toBe("a".repeat(511));
  });

  it("passes through short messages unchanged", () => {
    expect(clipSpawnErrorDetail("short")).toBe("short");
    expect(clipSpawnErrorDetail("driver cwd must not be a symlink")).toBe(
      "driver cwd must not be a symlink",
    );
  });
});
