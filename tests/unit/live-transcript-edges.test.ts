import {
  displayLastActivity,
  foldLiveEvents,
  isDeliverableText,
  originAt,
  splitSeatDeliverable,
} from "@/lib/live-transcript";
import { describe, expect, it } from "vitest";

describe("live transcript edges", () => {
  it("lifts a long plain text block once the seat is ready", () => {
    const long = "a".repeat(280);
    const split = splitSeatDeliverable(
      [
        { kind: "thinking", text: "先看 diff", at: "t0" },
        { kind: "text", text: long, at: "t1" },
      ],
      true,
    );
    expect(split.deliverable).toBe(long);
    expect(split.process).toEqual([{ kind: "thinking", text: "先看 diff", at: "t0" }]);
  });

  it("recognizes schema_version, invariants, five-key JSON, and rejects broken JSON", () => {
    const schema = JSON.stringify({
      schema_version: 1,
      planner_id: "planner-a",
      note: "n".repeat(260),
    });
    const invariants = JSON.stringify({
      invariants: ["bounded"],
      planner_id: "planner-a",
      note: "n".repeat(260),
    });
    const five = JSON.stringify({
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: "e".repeat(280),
    });
    expect(isDeliverableText(schema)).toBe(true);
    expect(isDeliverableText(invariants)).toBe(true);
    expect(isDeliverableText(five)).toBe(true);
    expect(isDeliverableText(`{${"x".repeat(280)}}`)).toBe(false);
  });

  it("pairs a generic completion onto an open shell and keeps an orphan completion", () => {
    expect(
      foldLiveEvents([
        { seq: 1, at: "t0", type: "tool.started", name: "shell", summary: "old" },
        { seq: 2, at: "t1", type: "tool.completed", name: "tool", summary: "npm test" },
      ]),
    ).toEqual([
      {
        kind: "tool",
        name: "shell",
        summary: "npm test",
        status: "completed",
        at: "t0",
        endAt: "t1",
      },
    ]);
    expect(
      foldLiveEvents([
        { seq: 1, at: "t0", type: "tool.completed", name: "tool", summary: "npm test" },
      ]),
    ).toEqual([{ kind: "tool", name: "tool", summary: "npm test", status: "completed", at: "t0" }]);
  });

  it("clips a long last-activity line and hides a claims envelope", () => {
    expect(displayLastActivity("a".repeat(81))).toBe(`${"a".repeat(80)}…`);
    expect(displayLastActivity('{"claims":"abcdefghijklmnopqrstuvwxyz0123456789"}')).toBeNull();
  });

  it("reads the first event timestamp and is empty when there are no events", () => {
    expect(originAt([{ at: "2026-01-01T00:00:00.000Z" }, { at: "2026-01-01T00:00:02.000Z" }])).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(originAt([])).toBe("");
  });
});
