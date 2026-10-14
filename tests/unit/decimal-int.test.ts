import { parseCanonicalInt, parseCanonicalPositiveInt } from "@shared/runtime/decimal-int";
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
