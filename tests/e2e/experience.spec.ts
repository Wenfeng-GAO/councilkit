/**
 * S8 体验打磨 E2E（plan-a §3 五场景）。beforeEach/afterEach 复刻 control.spec.ts
 * 的单 context 模式：每例自带 fresh IndexedDB + Web Lock，互不串扰。
 *
 * 五场景：
 *  1. 「取得控制权」手动接管按钮（observing → controlling，Host leaseEpoch +1）。
 *  2. 预检 badge：ready 成功态 + installation changed 后 warn 态（两态都验）。
 *  3. 两种暂停文案：Room runState「已暂停调度」与 Round phase「本轮已暂停」双轴不混。
 *  4. 运行中发送用户消息的中断确认 Modal（取消不发 / 确认发 + 停止后保留）。
 *  5. a11y：globals.css 静态断言 + 焦点轮廓活断言 + reduced-motion 活断言。
 *
 * 纪律：通知无 e2e（headless 恒 visible，plan-a R4）——本文件不模拟 hidden。
 * 时序：先等 UI 反映、再验 Host counters / leaseEpoch（S5 教训）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import {
  activeBinding,
  expectControlState,
  scopeLeaseEpoch,
  setupRoomWithTwoAgents,
  waitRoundPhase,
} from "./control-helpers";
import {
  abortPausedRound,
  activePreview,
  createAgent,
  createProfile,
  createRoom,
  pausedPanel,
  resetDriverState,
  roomSummaries,
  roundSection,
  setDriverBehavior,
  setInstallationState,
  startRound,
} from "./helpers";

const CLAUDE_INSTALLATION = "claude-e2e-fake01";
const CLAUDE_PROFILE = "GLM 5.2 主用";
const CLAUDE_AGENT = "蓝方评审";
const CLAUDE_MODEL = "e2e-claude-model";
const CODEX_AGENT = "红方助手";

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

test.describe("S8 experience polish", () => {
  test("1. takeover button: observing page steals control, Host leaseEpoch +1 (§3)", async () => {
    const { roomId } = await setupRoomWithTwoAgents(pageA, "E2E 手动接管");
    await expectControlState(pageA, "controlling");

    // 第 1 轮完成 → 存在 active binding 带 scopeId（takeover 路径的前提）。
    await startRound(pageA);
    await waitRoundPhase(pageA, 1, "已完成");

    // 同 context 第二页：只读观察，banner 暴露对方控制者前缀。
    const pageB = await context.newPage();
    await pageB.goto(`/rooms/${roomId}`);
    await expectControlState(pageB, "observing");
    await expect(pageB.getByTestId("controller-id")).toBeVisible();

    // 接管前 Host leaseEpoch（scope 创建时为 1）。
    const scopeId = (await activeBinding(pageB, roomId)).executionScopeId as string;
    const epochBefore = await scopeLeaseEpoch(pageB, scopeId);

    // 手动「取得控制权」：Web Lock steal + 重跑 controlRoom → takeoverScope（epoch +1）。
    await pageB.getByRole("button", { name: "取得控制权" }).click();
    await expectControlState(pageB, "controlling", 15_000);
    // notice「已取得控制权」与控制者前缀变化在手动接管路径都不可靠：controlRoom 先经
    // acquiring 中间态（notice 分支需 observing→controlling 直翻才 set）；recovery
    // query 的 controllerId 刷新由 tick 驱动、滞后于 display bridge 的 controlState。
    // 故以 Host leaseEpoch +1 与 B 能开新轮完成作为接管的硬证明（比 notice 更强）。

    // 先等 UI 翻转、再验 Host：leaseEpoch 较接管前 +1（takeoverScope 每次 +1）。
    expect(await scopeLeaseEpoch(pageB, scopeId)).toBe(epochBefore + 1);

    // 真控制：B 开始新一轮并完成（证明接管后 token 写入成功）。
    await pageB.getByRole("button", { name: "开始新一轮" }).click();
    await waitRoundPhase(pageB, 2, "已完成");
  });

  test("1b. takeover切房不泄锁: B 接管房间1后切房间2, A 回房间1 可重新拿到控制权 (R1 cleanup by roomId)", async () => {
    // 场景背景：RoomPage 的 takeover slot 归属守卫修复后，切房 cleanup 按 roomId
    // 释放 takeover slot（RoomPage.tsx:326 `current.roomId === roomId`），不会把
    // 房间 1 的 takeover 锁带去房间 2 也不残留。本例是该修复的回归证据：B 在房间
    // 1 takeover 后切房到房间 2，房间 1 的锁必须随切房释放，否则 A 后续回到房间 1
    // 时挂载 controlRoom 的 acquire 会排队等 B 残留的锁、15s 内无法变 controlling。
    const { roomId: room1Id } = await setupRoomWithTwoAgents(pageA, "E2E 接管切房主");
    await expectControlState(pageA, "controlling");

    // 额外建房间 2（复用同一批 profile/agent，setupRoomWithTwoAgents 已建好物料），
    // 作为 B 稍后切房的目的地。createRoom 会把 pageA 导航到房间 2，记下 id 即返回。
    const room2Id = await createRoom(pageA, {
      topic: "E2E 接管切房副",
      agentNames: ["蓝方评审", "红方助手"],
      facilitatorName: "蓝方评审",
    });

    // pageA 回到房间 1 并完成第 1 轮 → 建立 active binding（takeover 路径的前提）。
    await pageA.goto(`/rooms/${room1Id}`);
    await expectControlState(pageA, "controlling");
    await startRound(pageA);
    await waitRoundPhase(pageA, 1, "已完成");

    // 同 context 第二页：只读观察，banner 暴露对方控制者前缀（A 仍在控）。
    const pageB = await context.newPage();
    await pageB.goto(`/rooms/${room1Id}`);
    await expectControlState(pageB, "observing");
    await expect(pageB.getByTestId("controller-id")).toBeVisible();

    // 房间 1 的 scopeId（B 接管会 takeoverScope，leaseEpoch +1）。
    const scopeId = (await activeBinding(pageB, room1Id)).executionScopeId as string;
    const epochBeforeTakeover = await scopeLeaseEpoch(pageB, scopeId);

    // B 手动「取得控制权」steal 抢锁 + 重跑 controlRoom 走 takeoverScope（epoch +1）。
    await pageB.getByRole("button", { name: "取得控制权" }).click();
    await expectControlState(pageB, "controlling", 15_000);
    expect(await scopeLeaseEpoch(pageB, scopeId)).toBe(epochBeforeTakeover + 1);

    // B 真接管证明：开新一轮并完成（takeoverScope 写入成功 + token 有效）。第 2 轮
    // summary 提交即硬证明 B 持合法 controller token（轮完成需经 createRound→speak→
    // commitSummary 全链路，全程用 B takeover 后的 token 才能通过 Host controller fence）。
    await pageB.getByRole("button", { name: "开始新一轮" }).click();
    await waitRoundPhase(pageB, 2, "已完成");
    const summariesAfterB = await roomSummaries(pageB, room1Id);
    expect(summariesAfterB.length).toBeGreaterThanOrEqual(2);

    // 关键回归动作：B 从房间 1 导航到房间 2（整页 goto）。RoomPage cleanup 必须按
    // roomId 释放房间 1 的 takeover 锁。先等 B 在房间 2 落定再继续。
    await pageB.goto(`/rooms/${room2Id}`);
    await expect(pageB.getByRole("heading", { name: "E2E 接管切房副" })).toBeVisible();
    await expectControlState(pageB, "controlling");

    // A reload 回房间 1 → 挂载 controlRoom 走 tryAcquire（而非点「取得控制权」按钮）：
    // 「取得控制权」走 handleTakeover 的 releaseSteal 自救路径，即使 B 残留锁 A 也能
    // steal 抢断，会掩盖 leak。故用挂载 controlRoom 的 acquire 排队路径作回归证据——
    // 修复后 B 切房已释放房间 1 锁，A 的 tryAcquire 直接成功 → 15s 内 controlling；
    // 若 B 的 takeover 锁未随切房释放，A 的 controlRoom 会卡在 acquire 排队超时。
    // 先等 UI 翻转再断言（S5 时序纪律）。
    await pageA.goto(`/rooms/${room1Id}`);
    await expectControlState(pageA, "controlling", 15_000);

    // 真控制：A 在房间 1 开新一轮并完成（证明 reload 后拿到的是合法 controller token，
    // 不是被 B 切房带走的失效 token）。A 完成 r1、B 完成 r2，此处 A 续开第 3 轮并完成；
    // 第 3 轮 summary 提交即硬证明 A 持合法 token（同上 fence 推理）。
    await pageA.getByRole("button", { name: "开始新一轮" }).click();
    await waitRoundPhase(pageA, 3, "已完成");
    const summariesAfterA = await roomSummaries(pageA, room1Id);
    expect(summariesAfterA.length).toBeGreaterThanOrEqual(3);
  });

  test("2. readiness badge: ready success, then installation changed → warn (§3)", async () => {
    // 建两个 Profile + 两个 Agent（进房前的物料）。
    await createProfile(pageA, {
      name: CLAUDE_PROFILE,
      driverId: "claude-stream-json",
      installationId: CLAUDE_INSTALLATION,
      route: "ant-glm5.2",
    });
    await createProfile(pageA, {
      name: "Codex 主用",
      driverId: "codex-app-server",
      installationId: "codex-e2e-fake001",
    });
    await createAgent(pageA, {
      name: CLAUDE_AGENT,
      persona: "蓝方评审。",
      profileName: CLAUDE_PROFILE,
      modelId: CLAUDE_MODEL,
      color: "#4f6ef7",
    });
    await createAgent(pageA, {
      name: CODEX_AGENT,
      persona: "红方助手。",
      profileName: "Codex 主用",
      modelId: "e2e-codex-model",
      color: "#f74f6e",
    });

    // /rooms/new 勾选 2 个 + 选 Facilitator → 全 ready 探针握手 → 成功 badge。
    await pageA.goto("/rooms/new");
    await pageA.getByRole("textbox", { name: "话题", exact: true }).fill("E2E 预检 badge");
    for (const name of [CLAUDE_AGENT, CODEX_AGENT]) {
      await pageA.locator("label", { hasText: name }).getByRole("checkbox").click();
    }
    await pageA
      .getByRole("combobox", { name: "Facilitator（负责生成每轮总结）", exact: true })
      .selectOption({ label: CLAUDE_AGENT });
    const newRoomBadge = pageA.getByTestId("room-readiness");
    await expect(newRoomBadge).toBeVisible();
    await expect(newRoomBadge.getByText("此房间可运行", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // 创建进房 → RoomHeader 同款成功 badge（同处探针，命中已建立的 ready 缓存）。
    await pageA.getByRole("button", { name: "创建并进入" }).click();
    await pageA.waitForURL(/\/rooms\/[0-9a-fA-F-]+/);
    const headerBadge = pageA.getByTestId("room-readiness");
    await expect(headerBadge.getByText("此房间可运行", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // 回到 /rooms/new 验 warn 态。先清 Host 探针缓存（S5 60s 成功缓存会遮蔽 changed
    // 后的 fresh 握手——resetDriverState 清 probe cache，且不动 IndexedDB 的
    // profile/agent/room），再把 claude 安装置为 changed，重新勾选即 fresh 探针。
    await resetDriverState(pageA);
    await setInstallationState(pageA, CLAUDE_INSTALLATION, "changed");
    await pageA.goto("/rooms/new");
    await pageA.getByRole("textbox", { name: "话题", exact: true }).fill("E2E 预检 badge v2");
    for (const name of [CLAUDE_AGENT, CODEX_AGENT]) {
      await pageA.locator("label", { hasText: name }).getByRole("checkbox").click();
    }
    await pageA
      .getByRole("combobox", { name: "Facilitator（负责生成每轮总结）", exact: true })
      .selectOption({ label: CLAUDE_AGENT });
    const warnBadge = pageA.getByTestId("room-readiness");
    await expect(warnBadge.getByText("此房间尚未就绪", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    // changed → resolveStatic 把非 trusted 态映射为 runtime_unavailable
    // （profileReadinessView.label「运行时不可用」）；badge 命名该 profile 并提示未就绪
    // （problems 列表里 message =「GLM 5.2 主用」未就绪：运行时不可用）。
    await expect(warnBadge.getByText("GLM 5.2 主用", { exact: false })).toBeVisible();
    await expect(warnBadge.getByText("运行时不可用", { exact: false })).toBeVisible();
  });

  test("3. two pause wordings: Room runState vs Round phase, never mixed (§3)", async () => {
    const { codexPid } = await setupRoomWithTwoAgents(pageA, "E2E 两种暂停文案");
    await expectControlState(pageA, "controlling");
    // codex hangUntilCancel：让第 1 轮停在 running，从容操作「暂停调度」（completed 态
    // 下 runState=idle、无活动轮，该按钮不渲染，故必须在 running 中触发）。
    await setDriverBehavior(pageA, codexPid, { hangUntilCancel: true });

    // 第 1 轮 running → 点「暂停调度」（Room runState 门）。pauseRoom 设 runState=paused
    // 并取消在途 execution，round 随之进 paused(user_cancelled)。
    await startRound(pageA);
    await expect(activePreview(pageA)).toContainText("正在生成", { timeout: 15_000 });
    await pageA.getByRole("button", { name: "暂停调度" }).click();
    // Room 维度文案：header runState pill 翻「已暂停调度」+「恢复调度」按钮出现。
    await expect(pageA.locator("header").getByText("已暂停调度", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(pageA.getByRole("button", { name: "恢复调度" })).toBeVisible();
    // 收尾本轮（暂停调度触发的 user_cancelled paused 可被终止）。
    await expect(pausedPanel(pageA)).toBeVisible({ timeout: 20_000 });
    await abortPausedRound(pageA);
    await waitRoundPhase(pageA, 1, "已终止");

    // 第 2 轮：codex 仍 hangUntilCancel，发起后「停止生成」（cancelActiveExecution，
    // 只取消在途 execution，不动 runState 调度门）→ Round phase「本轮已暂停」。
    await pageA.getByRole("button", { name: "开始新一轮" }).click();
    await expect(activePreview(pageA)).toContainText("正在生成", { timeout: 15_000 });
    await pageA.getByRole("button", { name: "停止生成" }).click();
    await expect(pausedPanel(pageA)).toBeVisible({ timeout: 20_000 });
    await expect(pausedPanel(pageA)).toContainText("第 2 轮已暂停：已手动停止生成");
    // 轮 section 的 phase pill 是 Round 维度「本轮已暂停」。
    await expect(
      roundSection(pageA, 2).locator("summary").getByText("本轮已暂停", { exact: true }),
    ).toBeVisible();

    // 关键双轴不混：「停止生成」只暂停 Round，不触发 Room 调度门暂停——故 header runState
    // pill 此刻不是「已暂停调度」（仍是 running 的「运行中」）。本轮终止收尾。
    await expect(pageA.locator("header").getByText("已暂停调度", { exact: true })).toHaveCount(0);
    await abortPausedRound(pageA);
    await waitRoundPhase(pageA, 2, "已终止");
  });

  test("4. interrupt confirm: sending while generating prompts, cancel keeps nothing, confirm writes (§3)", async () => {
    const { roomId, claudePid, codexPid } = await setupRoomWithTwoAgents(pageA, "E2E 中断确认");
    await setDriverBehavior(pageA, codexPid, { hangUntilCancel: true });

    // 发起：claude 先提交，codex hang 在 started（round.phase=running → roundGenerating）。
    await startRound(pageA);
    await expect(roundSection(pageA, 1).getByText(`reply-${claudePid}-1`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(activePreview(pageA)).toContainText("正在生成");

    // 填写一条用户消息并发送 → 中断确认 Modal（标题 + stale_context 文案）。
    const input = pageA.getByRole("textbox", { name: "用户发言" });
    const userText = "中途追问一句";
    await input.fill(userText);
    await pageA.getByRole("button", { name: "发送", exact: true }).click();
    const dialog = pageA.getByRole("dialog").filter({ hasText: "发送将中断当前生成" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("stale_context");

    // 取消 → Modal 关闭，且时间线此刻无该用户消息。
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toBeHidden();
    await expect(pageA.getByText(userText, { exact: true })).toHaveCount(0);

    // 再次发送 → 确认发送 → 时间线出现该用户消息（role=user 的 bubble）。
    await input.fill(userText);
    await pageA.getByRole("button", { name: "发送", exact: true }).click();
    const dialog2 = pageA.getByRole("dialog").filter({ hasText: "发送将中断当前生成" });
    await expect(dialog2).toBeVisible();
    await dialog2.getByRole("button", { name: "确认发送" }).click();
    await expect(dialog2).toBeHidden();
    await expect(pageA.getByText(userText, { exact: true })).toBeVisible({ timeout: 15_000 });

    // 停止生成 → paused 面板出现；claude 已提交发言与用户消息均保留在时间线。
    await pageA.getByRole("button", { name: "停止生成" }).click();
    await expect(pausedPanel(pageA)).toBeVisible({ timeout: 20_000 });
    await expect(pausedPanel(pageA)).toContainText("第 1 轮已暂停：已手动停止生成");
    await expect(roundSection(pageA, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();
    await expect(pageA.getByText(userText, { exact: true })).toBeVisible();
  });

  test("5. a11y: globals.css focus + reduced-motion, static and live (§3)", async () => {
    // 静态断言：globals.css 含全局焦点轮廓、reduced-motion 媒体查询、accent token。
    const cssPath = join(process.cwd(), "src", "styles", "globals.css");
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("--color-accent");

    // 活断言 1：键盘 Tab 把焦点停在一个非输入元素上，:focus-visible 计算轮廓宽度为 2px。
    // Settings 首屏的「+ 新建 Profile」按钮（无 outline-none，焦点轮廓自然生效）。
    const target = pageA.getByRole("button", { name: "+ 新建 Profile" });
    // 键盘导航逐次 Tab，直到焦点停在 target 上（键盘聚焦才匹配 :focus-visible）。
    for (let i = 0; i < 120; i += 1) {
      const focused = await target.evaluate((el) => el === document.activeElement);
      if (focused) break;
      await pageA.keyboard.press("Tab");
    }
    await expect(target).toBeFocused();
    const outlineWidth = await target.evaluate((el) => getComputedStyle(el).outlineWidth);
    expect(outlineWidth).toBe("2px");

    // 活断言 2：reduced-motion 下媒体查询 !important 把 transition-duration 压到
    // 0.01ms（接近瞬切）。Chromium 序列化该值为秒 + 科学计数法「1e-05s」，不同浏览器/
    // 版本可能序列化不同，故按「毫秒数 < 1ms」断言而非字面字符串。
    await pageA.emulateMedia({ reducedMotion: "reduce" });
    const transitionDurationMs = await target.evaluate((el) => {
      // getComputedStyletransitionDuration 形如 "0.01ms" 或 "1e-05s"；用一张临时元素
      // 的 transitionTimer 读出毫秒更稳，但此处直接解析 computed value 的秒表示。
      const raw = getComputedStyle(el).transitionDuration;
      const seconds = Number.parseFloat(raw);
      return Number.isFinite(seconds) ? seconds * 1000 : Number.NaN;
    });
    expect(transitionDurationMs).toBeLessThan(1);
  });
});
