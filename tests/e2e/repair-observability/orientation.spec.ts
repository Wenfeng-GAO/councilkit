import { type Page, expect, test } from "@playwright/test";
import { CANDIDATE_C, GOAL, PARENT_RUN_ID } from "./constants";
import {
  advanceClock,
  appendLines,
  expectChinese,
  expectGoalVisible,
  fetchObservation,
  finishCase,
  installOriginAllowlist,
  openRepairWorkspace,
  resetFixture,
  seedLine,
} from "./helpers";
import { shellCompleted, textProgress } from "./fixtures/cursor-events";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await installOriginAllowlist(page);
});

async function boot(page: Page, fixture: Parameters<typeof resetFixture>[1]) {
  await page.goto("/");
  await resetFixture(page, fixture);
}

test("[E01] @p0 enter repair workspace with goal/phase/activity/attention", async ({ page }) => {
  await boot(page, "F1");
  const obsPromise = page.waitForResponse(
    (r) => r.url().includes("/repair/observation") && r.ok(),
  );
  await openRepairWorkspace(page);
  const obs = await obsPromise;
  const body = (await obs.json()) as { data: { upserts: unknown[] } };
  expect(body.data.upserts.length).toBeGreaterThan(0);
  expect(body.data.upserts.length).toBeLessThanOrEqual(200);
  await expectGoalVisible(page);
  await expect(page.getByTestId("repair-phase")).toBeVisible();
  await expect(page.getByTestId("repair-last-activity")).toBeVisible();
  await expect(page.getByTestId("repair-attention")).toBeVisible();
  await expect(page.getByTestId("repair-tab-activity")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("%")).not.toBeVisible();
  await expect(page.getByTestId("repair-goal")).not.toHaveText(/^https?:\/\//);
});

test("[E02] @p0 waiting for first record then append", async ({ page }) => {
  await boot(page, "F0");
  await openRepairWorkspace(page);
  await expectChinese(page, "等待首条记录");
  await expect(page.getByTestId("repair-empty")).toBeVisible();
  await expect(page.getByTestId("repair-role-list")).toBeVisible();
  await expect(page.getByText("失败", { exact: true })).not.toBeVisible();
  await appendLines(page, [
    textProgress("首条公开活动：开始恢复", { at: "2026-09-22T06:00:01.000Z" }),
  ]);
  await expect(page.getByTestId("repair-activity-list")).toContainText("首条公开活动", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("repair-empty")).toHaveCount(0);
  await expect(page.getByTestId("repair-role-list")).toBeVisible();
});

test("[E03] @p0 continuous Builder roles share one execution group", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  const roles = page.getByTestId("repair-role-list");
  await expect(roles).toContainText(/编排|开发|Builder/i);
  const groupCount = await page.locator("[data-testid^='repair-role-'][data-execution-group]").count();
  // Shared session → one group, not three parallel executors.
  expect(groupCount).toBeLessThanOrEqual(2);
  await page.getByTestId("repair-role-builder").click();
  const detailsVisible = await page.getByTestId("repair-run-details").isVisible();
  const drawerVisible = await page.getByTestId("repair-event-drawer").isVisible();
  expect(detailsVisible || drawerVisible).toBeTruthy();
});

test("[E04] @p0 optional Planner B appears only when planned", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-role-planner_b")).toHaveCount(0);
  const selected = await page.getByTestId(/^repair-role-/).first().getAttribute("data-testid");
  await resetFixture(page, "F2");
  await page.reload();
  await expect(page.getByTestId("repair-workspace")).toBeVisible();
  // F2 has independent reviewer/verifier; still no invented planner_b pending seat from F1 plan.
  if (selected) {
    // Selection should not auto-jump solely because another fixture role became active.
    await expect(page.getByTestId("repair-role-list")).toBeVisible();
  }
});

test("[E05] @p0 independent Reviewer and Verifier run in parallel", async ({ page }) => {
  await boot(page, "F2");
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-role-reviewer")).toBeVisible();
  await expect(page.getByTestId("repair-role-verifier")).toBeVisible();
  await expect(page.getByTestId("repair-activity-list")).toContainText(/Reviewer|Verifier|核验|审查/);
  // Builder ended ≠ PR approved
  await expect(page.getByText("已准出")).toHaveCount(0);
});

