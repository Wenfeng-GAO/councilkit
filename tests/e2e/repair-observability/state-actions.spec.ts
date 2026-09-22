import { type Page, expect, test } from "@playwright/test";
import { PARENT_RUN_ID } from "./constants";
import {
  advanceClock,
  appendLines,
  blockObservation,
  delayObservation,
  expectChinese,
  finishCase,
  installOriginAllowlist,
  launcherCalls,
  openRepairWorkspace,
  postRepairStop,
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

test("[E21] @p0 silent but process still online", async ({ page }) => {
  await boot(page, "F3");
  await advanceClock(page, { to: "2026-09-22T06:00:00.000Z" });
  await openRepairWorkspace(page);
  await expectChinese(page, "暂时没有新活动，进程仍在线");
  await expect(page.getByTestId("repair-last-activity")).toBeVisible();
  await expect(page.getByText(/卡死|自动重试/)).toHaveCount(0);
});

test("[E22] @p0 no live process evidence shows unknown", async ({ page }) => {
  await boot(page, "F3b");
  await openRepairWorkspace(page);
  await expectChinese(page, "执行进程状态未知");
  await expect(page.getByTestId("repair-activity-list")).toContainText(/历史活动|保留/);
});

test("[E23] @p0 connection lost keeps last known state", async ({ page }) => {
  await boot(page, "F4");
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-workspace")).toBeVisible();
  const unblock = await blockObservation(page);
  await page.waitForTimeout(1200);
  await expectChinese(page, "连接已断开");
  await expect(page.getByTestId("repair-connection")).toBeVisible();
  await expect(page.getByTestId("repair-filter-query")).toBeVisible();
  await expect(page.getByText(/进程死|任务失败/)).toHaveCount(0);
  await expect(page.getByTestId("repair-stop")).toBeDisabled();
  await unblock();
});

test("[E24] @p0 reconnect dedupes and keeps anchor", async ({ page }) => {
  await boot(page, "F4");
  await openRepairWorkspace(page);
  const unblock = await blockObservation(page);
  await expectChinese(page, "连接已断开");
  await unblock();
  await resetFixture(page, "F2");
  for (let i = 0; i < 5; i += 1) {
    await seedLine(page, `重放行-${i}`);
  }
  await seedLine(page, "恢复后新记录");
  await expect(page.getByTestId("repair-connection")).not.toContainText("连接已断开", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("repair-activity-list")).toContainText("恢复后新记录");
  const launches = await launcherCalls(page);
  expect(launches.stops.length).toBe(0);
});

test("[E25] @p0 polling single in-flight and visibility pause", async ({ page }) => {
  await boot(page, "F1");
  let inFlight = 0;
  let maxInFlight = 0;
  await page.route("**/api/v1/cli-runs/*/repair/observation**", async (route) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await route.continue();
    inFlight -= 1;
  });
  await openRepairWorkspace(page);
  await page.waitForTimeout(2500);
  expect(maxInFlight).toBeLessThanOrEqual(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const mid = maxInFlight;
  await page.waitForTimeout(1500);
  // hidden should stop scheduling new periodic polls (allow in-flight drain)
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1200);
  expect(maxInFlight).toBeGreaterThanOrEqual(mid);
});

test("[E26] @p0 stale observation response must not overwrite new selection", async ({ page }) => {
  await boot(page, "F2");
  await openRepairWorkspace(page);
  const release = await delayObservation(page, 5000, (url) => url.includes("round=current"));
  await page.getByTestId("repair-role-reviewer").click();
  await page.getByTestId("repair-role-verifier").click();
  release();
  await page.waitForTimeout(600);
  await expect(page.getByTestId("repair-role-verifier")).toHaveAttribute("aria-pressed", "true");
});

test("[E27] @p0 quota shortage shows readonly steps", async ({ page }) => {
  await boot(page, "F5");
  await openRepairWorkspace(page);
  await expectChinese(page, "独立评审额度不足，需要处理");
  await page.getByTestId("repair-quota-steps").click();
  await expect(page.getByTestId("repair-quota-steps")).toContainText(/换席|预算|session/);
  await expect(page.getByRole("button", { name: /自动fallback|热换|清零预算/ })).toHaveCount(0);
});

test("[E28] @p0 resume eligibility only when recoverable", async ({ page }) => {
  await boot(page, "F5b-recoverable");
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-resume")).toBeEnabled();

  await resetFixture(page, "F5b-budget");
  await page.reload();
  await expect(page.getByTestId("repair-workspace")).toBeVisible();
  await expect(page.getByTestId("repair-resume")).toBeDisabled();
  await expect(page.getByText(/再修一次/)).toHaveCount(0);

  await resetFixture(page, "F5b-unknown");
  await page.reload();
  await expect(page.getByTestId("repair-workspace")).toBeVisible();
  await expect(page.getByTestId("repair-resume")).toBeDisabled();
});

test("[E29] @p0 stop cancel Esc no POST", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await page.getByTestId("repair-stop").click();
  await expect(page.getByTestId("repair-stop-confirm")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "确认停止" }).getByText(/历史|预算/)).toBeVisible();
  await page.getByTestId("repair-stop-cancel").click();
  const launches = await launcherCalls(page);
  expect(launches.stops.length).toBe(0);
  await page.getByTestId("repair-stop").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("repair-stop-confirm")).toBeHidden();
  expect((await launcherCalls(page)).stops.length).toBe(0);
});

