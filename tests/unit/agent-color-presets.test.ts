import {
  AGENT_COLOR_PRESETS,
  findAgentColorPreset,
  isAgentColorPreset,
} from "@/models/discussion/agent-colors";
import { describe, expect, it } from "vitest";

/**
 * Closed agent color swatches. Membership is case-insensitive; the stored
 * preset value stays lowercase.
 */

const PRESETS = [
  { name: "靛蓝", value: "#4f6ef7" },
  { name: "玫红", value: "#f74f6e" },
  { name: "翠绿", value: "#4ff76e" },
  { name: "琥珀", value: "#f59e0b" },
  { name: "天蓝", value: "#38bdf8" },
  { name: "紫罗兰", value: "#a78bfa" },
  { name: "青色", value: "#22d3ee" },
  { name: "石灰", value: "#a3e635" },
  { name: "橙红", value: "#f97316" },
  { name: "板岩", value: "#94a3b8" },
] as const;

describe("AGENT_COLOR_PRESETS", () => {
  it("is the ten named swatches in product order", () => {
    expect(AGENT_COLOR_PRESETS).toEqual(PRESETS);
  });
});

describe("isAgentColorPreset and findAgentColorPreset", () => {
  it("matches every preset in lowercase, uppercase, and mixed case", () => {
    expect(findAgentColorPreset("#4F6eF7")).toEqual({ name: "靛蓝", value: "#4f6ef7" });
    expect(isAgentColorPreset("#4F6eF7")).toBe(true);

    for (const preset of PRESETS) {
      expect(isAgentColorPreset(preset.value)).toBe(true);
      expect(isAgentColorPreset(preset.value.toUpperCase())).toBe(true);
      expect(findAgentColorPreset(preset.value)).toEqual({
        name: preset.name,
        value: preset.value,
      });
      expect(findAgentColorPreset(preset.value.toUpperCase())).toEqual({
        name: preset.name,
        value: preset.value,
      });
    }
  });

  it("rejects hex values outside the closed set", () => {
    const outsiders = ["", "#a1b2c3", "#4f6ef7 ", "#F74F6EAA", "indigo", "#4f6ef", "#94a3b8ff"];
    for (const hex of outsiders) {
      expect(isAgentColorPreset(hex)).toBe(false);
      expect(findAgentColorPreset(hex)).toBeNull();
    }
  });
});
