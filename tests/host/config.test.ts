import { loadConfig, resolveHostPort } from "@host/config";
import { CANONICAL_HOST_HEADER, CANONICAL_PORT } from "@shared/runtime/contracts";
import { describe, expect, it } from "vitest";

/**
 * The canonical origin (43127) is a product constraint: COUNCILKIT_PORT is an
 * E2E-only escape hatch and must fail loudly in every other context.
 */
describe("resolveHostPort", () => {
  it("keeps the canonical port by default and under an empty override", () => {
    expect(resolveHostPort({})).toBe(CANONICAL_PORT);
    expect(resolveHostPort({ COUNCILKIT_PORT: "" })).toBe(CANONICAL_PORT);
    expect(loadConfig({}).port).toBe(CANONICAL_PORT);
    expect(loadConfig({}).hostHeader).toBe(CANONICAL_HOST_HEADER);
  });

  it("honors the override only inside E2E runs", () => {
    expect(resolveHostPort({ COUNCILKIT_E2E: "1", COUNCILKIT_PORT: "45907" })).toBe(45907);
    expect(loadConfig({ COUNCILKIT_E2E: "1", COUNCILKIT_PORT: "45907" }).hostHeader).toBe(
      "127.0.0.1:45907",
    );
  });

  it("rejects an explicit override outside E2E runs", () => {
    expect(() => resolveHostPort({ COUNCILKIT_PORT: "45907" })).toThrow(/only allowed for E2E/);
    expect(() => loadConfig({ COUNCILKIT_PORT: "45907" })).toThrow(/only allowed for E2E/);
    expect(() => resolveHostPort({ COUNCILKIT_E2E: "0", COUNCILKIT_PORT: "45907" })).toThrow(
      /only allowed for E2E/,
    );
  });

  it("rejects non-integer strings instead of parsing a prefix", () => {
    for (const raw of ["123abc", " 123", "45907 ", "+45907", "0x1f", "45907.5"]) {
      expect(() => resolveHostPort({ COUNCILKIT_E2E: "1", COUNCILKIT_PORT: raw })).toThrow(
        /valid TCP port/,
      );
    }
  });

  it("rejects out-of-range ports", () => {
    expect(() => resolveHostPort({ COUNCILKIT_E2E: "1", COUNCILKIT_PORT: "0" })).toThrow(
      /valid TCP port/,
    );
    expect(() => resolveHostPort({ COUNCILKIT_E2E: "1", COUNCILKIT_PORT: "65536" })).toThrow(
      /valid TCP port/,
    );
  });
});
