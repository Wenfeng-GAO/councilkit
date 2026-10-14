import "fake-indexeddb/auto";
import "./app-dom-install";

import {
  HomePage,
  type RoomSortOrder,
  filterRooms,
  normalizeRoomSearchText,
  sortRooms,
} from "@/app/pages/HomePage";
import { runtimeDb } from "@/lib/runtime-db";
import type { DiscussionRoom } from "@/models/discussion/entities";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clickButton, setControlValue } from "./app-dom-install";
import { deferred, mountRouted, settle, waitForText } from "./app-page-harness";

const scene = vi.hoisted(() => ({
  rename: vi.fn(async () => undefined),
  duplicate: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  orchestrator: { label: "home-orchestrator" },
}));

vi.mock("@/runtime/bootstrap", () => ({
  getAppRuntime: () => ({ client: {}, orchestrator: scene.orchestrator }),
}));

vi.mock("@/lib/room-admin", () => ({
  renameRoom: (...args: unknown[]) => (scene.rename as (...input: unknown[]) => unknown)(...args),
  duplicateRoom: (...args: unknown[]) =>
    (scene.duplicate as (...input: unknown[]) => unknown)(...args),
  deleteRoomCascade: (...args: unknown[]) =>
    (scene.remove as (...input: unknown[]) => unknown)(...args),
}));

