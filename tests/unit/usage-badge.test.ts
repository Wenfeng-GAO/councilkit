import {
  UsageBadge,
  addUsage,
  aggregateUsage,
  aggregateUsageByRound,
  emptyUsageTotals,
  formatUsageTotals,
} from "@/components/room/UsageBadge";
import { createModelExecution } from "@/models/discussion/factories";
import type { ModelExecution, ModelExecutionUsage } from "@/models/discussion/model-execution";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/**
 * UsageBadge pure functions (S7): null-usage skipping, token/cost summation
 * across ALL persisted states (discarded/failed included — ruling #6),
 * hasCost/hasTokens tracking so an all-null aggregate never renders a "$0"
 * mirage, per-round grouping, and the format contract (k abbreviation, $
 * precision, empty string ⇒ component renders nothing).
 */

function makeExecution(
  roundId: string,
  usage: ModelExecutionUsage | null,
  state: ModelExecution["state"] = "committed",
): ModelExecution {
  const execution = createModelExecution({
    executionId: crypto.randomUUID(),
    roomId: "room-1",
    roundId,
    participantId: "p-1",
    resultKind: "message",
    requestedModel: "model-a",
    contextRevision: 0,
    expectedRoomDigest: "d",
    participantSnapshotDigest: "p",
    instructionDigest: "i",
  });
  execution.state = state;
  execution.usage = usage;
  return execution;
}

describe("aggregateUsage", () => {
  it("null usage 跳过：全 null → 空 totals", () => {
    const totals = aggregateUsage([makeExecution("r1", null), makeExecution("r1", null)]);
    expect(totals).toEqual(emptyUsageTotals());
    expect(formatUsageTotals(totals)).toBe("");
  });

  it("token/cost 求和；null 字段按 0 计", () => {
    const totals = aggregateUsage([
      makeExecution("r1", { inputTokens: 10, outputTokens: null, costUsd: null }),
      makeExecution("r1", { inputTokens: null, outputTokens: 5, costUsd: 0.5 }),
      makeExecution("r1", { inputTokens: 100, outputTokens: 200, costUsd: 0.25 }),
    ]);
    expect(totals.inputTokens).toBe(110);
    expect(totals.outputTokens).toBe(205);
    expect(totals.costUsd).toBe(0.75);
    expect(totals.hasTokens).toBe(true);
    expect(totals.hasCost).toBe(true);
  });

  it("含 discarded/failed 行（token 已烧，成本透明）", () => {
    const totals = aggregateUsage([
      makeExecution("r1", { inputTokens: 10, outputTokens: 20, costUsd: 0.5 }, "committed"),
      makeExecution("r1", { inputTokens: 1, outputTokens: 2, costUsd: 0.25 }, "discarded"),
      makeExecution("r1", { inputTokens: 4, outputTokens: 8, costUsd: 0.25 }, "failed"),
    ]);
    expect(totals.inputTokens).toBe(15);
    expect(totals.outputTokens).toBe(30);
    expect(totals.costUsd).toBe(1);
  });

  it("全 null costUsd → hasCost=false（无 $0 假象），token 部分仍累计", () => {
    const totals = aggregateUsage([
      makeExecution("r1", { inputTokens: 3, outputTokens: 4, costUsd: null }),
    ]);
    expect(totals.hasCost).toBe(false);
    expect(totals.hasTokens).toBe(true);
    expect(formatUsageTotals(totals)).not.toContain("$");
  });

  it("addUsage 不可变：传入 totals 不被改写", () => {
    const base = emptyUsageTotals();
    addUsage(base, { inputTokens: 1, outputTokens: 1, costUsd: 0.5 });
    expect(base).toEqual(emptyUsageTotals());
  });
});

describe("aggregateUsageByRound", () => {
  it("按 roundId 分组求和；null usage 的轮次保留空 totals", () => {
    const byRound = aggregateUsageByRound([
      makeExecution("r1", { inputTokens: 10, outputTokens: 5, costUsd: 0.5 }),
      makeExecution("r1", { inputTokens: 10, outputTokens: 5, costUsd: null }),
      makeExecution("r2", { inputTokens: 1, outputTokens: 1, costUsd: 0.25 }),
      makeExecution("r3", null),
    ]);
    expect(byRound.size).toBe(3);
    expect(byRound.get("r1")).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      costUsd: 0.5,
      hasTokens: true,
      hasCost: true,
    });
    expect(byRound.get("r2")?.costUsd).toBe(0.25);
    expect(byRound.get("r3")).toEqual(emptyUsageTotals());
  });
});

describe("formatUsageTotals", () => {
  it("k 缩写：999 原样、1234 → 1.2k、45678 → 45.7k", () => {
    const totals = aggregateUsage([
      makeExecution("r1", { inputTokens: 999, outputTokens: 1234, costUsd: null }),
    ]);
    expect(formatUsageTotals(totals)).toBe("↑999 ↓1.2k");
    const big = aggregateUsage([
      makeExecution("r1", { inputTokens: 45678, outputTokens: 1000, costUsd: null }),
    ]);
    expect(formatUsageTotals(big)).toBe("↑45.7k ↓1.0k");
  });

  it("$ 精度：不足 1 美元 4 位小数，1 美元以上 2 位小数", () => {
    const small = aggregateUsage([
      makeExecution("r1", { inputTokens: null, outputTokens: null, costUsd: 0.75 }),
    ]);
    expect(formatUsageTotals(small)).toBe("$0.7500");
    const large = aggregateUsage([
      makeExecution("r1", { inputTokens: null, outputTokens: null, costUsd: 12.5 }),
    ]);
    expect(formatUsageTotals(large)).toBe("$12.50");
  });

  it("token + cost 组合以 · 分隔；空 → 空串", () => {
    const totals = aggregateUsage([
      makeExecution("r1", { inputTokens: 1234, outputTokens: 3400, costUsd: 0.75 }),
    ]);
    expect(formatUsageTotals(totals)).toBe("↑1.2k ↓3.4k · $0.7500");
    expect(formatUsageTotals(emptyUsageTotals())).toBe("");
  });
});

describe("UsageBadge 组件", () => {
  it("全 null → 不渲染；有数据 → 渲染「累计用量」文案", () => {
    expect(renderToStaticMarkup(createElement(UsageBadge, { totals: emptyUsageTotals() }))).toBe(
      "",
    );
    const totals = aggregateUsage([
      makeExecution("r1", { inputTokens: 1234, outputTokens: 3400, costUsd: 0.75 }),
    ]);
    const html = renderToStaticMarkup(createElement(UsageBadge, { totals }));
    expect(html).toContain("累计用量");
    expect(html).toContain("↑1.2k ↓3.4k · $0.7500");
  });
});
