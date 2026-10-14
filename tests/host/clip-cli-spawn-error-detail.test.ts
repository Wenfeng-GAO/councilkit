import { CLI_SPAWN_ERROR_DETAIL_MAX } from "@host/routes/cli-runs";
import { clipUtf16 } from "@shared/text/clip-utf16";
import { describe, expect, it } from "vitest";

describe("cli spawn error detail clip", () => {
  it("keeps the spawn detail budget at 1024 UTF-16 code units", () => {
    expect(CLI_SPAWN_ERROR_DETAIL_MAX).toBe(1024);
  });

  it("does not split a surrogate pair at the detail-limit boundary", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);

    // emoji straddles the limit: raw slice leaves a lone high surrogate
    const long = `${"a".repeat(CLI_SPAWN_ERROR_DETAIL_MAX - 1)}${emoji}${"x".repeat(20)}`;
    expect(long.length).toBeGreaterThan(CLI_SPAWN_ERROR_DETAIL_MAX);

    const rawSlice = long.slice(0, CLI_SPAWN_ERROR_DETAIL_MAX);
    expect(rawSlice.endsWith("\uD83D")).toBe(true);
    expect(rawSlice.length).toBe(CLI_SPAWN_ERROR_DETAIL_MAX);

    const clipped = clipUtf16(long, CLI_SPAWN_ERROR_DETAIL_MAX);
    expect(clipped.length).toBeLessThanOrEqual(CLI_SPAWN_ERROR_DETAIL_MAX);
    expect(clipped.endsWith("\uD83D")).toBe(false);
    // Keep the ASCII prefix intact; drop the straddling emoji rather than split it.
    expect(clipped).toBe("a".repeat(CLI_SPAWN_ERROR_DETAIL_MAX - 1));
  });

  it("passes through short messages unchanged", () => {
    expect(clipUtf16("short", CLI_SPAWN_ERROR_DETAIL_MAX)).toBe("short");
    expect(clipUtf16("failed to spawn councilkit", CLI_SPAWN_ERROR_DETAIL_MAX)).toBe(
      "failed to spawn councilkit",
    );
  });
});