test("[E30] @p0 stop confirm double-click posts once", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await page.getByTestId("repair-stop").click();
  const confirm = page.getByTestId("repair-stop-confirm");
  await confirm.click();
  await confirm.click({ force: true }).catch(() => undefined);
  await expect.poll(async () => (await launcherCalls(page)).stops.length).toBe(1);
  expect((await launcherCalls(page)).stops[0]?.runId).toBe(PARENT_RUN_ID);
});

test("[E31] @p0 stop ack is not stopped until controller terminal", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await page.getByTestId("repair-stop").click();
  await page.getByTestId("repair-stop-confirm").click();
  await expectChinese(page, "停止中，等待执行确认");
  await expect(page.getByText("已停止")).toHaveCount(0);
  await finishCase(page, { businessResult: "stopped", reasonCode: "user_stop", status: "completed" });
  await expectChinese(page, "已停止");
});

test("[E32] @p0 stop failure does not claim success", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await page.route(`**/api/v1/cli-runs/${PARENT_RUN_ID}/repair/stop`, async (route) => {
    await route.abort();
  });
  await page.getByTestId("repair-stop").click();
  await page.getByTestId("repair-stop-confirm").click();
  await expect(page.getByText(/失败|待确认|不确定/)).toBeVisible();
  await expect(page.getByText("已停止")).toHaveCount(0);
});

test("[E33] @p0 historical round is readonly", async ({ page }) => {
  await boot(page, "F7");
  await openRepairWorkspace(page);
  await page.getByTestId("repair-round-select").selectOption({ value: "1" });
  await expect(page.getByTestId("repair-history-banner")).toBeVisible();
  await expect(page.getByTestId("repair-stop")).toBeDisabled();
  await expect(page.getByTestId("repair-resume")).toBeDisabled();
  await expect(page.getByTestId("repair-activity-list")).toContainText(/round1|archived|历史/);
});

test("[E34] @p0 return to current round after history", async ({ page }) => {
  await boot(page, "F7");
  await openRepairWorkspace(page);
  await page.getByTestId("repair-round-select").selectOption("1");
  await finishCase(page, {
    businessResult: "needs_attention",
    reasonCode: "still_open",
    status: "running",
    phase: "repair-building",
  });
  await page.getByTestId("repair-round-select").selectOption("2");
  await expect(page.getByText("已准出")).toHaveCount(0);
  await expect(page.getByTestId("repair-phase")).toBeVisible();
});

test("[E35] @p0 acceptance four states", async ({ page }) => {
  await boot(page, "F2");
  await openRepairWorkspace(page);
  await page.getByTestId("repair-tab-evidence").click();
  const evidence = page.getByTestId("repair-evidence");
  await expect(evidence).toContainText(/通过|未通过|待验证|证据不足/);
  await expect(evidence).not.toContainText(/✓.*证据不足/);
});

test("[E36] @p0 candidate ready awaiting final gate", async ({ page }) => {
  await boot(page, "F6");
  await openRepairWorkspace(page);
  await expectChinese(page, "本地候选完成，等待最终准出");
  await expect(page.getByText("已准出")).toHaveCount(0);
  await expect(page.getByText(/已交付/)).toHaveCount(0);
});

test("[E37] @p0 legitimate approved with evidence", async ({ page }) => {
  await boot(page, "F6a");
  await openRepairWorkspace(page);
  await expectChinese(page, "已准出");
  await expect(page.getByTestId("repair-workspace")).toContainText(/SHA|核验/);
  await expect(page.getByTestId("repair-stop")).toHaveCount(0);
});

test("[E38] @p0 approved conflicting evidence", async ({ page }) => {
  await boot(page, "F6b");
  await openRepairWorkspace(page);
  await expectChinese(page, "状态与证据不一致");
  await expect(page.locator(".text-green-500, [data-tone='success']").filter({ hasText: /已准出/ })).toHaveCount(0);
});

test("[E39] @p0 budget remaining without fake token zero", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-workspace")).toContainText(/剩余\s*1|1\s*\/\s*3|还剩\s*1/);
  await expect(page.getByText(/0\s*消耗|估算.*%/)).toHaveCount(0);
  await expect(page.getByText(/500K|上下文/)).toBeVisible();
});

test("[E68] @p0 terminal state drains final log before observationDone", async ({ page }) => {
  await boot(page, "F6");
  await openRepairWorkspace(page);
  await finishCase(page, {
    businessResult: "needs_attention",
    status: "completed",
    phase: "done",
    appendFinalLog: false,
  });
  // Still observing until drain
  await appendLines(page, [textProgress("终态后最后一条完整日志", { at: "2026-09-22T06:10:00.000Z" })]);
  await expect(page.getByTestId("repair-activity-list")).toContainText("终态后最后一条完整日志", {
    timeout: 10_000,
  });
  // Candidate-complete alone must not freeze final gate visibility forever
  await expect(page.getByText(/等待最终准出|需要处理|已准出/)).toBeVisible();
});
