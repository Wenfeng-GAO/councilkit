import { oneLineIdeateMessage } from "@/lib/ideate-integrity";
import {
  REPAIR_OBS_SUMMARY_MAX,
  type RawSourceRecord,
  foldPublicText,
} from "@shared/runtime/repair-observation";
import { SEAT_RESULT_SUMMARY_MAX, clipSeatSummary } from "@shared/runtime/seat-result";
import { clipUtf16, clipUtf16Tail } from "@shared/text/clip-utf16";
import { describe, expect, it } from "vitest";

const EMOJI = "😀";
const CJK = "审";

function loneSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

describe("clipUtf16", () => {
  it("returns an empty string for an empty value, a zero budget, or a negative budget", () => {
    expect(clipUtf16("", 8)).toBe("");
    expect(clipUtf16("hello", 0)).toBe("");
    expect(clipUtf16("hello", -4)).toBe("");
    expect(clipUtf16("hello", -1, "…")).toBe("");
  });

  it("returns the original string when it already fits, including an exact-length CJK value", () => {
    expect(clipUtf16("exact", 5)).toBe("exact");
    expect(clipUtf16(CJK.repeat(4), 4)).toBe(CJK.repeat(4));
    expect(clipUtf16(`${CJK.repeat(3)}${EMOJI}`, 5)).toBe(`${CJK.repeat(3)}${EMOJI}`);
  });

  it("clips BMP and CJK text on the code-unit budget", () => {
    expect(clipUtf16(CJK.repeat(5), 3)).toBe(CJK.repeat(3));
    expect(clipUtf16("abcdef", 3)).toBe("abc");
  });

  it("backs off when an emoji straddles the cut", () => {
    const value = `${"a".repeat(3)}${EMOJI}tail`;
    expect(value.length).toBe(9);
    expect(value.slice(0, 4).endsWith("\uD83D")).toBe(true);

    const clipped = clipUtf16(value, 4);
    expect(clipped).toBe("aaa");
    expect(clipped.endsWith("\uD83D")).toBe(false);
    expect(loneSurrogate(clipped)).toBe(false);
  });

  it("counts the suffix toward the budget and omits it when the value already fits", () => {
    expect(clipUtf16("short", 10, "…")).toBe("short");
    expect(clipUtf16(CJK.repeat(5), 4, "…")).toBe(`${CJK.repeat(3)}…`);
    expect(clipUtf16(`${"a".repeat(3)}${EMOJI}tail`, 5, "…")).toBe("aaa…");
    expect(clipUtf16("abcdef", 2, "...")).toBe("..");
  });
});

describe("clipUtf16Tail", () => {
  it("returns the original string when it fits, and empty for a non-positive budget", () => {
    expect(clipUtf16Tail("tail", 4)).toBe("tail");
    expect(clipUtf16Tail("tail", 0)).toBe("");
    expect(clipUtf16Tail("tail", -2)).toBe("");
    expect(clipUtf16Tail("", 3)).toBe("");
  });

  it("keeps a CJK tail and a whole emoji that still fits", () => {
    expect(clipUtf16Tail(CJK.repeat(6), 3)).toBe(CJK.repeat(3));
    const value = `${"a".repeat(4)}${EMOJI}`;
    expect(clipUtf16Tail(value, 2)).toBe(EMOJI);
    expect(loneSurrogate(clipUtf16Tail(value, 2))).toBe(false);
  });

  it("skips a low surrogate when the tail would start in the middle of an emoji", () => {
    const value = `${"a".repeat(4)}${EMOJI}bc`;
    // Last 3 units would be the low surrogate of 😀 plus "bc".
    expect(value.slice(-3).charCodeAt(0)).toBe(0xde00);

    const clipped = clipUtf16Tail(value, 3);
    expect(clipped).toBe("bc");
    expect(loneSurrogate(clipped)).toBe(false);
  });

  it("counts a prefix toward the budget", () => {
    const value = `${CJK.repeat(6)}end`;
    expect(clipUtf16Tail(value, 4, "…")).toBe("…end");
    expect(clipUtf16Tail(`${"a".repeat(4)}${EMOJI}z`, 3, "…")).toBe("…z");
  });
});

describe("clipUtf16 call sites", () => {
  it("clipSeatSummary trims and drops an emoji that straddles the seat cap", () => {
    expect(clipSeatSummary(null)).toBeNull();
    expect(clipSeatSummary("   ")).toBeNull();
    expect(clipSeatSummary("  短  ")).toBe("短");

    const over = `  ${"a".repeat(SEAT_RESULT_SUMMARY_MAX - 1)}${EMOJI}  `;
    const clipped = clipSeatSummary(over);
    expect(clipped).toBe("a".repeat(SEAT_RESULT_SUMMARY_MAX - 1));
    expect(loneSurrogate(clipped ?? "")).toBe(false);
  });

  it("foldPublicText keeps a CJK prefix and a whole emoji under the observation cap", () => {
    const record = (text: string): RawSourceRecord => ({
      sourceId: "s",
      sourceGeneration: "g",
      executionRef: "e",
      round: 1,
      roleKey: "builder",
      byteOffset: 1,
      receivedAt: "2026-09-22T06:00:00Z",
      occurredAt: null,
      type: "text",
      callId: null,
      text,
    });
    expect(foldPublicText([record(CJK.repeat(3))])[0]?.summary).toBe(CJK.repeat(3));
    const over = `${"a".repeat(REPAIR_OBS_SUMMARY_MAX - 1)}${EMOJI}`;
    const clipped = foldPublicText([record(over)])[0]?.summary ?? "";
    expect(clipped).toBe("a".repeat(REPAIR_OBS_SUMMARY_MAX - 1));
    expect(clipped.length).toBeLessThanOrEqual(REPAIR_OBS_SUMMARY_MAX);
    expect(loneSurrogate(clipped)).toBe(false);
  });

  it("oneLineIdeateMessage counts the ellipsis inside the caller's budget", () => {
    expect(oneLineIdeateMessage(CJK.repeat(160))).toBe(CJK.repeat(160));
    expect(oneLineIdeateMessage(CJK.repeat(161))).toBe(`${CJK.repeat(159)}…`);
    expect(oneLineIdeateMessage(`${"a".repeat(158)}${EMOJI}tail`).length).toBeLessThanOrEqual(160);
  });
});
