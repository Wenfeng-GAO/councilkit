import { type Page, expect, test } from "@playwright/test";
import {
  advanceClock,
  expectChinese,
  fetchObservation,
  installOriginAllowlist,
  openRepairWorkspace,
  resetFixture,
  seedLine,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await installOriginAllowlist(page);
});

async function boot(page: Page, fixture: Parameters<typeof resetFixture>[1]) {
  await page.goto("/");
  await resetFixture(page, fixture);
}

test("[E51] @p0 responsive layout viewports", async ({ page }) => {
  await boot(page, "F1");
  for (const size of [
    { width: 1440, height: 960 },
    { width: 1280, height: 900 },
    { width: 721, height: 900 },
    { width: 720, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await openRepairWorkspace(page);
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflowX, `overflow at ${size.width}`).toBeFalsy();
    await expect(page.getByTestId("repair-role-list")).toBeVisible();
    await expect(page.getByTestId("repair-follow-toggle")).toBeVisible();
  }
});

test("[E52] @p0 drawer geometry desktop and mobile", async ({ page }) => {
  await boot(page, "F1");
  await page.setViewportSize({ width: 1440, height: 960 });
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-event-drawer")).toBeHidden();
  await page.locator("[data-testid^='repair-activity-row-']").first().click();
  const drawer = page.getByTestId("repair-event-drawer");
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  expect(box).toBeTruthy();
  if (box) {
    expect(Math.abs(box.width - 430)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.x + box.width - 1440)).toBeLessThanOrEqual(1);
  }
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-testid^='repair-activity-row-']").first().click();
  const mobile = await drawer.boundingBox();
  expect(mobile).toBeTruthy();
  if (mobile) {
    expect(Math.abs(mobile.width - 390)).toBeLessThanOrEqual(2);
    expect(mobile.x).toBeLessThanOrEqual(1);
  }
});

test("[E53] @p0 keyboard focus path", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName);
  expect(focused).toBeTruthy();
  await page.locator("[data-testid^='repair-activity-row-']").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("repair-event-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("repair-event-drawer")).toBeHidden();
  await page.getByTestId("repair-stop").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("repair-stop-confirm")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("repair-stop-confirm")).toBeHidden();
});

test("[E54] @p0 prefers-reduced-motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await seedLine(page, "reduced-motion 新事件");
  await expect(page.getByTestId("repair-activity-list")).toContainText("reduced-motion", {
    timeout: 10_000,
  });
  const spinning = await page.locator(".animate-spin, [data-spinning='true']").count();
  expect(spinning).toBe(0);
});

test("[E55] @p0 visual tokens contrast snapshots", async ({ page }) => {
  await boot(page, "F1");
  await page.setViewportSize({ width: 1440, height: 960 });
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-workspace")).toBeVisible();
  const color = await page.getByTestId("repair-goal").evaluate((el) => getComputedStyle(el).color);
  expect(color).toBeTruthy();
  await page.screenshot({
    path: "test-results/repair-observability/screenshots/e55-f1.png",
    fullPage: false,
  });
  await resetFixture(page, "F3");
  await page.reload();
  await expectChinese(page, "暂时没有新活动，进程仍在线");
  await page.screenshot({ path: "test-results/repair-observability/screenshots/e55-f3.png" });
  await resetFixture(page, "F5");
  await page.reload();
  await expectChinese(page, "独立评审额度不足，需要处理");
  await page.screenshot({ path: "test-results/repair-observability/screenshots/e55-f5.png" });
  await resetFixture(page, "F6a");
  await page.reload();
  await expectChinese(page, "已准出");
  await page.screenshot({ path: "test-results/repair-observability/screenshots/e55-f6a.png" });
});

test("[E56] @p0 read and memory upper bounds", async ({ page }) => {
  test.setTimeout(300_000);
  await boot(page, "F9");
  const sizes: number[] = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/repair/observation")) return;
    try {
      const buf = await res.body();
      sizes.push(buf.byteLength);
    } catch {
      // ignore
    }
  });
  await openRepairWorkspace(page);
  await page.waitForTimeout(2000);
  for (const size of sizes) {
    expect(size).toBeLessThanOrEqual(512 * 1024);
  }
  const obs = await fetchObservation(page);
  expect(((obs.data?.upserts as unknown[]) ?? []).length).toBeLessThanOrEqual(200);
  const rows = await page.locator("[data-testid^='repair-activity-row-']").count();
  expect(rows).toBeLessThanOrEqual(400);
});

test("[E57] @p0 flush-to-visible latency 20 samples", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await resetFixture(page, "F1");
  await advanceClock(page, { useRealClock: true });
  await openRepairWorkspace(page);
  const samples: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const summary = `latency-sample-${i}-${Date.now()}`;
    const t0 = Date.now();
    await seedLine(page, summary);
    await expect(page.getByTestId("repair-activity-list")).toContainText(summary, {
      timeout: 5_000,
    });
    samples.push(Date.now() - t0);
  }
  const within2s = samples.filter((ms) => ms <= 2000).length;
  expect(within2s).toBeGreaterThanOrEqual(19);
  expect(Math.max(...samples)).toBeLessThanOrEqual(4000);
  // Persist samples into test output (not committed)
  const fs = await import("node:fs");
  fs.mkdirSync("test-results/repair-observability", { recursive: true });
  fs.writeFileSync(
    "test-results/repair-observability/e57-latency.json",
    JSON.stringify({ samples, within2s, max: Math.max(...samples) }, null, 2),
  );
});

test("[E61] @p0 production build has no demo chrome", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (req) => {
    const url = req.url();
    if (!url.startsWith("http://127.0.0.1:43837") && !url.startsWith("data:") && !url.startsWith("blob:")) {
      external.push(url);
    }
  });
  await boot(page, "F1");
  await openRepairWorkspace(page);
  const html = await page.content();
  expect(html).not.toMatch(/模拟活动|重置演示|fake数据|场景切换|全部fake/i);
  expect(external).toEqual([]);
});
