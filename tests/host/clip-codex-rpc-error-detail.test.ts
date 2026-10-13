import { describe, expect, it } from "vitest";
import { clipCodexRpcErrorDetail } from "@host/drivers/codex-app-server";

describe("clipCodexRpcErrorDetail", () => {
  it("does not split a surrogate pair at the 300-unit truncation boundary", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);

    // emoji straddles index 300: raw slice(0, 300) leaves a lone high surrogate
    const long = `${"a".repeat(299)}${emoji}${"x".repeat(20)}`;
    expect(long.length).toBeGreaterThan(300);

    const rawSlice = long.slice(0, 300);
    expect(rawSlice.endsWith("\uD83D")).toBe(true);
    expect(rawSlice.length).toBe(300);

    const clipped = clipCodexRpcErrorDetail(long);
    expect(clipped.length).toBeLessThanOrEqual(300);
    expect(clipped.endsWith("\uD83D")).toBe(false);
    // Keep the ASCII prefix intact; drop the straddling emoji rather than split it.
    expect(clipped).toBe("a".repeat(299));
  });

  it("passes through short messages unchanged", () => {
    expect(clipCodexRpcErrorDetail("short")).toBe("short");
    expect(clipCodexRpcErrorDetail('{"code":"failed"}')).toBe('{"code":"failed"}');
  });
});
