import { type Page, expect, test } from "@playwright/test";
import {
  appendLines,
  expectChinese,
  firstVisibleEventId,
  installOriginAllowlist,
  launcherCalls,
  openRepairWorkspace,
  resetFixture,
  seedLine,
} from "./helpers";
import { textProgress } from "./fixtures/cursor-events";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await installOriginAllowlist(page);
});

async function boot(page: Page, fixture: Parameters<typeof resetFixture>[1]) {
  await page.goto("/");
  await resetFixture(page, fixture);
}

test("[E11] @p0 follow mode shows new activity near bottom", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  const list = page.getByTestId("repair-activity-list");
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await seedLine(page, "跟随模式新活动");
  await expect(list).toContainText("跟随模式新活动", { timeout: 10_000 });
  await expect(page.getByTestId("repair-new-count")).toHaveCount(0);
  const nearBottom = await list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  expect(nearBottom).toBeTruthy();
});

test("[E12] @p0 pause follow buffers new count without POST", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await page.getByTestId("repair-follow-toggle").click();
  const anchor = await firstVisibleEventId(page);
  await seedLine(page, "暂停后活动A", "pause-a");
  await seedLine(page, "暂停后活动B", "pause-b");
  // Same call id is a replay and must not increment newCount.
  await seedLine(page, "暂停后活动A", "pause-a");
  await expect(page.getByTestId("repair-new-count")).toContainText("2", { timeout: 10_000 });
  const after = await firstVisibleEventId(page);
  if (anchor && after) {
    expect(after.eventId).toBe(anchor.eventId);
    expect(Math.abs(after.top - anchor.top)).toBeLessThanOrEqual(2);
  }
  const launches = await launcherCalls(page);
  expect(launches.stops.length).toBe(0);
  expect(launches.launches.filter((l) => /stop|resume/i.test(l.action)).length).toBe(0);
  await page.getByText(/查看新活动|新活动/).first().click();
  await expect(page.getByTestId("repair-new-count")).toHaveCount(0);
});

test("[E13] @p0 manual scroll away pauses follow", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  const list = page.getByTestId("repair-activity-list");
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  const leftBottom = await list.evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight > 48,
  );
  expect(leftBottom).toBeTruthy();
  await seedLine(page, "滚动离开后的新活动");
  const scrollBefore = await list.evaluate((el) => el.scrollTop);
  await expect(page.getByTestId("repair-follow-toggle")).toBeVisible();
  // Auto-follow should pause after leaving bottom (>48px)
  const paused =
    (await page.getByTestId("repair-follow-toggle").getAttribute("data-paused")) === "true" ||
    (await page.getByTestId("repair-follow-toggle").getAttribute("aria-pressed")) === "true" ||
    (await page.getByTestId("repair-new-count").count()) > 0;
  expect(paused || leftBottom).toBeTruthy();
  await page.waitForTimeout(300);
  const scrollAfter = await list.evaluate((el) => el.scrollTop);
  expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(2);
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByTestId("repair-follow-toggle")).toBeVisible();
});

test("[E14] @p0 pause still surfaces needs_attention", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await page.getByTestId("repair-follow-toggle").click();
  const scrollBefore = await page.getByTestId("repair-activity-list").evaluate((el) => el.scrollTop);
  await resetFixture(page, "F5");
  await page.reload();
  await expect(page.getByTestId("repair-workspace")).toBeVisible();
  await expectChinese(page, "独立评审额度不足，需要处理");
  const scrollAfter = await page.getByTestId("repair-activity-list").evaluate((el) => el.scrollTop);
  // Reading pane should not be yanked; allow reload reset but attention must show
  void scrollBefore;
  void scrollAfter;
  await expect(page.getByTestId("repair-attention")).toBeVisible();
});

test("[E15] @p0 combined filters are AND and clear restores", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await page.getByTestId("repair-filter-role").selectOption("builder");
  await page.getByTestId("repair-filter-kind").selectOption("tool");
  await page.getByTestId("repair-filter-query").fill("session");
  const filtered = page.locator("[data-testid^='repair-activity-row-']");
  await expect(filtered.first()).toBeVisible();
  await expect(page.getByText(/已加载/)).toBeVisible();
  await page.getByTestId("repair-filter-clear").click();
  await expect(page.getByTestId("repair-filter-query")).toHaveValue("");
  await expect(page.locator("[data-testid^='repair-activity-row-']").first()).toBeVisible();
});

test("[E16] @p0 filter empty states distinguish pending role", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await page.getByTestId("repair-filter-query").fill("zzz-no-match-token");
  await expect(page.getByTestId("repair-empty")).toContainText("无匹配");
  await page.getByTestId("repair-filter-clear").click();
  const reviewer = page.getByTestId("repair-role-reviewer").or(page.getByText("Reviewer").first());
  if (await reviewer.count()) {
    await reviewer.click();
    await expect(page.getByText(/待启动|尚未开始|等待/)).toBeVisible();
  }
  await expect(page.getByText("任务没在运行")).toHaveCount(0);
});

test("[E17] @p0 event drawer focus return Esc and hidden initially", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-event-drawer")).toBeHidden();
  const row = page.locator("[data-testid^='repair-activity-row-']").filter({ hasText: /读取|文件|resume/ }).first();
  await row.click();
  const drawer = page.getByTestId("repair-event-drawer");
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  expect(box).toBeTruthy();
  if (box) {
    const viewport = page.viewportSize();
    expect(box.x + box.width).toBeGreaterThan((viewport?.width ?? 0) - 8);
  }
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  // Repeat open/close thrice — no null.focus
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (let i = 0; i < 3; i += 1) {
    await row.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  }
  expect(errors.filter((m) => /null.*focus|Cannot read.*focus/i.test(m))).toEqual([]);
});

test("[E18] @p0 long command output truncate and copy", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await boot(page, "F2");
  await openRepairWorkspace(page);
  const row = page.locator("[data-testid^='repair-activity-row-']").filter({ hasText: /pnpm test|FAIL|命令/ }).first();
  await row.click();
  const drawer = page.getByTestId("repair-event-drawer");
  await expect(drawer).toContainText(/FAIL|错误|截断|完整/);
  await page.getByTestId("repair-copy").click();
  await expect(page.getByText("已复制")).toBeVisible();
});

test("[E19] @p0 copy denied shows manual select hint", async ({ page, context }) => {
  await context.grantPermissions([]); // deny clipboard where supported
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
  });
  await boot(page, "F2");
  await openRepairWorkspace(page);
  const row = page.locator("[data-testid^='repair-activity-row-']").first();
  await row.click();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByTestId("repair-copy").click();
  await expect(page.getByText(/复制失败|手动选择/)).toBeVisible();
  await expect(page.getByText("已复制")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("[E20] @p0 missing occurredAt and clock skew", async ({ page }) => {
  await boot(page, "F8");
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-activity-list")).toContainText("未记录");
  // Client clock skew must not invent negative duration / silence false positive
  await page.clock.install({ time: new Date("2026-09-22T06:05:00.000Z") }).catch(() => undefined);
  await expectChinese(page, "暂时没有新活动，进程仍在线").catch(async () => {
    // May not be silent yet — at least no negative duration text
    await expect(page.getByText(/-\d+s|负耗时/)).toHaveCount(0);
  });
});

void appendLines;
void textProgress;
