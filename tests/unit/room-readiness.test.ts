import { deriveRoomReadiness } from "@/app/pages/NewRoomPage";
import type { ProfileReadinessState } from "@shared/runtime/contracts";
import { describe, expect, it } from "vitest";

/**
 * S8 预检 badge 判定（plan-a §1.4）：profiles ready + agents ≥ 2 + facilitator
 * 已选 → 此房间可运行。deriveRoomReadiness 是纯函数，从 NewRoomPage 导出按
 * parseMaxRoundsInput 先例单测；problems 顺序固定 agents → facilitator → profiles，
 * 建议性不阻塞。profile 状态文案复用 profileReadinessView（无效绑定=「绑定失效」）。
 */

describe("deriveRoomReadiness — ready", () => {
  it("all satisfied → ready=true, no problems", () => {
    expect(
      deriveRoomReadiness({
        agentCount: 2,
        facilitatorChosen: true,
        profiles: [{ name: "GLM", state: "ready" }],
      }),
    ).toEqual({ ready: true, problems: [] });
  });
});

describe("deriveRoomReadiness — agents / facilitator", () => {
  it("agentCount < 2 → agents problem", () => {
    const result = deriveRoomReadiness({
      agentCount: 1,
      facilitatorChosen: true,
      profiles: [{ name: "GLM", state: "ready" }],
    });
    expect(result.ready).toBe(false);
    expect(result.problems).toContainEqual({
      kind: "agents",
      message: "至少需要 2 个 Agent",
    });
  });

  it("facilitator not chosen → facilitator problem", () => {
    const result = deriveRoomReadiness({
      agentCount: 2,
      facilitatorChosen: false,
      profiles: [{ name: "GLM", state: "ready" }],
    });
    expect(result.ready).toBe(false);
    expect(result.problems).toContainEqual({
      kind: "facilitator",
      message: "尚未选择 Facilitator",
    });
  });
});

describe("deriveRoomReadiness — profiles", () => {
  it("profile invalid_binding → problem names the profile and「绑定失效」", () => {
    const state: ProfileReadinessState = "invalid_binding";
    const result = deriveRoomReadiness({
      agentCount: 2,
      facilitatorChosen: true,
      profiles: [{ name: "GLM 5.2 主用", state }],
    });
    expect(result.ready).toBe(false);
    const message = result.problems.find((problem) => problem.kind === "profile")?.message;
    expect(message).toContain("GLM 5.2 主用");
    expect(message).toContain("绑定失效");
  });

  it("profile state=undefined →「就绪状态未知」problem", () => {
    const result = deriveRoomReadiness({
      agentCount: 2,
      facilitatorChosen: true,
      profiles: [{ name: "GLM", state: undefined }],
    });
    expect(result.ready).toBe(false);
    const message = result.problems.find((problem) => problem.kind === "profile")?.message;
    expect(message).toContain("GLM");
    expect(message).toContain("就绪状态未知");
  });
});

describe("deriveRoomReadiness — problem order", () => {
  it("multiple problems preserve fixed order agents → facilitator → profiles", () => {
    const result = deriveRoomReadiness({
      agentCount: 1,
      facilitatorChosen: false,
      profiles: [
        { name: "A", state: "invalid_binding" },
        { name: "B", state: undefined },
      ],
    });
    expect(result.ready).toBe(false);
    expect(result.problems.map((problem) => problem.kind)).toEqual([
      "agents",
      "facilitator",
      "profile",
      "profile",
    ]);
    // profile 顺序与输入顺序一致（A 在 B 前）
    expect(result.problems[2]?.message).toContain("A");
    expect(result.problems[3]?.message).toContain("B");
  });
});
