import { unavailableCursorSeats } from "@/lib/jury-model-validation";
import type { ReviewJurySeat } from "@shared/runtime/review-jury";
import { describe, expect, it } from "vitest";

const seat = (modelId: string): ReviewJurySeat => ({
  agentId: "aggregator",
  driverSelection: { driverId: "cursor-stream-json", options: {} },
  modelId,
});

describe("review jury Cursor catalog validation", () => {
  it("rejects the saved 500K binding without migrating it to 256K", () => {
    const old = seat("grok-4.7[context=500k,reasoning_effort=xhigh,fast=false]");
    expect(unavailableCursorSeats([old], ["auto", "grok-4.7-xhigh"])).toEqual([old]);
    expect(old.modelId).toContain("context=500k");
  });

  it("allows explicit supported models and Cursor's default aliases", () => {
    const seats = ["grok-4.7-xhigh", "auto", "default", "configured"].map(seat);
    expect(unavailableCursorSeats(seats, ["auto", "grok-4.7-xhigh"])).toEqual([]);
  });

  it("does not accept a cached model or a different effort absent from the live catalog", () => {
    const old = seat("grok-4.7-high");
    expect(unavailableCursorSeats([old], ["grok-4.7-xhigh"])).toEqual([old]);
    expect(unavailableCursorSeats([seat("auto")], [])).toHaveLength(1);
  });

  it("does not validate other drivers against the Cursor catalog", () => {
    const other: ReviewJurySeat = {
      ...seat("kimi-code/k3"),
      driverSelection: { driverId: "kimi-stream-json", options: {} },
    };
    expect(unavailableCursorSeats([other], [])).toEqual([]);
  });
});
