import { ideateDriverLabel } from "@/lib/ideate-roster";
import { describe, expect, it } from "vitest";

describe("ideateDriverLabel", () => {
  it("maps known drivers and keeps an unknown id", () => {
    expect(ideateDriverLabel("cursor-stream-json")).toBe("Cursor");
    expect(ideateDriverLabel("kimi-stream-json")).toBe("Kimi");
    expect(ideateDriverLabel("custom-driver")).toBe("custom-driver");
  });
});
