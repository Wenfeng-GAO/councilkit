/**
 * B4 (#279): closing the tab while the decision report generates, then
 * reopening the room, must not leave the page stuck in 「正在生成决策报告…」.
 */
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import { setupRoomWithTwoAgents, waitRoundPhase } from "./control-helpers";
import {
  concludeRoomViaButton,
  driverCounters,
  reportView,
  resetDriverState,
  resumeDrivers,
  roomExecutions,
  setDriverBehavior,
  startRound,
} from "./helpers";

/** Set B4_SHOTS=<dir> to save the designer-review screenshots. */
const SHOTS = process.env.B4_SHOTS;
async function shot(target: Page, name: string) {
  if (SHOTS) await target.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

let context: BrowserContext;
let page: Page;

test.beforeEach(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await resetDriverState(page);
});

test.afterEach(async () => {
  await context?.close();
});

async function closeDuringReport(topic: string) {
  const fixture = await setupRoomWithTwoAgents(page, topic);
  await startRound(page);
  await waitRoundPhase(page, 1, "已完成");
  await setDriverBehavior(page, fixture.claudePid, {
    pauseAfterEvents: 2,
    holdUntilResume: true,
  });
  await concludeRoomViaButton(page);
  await expect(page.getByText("正在生成决策报告")).toBeVisible({ timeout: 15_000 });
  // The report execution is in flight on the Host (held mid-stream).
  await expect
    .poll(async () => (await driverCounters(page))[fixture.claudePid]?.executeCount ?? 0)
    .toBe(4);
  await page.waitForTimeout(300);
  await page.close();
  return fixture;
}

function watchReopen(reopened: Page) {
  const consoleErrors: string[] = [];
  const conflicts: string[] = [];
  reopened.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  reopened.on("response", (response) => {
    if (response.url().includes("/api/v1/") && response.status() === 409) {
      conflicts.push(`${response.request().method()} ${new URL(response.url()).pathname}`);
    }
  });
  return { consoleErrors, conflicts };
}

async function expectInterruptedCard(reopened: Page, startedAt: number) {
  const card = reopened.getByTestId("report-failure");
  // B4-01 / B4-04: the card replaces the stuck 「正在生成决策报告…」 within the
  // single 10s ABANDON_CANCEL_BUDGET_MS ceiling (+10%).
  await expect(card).toBeVisible({ timeout: 11_000 });
  expect(Date.now() - startedAt).toBeLessThan(11_000);
  await expect(reopened.getByText("正在生成决策报告")).toHaveCount(0);
  // B4-05: designer copy; the raw code only lives in the collapsed 「详情」.
  await expect(card.getByText("报告生成已中断", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "重新生成报告" })).toBeVisible();
  await expect(card.getByText("将重新调用模型", { exact: true })).toBeVisible();
  await expect(card.getByText("INTERRUPTED_UNKNOWN")).toBeHidden();
  await expect(reopened.getByText("INTERRUPTED_UNKNOWN")).toBeHidden();
  return card;
}

test.describe("B4 report generation survives a closed tab", () => {
  test("B4-01/03/04/05 report still running on the Host: card within 10s, no 409", async () => {
    test.setTimeout(120_000);
    const { roomId, claudePid } = await closeDuringReport("B4 关页重开·仍在生成");
    const reopened = await context.newPage();
    const watch = watchReopen(reopened);
    const startedAt = Date.now();
    await reopened.goto(`/rooms/${roomId}`);
    await expectInterruptedCard(reopened, startedAt);
    // The orphan was stopped on the Host (not left holding the participant).
    expect((await driverCounters(reopened))[claudePid]?.cancelCount).toBe(1);
    expect(watch.conflicts).toEqual([]);
    expect(watch.consoleErrors).toEqual([]);
  });

  test("B4-01 report finished on the Host while the tab was closed: card within 10s", async () => {
    test.setTimeout(120_000);
    const { roomId } = await closeDuringReport("B4 关页重开·已完成");
    // Release the held report on the Host before the page comes back (QA run2).
    const helper = await context.newPage();
    await helper.goto("/settings");
    await resumeDrivers(helper);
    await helper.close();
    const reopened = await context.newPage();
    const watch = watchReopen(reopened);
    const startedAt = Date.now();
    await reopened.goto(`/rooms/${roomId}`);
    await expectInterruptedCard(reopened, startedAt);
    expect(watch.conflicts).toEqual([]);
    expect(watch.consoleErrors).toEqual([]);
  });

  test("B4-02 regenerate succeeds and the red 「已中断」 record is gone, also after reload", async () => {
    test.setTimeout(120_000);
    const { roomId, claudePid } = await closeDuringReport("B4 重新生成后清理");
    const reopened = await context.newPage();
    await reopened.goto(`/rooms/${roomId}`);
    const card = await expectInterruptedCard(reopened, Date.now());
    await shot(reopened, "b4-after-01-interrupted-card");
    await card.getByText("详情").click();
    await shot(reopened, "b4-after-02-detail-expanded");
    await setDriverBehavior(reopened, claudePid, {
      pauseAfterEvents: undefined,
      holdUntilResume: false,
    });
    await card.getByRole("button", { name: "重新生成报告" }).click();
    await expect(reportView(reopened)).toBeVisible({ timeout: 20_000 });
    await expect(reopened.getByTestId("report-failure")).toHaveCount(0);
    await expect(reopened.getByText("已中断")).toHaveCount(0);
    await reopened.reload();
    await expect(reportView(reopened)).toBeVisible({ timeout: 20_000 });
    await expect(reopened.getByText("已中断")).toHaveCount(0);
    await shot(reopened, "b4-after-03-regenerated-after-reload");
    await expect(reopened.getByText("INTERRUPTED_UNKNOWN")).toHaveCount(0);
    const reports = (await roomExecutions(reopened, roomId)).filter(
      (execution) => (execution as { resultKind?: string }).resultKind === "report",
    );
    expect(reports.map((execution) => (execution as { state: string }).state).sort()).toEqual([
      "committed",
      "interrupted",
    ]);
  });
});
