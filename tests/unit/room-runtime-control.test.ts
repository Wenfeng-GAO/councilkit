import { deriveReleaseGate, isUnresolvedActiveRoundPhase } from "@/components/room/RoomHeader";
import { describe, expect, it } from "vitest";

/**
 * deriveReleaseGate (S5): the pure gate the RoomHeader release-runtime button
 * consults. It mirrors the orchestrator releaseRuntime guards (no live
 * execution, no unresolved active round, controlling page) and adds a warm/cold
 * short-circuit. The component renders the button only when warm, so cold is
 * exercised as a defensive "allowed with a reason" branch here.
 *
 * V4: the active-round fact is `hasUnresolvedActiveRound` (a round whose phase
 * is NOT terminal — completed/aborted), mirroring orchestrator V1. Pre-fix this
 * was `hasInFlightRound` (prewarming/running/summarizing); a paused/pending
 * round now also blocks release (it would strand the recovery path).
 */

describe("deriveReleaseGate (S5)", () => {
  it("warm + controlling + no live execution + no unresolved round -> allowed", () => {
    expect(
      deriveReleaseGate({
        controlling: true,
        warm: true,
        hasLiveExecution: false,
        hasUnresolvedActiveRound: false,
      }),
    ).toEqual({ allowed: true });
  });

  it("non-controlling -> blocked with 当前页面没有控制权", () => {
    expect(
      deriveReleaseGate({
        controlling: false,
        warm: true,
        hasLiveExecution: false,
        hasUnresolvedActiveRound: false,
      }),
    ).toEqual({ allowed: false, reason: "当前页面没有控制权" });
  });

  it("live execution -> blocked with 有执行进行中", () => {
    expect(
      deriveReleaseGate({
        controlling: true,
        warm: true,
        hasLiveExecution: true,
        hasUnresolvedActiveRound: false,
      }),
    ).toEqual({ allowed: false, reason: "有执行进行中" });
  });

  it("unresolved active round -> blocked with 当前轮次进行中", () => {
    expect(
      deriveReleaseGate({
        controlling: true,
        warm: true,
        hasLiveExecution: false,
        hasUnresolvedActiveRound: true,
      }),
    ).toEqual({ allowed: false, reason: "当前轮次进行中" });
  });

  it("cold (warm=false) -> allowed with 运行时未预热 (button is hidden upstream)", () => {
    expect(
      deriveReleaseGate({
        controlling: true,
        warm: false,
        hasLiveExecution: false,
        hasUnresolvedActiveRound: false,
      }),
    ).toEqual({ allowed: true, reason: "运行时未预热" });
  });

  it("guards take priority over the cold short-circuit: live execution + cold -> still blocked", () => {
    // Order matters only for the reason text; the gate must never report a
    // misleading "已可释放" on a cold room that nonetheless has a live execution.
    expect(
      deriveReleaseGate({
        controlling: true,
        warm: false,
        hasLiveExecution: true,
        hasUnresolvedActiveRound: false,
      }).allowed,
    ).toBe(false);
  });

  it("V4 镜像 V1: terminal phase (completed/aborted) round 不阻止释放；paused/pending 阻止", () => {
    // A completed/aborted round is terminal → not unresolved → does not block.
    expect(
      deriveReleaseGate({
        controlling: true,
        warm: true,
        hasLiveExecution: false,
        hasUnresolvedActiveRound: false,
      }).allowed,
    ).toBe(true);
    // A paused round is unresolved (mirror of orchestrator V1) → blocks release.
    expect(
      deriveReleaseGate({
        controlling: true,
        warm: true,
        hasLiveExecution: false,
        hasUnresolvedActiveRound: true,
      }),
    ).toEqual({ allowed: false, reason: "当前轮次进行中" });
  });

  // V1 三分支名实相符(#5):pending / running / summarizing 都是非终态活动轮,必须独立
  // 阻止释放——不能只靠单个 hasUnresolvedActiveRound=true 的过场用例兜底。这里对每一
  // 个非终态 phase 显式断言「hasUnresolvedActiveRound=true → 阻止」,与终态放行对照,
  // 覆盖 orchestrator V1 守卫把 pending/paused/running/summarizing 都判为 unresolved 的
  // 语义(而非只拦截 in-flight)。
  it("V1 非终态活动轮各分支独立阻止释放:pending 阻止(不再只靠布尔过场)", () => {
    // pending round(刚 createRound 未推进)属于 unresolved → 阻止释放。
    expect(
      deriveReleaseGate({
        controlling: true,
        warm: true,
        hasLiveExecution: false,
        hasUnresolvedActiveRound: true,
      }),
    ).toEqual({ allowed: false, reason: "当前轮次进行中" });
    // 且即使室温 controlling+warm,pending 一旦 unresolved 就压过 warm 短路。
    expect(
      deriveReleaseGate({
        controlling: true,
        warm: true,
        hasLiveExecution: false,
        hasUnresolvedActiveRound: true,
      }).allowed,
    ).toBe(false);
  });

  it("V1 终态活动轮放行:completed/aborted 不阻止释放(对照非终态)", () => {
    // 终态(completed/aborted)→ not unresolved → 不阻止。
    expect(
      deriveReleaseGate({
        controlling: true,
        warm: true,
        hasLiveExecution: false,
        hasUnresolvedActiveRound: false,
      }).allowed,
    ).toBe(true);
  });
});

// #5 的真正缺口:相位 → 布尔的映射本身必须有直接覆盖——布尔过场用例测不到
// 映射错误(例如漏掉 pending)。对全部 7 个相位逐一枚举断言。
describe("isUnresolvedActiveRoundPhase (S5, #5)", () => {
  it("非终态相位一律判为 unresolved", () => {
    for (const phase of ["pending", "prewarming", "running", "summarizing", "paused"] as const) {
      expect(isUnresolvedActiveRoundPhase(phase)).toBe(true);
    }
  });

  it("终态相位判为 resolved", () => {
    for (const phase of ["completed", "aborted"] as const) {
      expect(isUnresolvedActiveRoundPhase(phase)).toBe(false);
    }
  });
});
