import { driverLabel, seatModelLabel } from "@/lib/seat-label";
import { describe, expect, it } from "vitest";

describe("driverLabel and generic seat models", () => {
  it("maps known drivers and echoes an unknown driver id", () => {
    expect(driverLabel("codex-app-server")).toBe("Codex");
    expect(driverLabel("claude-stream-json")).toBe("Claude");
    expect(driverLabel("custom-driver")).toBe("custom-driver");
  });

  it("uses the driver name when a non-Cursor seat is still on a generic model", () => {
    expect(seatModelLabel("auto", "grok-stream-json")).toBe("Grok");
    expect(seatModelLabel("default", "kimi-stream-json")).toBe("Kimi");
    expect(seatModelLabel("", "codex-app-server")).toBe("Codex");
    expect(seatModelLabel("current", "claude-stream-json")).toBe("Claude");
    expect(seatModelLabel("-", "custom-driver")).toBe("custom-driver");
  });
});
