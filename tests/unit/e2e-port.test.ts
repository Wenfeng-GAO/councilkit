import { CANONICAL_PORT } from "@shared/runtime/contracts";
import { describe, expect, it } from "vitest";
import { resolveE2ePort } from "../e2e/e2e-port";

describe("resolveE2ePort", () => {
  it("defaults to the canonical host", () => {
    expect(resolveE2ePort(undefined)).toBe(CANONICAL_PORT);
    expect(resolveE2ePort("")).toBe(CANONICAL_PORT);
  });

  it("accepts a canonical port", () => {
    expect(resolveE2ePort("45907")).toBe(45907);
  });

  it("rejects a padded port that would bind the canonical host", () => {
    expect(() => resolveE2ePort("01")).toThrow(/valid TCP port/);
    expect(() => resolveE2ePort("043127")).toThrow(/valid TCP port/);
    expect(() => resolveE2ePort("45907x")).toThrow(/valid TCP port/);
    expect(() => resolveE2ePort("0")).toThrow(/valid TCP port/);
    expect(() => resolveE2ePort("65536")).toThrow(/valid TCP port/);
  });
});