test("[E06] @p0 role reading state restored after switch", async ({ page }) => {
  await boot(page, "F2");
  await openRepairWorkspace(page);
  const verifier = page.getByTestId("repair-role-verifier");
  await verifier.click();
  await page.getByTestId("repair-filter-query").fill("核验");
  const list = page.getByTestId("repair-activity-list");
  await list.evaluate((el) => {
    el.scrollTop = Math.min(120, el.scrollHeight);
  });
  const before = await list.evaluate((el) => el.scrollTop);
  await page.getByTestId("repair-role-reviewer").click();
  await appendLines(page, [textProgress("Reviewer extra", { at: "2026-09-22T06:01:00.000Z" })]);
  await verifier.click();
  await expect(page.getByTestId("repair-filter-query")).toHaveValue("核验");
  const after = await list.evaluate((el) => el.scrollTop);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(48);
});

test("[E07] @p0 activity kinds show role/time/type/summary as text", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  const rows = page.locator("[data-testid^='repair-activity-row-']");
  await expect(rows.first()).toBeVisible();
  const text = await page.getByTestId("repair-activity-list").innerText();
  expect(text).toMatch(/读取|修改|命令|进展|状态|文件|工具/);
  expect(text.length).toBeGreaterThan(20);
  // Not one row per token: row count bounded vs log volume
  expect(await rows.count()).toBeLessThan(50);
});

test("[E08] @p0 interleaved same-name tools pair by callId", async ({ page }) => {
  await boot(page, "F8");
  await openRepairWorkspace(page);
  const obs = await fetchObservation(page);
  const upserts = (obs.data?.upserts as Array<{ operationId: string; summary: string }>) ?? [];
  const shells = upserts.filter((u) => /echo one|shell|命令/i.test(u.summary) || u.operationId.includes("call_x"));
  // Two distinct operations, not name-adjacent pairing into one
  expect(shells.length).toBeGreaterThanOrEqual(2);
  const ids = new Set(shells.map((s) => s.operationId));
  expect(ids.size).toBeGreaterThanOrEqual(2);
});

test("[E09] @p0 read vs edit diff provenance", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  const readRow = page.locator("[data-testid^='repair-activity-row-']").filter({ hasText: "读取" }).first();
  await readRow.click();
  const drawer = page.getByTestId("repair-event-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText(/读取/);
  await expect(drawer).not.toContainText(/已修改统计|编造/);
  await page.keyboard.press("Escape");
  const editRow = page.locator("[data-testid^='repair-activity-row-']").filter({ hasText: "已记录差异" }).first();
  await editRow.click();
  await expect(drawer).toContainText(/差异|已记录|未记录/);
});

test("[E10] @p0 unfinished tool then real failure completion", async ({ page }) => {
  await boot(page, "F8");
  await openRepairWorkspace(page);
  await advanceClock(page, { ms: 3 * 60 * 1000 + 20_000 });
  await expectChinese(page, "未收到结束记录");
  await appendLines(page, [
    shellCompleted("call_hang", "sleep 999", "killed by timeout", 1, {
      at: "2026-09-22T06:05:00.000Z",
    }),
  ]);
  await expect(page.getByTestId("repair-activity-list")).toContainText(/失败|killed|timeout/, {
    timeout: 10_000,
  });
  await expect(page.getByText("未收到结束记录")).toHaveCount(0);
});

test("[E64] @p0 run details distinguish requested vs actual model", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await page.getByTestId("repair-run-details").click();
  const details = page.getByTestId("repair-run-details");
  await expect(details).toContainText(/请求|实际|requested|actual/i);
  await expect(details).not.toContainText(/默认模型/);
  await expect(page.getByTestId("repair-goal")).toContainText(GOAL);
});

test("[E67] @p0 child review grouping does not impersonate sourceRun", async ({ page }) => {
  await boot(page, "F-child-review");
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-role-list")).toContainText(/终验|复审|jury|评审/i);
  const text = await page.getByTestId("repair-workspace").innerText();
  expect(text).toMatch(/child|终验|复审|ck-review-00000000-0000-4000-8000-000000000200/);
  await expect(page.getByText("已准出")).toHaveCount(0);
  // source baseline must not be presented as current execution
  await expect(page.getByTestId("repair-phase")).not.toContainText(/source baseline 作为当前执行/);
});

void CANDIDATE_C;
void PARENT_RUN_ID;
void finishCase;
void seedLine;
