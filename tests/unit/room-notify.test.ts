import { detectRoomNotifyEvent, notifyTitle, notifyTone } from "@/app/pages/RoomPage";
import { describe, expect, it } from "vitest";

/**
 * S8 tab-hidden 通知纯函数（plan-a §1.1）：三种语义事件 round-completed /
 * round-paused / report-ready，prev/next 签名比对。detectRoomNotifyEvent /
 * notifyTitle / notifyTone 从 RoomPage 导出按 deriveRoomPhase 先例单测（vitest
 * node 环境，不触达 document.title / favicon effect——headless 恒 visible，无 e2e）。
 */

type Sig = {
  roundId: string | null;
  phase: string | null;
  roundNumber: number | null;
  hasReport: boolean;
};

function sig(over: Partial<Sig> = {}): Sig {
  return {
    roundId: "r-1",
    phase: "running",
    roundNumber: 1,
    hasReport: false,
    ...over,
  };
}

describe("detectRoomNotifyEvent — transitions", () => {
  it("running → completed → round-completed with roundNumber", () => {
    expect(
      detectRoomNotifyEvent(sig({ phase: "running" }), sig({ phase: "completed", roundNumber: 1 })),
    ).toEqual({ kind: "round-completed", roundNumber: 1 });
  });

  it("running → paused → round-paused", () => {
    expect(
      detectRoomNotifyEvent(sig({ phase: "running" }), sig({ phase: "paused", roundNumber: 2 })),
    ).toEqual({ kind: "round-paused", roundNumber: 2 });
  });

  it("hasReport false → true → report-ready", () => {
    expect(detectRoomNotifyEvent(sig({ hasReport: false }), sig({ hasReport: true }))).toEqual({
      kind: "report-ready",
    });
  });

  // R2：commitSummary 清 activeRoundId 不应断裂通知——签名源改取 latest recovery
  // round，summarizing → completed 时 roundId 不变，触发 round-completed。
  it("summarizing → completed with same roundId → round-completed (R2 activeRoundId-clear invariant)", () => {
    expect(
      detectRoomNotifyEvent(
        sig({ roundId: "r-1", phase: "summarizing", roundNumber: 1 }),
        sig({ roundId: "r-1", phase: "completed", roundNumber: 1 }),
      ),
    ).toEqual({ kind: "round-completed", roundNumber: 1 });
  });
});

describe("detectRoomNotifyEvent — suppression", () => {
  it("roundId change → null (reset signature, no event even on phase→completed)", () => {
    expect(
      detectRoomNotifyEvent(
        sig({ roundId: "r-1", phase: "running" }),
        sig({ roundId: "r-2", phase: "completed", roundNumber: 3 }),
      ),
    ).toBeNull();
  });

  it("identical signature → null", () => {
    expect(detectRoomNotifyEvent(sig({ phase: "running" }), sig({ phase: "running" }))).toBeNull();
  });
});

describe("detectRoomNotifyEvent — same-frame priority", () => {
  it("same-frame report-ready + round-paused → report-ready wins", () => {
    expect(
      detectRoomNotifyEvent(
        sig({ phase: "running", hasReport: false }),
        sig({ phase: "paused", hasReport: true, roundNumber: 1 }),
      ),
    ).toEqual({ kind: "report-ready" });
  });
});

describe("notifyTitle", () => {
  it("prefixes ⚠ for paused, ✓ for completed/report, with base title suffix", () => {
    expect(notifyTitle({ kind: "round-paused", roundNumber: 2 }, "CouncilKit")).toBe(
      "⚠ 第 2 轮已暂停 · CouncilKit",
    );
    expect(notifyTitle({ kind: "round-completed", roundNumber: 1 }, "CouncilKit")).toBe(
      "✓ 第 1 轮已完成 · CouncilKit",
    );
    expect(notifyTitle({ kind: "report-ready" }, "CouncilKit")).toBe(
      "✓ 决策报告已生成 · CouncilKit",
    );
  });
});

describe("notifyTone", () => {
  it("paused → warn; completed/report → success", () => {
    expect(notifyTone({ kind: "round-paused", roundNumber: 1 })).toBe("warn");
    expect(notifyTone({ kind: "round-completed", roundNumber: 1 })).toBe("success");
    expect(notifyTone({ kind: "report-ready" })).toBe("success");
  });
});
