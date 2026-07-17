/**
 * Security E2E (U6, plan §580-582 + §589): drives injection payloads through
 * the fake drivers into the REAL rendering path, probes legacy IndexedDB /
 * localStorage access, audits every browser request, and completes the whole
 * happy path keyboard-only with a11y gates. All payloads are asserted in the
 * browser DOM — nothing is stubbed around SafeMarkdown.
 */
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import {
  abortPausedRound,
  activePreview,
  freshPage,
  pausedPanel,
  resumeDrivers,
  roomParticipants,
  roundSection,
  setDriverBehavior,
  startRound,
  summaryContent,
} from "./helpers";
import {
  BAD_ANCHOR_SELECTOR,
  CLAUDE_MODEL,
  CODEX_MODEL,
  DANGEROUS_SELECTOR,
  FAILURE_MARKERS,
  FAILURE_PAYLOAD,
  LEGACY_SENTINEL,
  PREVIEW_MARKER,
  PREVIEW_PAYLOAD,
  RUNTIME_DB_NAME,
  type SecurityTripwires,
  UNTRUSTED_PAYLOAD,
  XSS_MARKERS,
  attachSecurityTripwires,
  bootSettings,
  dbOpenLog,
  expectTripwiresClean,
  installLegacyProbes,
  installLiveRegionRecorder,
  installStreamingRecorder,
  keyboardSelect,
  keyboardTypeInto,
  liveRegionLog,
  localStorageReadLog,
  readLegacySentinel,
  seedLegacyState,
  setupRoom,
  streamingRecord,
  tabToFocus,
  waitRoundPhase,
  windowMarkers,
} from "./security-helpers";

let context: BrowserContext;
let page: Page;
let tripwires: SecurityTripwires;

test.beforeEach(async ({ browser }) => {
  ({ context, page } = await freshPage(browser));
  // Attach before the first navigation so the ENTIRE flow is audited (§582).
  tripwires = attachSecurityTripwires(page);
});

test.afterEach(async () => {
  await context?.close();
});

