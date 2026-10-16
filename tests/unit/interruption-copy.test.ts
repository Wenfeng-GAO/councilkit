import {
  BLOCKING_ZERO_INCOMPLETE,
  INCOMPLETE_CONCLUSION_LABEL,
  ONESHOT_UNFINISHED_MS,
  STREAM_SILENCE_MS,
  driftAggregationCard,
  incompleteBanner,
  incompleteClosing,
  interruptionBudget,
  interruptionReason,
  reviewInterruptionOf,
  seatCountLabel,
  seatInterruptionLine,
} from "@shared/runtime/interruption-copy";
import { describe, expect, it } from "vitest";

describe("review interruption copy", () => {
  it("keeps the designer strings verbatim", () => {
    expect(STREAM_SILENCE_MS).toBe(120_000);
    expect(ONESHOT_UNFINISHED_MS).toBe(600_000);
    expect(interruptionBudget("claude-stream-json")).toEqual({
      silenceMs: 120_000,
      unfinishedMs: null,
    });
    expect(interruptionBudget("grok-stream-json")).toEqual({
      silenceMs: null,
      unfinishedMs: 600_000,
    });
    expect(interruptionBudget("kimi-stream-json").unfinishedMs).toBe(600_000);
    expect(interruptionBudget("cursor-stream-json").unfinishedMs).toBe(600_000);
    expect(interruptionReason("IDLE_TIMEOUT")).toBe("2 分钟没有输出");
    expect(interruptionReason("UNFINISHED")).toBe("10 分钟没有写完");
    expect(interruptionReason("PROCESS_CRASH")).toBe("进程意外退出");
    expect(interruptionReason("DRIVER_DRIFT", "grok")).toBe("grok 可执行文件在运行中被更新");
    expect(incompleteBanner(2)).toBe("结论不完整：2 路审查没有完成");
    expect(seatInterruptionLine("review-security", "claude", "2 分钟没有输出")).toBe(
      "review-security（claude）：2 分钟没有输出。",
    );
    expect(incompleteClosing(3)).toBe(
      "这份报告只汇总了其余 3 路的结果，缺的这几路负责查的问题可能没被发现。",
    );
    expect(seatCountLabel(2, 5)).toBe("2/5 席位已完成（缺 3 路）");
    expect(INCOMPLETE_CONCLUSION_LABEL).toBe("结论不完整");
    expect(BLOCKING_ZERO_INCOMPLETE).toBe("未发现阻塞项（结论不完整）");
    expect(driftAggregationCard("grok", 5)).toEqual({
      title: "审查汇总被中断（grok在运行中被更新）",
      detail:
        "grok的程序在审查过程中被更新了，为了安全，汇总没有换用新版本接着跑。已完成的 5 路审查结果都还在，可以直接查看。",
      primaryAction: "只重跑汇总",
      secondaryAction: "返回报告列表",
      hint: "用已完成的 5 路结果，以当前安装的grok重新汇总，不会重跑审查。",
    });
  });

  it("treats aggregator drift as an aggregation interruption and keeps seat results", () => {
    const view = reviewInterruptionOf({
      kind: "review",
      status: "interrupted",
      endedAt: "2026-10-16T08:06:55.000Z",
      progress: {
        attempts: [
          {
            role: "attempt",
            status: "success",
            agentName: "review-security",
            driverId: "grok-stream-json",
          },
          {
            role: "attempt",
            status: "success",
            agentName: "review-correctness",
            driverId: "grok-stream-json",
          },
          {
            role: "aggregator",
            status: "failure",
            agentName: "review-adversarial",
            driverId: "grok-stream-json",
            failureCode: "DRIVER_DRIFT",
          },
        ],
      },
    });
    expect(view?.kind).toBe("aggregation");
    if (view?.kind !== "aggregation") return;
    expect(view.drift).toBe(true);
    expect(view.completedSeats).toBe(2);
    expect(view.heading).toBe("审查未完成（汇总中断）");
  });
});
