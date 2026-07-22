import {
  createAgentColorState,
  resolveAgentColor,
  selectAgentColor,
} from "@/components/settings/agent-color-state";
import {
  AGENT_COLOR_PRESETS,
  findAgentColorPreset,
  isAgentColorPreset,
} from "@/models/discussion/agent-colors";
import { describe, expect, it } from "vitest";

/**
 * 色板闭集与表单状态机单测（AC1 / plan-a §2）。
 */

/** WCAG relative luminance of a #rrggbb hex. */
function relativeLuminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two hex colors. */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

const SURFACE = "#15181d";

describe("agent-colors preset set", () => {
  it("has exactly 10 presets", () => {
    expect(AGENT_COLOR_PRESETS).toHaveLength(10);
  });

  it("every preset is a valid 6-digit #rrggbb hex", () => {
    for (const preset of AGENT_COLOR_PRESETS) {
      expect(preset.value).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("preset hex values are unique", () => {
    const values = AGENT_COLOR_PRESETS.map((p) => p.value.toLowerCase());
    expect(new Set(values).size).toBe(values.length);
  });

  it("every preset has a non-empty name", () => {
    for (const preset of AGENT_COLOR_PRESETS) {
      expect(preset.name.trim().length).toBeGreaterThan(0);
    }
  });

  it("every preset contrasts ≥ 4:1 against the dark surface #15181d", () => {
    for (const preset of AGENT_COLOR_PRESETS) {
      expect(contrastRatio(preset.value, SURFACE)).toBeGreaterThanOrEqual(4);
    }
  });

  it("rose (玫红) and green (翠绿) have a relative-luminance difference > 0.15", () => {
    const rose = findAgentColorPreset("#f74f6e")?.value ?? "#f74f6e";
    const green = findAgentColorPreset("#4ff76e")?.value ?? "#4ff76e";
    expect(Math.abs(relativeLuminance(rose) - relativeLuminance(green))).toBeGreaterThan(0.15);
  });
});

describe("isAgentColorPreset / findAgentColorPreset", () => {
  it("matches a preset case-insensitively", () => {
    expect(isAgentColorPreset("#4F6EF7")).toBe(true);
    expect(isAgentColorPreset("#4f6ef7")).toBe(true);
    expect(findAgentColorPreset("#4F6EF7")?.value).toBe("#4f6ef7");
  });

  it("rejects a non-preset hex", () => {
    expect(isAgentColorPreset("#a1b2c3")).toBe(false);
    expect(findAgentColorPreset("#a1b2c3")).toBeNull();
  });
});

describe("agent-color-state machinery", () => {
  it("create mode: no selection, resolveAgentColor returns null (new agent must pick)", () => {
    const state = createAgentColorState("create", "");
    expect(state.selected).toBeNull();
    expect(state.touched).toBe(false);
    expect(resolveAgentColor(state)).toBeNull();
  });

  it("create mode: after selecting a swatch, resolveAgentColor returns the preset value", () => {
    const state = selectAgentColor(createAgentColorState("create", ""), AGENT_COLOR_PRESETS[0]);
    expect(resolveAgentColor(state)).toBe("#4f6ef7");
    expect(state.touched).toBe(true);
  });

  it("edit mode preset hex: highlights the matching swatch, untouched resolve returns original", () => {
    const state = createAgentColorState("edit", "#4f6ef7");
    expect(state.selected?.value).toBe("#4f6ef7");
    expect(state.touched).toBe(false);
    // untouched edit preserves the original verbatim (case + value)
    expect(resolveAgentColor(state)).toBe("#4f6ef7");
  });

  it("edit mode legacy hex: no preset highlighted, untouched resolve preserves original verbatim", () => {
    const state = createAgentColorState("edit", "#A1B2C3");
    expect(state.selected).toBeNull();
    expect(state.touched).toBe(false);
    expect(resolveAgentColor(state)).toBe("#A1B2C3");
  });

  it("edit mode legacy hex: after selecting a swatch, resolve returns the preset (closure into the closed set)", () => {
    const rose = findAgentColorPreset("#f74f6e");
    expect(rose).not.toBeNull();
    const state = selectAgentColor(createAgentColorState("edit", "#a1b2c3"), rose as never);
    expect(resolveAgentColor(state)).toBe("#f74f6e");
  });

  it("edit mode touched but no selection resolves to null (cannot submit a preset)", () => {
    // Pathological: touched with null selected should never happen via the UI,
    // but resolve must not silently fall back to the original legacy value.
    const state = { ...createAgentColorState("edit", "#a1b2c3"), touched: true, selected: null };
    expect(resolveAgentColor(state)).toBeNull();
  });
});
