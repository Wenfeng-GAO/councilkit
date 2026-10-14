import { CODEX_RPC_ERROR_DETAIL_MAX } from "@host/drivers/codex-app-server";
import { clipUtf16 } from "@shared/text/clip-utf16";
import { describe, expect, it } from "vitest";

describe("codex RPC error detail clip", () => {
  it("keeps the RPC detail budget at 300 UTF-16 code units", () => {
    expect(CODEX_RPC_ERROR_DETAIL_MAX).toBe(300);
  });

  it("does not split a surrogate pair at the detail-limit boundary", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);

    // emoji straddles the limit: raw slice leaves a lone high surrogate
    const long = `${"a".repeat(CODEX_RPC_ERROR_DETAIL_MAX - 1)}${emoji}${"x".repeat(20)}`;
    expect(long.length).toBeGreaterThan(CODEX_RPC_ERROR_DETAIL_MAX);

    const rawSlice = long.slice(0, CODEX_RPC_ERROR_DETAIL_MAX);
    expect(rawSlice.endsWith("\uD83D")).toBe(true);
    expect(rawSlice.length).toBe(CODEX_RPC_ERROR_DETAIL_MAX);

    const clipped = clipUtf16(long, CODEX_RPC_ERROR_DETAIL_MAX);
    expect(clipped.length).toBeLessThanOrEqual(CODEX_RPC_ERROR_DETAIL_MAX);
    expect(clipped.endsWith("\uD83D")).toBe(false);
    // Keep the ASCII prefix intact; drop the straddling emoji rather than split it.
    expect(clipped).toBe("a".repeat(CODEX_RPC_ERROR_DETAIL_MAX - 1));
  });

  it("passes through short messages unchanged", () => {
    expect(clipUtf16("short", CODEX_RPC_ERROR_DETAIL_MAX)).toBe("short");
    expect(clipUtf16('{"code":"failed"}', CODEX_RPC_ERROR_DETAIL_MAX)).toBe('{"code":"failed"}');
  });
});
