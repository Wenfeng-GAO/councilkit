/**
 * B4 (#279): closing the tab while the decision report generates, then
 * reopening the room, must not leave the page stuck in 「正在生成决策报告…」.
 */
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import { formatLimitZh, generationTimeoutsFromEnv } from "@shared/runtime/generation-timeouts";
import { oneShotGeneratingNote } from "@shared/runtime/interruption-copy";
import {
  setupRoomWithKimiReporter,
  setupRoomWithTwoAgents,
  waitRoundPhase,
} from "./control-helpers";
import {
  concludeRoomViaButton,
  driverCounters,
  forgetHostExecutions,
  reportView,
  resetDriverState,
  resumeDrivers,
  roomExecutions,
  setDriverBehavior,
  startRound,
} from "./helpers";

/** Set B4_SHOTS=<dir> to save the designer-review screenshots, and
 * B4_SHOT_WIDTH=390 for the phone width. The room is set up at the default
 * desktop width (setup clicks a sidebar item that is hidden at 390) and the
 * viewport is resized just before each shot. */
const SHOTS = process.env.B4_SHOTS;
const SHOT_WIDTH = Number(process.env.B4_SHOT_WIDTH) === 390 ? 390 : 1280;
const SHOT_HEIGHT = SHOT_WIDTH === 390 ? 844 : 800;
async function shot(target: Page, name: string) {
  if (!SHOTS) return;
  await target.setViewportSize({ width: SHOT_WIDTH, height: SHOT_HEIGHT });
  await target.waitForTimeout(300);
  await target.screenshot({ path: `${SHOTS}/b4-${SHOT_WIDTH}-${name}.png`, fullPage: true });
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
  await expect(card.getByText("报告生成被中断（可能关闭了页面）", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "重新生成报告" })).toBeVisible();
  await expect(card.getByText("将重新调用模型", { exact: true })).toBeVisible();
  await expect(card.getByText("INTERRUPTED_UNKNOWN")).toBeHidden();
  await expect(reopened.getByText("INTERRUPTED_UNKNOWN")).toBeHidden();
  // B4 design: regenerating is the primary action; 「开始新一轮」 steps down to ghost.
  await expect(card.getByRole("button", { name: "重新生成报告" })).toHaveAttribute(
    "data-variant",
    "primary",
  );
  await expect(reopened.getByRole("button", { name: "开始新一轮" })).toHaveAttribute(
    "data-variant",
    "ghost",
  );
  await card.getByText("详情").click();
  await expect(card.getByText("刷新后找不到这次生成的结果。", { exact: true })).toBeVisible();
  await expect(card.getByText(/outcome is unknown/)).toHaveCount(0);
  await card.getByText("详情").click();
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
    await shot(reopened, "close-01-interrupted-card");
    await card.getByText("详情").click();
    await shot(reopened, "close-02-detail-expanded");
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
    await shot(reopened, "close-03-regenerated-after-reload");
    await expect(reopened.getByText("INTERRUPTED_UNKNOWN")).toHaveCount(0);
    const reports = (await roomExecutions(reopened, roomId)).filter(
      (execution) => (execution as { resultKind?: string }).resultKind === "report",
    );
    expect(reports.map((execution) => (execution as { state: string }).state).sort()).toEqual([
      "committed",
      "interrupted",
    ]);
  });

  test("B4 #279 report model silent past the idle window: idle variant of the card", async () => {
    test.setTimeout(120_000);
    const fixture = await setupRoomWithTwoAgents(page, "B4 无进展超时");
    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");
    // The report turn (claude seat) emits nothing; production waits 120s, the
    // fake waits 1.5s and fails it with STREAM_IDLE_TIMEOUT like a real driver.
    await setDriverBehavior(page, fixture.claudePid, { slowSilent: true, slowSilentIdleMs: 1500 });
    await concludeRoomViaButton(page);
    const card = page.getByTestId("report-failure");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("正在生成决策报告")).toHaveCount(0);
    await expect(
      card.getByText("报告生成被中断（模型 2 分钟没有输出）", { exact: true }),
    ).toBeVisible();
    await expect(card.getByRole("button", { name: "重新生成报告" })).toHaveAttribute(
      "data-variant",
      "primary",
    );
    await expect(card.getByText("将重新调用模型", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "开始新一轮" })).toHaveAttribute(
      "data-variant",
      "ghost",
    );
    await expect(card.getByText("STREAM_IDLE_TIMEOUT")).toBeHidden();
    await shot(page, "idle-01-interrupted-card");
    await card.getByText("详情").click();
    await expect(card.getByText("模型超过 2 分钟没有任何输出。", { exact: true })).toBeVisible();
    await expect(card.getByText("STREAM_IDLE_TIMEOUT")).toBeVisible();
    await expect(card.getByText(/idle limit/)).toHaveCount(0);
    await shot(page, "idle-02-detail-expanded");
  });
});

