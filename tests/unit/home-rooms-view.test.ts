import { filterRooms, sortRooms } from "@/app/pages/HomePage";
import type { UsageTotals } from "@/components/room/UsageBadge";
import type { DiscussionRoom } from "@/models/discussion/entities";
import { createDiscussionRoom } from "@/models/discussion/factories";
import { describe, expect, it } from "vitest";

/**
 * HomePage room-list view functions (S7 段 1): sortRooms pins the default
 * lastActiveAt-descending order, the cost-descending order with no-cost rooms
 * at the tail (ruling #7) and stability on ties; filterRooms pins topic hits,
 * message-hit-set membership, case insensitivity and the empty-query passthrough.
 */

function makeRoom(topic: string, lastActiveAt: string): DiscussionRoom {
  const room = createDiscussionRoom({ topic, facilitatorParticipantId: "pending" });
  room.lastActiveAt = lastActiveAt;
  return room;
}

function costTotals(costUsd: number | null): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: costUsd ?? 0,
    hasTokens: false,
    hasCost: costUsd !== null,
  };
}

describe("sortRooms", () => {
  it("默认 recent：lastActiveAt 降序", () => {
    const a = makeRoom("A", "2026-07-01T00:00:00.000Z");
    const b = makeRoom("B", "2026-07-03T00:00:00.000Z");
    const c = makeRoom("C", "2026-07-02T00:00:00.000Z");
    expect(sortRooms([a, b, c], "recent").map((r) => r.topic)).toEqual(["B", "C", "A"]);
  });

  it("recent 同值稳定：保持原相对顺序", () => {
    const a = makeRoom("A", "2026-07-01T00:00:00.000Z");
    const b = makeRoom("B", "2026-07-01T00:00:00.000Z");
    const c = makeRoom("C", "2026-06-01T00:00:00.000Z");
    expect(sortRooms([a, b, c], "recent").map((r) => r.topic)).toEqual(["A", "B", "C"]);
  });

  it("cost：累计成本降序，无成本数据排尾（排尾部分保持原顺序）", () => {
    const cheap = makeRoom("cheap", "2026-07-01T00:00:00.000Z");
    const noEntry = makeRoom("noEntry", "2026-07-02T00:00:00.000Z");
    const pricey = makeRoom("pricey", "2026-07-03T00:00:00.000Z");
    const noCost = makeRoom("noCost", "2026-07-04T00:00:00.000Z");
    const usage = new Map<string, UsageTotals>([
      [cheap.id, costTotals(0.5)],
      [pricey.id, costTotals(12.5)],
      [noCost.id, costTotals(null)],
    ]);
    expect(sortRooms([cheap, noEntry, pricey, noCost], "cost", usage).map((r) => r.topic)).toEqual([
      "pricey",
      "cheap",
      "noEntry",
      "noCost",
    ]);
  });

  it("cost 同值稳定", () => {
    const a = makeRoom("A", "2026-07-01T00:00:00.000Z");
    const b = makeRoom("B", "2026-07-02T00:00:00.000Z");
    const usage = new Map<string, UsageTotals>([
      [a.id, costTotals(1.5)],
      [b.id, costTotals(1.5)],
    ]);
    expect(sortRooms([a, b], "cost", usage).map((r) => r.topic)).toEqual(["A", "B"]);
  });
});

describe("filterRooms", () => {
  const a = makeRoom("给新项目起个名字", "2026-07-01T00:00:00.000Z");
  const b = makeRoom("发布计划 review", "2026-07-02T00:00:00.000Z");
  const c = makeRoom("ABC 讨论", "2026-07-03T00:00:00.000Z");

  it("topic 命中", () => {
    expect(filterRooms([a, b, c], "新项目").map((r) => r.topic)).toEqual(["给新项目起个名字"]);
  });

  it("消息命中集合：topic 不命中但 roomId 在 matchedRoomIds 内也保留", () => {
    expect(filterRooms([a, b, c], "zzz", new Set([b.id])).map((r) => r.topic)).toEqual([
      "发布计划 review",
    ]);
  });

  it("大小写不敏感", () => {
    expect(filterRooms([a, b, c], "abc").map((r) => r.topic)).toEqual(["ABC 讨论"]);
  });

  it("空 query（含纯空白）返回全量", () => {
    expect(filterRooms([a, b, c], "")).toHaveLength(3);
    expect(filterRooms([a, b, c], "   ")).toHaveLength(3);
  });
});
