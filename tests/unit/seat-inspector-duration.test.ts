import { inspectorDuration } from "@/lib/seat-inspector";
import { describe, expect, it } from "vitest";

describe("inspectorDuration remaining shapes", () => {
  it("returns null when a finished seat has neither a receipt nor a timeline", () => {
    expect(inspectorDuration(null, null, "success")).toBeNull();
    expect(inspectorDuration(null, { hasTimeline: false, spanMs: null, eventCount: 0 })).toBeNull();
  });

  it("marks a receipt that has events but no timeline", () => {
    expect(
      inspectorDuration(90_000, { hasTimeline: false, spanMs: null, eventCount: 3 }, "success"),
    ).toBe("1m30s · 过程无时间轴");
  });

  it("shows only the receipt when the span is absent", () => {
    expect(inspectorDuration(4_000, null, "success")).toBe("4s");
    expect(inspectorDuration(4_000, { hasTimeline: false, spanMs: null, eventCount: 0 })).toBe(
      "4s",
    );
  });
});