function room(
  partial: Partial<DiscussionRoom> & Pick<DiscussionRoom, "id" | "topic" | "lastActiveAt">,
): DiscussionRoom {
  return {
    background: "",
    facilitatorParticipantId: "part-1",
    runState: "idle",
    activeRoundId: null,
    contextRevision: 0,
    contextDigest: "",
    mode: "brainstorm",
    targetOutput: "",
    maxRounds: null,
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const ALPHA = room({
  id: "room-alpha",
  topic: "İstanbul 路线",
  lastActiveAt: "2026-03-01T00:00:00.000Z",
});
const BETA = room({
  id: "room-beta",
  topic: "成本居中",
  lastActiveAt: "2026-02-01T00:00:00.000Z",
});
const GAMMA = room({
  id: "room-gamma",
  topic: "最早的房间",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  status: "concluded",
});

async function resetDb(): Promise<void> {
  await runtimeDb.open();
  await runtimeDb.transaction("rw", runtimeDb.tables, async () => {
    await Promise.all(runtimeDb.tables.map((table) => table.clear()));
  });
}

describe("home room ordering", () => {
  it("normalizes Turkish I and filters by topic or matched messages", () => {
    expect(normalizeRoomSearchText("  İSTANBUL ")).toBe("istanbul");
    expect(filterRooms([ALPHA, BETA], "   ").map((item) => item.id)).toEqual([
      "room-alpha",
      "room-beta",
    ]);
    expect(filterRooms([ALPHA, BETA], "istanbul").map((item) => item.id)).toEqual(["room-alpha"]);
    expect(
      filterRooms([ALPHA, BETA], "没有", new Set(["room-beta"])).map((item) => item.id),
    ).toEqual(["room-beta"]);
  });

  it("sorts recent activity and sends rooms without cost to the end", () => {
    const sameTime = [
      room({ id: "a", topic: "a", lastActiveAt: "2026-01-01T00:00:00.000Z" }),
      room({ id: "b", topic: "b", lastActiveAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(sortRooms(sameTime, "recent").map((item) => item.id)).toEqual(["a", "b"]);
    expect(sortRooms([GAMMA, ALPHA, BETA], "recent").map((item) => item.id)).toEqual([
      "room-alpha",
      "room-beta",
      "room-gamma",
    ]);
    const usage = new Map<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        hasTokens: boolean;
        hasCost: boolean;
      }
    >([
      [
        "room-alpha",
        { inputTokens: 0, outputTokens: 0, costUsd: 1, hasTokens: false, hasCost: true },
      ],
      [
        "room-gamma",
        { inputTokens: 0, outputTokens: 0, costUsd: 5, hasTokens: false, hasCost: true },
      ],
    ]);
    expect(
      sortRooms([ALPHA, BETA, GAMMA], "cost" satisfies RoomSortOrder, usage).map((item) => item.id),
    ).toEqual(["room-gamma", "room-alpha", "room-beta"]);
    const noCost = new Map(usage);
    noCost.delete("room-gamma");
    expect(sortRooms([ALPHA, GAMMA], "cost", noCost).map((item) => item.id)).toEqual([
      "room-alpha",
      "room-gamma",
    ]);
    expect(sortRooms([ALPHA, BETA], "cost", new Map()).map((item) => item.id)).toEqual([
      "room-alpha",
      "room-beta",
    ]);
  });
});

describe("HomePage", () => {
  const mounted: Array<{ unmount: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(mounted.splice(0).map((item) => item.unmount()));
    scene.rename.mockReset();
    scene.duplicate.mockReset();
    scene.remove.mockReset();
    scene.rename.mockResolvedValue(undefined);
    scene.duplicate.mockResolvedValue(undefined);
    scene.remove.mockResolvedValue(undefined);
    await resetDb();
  });

  it("shows the empty library", async () => {
    await resetDb();
    const view = await mountRouted("/", "/", createElement(HomePage));
    mounted.push(view);
    await waitForText(view.container, "还没有房间");
    expect(view.container.textContent).toContain(
      "新建一个房间来发起多 Agent 讨论。V1 不会导入旧版本地数据，但也没有删除它。",
    );
    expect(view.container.querySelector("#rooms a")?.textContent).toBe("新建房间");
  });

  it("searches topics and message bodies, then sorts by recorded cost", async () => {
    await resetDb();
    await runtimeDb.rooms.bulkAdd([ALPHA, BETA, GAMMA]);
    await runtimeDb.messages.bulkAdd([
      {
        id: "msg-1",
        roomId: "room-beta",
        roundId: "round-1",
        role: "user",
        participantId: null,
        content: "独特词斑马",
        sourceExecutionId: null,
        createdAt: "2026-02-02T00:00:00.000Z",
      },
      {
        id: "msg-2",
        roomId: "room-gamma",
        roundId: "round-1",
        role: "user",
        participantId: null,
        content: "无关内容",
        sourceExecutionId: "exec-msg",
        createdAt: "2026-02-02T00:00:00.000Z",
      },
    ]);
    await runtimeDb.modelExecutions.bulkAdd([
      {
        executionId: "exec-a1",
        roomId: "room-alpha",
        usage: { costUsd: 1, inputTokens: 10, outputTokens: null },
      },
      {
        executionId: "exec-a2",
        roomId: "room-alpha",
        usage: { costUsd: 2, inputTokens: null, outputTokens: 4 },
      },
      {
        executionId: "exec-c",
        roomId: "room-gamma",
        usage: { costUsd: 9, inputTokens: null, outputTokens: null },
      },
    ] as never);
    const view = await mountRouted("/", "/", createElement(HomePage));
    mounted.push(view);
    await waitForOrder(view.container, [
      "/rooms/room-alpha",
      "/rooms/room-beta",
      "/rooms/room-gamma#report",
    ]);

    const search = view.container.querySelector('input[placeholder="话题或消息内容"]');
    expect(search instanceof HTMLInputElement).toBe(true);
    await setControlValue(search as HTMLInputElement, "istanbul");
    await waitForOrder(view.container, ["/rooms/room-alpha"]);

    await setControlValue(search as HTMLInputElement, "斑马");
    await waitForOrder(view.container, ["/rooms/room-beta"]);

    await setControlValue(search as HTMLInputElement, "不存在的词");
    await waitForText(view.container, "没有匹配的房间");
    expect(view.container.textContent).toContain("换个搜索关键词试试。");
    expect(linkOrder(view.container)).toEqual([]);

    await setControlValue(search as HTMLInputElement, "");
    await waitForOrder(view.container, [
      "/rooms/room-alpha",
      "/rooms/room-beta",
      "/rooms/room-gamma#report",
    ]);
    const sort = view.container.querySelector("select");
    expect(sort instanceof HTMLSelectElement).toBe(true);
    await setControlValue(sort as HTMLSelectElement, "cost");
    await waitForOrder(view.container, [
      "/rooms/room-gamma#report",
      "/rooms/room-alpha",
      "/rooms/room-beta",
    ]);
  });

  it("renames, duplicates, and deletes through the row actions", async () => {
    await resetDb();
    await runtimeDb.rooms.add(ALPHA);
    const view = await mountRouted("/", "/", createElement(HomePage));
    mounted.push(view);
    await waitForText(view.container, "İstanbul 路线");
    const rooms = view.container.querySelector("#rooms");
    expect(rooms instanceof HTMLElement).toBe(true);

    await clickButton(rooms as HTMLElement, "重命名");
    expect(view.container.textContent).toContain("重命名房间");
    const topic = view.container.querySelector("dialog input");
    expect(topic instanceof HTMLInputElement).toBe(true);
    expect((topic as HTMLInputElement).value).toBe("İstanbul 路线");
    await setControlValue(topic as HTMLInputElement, "   ");
    await clickButton(rooms as HTMLElement, "保存");
    expect(view.container.textContent).toContain("请输入新话题。");
    expect(scene.rename.mock.calls).toEqual([]);

    await setControlValue(topic as HTMLInputElement, "新的路线");
    expect(view.container.textContent).not.toContain("请输入新话题。");
    let gate = deferred<undefined>();
    scene.rename.mockReturnValueOnce(gate.promise);
    await clickButton(rooms as HTMLElement, "保存");
    expect((rooms as HTMLElement).textContent).toContain("保存中…");
    gate.resolve(undefined);
    await settle();
    await settle();
    expect(scene.rename.mock.calls).toEqual([
      [runtimeDb, scene.orchestrator, "room-alpha", "新的路线"],
    ]);
    expect(view.container.querySelector("dialog")).toBeNull();

    await clickButton(rooms as HTMLElement, "重命名");
    scene.rename.mockRejectedValueOnce(new Error("上下文过期"));
    await clickButton(rooms as HTMLElement, "保存");
    await waitForText(view.container, "上下文过期");
    scene.rename.mockRejectedValueOnce("纯字符串");
    await clickButton(rooms as HTMLElement, "保存");
    await waitForText(view.container, "纯字符串");
    await clickButton(rooms as HTMLElement, "取消");
    expect(view.container.querySelector("dialog")).toBeNull();

    gate = deferred<undefined>();
    scene.duplicate.mockReturnValueOnce(gate.promise);
    await clickButton(rooms as HTMLElement, "复制");
    expect((rooms as HTMLElement).textContent).toContain("复制中…");
    gate.resolve(undefined);
    await settle();
    await settle();
    expect(scene.duplicate.mock.calls).toEqual([[runtimeDb, scene.orchestrator, "room-alpha"]]);
    scene.duplicate.mockRejectedValueOnce(new Error("锁被占用"));
    await clickButton(rooms as HTMLElement, "复制");
    await waitForText(view.container, "复制「İstanbul 路线」失败：锁被占用");
    scene.duplicate.mockRejectedValueOnce("boom");
    await clickButton(rooms as HTMLElement, "复制");
    await waitForText(view.container, "复制「İstanbul 路线」失败：boom");

    await clickButton(rooms as HTMLElement, "删除");
    expect(view.container.textContent).toContain(
      "将删除房间「İstanbul 路线」的全部轮次、消息、总结、执行记录与报告。此操作不可撤销。",
    );
    gate = deferred<undefined>();
    scene.remove.mockReturnValueOnce(gate.promise);
    await clickButton(rooms as HTMLElement, "确认删除");
    expect((rooms as HTMLElement).textContent).toContain("删除中…");
    gate.resolve(undefined);
    await settle();
    await settle();
    expect(scene.remove.mock.calls).toEqual([[runtimeDb, scene.orchestrator, "room-alpha"]]);
    expect(view.container.querySelector("dialog")).toBeNull();

    await clickButton(rooms as HTMLElement, "删除");
    scene.remove.mockRejectedValueOnce(new Error("仍有进行中的轮次"));
    await clickButton(rooms as HTMLElement, "确认删除");
    await waitForText(view.container, "仍有进行中的轮次");
    expect(view.container.textContent).toContain("请先恢复或终止该房间进行中的轮次，再重试删除。");
    scene.remove.mockRejectedValueOnce("字符串失败");
    await clickButton(rooms as HTMLElement, "确认删除");
    await waitForText(view.container, "字符串失败");
    await clickButton(rooms as HTMLElement, "取消");
    expect(view.container.querySelector("dialog")).toBeNull();
  });
});

function linkOrder(scope: ParentNode): string[] {
  return [...scope.querySelectorAll('a[href^="/rooms/room-"]')].map(
    (node) => node.getAttribute("href") ?? "",
  );
}

async function waitForOrder(scope: ParentNode, hrefs: string[]): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const order = linkOrder(scope);
    if (order.length === hrefs.length && order.every((href, index) => href === hrefs[index]))
      return;
    await settle();
  }
  throw new Error(`links ${linkOrder(scope).join(", ")} != ${hrefs.join(", ")}`);
}