test.describe("security gates", () => {
  test("§580 committed message + summary: injection payload renders inert, text stays readable", async () => {
    test.slow();
    await bootSettings(page);
    const { claudePid, codexPid } = await setupRoom(page, "安全 渲染注入");
    // claude facilitates, so this payload lands in TWO committed messages AND
    // the committed Round Summary in a single round.
    await setDriverBehavior(page, claudePid, { reply: UNTRUSTED_PAYLOAD });
    await setDriverBehavior(page, codexPid, { reply: UNTRUSTED_PAYLOAD });

    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");

    // No marker ever got set — no script/svg/handler/protocol executed.
    expect(await windowMarkers(page, XSS_MARKERS)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);

    const round1 = roundSection(page, 1);
    // DOM holds no injected elements and no dangerous-protocol anchors.
    await expect(round1.locator(DANGEROUS_SELECTOR)).toHaveCount(0);
    await expect(round1.locator(BAD_ANCHOR_SELECTOR)).toHaveCount(0);

    // The safe https link survives — with isolation attributes (both messages).
    const safeLinks = round1.locator('a[href="https://example.com"]');
    expect(await safeLinks.count()).toBe(2);
    for (const link of await safeLinks.all()) {
      expect(await link.getAttribute("target")).toBe("_blank");
      const rel = (await link.getAttribute("rel")) ?? "";
      expect(rel).toContain("noopener");
      expect(rel).toContain("ugc");
    }

    // javascript:/data: labels render as plain text spans (no href anywhere).
    const clickLabel = round1.getByText("click", { exact: true }).first();
    await expect(clickLabel).toBeVisible();
    expect(await clickLabel.evaluate((el) => el.tagName)).toBe("SPAN");
    const dataLabel = round1.getByText("d", { exact: true }).first();
    await expect(dataLabel).toBeVisible();
    expect(await dataLabel.evaluate((el) => el.tagName)).toBe("SPAN");

    // ANSI escapes are gone but RED stays readable; raw payload text is still
    // visible AS TEXT (sanitized ≠ deleted), malformed markdown included.
    expect(await round1.evaluate((el) => el.textContent?.includes("\u001b") ?? false)).toBe(false);
    await expect(round1.getByText("RED").first()).toBeVisible();
    await expect(round1.getByText("window.__xss1=1").first()).toBeVisible();
    await expect(round1.getByText("window.__xss4=1").first()).toBeVisible();
    await expect(round1.getByText("**unclosed").first()).toBeVisible();

    // Same payload in the committed Summary (expanded block).
    const summary = await summaryContent(page, 1);
    await expect(summary.getByText("window.__xss1=1")).toBeVisible();
    await expect(summary.locator(DANGEROUS_SELECTOR)).toHaveCount(0);
    await expect(summary.locator(BAD_ANCHOR_SELECTOR)).toHaveCount(0);
    const summaryLink = summary.locator('a[href="https://example.com"]');
    expect(await summaryLink.getAttribute("target")).toBe("_blank");
    expect((await summaryLink.getAttribute("rel")) ?? "").toContain("ugc");

    // §582: the whole flow never left the canonical origin; no dialog fired.
    expectTripwiresClean(tripwires);
  });

  test("§580 streaming preview: payload deltas render sanitized mid-stream", async () => {
    test.slow();
    await bootSettings(page);
    const { claudePid } = await setupRoom(page, "安全 流式预览");
    // Pause after started + first delta: the preview holds the payload's
    // first half (complete raw <script> + ANSI marker) until resumed.
    await setDriverBehavior(page, claudePid, { reply: PREVIEW_PAYLOAD, pauseAfterEvents: 2 });
    // The in-page recorder is deterministic — it does not race the driver's
    // 300ms pause fallback.
    await installStreamingRecorder(page);

    await startRound(page);
    await expect(activePreview(page).getByText("PRED")).toBeVisible({ timeout: 20_000 });
    // Live check while the stream is (likely) still paused.
    expect(await windowMarkers(page, [PREVIEW_MARKER])).toEqual([undefined]);

    await resumeDrivers(page);
    await waitRoundPhase(page, 1, "已完成");

    const record = await streamingRecord(page);
    // Streaming really happened (multiple distinct preview states)…
    expect(record.previewSnapshots.length).toBeGreaterThanOrEqual(2);
    expect(record.previewTexts.some((text) => text.includes("PRED"))).toBe(true);
    // …and at NO recorded moment did the preview hold a dangerous element,
    // an escape character, or an executed marker.
    for (const snapshot of record.previewSnapshots) {
      expect(snapshot.dangerousCount).toBe(0);
      expect(snapshot.hasEscapeChar).toBe(false);
      expect(snapshot.xssMarker).toBeNull();
    }
    // No dangerous element was injected anywhere in the document, ever.
    expect(record.injections).toEqual([]);

    // The committed replacement is sanitized too.
    expect(await windowMarkers(page, [PREVIEW_MARKER])).toEqual([undefined]);
    await expect(roundSection(page, 1).locator(DANGEROUS_SELECTOR)).toHaveCount(0);
    expectTripwiresClean(tripwires);
  });

  test("§580 failure record + paused panel: hostile error detail stays inert text", async () => {
    test.slow();
    await bootSettings(page);
    const { codexPid } = await setupRoom(page, "安全 失败记录");
    await setDriverBehavior(page, codexPid, {
      failWith: {
        error: { code: "DRIVER_CRASH", message: FAILURE_PAYLOAD },
        retryable: false,
        dispatchState: "accepted",
      },
    });

    await startRound(page);
    await expect(pausedPanel(page)).toBeVisible({ timeout: 20_000 });
    await expect(pausedPanel(page)).toContainText("第 1 轮已暂停：执行失败");
    // The paused panel shows the hostile detail as plain text — inert.
    await expect(pausedPanel(page)).toContainText("window.__xssF=1");
    await expect(pausedPanel(page).locator(DANGEROUS_SELECTOR)).toHaveCount(0);
    await expect(pausedPanel(page).locator(BAD_ANCHOR_SELECTOR)).toHaveCount(0);

    // The collapsed failure record carries structure; expanding it reveals
    // the same detail as text, never as elements or anchors.
    const record = roundSection(page, 1).getByTestId("failure-record");
    await expect(record).toContainText("执行失败");
    await expect(record).toContainText("DRIVER_CRASH");
    await record.locator("summary").click();
    await expect(record).toContainText("window.__xssF=1");
    await expect(record).toContainText("javascript:window.__xssF2=1");
    await expect(record.locator(DANGEROUS_SELECTOR)).toHaveCount(0);
    await expect(record.locator("a")).toHaveCount(0);

    expect(await windowMarkers(page, FAILURE_MARKERS)).toEqual([undefined, undefined]);

    // Clean exit: abort the paused round (its committed speech is kept).
    await abortPausedRound(page);
    await waitRoundPhase(page, 1, "已终止");
    expectTripwiresClean(tripwires);
  });

  test("§581 legacy probes: never opens the legacy DB, never reads legacy keys, legacy bytes untouched", async () => {
    test.slow();
    // Registered BEFORE the first navigation; arrays reset per navigation.
    await installLegacyProbes(page);
    await bootSettings(page);
    // Pre-seed what a pre-cutover browser would hold, then reload so the
    // probe arrays only record the post-reload flow.
    await seedLegacyState(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();

    // Full target flow: setup + one complete round — no fallback to legacy.
    await setupRoom(page, "安全 legacy 探针");
    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");

    // Snapshot the probe arrays BEFORE the sentinel read-back (which itself
    // legitimately opens the legacy DB from this test, not from the app).
    const dbOpens = await dbOpenLog(page);
    expect(dbOpens.length, "the app should open its runtime DB").toBeGreaterThan(0);
    expect([...new Set(dbOpens)]).toEqual([RUNTIME_DB_NAME]);
    const lsReads = await localStorageReadLog(page);
    const legacyKeyReads = lsReads.filter(
      (key) => key.startsWith("councilkit.key") || key.startsWith("councilkit.gateways"),
    );
    expect(legacyKeyReads).toEqual([]);

    // The pre-seeded legacy content is byte-identical afterwards.
    expect(await readLegacySentinel(page)).toEqual(LEGACY_SENTINEL);
    // …and the flow completed normally (heading + completed round visible).
    await expect(roundSection(page, 1).locator("summary").getByText("已完成")).toBeVisible();
    expectTripwiresClean(tripwires);
  });

  test("§589 keyboard-only happy path + a11y gates (focus, alerts, labels, live region, narrow layout)", async () => {
    test.slow();
    await bootSettings(page);
    // Host must be online for the create buttons to be enabled (Tab skips
    // disabled controls).
    await expect(page.getByText("本地执行服务在线")).toBeVisible();

    // --- Profile 1 (claude) via keyboard ---
    const addProfile = page.getByRole("button", { name: "+ 新建 Profile" });
    await tabToFocus(page, addProfile);
    await page.keyboard.press("Enter");
    let dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await keyboardTypeInto(
      page,
      dialog.getByRole("textbox", { name: "名称", exact: true }),
      "Alpha Profile 甲",
      { expectEmptyFirst: true },
    );
    const installSelect = dialog.getByRole("combobox", {
      name: "Runtime Installation",
      exact: true,
    });
    await expect(installSelect).toContainText("claude-e2e-fake01");
    await keyboardSelect(page, installSelect, "claude-e2e-fake01");
    // Route select keeps its ant-glm5.2 default; Tab to the submit button.
    await tabToFocus(page, dialog.getByRole("button", { name: "创建 Profile" }));
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Alpha Profile 甲", { exact: true })).toBeVisible();

    // --- Profile 2 (codex) via keyboard ---
    await tabToFocus(page, addProfile);
    await page.keyboard.press("Enter");
    dialog = page.getByRole("dialog");
    await keyboardTypeInto(
      page,
      dialog.getByRole("textbox", { name: "名称", exact: true }),
      "Beta Profile 乙",
      { expectEmptyFirst: true },
    );
    await keyboardSelect(
      page,
      dialog.getByRole("combobox", { name: "Runtime Driver（内置闭集）", exact: true }),
      "codex-app-server",
    );
    await expect(installSelect).toContainText("codex-e2e-fake001");
    await keyboardSelect(page, installSelect, "codex-e2e-fake001");
    await tabToFocus(page, dialog.getByRole("button", { name: "创建 Profile" }));
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Beta Profile 乙", { exact: true })).toBeVisible();

    // --- Agent 1 (claude) via keyboard ---
    const addAgent = page.getByRole("button", { name: "+ 新建 Agent" });
    await tabToFocus(page, addAgent);
    await page.keyboard.press("Enter");
    dialog = page.getByRole("dialog");
    await keyboardTypeInto(
      page,
      dialog.getByRole("textbox", { name: "名称", exact: true }),
      "Alpha蓝方",
      { expectEmptyFirst: true },
    );
    await keyboardTypeInto(
      page,
      dialog.getByRole("textbox", { name: "人格设定（personaPrompt）", exact: true }),
      "键盘 persona 蓝方",
      { expectEmptyFirst: true },
    );
    await keyboardSelect(
      page,
      dialog.getByRole("combobox", { name: "Execution Profile", exact: true }),
      "Alpha Profile 甲",
      "label",
    );
    const modelSelect = dialog.getByRole("combobox", {
      name: "modelId（Driver 闭集 canonical 目录）",
      exact: true,
    });
    await expect(modelSelect).toContainText(CLAUDE_MODEL);
    await keyboardSelect(page, modelSelect, CLAUDE_MODEL);
    // Color input keeps its valid default; Tab straight to the submit button.
    await tabToFocus(page, dialog.getByRole("button", { name: "创建 Agent" }));
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Alpha蓝方", { exact: true }).first()).toBeVisible();

    // --- Agent 2 (codex) via keyboard ---
    await tabToFocus(page, addAgent);
    await page.keyboard.press("Enter");
    dialog = page.getByRole("dialog");
    await keyboardTypeInto(
      page,
      dialog.getByRole("textbox", { name: "名称", exact: true }),
      "Beta红方",
      { expectEmptyFirst: true },
    );
    await keyboardTypeInto(
      page,
      dialog.getByRole("textbox", { name: "人格设定（personaPrompt）", exact: true }),
      "键盘 persona 红方",
      { expectEmptyFirst: true },
    );
    await keyboardSelect(
      page,
      dialog.getByRole("combobox", { name: "Execution Profile", exact: true }),
      "Beta Profile 乙",
      "label",
    );
    await expect(modelSelect).toContainText(CODEX_MODEL);
    await keyboardSelect(page, modelSelect, CODEX_MODEL);
    await tabToFocus(page, dialog.getByRole("button", { name: "创建 Agent" }));
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Beta红方", { exact: true }).first()).toBeVisible();

    // --- New Room via keyboard ---
    await tabToFocus(page, page.getByRole("link", { name: "新建讨论", exact: true }));
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/rooms\/new/);
    await expect(page.getByRole("heading", { name: "新建讨论房间" })).toBeVisible();

    // Submit empty: the validation error is perceivable via role="alert".
    const createRoomButton = page.getByRole("button", { name: "创建并进入" });
    await tabToFocus(page, createRoomButton);
    await page.keyboard.press("Enter");
    const topicAlert = page.getByRole("alert").filter({ hasText: "请输入话题" });
    await expect(topicAlert).toBeVisible();

    await keyboardTypeInto(
      page,
      page.getByRole("textbox", { name: "话题", exact: true }),
      "键盘可达性话题",
      { expectEmptyFirst: true },
    );
    await expect(topicAlert).toBeHidden();

    // Checkboxes via Space.
    const checkboxA = page.locator("label", { hasText: "Alpha蓝方" }).getByRole("checkbox");
    await tabToFocus(page, checkboxA);
    await page.keyboard.press("Space");
    await expect(checkboxA).toBeChecked();
    const checkboxB = page.locator("label", { hasText: "Beta红方" }).getByRole("checkbox");
    await tabToFocus(page, checkboxB);
    await page.keyboard.press("Space");
    await expect(checkboxB).toBeChecked();

    // Speaking order via the focused ↑/↓ buttons: move 蓝方 down → [红方, 蓝方].
    const downA = page.getByRole("button", { name: "下移 Alpha蓝方" });
    await tabToFocus(page, downA);
    await page.keyboard.press("Enter");
    const orderItems = page.locator("main ol > li");
    await expect(orderItems.first()).toContainText("Beta红方");
    await expect(orderItems.nth(1)).toContainText("Alpha蓝方");

    // Facilitator via keyboard select (红方 facilitates AND speaks first).
    await keyboardSelect(
      page,
      page.getByRole("combobox", { name: "Facilitator（负责生成每轮总结）", exact: true }),
      "Beta红方",
      "label",
    );

    await tabToFocus(page, createRoomButton);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/rooms\/[0-9a-fA-F-]+/);
    await expect(page.getByRole("heading", { name: "键盘可达性话题" })).toBeVisible();

    // Status indicators carry text labels (never color alone).
    const banner = page.getByTestId("control-banner");
    await expect(banner).toHaveAttribute("data-control-state", "controlling");
    await expect(banner).toContainText("当前页面拥有控制权");
    await expect(page.getByText("Host 在线")).toBeVisible();
    await expect(page.locator("header").getByText("空闲", { exact: true })).toBeVisible();

    // --- Start the round from the keyboard; live region under observation ---
    await installLiveRegionRecorder(page);
    const startButton = page.getByRole("button", { name: "发起讨论" });
    await tabToFocus(page, startButton);
    await page.keyboard.press("Enter");
    await waitRoundPhase(page, 1, "已完成");
    // runState pill back to a text-labeled idle state.
    await expect(page.locator("header").getByText("空闲", { exact: true })).toBeVisible();

    // aria-live: semantic announcements only — bounded count, phase/speech
    // shapes only, NEVER per-delta (no entry carries streamed reply text).
    const liveLog = await liveRegionLog(page);
    expect(liveLog.length).toBeGreaterThan(0);
    expect(
      liveLog.length,
      `aria-live announced ${liveLog.length} times for one 3-execution round: ${JSON.stringify(liveLog)}`,
    ).toBeLessThanOrEqual(16);
    for (const entry of liveLog) {
      expect(entry).not.toContain("reply-");
      expect(entry === "" || /^第 \d+ 轮/.test(entry) || /已发言$/.test(entry)).toBe(true);
    }

    // --- Modal Esc returns focus to the invoking button (paused round) ---
    const roomId = page.url().split("/rooms/")[1] as string;
    const participants = await roomParticipants(page, roomId);
    const codexPid = participants.find((participant) => participant.modelId === CODEX_MODEL)?.id;
    expect(codexPid, "codex participant should exist").toBeTruthy();
    await setDriverBehavior(page, codexPid as string, {
      failWith: {
        error: { code: "DRIVER_CRASH", message: "键盘 focus 测试用失败详情" },
        retryable: false,
        dispatchState: "accepted",
      },
    });
    const newRoundButton = page.getByRole("button", { name: "开始新一轮" });
    await tabToFocus(page, newRoundButton);
    await page.keyboard.press("Enter");
    await expect(pausedPanel(page)).toBeVisible({ timeout: 20_000 });

    const dangerButton = pausedPanel(page).getByRole("button", { name: "终止本轮（不生成总结）" });
    await tabToFocus(page, dangerButton);
    await page.keyboard.press("Enter");
    dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Move focus INTO the modal first — the honest focus-restoration check.
    const cancelButton = dialog.getByRole("button", { name: "取消" });
    await tabToFocus(page, cancelButton);
    await expect(cancelButton).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(dangerButton).toBeFocused();

    // Re-open and confirm the abort via keyboard (round ends cleanly).
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await tabToFocus(page, dialog.getByRole("button", { name: "确认终止" }));
    await page.keyboard.press("Enter");
    await waitRoundPhase(page, 2, "已终止");

    // --- Narrow viewport (500×800): no horizontal scrollbar, no overlap ---
    await page.setViewportSize({ width: 500, height: 800 });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(
      scrollWidth,
      `horizontal overflow at 500px (scrollWidth=${scrollWidth})`,
    ).toBeLessThanOrEqual(501);
    const ctaBox = await newRoundButton.boundingBox();
    const timelineBox = await roundSection(page, 1).boundingBox();
    expect(ctaBox, "primary CTA should be visible at 500px").not.toBeNull();
    expect(timelineBox, "timeline should be visible at 500px").not.toBeNull();
    if (ctaBox && timelineBox) {
      const overlap = !(
        ctaBox.x + ctaBox.width <= timelineBox.x ||
        timelineBox.x + timelineBox.width <= ctaBox.x ||
        ctaBox.y + ctaBox.height <= timelineBox.y ||
        timelineBox.y + timelineBox.height <= ctaBox.y
      );
      expect(overlap, "primary CTA overlaps the timeline at 500px").toBe(false);
    }

    // §582: the whole keyboard flow never left the canonical origin.
    expectTripwiresClean(tripwires);
  });
});
