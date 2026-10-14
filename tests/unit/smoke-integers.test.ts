import { describe, expect, it } from "vitest";
import { positiveIntOverride, requiredPositiveInt } from "../smoke/smoke-integers";

describe("smoke integer gates", () => {
  it("keeps the real soak floor when the override is not that integer", () => {
    expect(positiveIntOverride("2abc", 10)).toBe(10);
    expect(positiveIntOverride("1.9", 15 * 60 * 1000)).toBe(15 * 60 * 1000);
    expect(positiveIntOverride("1e5", 90_000)).toBe(90_000);
    expect(positiveIntOverride("01", 10)).toBe(10);
    expect(positiveIntOverride("", 10)).toBe(10);
    expect(positiveIntOverride(undefined, 10)).toBe(10);
  });

  it("accepts a canonical soak override", () => {
    expect(positiveIntOverride("2", 10)).toBe(2);
  });

  it("rejects a prefix round count", () => {
    expect(() => requiredPositiveInt("2abc", "rounds")).toThrow(
      /--rounds requires a positive integer/,
    );
    expect(() => requiredPositiveInt("1.9", "rounds")).toThrow(/positive integer/);
    expect(() => requiredPositiveInt(undefined, "rounds")).toThrow(/positive integer/);
    expect(requiredPositiveInt("3", "rounds")).toBe(3);
  });
});
