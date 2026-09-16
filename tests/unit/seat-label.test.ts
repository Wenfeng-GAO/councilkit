import {
  reviewSeatIdentity,
  reviewSeatTabLabel,
  reviewSeatTitle,
  seatModelLabel,
} from "@/lib/seat-label";
import { describe, expect, it } from "vitest";

describe("reviewSeatTitle", () => {
  it("keeps persona role titles even when the model is remapped", () => {
    expect(
      reviewSeatTitle({
        agentName: "review-security",
        modelId: "gpt-6-astra",
        driverId: "codex-app-server",
      }),
    ).toBe("安全审查");
  });

  it("shows the bound model for extra seats instead of review-cursor", () => {
    expect(
      reviewSeatTitle({
        agentName: "review-cursor",
        modelId: "gpt-6-astra",
        driverId: "codex-app-server",
      }),
    ).toBe("gpt-6-astra");
  });

  it("shows Cursor Auto when the extra seat is still the default Cursor model", () => {
    expect(
      reviewSeatTitle({
        agentName: "review-cursor",
        modelId: "auto",
        driverId: "cursor-stream-json",
      }),
    ).toBe("Cursor Auto");
  });

  it("labels the aggregator by role, not agent name", () => {
    expect(
      reviewSeatTitle({
        agentName: "review-adversarial",
        modelId: "grok-4.6",
        driverId: "grok-stream-json",
        role: "aggregator",
      }),
    ).toBe("结果汇总");
  });
});

describe("reviewSeatIdentity", () => {
  it("does not surface review-cursor when the extra seat is a Codex model", () => {
    expect(
      reviewSeatIdentity({
        agentName: "review-cursor",
        modelId: "gpt-6-astra",
        driverId: "codex-app-server",
      }),
    ).toBe("codex-app-server");
  });

  it("keeps persona identity as agent · driver", () => {
    expect(
      reviewSeatIdentity({
        agentName: "review-security",
        modelId: "antchat/GLM-5.2[1m]",
        driverId: "claude-stream-json",
      }),
    ).toBe("review-security · claude-stream-json");
  });
});

describe("reviewSeatTabLabel", () => {
  it("uses the model on inspector tabs for extra seats", () => {
    const row = {
      agentName: "review-cursor",
      modelId: "gpt-6-astra",
      driverId: "codex-app-server",
    };
    expect(reviewSeatTabLabel(row, [row], "attempt-4")).toBe("gpt-6-astra");
  });
});

describe("seatModelLabel", () => {
  it("passes through concrete model ids", () => {
    expect(seatModelLabel("grok-4.6", "grok-stream-json")).toBe("grok-4.6");
  });
});
