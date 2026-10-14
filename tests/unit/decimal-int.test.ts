import {
  decimalIntExceeds,
  parseCanonicalInt,
  parseCanonicalPositiveInt,
} from "@shared/runtime/decimal-int";
import { describe, expect, it } from "vitest";

describe("parseCanonicalInt", () => {
  it("accepts the canonical spelling of a safe integer", () => {
    expect(parseCanonicalInt("0")).toBe(0);
    expect(parseCanonicalInt("3")).toBe(3);
    expect(parseCanonicalInt("9007199254740991")).toBe(9_007_199_254_740_991);
  });

  it("rejects a spelling that would become a different number", () => {
    for (const raw of [
      "",
      " ",
      "2abc",
      "1.9",
      "-1",
      "+5",
      "01",
      "0x10",
      "1e2",
      "9007199254740993",
      "9".repeat(400),
    ]) {
      expect(parseCanonicalInt(raw), raw).toBeNull();
    }
  });
});

describe("parseCanonicalPositiveInt", () => {
  it("rejects zero and accepts one", () => {
    expect(parseCanonicalPositiveInt("0")).toBeNull();
    expect(parseCanonicalPositiveInt("1")).toBe(1);
    expect(parseCanonicalPositiveInt("2abc")).toBeNull();
  });
});

describe("decimalIntExceeds", () => {
  const limit = 4 * 1024 * 1024;

  it("compares a digit string that Number cannot represent", () => {
    expect(decimalIntExceeds("9999999999999999999", limit)).toBe(true);
    expect(decimalIntExceeds("9007199254740993", limit)).toBe(true);
    expect(decimalIntExceeds("0000004194305", limit)).toBe(true);
    expect(decimalIntExceeds(String(limit + 1), limit)).toBe(true);
  });

  it("does not treat a smaller or equal length as over the limit", () => {
    expect(decimalIntExceeds(String(limit), limit)).toBe(false);
    expect(decimalIntExceeds("0000000007", limit)).toBe(false);
    expect(decimalIntExceeds("0", limit)).toBe(false);
    expect(decimalIntExceeds("5abc", limit)).toBe(false);
    expect(decimalIntExceeds("1.9", limit)).toBe(false);
    expect(decimalIntExceeds("", limit)).toBe(false);
  });
});
