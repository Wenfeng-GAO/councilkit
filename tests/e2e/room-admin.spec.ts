/**
 * S7 room admin E2E (plan-a §3): 删除级联（8 个 room 作用域表行归零 + 全局
 * 表不变 + legacy 探针零读取）与复制（「（副本）」房间不带消息、参与者重
 * join、可直接跑完一轮）。断言时序遵循 S5 教训：先等 UI 反映，再验 Dexie
 * 行。串行锁纪律：mkdir /tmp/councilkit-e2e.lock && pnpm exec playwright
 * test; rmdir /tmp/councilkit-e2e.lock（绝不与 vitest 并发）。
 */
import { type BrowserContext, type Locator, type Page, expect, test } from "@playwright/test";
import {
  freshPage,
  readStore,
  roomMessages,
  roomParticipants,
  roomRounds,
  roomSummaries,
  startRound,
} from "./helpers";
import {
  LEGACY_SENTINEL,
  RUNTIME_DB_NAME,
  bootSettings,
  dbOpenLog,
  installLegacyProbes,
  readLegacySentinel,
  seedLegacyState,
  setupRoom,
  waitRoundPhase,
} from "./security-helpers";

/** HomePage 行：RoomListItem 的 Link（a[href=/rooms/:id]）向上两层即行容器
 * （min-w-0 flex-1 的父级），行尾是重命名/复制/删除操作组。 */
function roomListRow(page: Page, roomId: string): Locator {
  return page.locator(`a[href="/rooms/${roomId}"]`).locator("xpath=../..");
}

/** 8 个 room 作用域表（rooms 走主键断言；executionProfiles 事务内零写入、
 * agents 全局——两者以行数不变断言，裁决 #1）。 */
const ROOM_SCOPED_STORES = [
  "participants",
  "rounds",
  "messages",
  "summaries",
  "modelExecutions",
  "runtimeBindings",
  "reports",
] as const;

interface RoomScopedRow {
  roomId: string;
}

interface AgentRow {
  id: string;
  name: string;
}

interface ProfileRow {
  id: string;
  name: string;
}

let context: BrowserContext;
let page: Page;

test.beforeEach(async ({ browser }) => {
  ({ context, page } = await freshPage(browser));
});

test.afterEach(async () => {
  await context?.close();
});

test.describe("S7 room admin", () => {
  test("删除：确认后列表消失，逐表归零，全局表不变，legacy 探针零读取", async () => {
    test.slow();
    // legacy 探针必须在首次导航前注册（addInitScript）；seed 后 reload，探针
    // 数组只记录 reload 之后的流程（security.spec §581 同款写法）。
    await installLegacyProbes(page);
    await bootSettings(page);
    await seedLegacyState(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();

    const topic = "S7 删除级联";
    const { roomId } = await setupRoom(page, topic);
    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");

    // 全局表基线（一轮完成后读取）：agents/executionProfiles 各 2 行。
    const agentsBefore = (await readStore<AgentRow>(page, "agents")).length;
    const profilesBefore = (await readStore<ProfileRow>(page, "executionProfiles")).length;
    expect(agentsBefore).toBe(2);
    expect(profilesBefore).toBe(2);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "讨论房间" })).toBeVisible();
    await roomListRow(page, roomId).getByRole("button", { name: "删除", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/此操作不可撤销/)).toBeVisible();
    await dialog.getByRole("button", { name: "确认删除" }).click();

    // 先等 UI 反映：Modal 关闭 + 列表清空（唯一房间，落回 EmptyState）。
    await expect(dialog).toBeHidden();
    await expect(page.getByText("还没有房间")).toBeVisible();
    await expect(page.getByText(topic)).toHaveCount(0);

    // 再验 Dexie 行：8 个 room 作用域表该 roomId 行全归零 + rooms 主键行消失。
    for (const store of ROOM_SCOPED_STORES) {
      const rows = await readStore<RoomScopedRow>(page, store);
      expect(
        rows.filter((row) => row.roomId === roomId),
        `${store} 不应残留被删房间的行`,
      ).toEqual([]);
    }
    const rooms = await readStore<{ id: string }>(page, "rooms");
    expect(
      rooms.some((room) => room.id === roomId),
      "rooms 表不应残留被删房间",
    ).toBe(false);
    // agents/executionProfiles 是全局表：行数不变（裁决 #1）。
    expect(await readStore<AgentRow>(page, "agents")).toHaveLength(agentsBefore);
    expect(await readStore<ProfileRow>(page, "executionProfiles")).toHaveLength(profilesBefore);

    // legacy 探针：应用全程只打开 runtime 库（快照先于 sentinel 读回——读回
    // 本身是测试侧合法的 legacy open）。
    const dbOpens = await dbOpenLog(page);
    expect(dbOpens.length, "the app should open its runtime DB").toBeGreaterThan(0);
    expect([...new Set(dbOpens)]).toEqual([RUNTIME_DB_NAME]);
    expect(await readLegacySentinel(page)).toEqual(LEGACY_SENTINEL);
  });

  test("复制：副本不带消息、参与者重 join 为新 id、可直接跑完一轮", async () => {
    test.slow();
    await bootSettings(page);
    const topic = "S7 复制验收";
    const { roomId, claudePid, codexPid } = await setupRoom(page, topic);
    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");
    const sourceMessages = await roomMessages(page, roomId);
    expect(sourceMessages.length).toBeGreaterThan(0);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "讨论房间" })).toBeVisible();
    await roomListRow(page, roomId).getByRole("button", { name: "复制", exact: true }).click();

    // 先等 UI 反映：副本（带「（副本）」后缀）出现在列表，源房间仍在。
    const copyLink = page.getByRole("link", { name: "（副本）" });
    await expect(copyLink).toBeVisible();
    await expect(page.locator(`a[href="/rooms/${roomId}"]`)).toBeVisible();

    await copyLink.click();
    await page.waitForURL(/\/rooms\/[0-9a-fA-F-]+/);
    const copyRoomId = page.url().split("/rooms/")[1] as string;
    await expect(page.getByRole("heading", { name: `${topic}（副本）` })).toBeVisible();
    await expect(page.getByText("还没有讨论")).toBeVisible();
    const strip = page.getByRole("list", { name: "参与者" });
    await expect(strip.getByText("安全蓝方")).toBeVisible();
    await expect(strip.getByText("安全红方")).toBeVisible();

    // 再验 Dexie 行：不复制消息/轮次/总结；Participant 重 join 为新 id。
    expect(await roomMessages(page, copyRoomId)).toEqual([]);
    expect(await roomRounds(page, copyRoomId)).toEqual([]);
    expect(await roomSummaries(page, copyRoomId)).toEqual([]);
    const copyParticipants = await roomParticipants(page, copyRoomId);
    expect(copyParticipants).toHaveLength(2);
    for (const participant of copyParticipants) {
      expect([claudePid, codexPid]).not.toContain(participant.id);
    }
    // 源房间行零变化。
    expect(await roomMessages(page, roomId)).toHaveLength(sourceMessages.length);

    // 副本可直接跑完一轮（fake driver；profileDigest 复制时已现算）。
    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");
    expect((await roomMessages(page, copyRoomId)).length).toBeGreaterThan(0);
  });
});
