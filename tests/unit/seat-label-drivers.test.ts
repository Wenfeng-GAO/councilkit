import { DRIVER_SELECT_OPTIONS, driverLabel, seatModelLabel } from "@/lib/seat-label";
import { describe, expect, it } from "vitest";

describe("driverLabel and generic seat models", () => {
  it("maps known drivers and echoes an unknown driver id", () => {
    expect(driverLabel("codex-app-server")).toBe("Codex");
    expect(driverLabel("claude-stream-json")).toBe("Claude");
    expect(driverLabel("grok-stream-json")).toBe("Grok");
    expect(driverLabel("kimi-stream-json")).toBe("Kimi");
    expect(driverLabel("cursor-stream-json")).toBe("Cursor");
    expect(driverLabel("custom-driver")).toBe("custom-driver");
  });

  it("lists the five short driver names in menu order", () => {
    expect(DRIVER_SELECT_OPTIONS.map((option) => [option.value, option.label])).toEqual([
      ["codex-app-server", "Codex"],
      ["claude-stream-json", "Claude"],
      ["grok-stream-json", "Grok"],
      ["kimi-stream-json", "Kimi"],
      ["cursor-stream-json", "Cursor"],
    ]);
  });

  it("uses the driver name when a non-Cursor seat is still on a generic model", () => {
    expect(seatModelLabel("auto", "grok-stream-json")).toBe("Grok");
    expect(seatModelLabel("default", "kimi-stream-json")).toBe("Kimi");
    expect(seatModelLabel("", "codex-app-server")).toBe("Codex");
    expect(seatModelLabel("current", "claude-stream-json")).toBe("Claude");
    expect(seatModelLabel("-", "custom-driver")).toBe("custom-driver");
  });
});
