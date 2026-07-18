/**
 * Scope Controller / observer E2E (U6, plan §576-579). Both room pages share
 * ONE browser context — one IndexedDB and one Web Lock manager — so the
 * second page can only observe: its mutation controls are disabled, the Host
 * fences a stale controller pair, and control transfers automatically (with a
 * higher leaseEpoch) once the controlling page goes away.
 */
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import {
  activeBinding,
  controlBanner,
  delayRoute,
  expectControlState,
  expectObserverControlsDisabled,
  postStaleExecute,
  scopeLeaseEpoch,
  setupRoomWithTwoAgents,
  simulateTabFocus,
  waitRoundPhase,
} from "./control-helpers";
import {
  abortPausedRound,
  activePreview,
  driverCounters,
  pausedPanel,
  resetDriverState,
  resumeDrivers,
  roomSummaries,
  roundSection,
  setDriverBehavior,
  startRound,
  summaryContent,
} from "./helpers";

let context: BrowserContext;
let pageA: Page;

test.beforeEach(async ({ browser }) => {
  context = await browser.newContext();
  pageA = await context.newPage();
  await pageA.goto("/settings");
  await expect(pageA.getByRole("heading", { name: "设置" })).toBeVisible();
  await resetDriverState(pageA);
});

test.afterEach(async () => {
  await context?.close();
});

