import { describe, expect, it } from "vitest";
import {
  ideateRoleLabel,
  rosterToIdeateModels,
  savedRosterUnchanged,
  uniqueModelConfigCount,
} from "@/lib/ideate-roster";
import type { ReviewJurySeat } from "@shared/runtime/review-jury";

const seats: ReviewJurySeat[] = [
  {
    agentId: "p",
    modelId: "grok-4.6",
    driverSelection: { driverId: "grok-stream-json", options: {} },
  },
  {
    agentId: "e",
    modelId: "kimi-code/k3",
    driverSelection: { driverId: "kimi-stream-json", options: {} },
  },
];

describe("ideate roster", () => {
  it("keeps customized names and maps a one-shot models payload", () => {
    expect(ideateRoleLabel("ideate-product")).toBe("产品席");
    expect(ideateRoleLabel("custom-scout")).toBe("custom-scout");
    expect(rosterToIdeateModels(seats, "e")).toEqual({
      models: [
        { modelId: "grok-4.6", driverSelection: { driverId: "grok-stream-json", options: {} } },
        { modelId: "kimi-code/k3", driverSelection: { driverId: "kimi-stream-json", options: {} } },
      ],
      aggregatorIndex: 1,
    });
    expect(savedRosterUnchanged(seats, "e", seats, "e")).toBe(true);
    expect(savedRosterUnchanged(seats, "e", seats, "p")).toBe(false);
    expect(uniqueModelConfigCount(seats)).toBe(2);
  });
});