/** The Host this spec talks to was started with the same env, so its limits
 * (and the copy that follows them) are computed the same way here. Run with
 * COUNCILKIT_ONESHOT_TIMEOUT_MS=60000 to check the number changes (「1 分钟」). */
const LIMITS = generationTimeoutsFromEnv(process.env);
const ONESHOT = formatLimitZh(LIMITS.oneshotMs);
const ONESHOT_TAG = LIMITS.oneshotMs === 600_000 ? "" : `-${Math.round(LIMITS.oneshotMs / 1000)}s`;

test.describe("B4 #339 report on a one-shot seat (kimi/grok/cursor)", () => {
  test("not finished within the one-shot limit: grey line while generating, then the card", async () => {
    test.setTimeout(120_000);
    const fixture = await setupRoomWithKimiReporter(page, "B4 一次性模型未写完");
    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");
    // Production waits oneshotMs (10 min); the fake fires after 4s and still
    // reports the Host's configured limit, like the real kimi driver.
    await setDriverBehavior(page, fixture.kimiPid, { slowSilent: true, slowSilentIdleMs: 4000 });
    await concludeRoomViaButton(page);
    const note = page.getByTestId("report-oneshot-note");
    await expect(note).toBeVisible({ timeout: 15_000 });
    await expect(note).toHaveText(oneShotGeneratingNote("kimi-stream-json", LIMITS.oneshotMs));
    await shot(page, `oneshot${ONESHOT_TAG}-01-generating`);
    const card = page.getByTestId("report-failure");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("report-oneshot-note")).toHaveCount(0);
    await expect(
      card.getByText(`报告生成被中断（模型 ${ONESHOT}没有写完）`, { exact: true }),
    ).toBeVisible();
    await expect(card.getByRole("button", { name: "重新生成报告" })).toHaveAttribute(
      "data-variant",
      "primary",
    );
    await expect(card.getByText("将重新调用模型", { exact: true })).toBeVisible();
    await expect(card.getByText("ONESHOT_TIMEOUT")).toBeHidden();
    await shot(page, `oneshot${ONESHOT_TAG}-02-interrupted-card`);
    await card.getByText("详情").click();
    await expect(
      card.getByText(`Kimi 超过 ${ONESHOT}没有返回结果。`, { exact: true }),
    ).toBeVisible();
    await expect(card.getByText("ONESHOT_TIMEOUT")).toBeVisible();
    await shot(page, `oneshot${ONESHOT_TAG}-03-detail-expanded`);
  });

  test("model process exits mid-report: the 「进程意外退出」 card at once", async () => {
    test.setTimeout(120_000);
    const fixture = await setupRoomWithKimiReporter(page, "B4 模型进程退出");
    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");
    await setDriverBehavior(page, fixture.kimiPid, { slowSilent: true, crashAfterMs: 800 });
    await concludeRoomViaButton(page);
    const card = page.getByTestId("report-failure");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(
      card.getByText("报告生成被中断（模型进程意外退出）", { exact: true }),
    ).toBeVisible();
    await expect(card.getByRole("button", { name: "重新生成报告" })).toHaveAttribute(
      "data-variant",
      "primary",
    );
    await shot(page, "crash-01-interrupted-card");
    await card.getByText("详情").click();
    await expect(card.getByText("Kimi 在写完报告前退出了。", { exact: true })).toBeVisible();
    await expect(card.getByText("DRIVER_CRASH")).toBeVisible();
    await shot(page, "crash-02-detail-expanded");
  });
});

test.describe("B4 #339 Host restarted or disconnected mid-report", () => {
  test("the Host forgets the running report: 「本地执行服务重启或断开」 card", async () => {
    test.setTimeout(120_000);
    const fixture = await setupRoomWithTwoAgents(page, "B4 执行服务重启");
    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");
    await setDriverBehavior(page, fixture.claudePid, {
      pauseAfterEvents: 2,
      holdUntilResume: true,
    });
    await concludeRoomViaButton(page);
    await expect(page.getByText("正在生成决策报告")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await driverCounters(page))[fixture.claudePid]?.executeCount ?? 0)
      .toBe(4);
    // What the page sees when the Host restarts: the stream drops and the
    // new Host has no record of the execution (404).
    await forgetHostExecutions(page);
    const card = page.getByTestId("report-failure");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(
      card.getByText("报告生成被中断（本地执行服务重启或断开）", { exact: true }),
    ).toBeVisible();
    await expect(card.getByRole("button", { name: "重新生成报告" })).toHaveAttribute(
      "data-variant",
      "primary",
    );
    await expect(card.getByText("将重新调用模型", { exact: true })).toBeVisible();
    await shot(page, "restart-01-interrupted-card");
    await card.getByText("详情").click();
    await expect(
      card.getByText("和本地执行服务的连接断了，这次生成没有完成。", { exact: true }),
    ).toBeVisible();
    await expect(card.getByText("SAFE_INTERRUPTION")).toBeVisible();
    await shot(page, "restart-02-detail-expanded");
    await resumeDrivers(page);
  });
});