test.describe("scope controller and observer pages", () => {
  test("dual-page: observer is fenced, auto takeover bumps the Host leaseEpoch (§577)", async () => {
    const { roomId, codexPid } = await setupRoomWithTwoAgents(pageA, "E2E 双页面控制");
    await expectControlState(pageA, "controlling");

    // Round 1 creates the Scope + active binding both pages will share.
    await startRound(pageA);
    await waitRoundPhase(pageA, 1, "已完成");

    // acquiring: visible while the page re-takes an existing binding — the
    // takeover POST is held briefly by this route (Host leaseEpoch 1 → 2).
    await delayRoute(pageA, "**/api/v1/scopes/*/controller", 1000);
    await pageA.reload();
    await expectControlState(pageA, "acquiring");
    await pageA.unroute("**/api/v1/scopes/*/controller");
    await expectControlState(pageA, "controlling");

    // Second page, same context: observes; every mutation control disabled.
    const pageB = await context.newPage();
    await pageB.goto(`/rooms/${roomId}`);
    await expectControlState(pageB, "observing");
    await expectObserverControlsDisabled(pageB);

    // Host fencing: B's own browser context (session cookie + Origin + CSRF
    // capability) with a stale controller pair is rejected, never dispatched.
    const scopeId = (await activeBinding(pageB, roomId)).executionScopeId as string;
    const epochBefore = await scopeLeaseEpoch(pageB, scopeId);
    const fenced = await postStaleExecute(pageB, { scopeId, participantId: codexPid });
    expect(fenced.status).toBe(409);
    expect(fenced.code).toBe("STALE_CONTROLLER");
    const counters = await driverCounters(pageB);
    expect(counters[codexPid]?.executeCount).toBe(1);

    // The controller page closes → the observer auto-takes-over: banner flips
    // to controlling with the takeover notice, the Host leaseEpoch increases,
    // and the new controller can run the next round.
    await pageA.close();
    await expectControlState(pageB, "controlling", 15_000);
    await expect(controlBanner(pageB)).toContainText("已取得控制权");
    expect(await scopeLeaseEpoch(pageB, scopeId)).toBe(epochBefore + 1);
    const startNext = pageB.getByRole("button", { name: "开始新一轮" });
    await expect(startNext).toBeEnabled();
    await startNext.click();
    await waitRoundPhase(pageB, 2, "已完成");
    expect(await roomSummaries(pageB, roomId)).toHaveLength(2);

    // The old page reopens as a read-only observer.
    const pageA2 = await context.newPage();
    await pageA2.goto(`/rooms/${roomId}`);
    await expectControlState(pageA2, "observing");
    await expectObserverControlsDisabled(pageA2);
  });

  test("observer: committed updates + live preview over the read-only stream, GETs only (§578)", async () => {
    const { roomId, claudePid, codexPid } = await setupRoomWithTwoAgents(pageA, "E2E 观察者预览");
    await expectControlState(pageA, "controlling");
    const reply = "观察者预览甲乙丙丁戊己庚辛";
    await setDriverBehavior(pageA, codexPid, { reply, pauseAfterEvents: 2 });

    const pageB = await context.newPage();
    const apiRequests: { method: string; url: string }[] = [];
    pageB.on("request", (request) => {
      if (request.url().includes("/api/v1/")) {
        apiRequests.push({ method: request.method(), url: request.url() });
      }
    });
    await pageB.goto(`/rooms/${roomId}`);
    await expectControlState(pageB, "observing");
    await expectObserverControlsDisabled(pageB);

    // A drives the round in the background page; codex holds mid-stream after
    // its first delta (released by resumeDrivers, or a 300ms host fallback).
    await startRound(pageA);
    await expect(activePreview(pageA).getByText(reply.slice(0, 4))).toBeVisible({
      timeout: 15_000,
    });

    // Activating the observer tab refetches committed state (react-query
    // refetch-on-focus) and starts the read-only SSE follow of the in-flight
    // execution: codex's live preview with the 生成中·尚未保存 badge, plus
    // claude's committed message — while the banner stays observing.
    await simulateTabFocus(pageB);
    await expect(activePreview(pageB).getByText(reply.slice(0, 4))).toBeVisible();
    await expect(activePreview(pageB)).toContainText("生成中·尚未保存");
    await expect(roundSection(pageB, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();
    await expectControlState(pageB, "observing");

    await resumeDrivers(pageA);
    await waitRoundPhase(pageA, 1, "已完成");
    // S2 focus 后口径: round 1 summary 是 facilitator 第 3 次执行（focus-1, message-2, summary-3）。
    await expect(await summaryContent(pageA, 1)).toContainText(`reply-${claudePid}-3`);

    // Refresh-free on the observer: re-activating the tab pulls the committed
    // message + summary (a tab activation, never a reload).
    await simulateTabFocus(pageB);
    await waitRoundPhase(pageB, 1, "已完成");
    await expect(roundSection(pageB, 1).getByText(reply)).toBeVisible();
    // S2 focus 后口径: 同上，observer 读到的 summary 也是 reply-claude-3。
    await expect(await summaryContent(pageB, 1)).toContainText(`reply-${claudePid}-3`);

    // Request audit: the observer page issued no mutation — GETs only — and
    // it did open the read-only event stream for the live preview.
    expect(apiRequests.length).toBeGreaterThan(0);
    expect(apiRequests.every((request) => request.method === "GET")).toBe(true);
    expect(apiRequests.some((request) => /\/executions\/[^/]+\/events/.test(request.url))).toBe(
      true,
    );
  });

  test("stop-generating → user_cancelled paused → abort keeps commits, new round works (§579)", async () => {
    const { roomId, claudePid, codexPid } = await setupRoomWithTwoAgents(pageA, "E2E 停止生成");
    await setDriverBehavior(pageA, codexPid, { hangUntilCancel: true });

    // claude speaks and commits; codex hangs after `started` until cancelled.
    await startRound(pageA);
    await expect(roundSection(pageA, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();
    await expect(activePreview(pageA)).toContainText("正在生成");
    await expect(activePreview(pageA)).toContainText("生成中·尚未保存");

    // The pending label shows while the cancel call is in flight (route-held).
    await delayRoute(pageA, "**/api/v1/scopes/*/executions/*/cancel", 1000);
    await pageA.getByRole("button", { name: "停止生成" }).click();
    const stopping = pageA.getByRole("button", { name: "正在停止…" });
    await expect(stopping).toBeVisible();
    await expect(stopping).toBeDisabled();

    // user_cancelled: paused copy, preview gone, collapsed failure record;
    // the committed first message stays rendered. (The cancel route is only
    // removed once the pause proves the request was fully handled — unrouting
    // mid-flight would fail the delayed handler's route.continue().)
    await expect(pausedPanel(pageA)).toBeVisible({ timeout: 20_000 });
    await pageA.unroute("**/api/v1/scopes/*/executions/*/cancel");
    await expect(pausedPanel(pageA)).toContainText("第 1 轮已暂停：已手动停止生成");
    await expect(activePreview(pageA)).toHaveCount(0);
    const failure = roundSection(pageA, 1).getByTestId("failure-record");
    await expect(failure).toContainText("已丢弃");
    await expect(failure).toContainText("已手动停止生成");
    expect(await failure.getAttribute("open")).toBeNull(); // collapsed record
    await expect(roundSection(pageA, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();
    const counters = await driverCounters(pageA);
    expect(counters[codexPid]?.cancelCount).toBe(1);

    // 终止本轮（不生成总结）→ aborted; committed speech kept; new round CTA.
    await abortPausedRound(pageA);
    await waitRoundPhase(pageA, 1, "已终止");
    await expect(roundSection(pageA, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();

    // Clearing the behavior override restores the default driver behavior:
    // 开始新一轮 works and round 2 completes.
    await setDriverBehavior(pageA, codexPid, { hangUntilCancel: false });
    await pageA.getByRole("button", { name: "开始新一轮" }).click();
    await waitRoundPhase(pageA, 2, "已完成");

    // A paused round's repair entry navigates to /settings. Prewarm only runs
    // at Scope creation, so the repair-link beat needs a fresh Scope: reset
    // closes the Host's scopes, then prewarmFails fails the next creation.
    await resetDriverState(pageA);
    await setDriverBehavior(pageA, codexPid, { prewarmFails: true });
    await pageA.getByRole("button", { name: "开始新一轮" }).click();
    await expect(pausedPanel(pageA)).toBeVisible({ timeout: 20_000 });
    await expect(pausedPanel(pageA)).toContainText("第 3 轮已暂停：执行环境预热失败");
    await pausedPanel(pageA)
      .getByRole("link", { name: "前往 Runtime 设置检查 Installation 与登录状态" })
      .click();
    await pageA.waitForURL(/\/settings$/);
    await expect(pageA.getByRole("heading", { name: "设置" })).toBeVisible();
  });

  test("host lost after page load: offline text + repair copy, round pauses prewarm_failed, recovers (§576)", async () => {
    const { roomId } = await setupRoomWithTwoAgents(pageA, "E2E Host 离线");
    await startRound(pageA);
    await waitRoundPhase(pageA, 1, "已完成");
    await expect(pageA.getByText("Host 在线", { exact: true })).toBeVisible();

    // The health endpoint drops: the sidebar indicator flips to a text label
    // (never color-only) on the next 5s poll.
    await pageA.route("**/api/v1/health", (route) => route.abort());
    await expect(pageA.getByText("Host 离线", { exact: true })).toBeVisible({ timeout: 15_000 });

    // The indicator links to /settings where the repair copy lives: the page
    // cannot fix the Host itself, it only points at the restart instructions.
    await pageA.getByRole("link", { name: "Host 离线" }).click();
    await pageA.waitForURL(/\/settings$/);
    await expect(pageA.getByText("本地执行服务已断开，禁止新执行")).toBeVisible();
    await pageA.getByRole("button", { name: "查看重启说明" }).click();
    await expect(pageA.getByRole("dialog").getByText("重启本地执行服务")).toBeVisible();

    // Back on the room with the whole API down, starting a round pauses it
    // prewarm_failed — a recoverable affordance, no crash, no silent hang.
    await pageA.goto(`/rooms/${roomId}`);
    await expectControlState(pageA, "controlling");
    await pageA.route("**/api/v1/**", (route) => route.abort());
    await pageA.getByRole("button", { name: "开始新一轮" }).click();
    await expect(pausedPanel(pageA)).toBeVisible({ timeout: 20_000 });
    await expect(pausedPanel(pageA)).toContainText("第 2 轮已暂停：执行环境预热失败");
    await expect(
      pausedPanel(pageA).getByRole("link", {
        name: "前往 Runtime 设置检查 Installation 与登录状态",
      }),
    ).toBeVisible();
    await waitRoundPhase(pageA, 2, "已暂停");
    await expect(pageA.getByRole("heading", { name: "E2E Host 离线" })).toBeVisible();

    // Recover: unroute, end the paused round, and a fresh round completes;
    // the sidebar indicator returns to online on its own poll.
    await pageA.unrouteAll();
    await abortPausedRound(pageA);
    await waitRoundPhase(pageA, 2, "已终止");
    await pageA.getByRole("button", { name: "开始新一轮" }).click();
    await waitRoundPhase(pageA, 3, "已完成");
    await expect(pageA.getByText("Host 在线", { exact: true })).toBeVisible({ timeout: 15_000 });
  });
});
