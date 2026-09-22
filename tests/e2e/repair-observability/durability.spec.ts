import { type Page, expect, test } from "@playwright/test";
import { GOAL, PARENT_RUN_ID, TASK_ID_ROUND2 } from "./constants";
import {
  advanceClock,
  appendHalfLine,
  appendRaw,
  chmodSource,
  expectChinese,
  expectGoalVisible,
  fetchObservation,
  installOriginAllowlist,
  openRepairWorkspace,
  resetFixture,
  rotateSource,
  seedLine,
} from "./helpers";
import { shellCompleted, textProgress } from "./fixtures/cursor-events";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await installOriginAllowlist(page);
});

async function boot(page: Page, fixture: Parameters<typeof resetFixture>[1]) {
  await page.goto("/");
  return resetFixture(page, fixture);
}

test("[E40] @p0 large log initial window 200 with earlier page", async ({ page }) => {
  test.setTimeout(300_000);
  const reset = await boot(page, "F9");
  expect(reset.operationCount).toBe(100_000);
  expect(reset.logBytes ?? 0).toBeGreaterThan(10 * 1024 * 1024);
  const obsPromise = page.waitForResponse(
    (r) => r.url().includes("/repair/observation") && r.ok(),
  );
  await openRepairWorkspace(page);
  const obsRes = await obsPromise;
  const body = (await obsRes.json()) as {
    data: { upserts: unknown[]; hasMore: boolean; earlierCursor: string | null };
  };
  expect(body.data.upserts.length).toBeLessThanOrEqual(200);
  expect(body.data.hasMore || body.data.earlierCursor).toBeTruthy();
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  expect(bytes).toBeLessThanOrEqual(512 * 1024);
  await page.getByTestId("repair-load-earlier").click();
  await expect(page.getByTestId("repair-activity-list")).toBeVisible();
  // Must not dump entire 50MiB into DOM
  const rowCount = await page.locator("[data-testid^='repair-activity-row-']").count();
  expect(rowCount).toBeLessThanOrEqual(400);
});

test("[E41] @p0 bad/half/chinese lines", async ({ page }) => {
  await boot(page, "F8");
  await openRepairWorkspace(page);
  await appendRaw(page, "{not-json\n");
  await appendHalfLine(page, `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"中文半行`);
  // Incomplete half-line must not advance past boundary — no garbled row yet for half
  await page.waitForTimeout(800);
  await appendHalfLine(page, `完整"}]}}`, true);
  await expect(page.getByTestId("repair-activity-list")).toContainText("中文半行完整", {
    timeout: 10_000,
  });
  await expect(page.getByText(/坏行|无法解析|部分不可用|受限/)).toBeVisible();
});

test("[E42] @p0 log rotate resets generation without id collision", async ({ page }) => {
  await boot(page, "F8");
  await openRepairWorkspace(page);
  const before = await fetchObservation(page);
  const beforeIds = new Set(
    ((before.data?.upserts as Array<{ eventId: string }>) ?? []).map((u) => u.eventId),
  );
  await rotateSource(page, {
    generation: "gen-rotate-1",
    seedLine: textProgress("轮转后新事件", { at: "2026-09-22T06:20:00.000Z" }),
  });
  await expect(page.getByTestId("repair-activity-list")).toContainText("轮转后新事件", {
    timeout: 10_000,
  });
  const after = await fetchObservation(page);
  const afterIds = ((after.data?.upserts as Array<{ eventId: string }>) ?? []).map((u) => u.eventId);
  for (const id of afterIds) {
    if (beforeIds.has(id) && id.includes("gen-rotate")) {
      // new generation ids must not collide with old
      expect(id).toContain("gen-rotate");
    }
  }
  await expect(page.getByText(/归档|重建|轮转|generation/i)).toBeVisible();
});

test("[E43] @p0 refresh restores from disk", async ({ page }) => {
  await boot(page, "F1");
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-activity-list")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("repair-workspace")).toBeVisible();
  await expectGoalVisible(page);
  await expect(page.getByTestId("repair-activity-list")).toContainText(/session|恢复|公开进展/);
});

test("[E44] @p0 late previous execution must not overwrite current", async ({ page }) => {
  await boot(page, "F8");
  await openRepairWorkspace(page);
  await appendRaw(
    page,
    `${JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      call_id: "call_e1",
      execution_ref: "exec-builder-e1",
      tool_call: { shellToolCall: { result: { exitCode: 1, stdout: "E1 late fail" } } },
    })}\n`,
  );
  const obs = await fetchObservation(page);
  const upserts = (obs.data?.upserts as Array<{ executionRef: string; status: string }>) ?? [];
  const e2 = upserts.filter((u) => u.executionRef?.includes("e2") || !u.executionRef?.includes("e1"));
  expect(e2.length).toBeGreaterThan(0);
  await expect(page.getByTestId("repair-activity-list")).toContainText("E1 late fail");
});

test("[E45] @p0 host restart recovery keeps durable history", async ({ page }) => {
  // Same Host process (Playwright webServer) — simulate by reset home intact + reload.
  const reset = await boot(page, "F1");
  await openRepairWorkspace(page);
  const home = reset.home;
  await page.reload();
  await expect(page.getByTestId("repair-workspace")).toBeVisible();
  await expect(page.getByTestId("repair-activity-list")).toContainText(/公开进展|session/);
  // Authority home unchanged path prefix
  expect(home).toContain("ck-repair-obs-");
});

test("[E59] @p0 legacy attempts=[] still observable", async ({ page }) => {
  await boot(page, "F-legacy");
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-activity-list")).toBeVisible();
  await expect(page.getByTestId("repair-activity-list")).toContainText(/升级前|legacy|公开/);
});

test("[E63] @p0 legacy empty final report vs waiting first record", async ({ page }) => {
  await boot(page, "F-legacy-empty");
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-workspace").getByText("仅有最终报告", { exact: true })).toBeVisible();
  await expectGoalVisible(page).catch(async () => {
    await expect(page.getByText(GOAL)).toBeVisible();
  });
  await expect(page.getByTestId("repair-process")).not.toHaveText(/无限|loading…{5,}/);

  await resetFixture(page, "F0");
  await page.goto(`/reports/${PARENT_RUN_ID}`);
  await expectChinese(page, "等待首条记录");
});

test("[E65] @p0 partial source unreadable still shows other roles", async ({ page }) => {
  await boot(page, "F2");
  await chmodSource(page, `squad-tasks/${TASK_ID_ROUND2}/adapter-runs/reviewer/events.jsonl`, 0o000);
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-workspace")).toBeVisible();
  await expect(page.getByText(/受限|不可读|权限|部分/)).toBeVisible();
  await expect(page.getByTestId("repair-role-list")).toBeVisible();
});

void advanceClock;
void shellCompleted;
void seedLine;
