import { fullSha } from "@shared/runtime/repair-identity";
import { describe, expect, it } from "vitest";

const LOWER = "9c0e83b83496b47590667532e71b2ffdca9fd7de";

describe("fullSha", () => {
  it("returns a lowercase 40-hex commit", () => {
    expect(fullSha(LOWER)).toBe(LOWER);
    expect(fullSha(LOWER.toUpperCase())).toBe(LOWER);
  });

  it("rejects anything that is not a 40-hex commit", () => {
    expect(fullSha(null)).toBeNull();
    expect(fullSha(undefined)).toBeNull();
    expect(fullSha("")).toBeNull();
    expect(fullSha(`${LOWER}a`)).toBeNull();
    expect(fullSha(LOWER.slice(0, 39))).toBeNull();
    expect(fullSha(` ${LOWER}`)).toBeNull();
    expect(fullSha(1)).toBeNull();
    expect(fullSha({ sha: LOWER })).toBeNull();
  });
});
