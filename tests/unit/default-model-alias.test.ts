import {
  DEFAULT_MODEL_ALIASES,
  isDefaultModelAlias,
  isExactDefaultModelAlias,
} from "@shared/runtime/default-model-alias";
import { describe, expect, it } from "vitest";

describe("default model aliases", () => {
  it("recognizes auto, default, and configured after trim and lowercasing", () => {
    expect(DEFAULT_MODEL_ALIASES).toEqual(["auto", "default", "configured"]);
    for (const alias of DEFAULT_MODEL_ALIASES) {
      expect(isDefaultModelAlias(alias)).toBe(true);
      expect(isDefaultModelAlias(`  ${alias.toUpperCase()}  `)).toBe(true);
      expect(isExactDefaultModelAlias(alias)).toBe(true);
    }
  });

  it("keeps the exact check case-sensitive and untrimmed", () => {
    expect(isDefaultModelAlias(" AUTO ")).toBe(true);
    expect(isExactDefaultModelAlias(" AUTO ")).toBe(false);
    expect(isExactDefaultModelAlias("AUTO")).toBe(false);
    expect(isExactDefaultModelAlias("Default")).toBe(false);
  });

  it("rejects concrete ids and the other generic sentinels", () => {
    for (const modelId of ["grok-4.7-xhigh", "current", "-", "", " automatic "]) {
      expect(isDefaultModelAlias(modelId)).toBe(false);
      expect(isExactDefaultModelAlias(modelId)).toBe(false);
    }
  });
});
