/**
 * Runtime Host cutover E2E (U6, plan §571-576 first five bullets): real
 * production-mode Host + scriptable fake drivers + real browser UI flows on a
 * fresh IndexedDB per test. Acceptance fixture: one claude-stream-json Agent
 * (Profile with route ant-glm5.2) + one codex-app-server Agent.
 */
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import {
  abortPausedRound,
  activePreview,
  createAgent,
  createProfile,
  createRoom,
  driverCounters,
  dropEventStreams,
  expandRound,
  freshPage,
  pausedPanel,
  resetDriverState,
  resumeDrivers,
  roomMessages,
  roomParticipants,
  roomRounds,
  roomSummaries,
  roundSection,
  setDriverBehavior,
  setInstallationState,
  startRound,
  summaryContent,
} from "./helpers";

const CLAUDE_PROFILE = "GLM 5.2 主用";
const CODEX_PROFILE = "Codex 主用";
const CLAUDE_AGENT = "蓝方评审";
const CODEX_AGENT = "红方助手";
const CLAUDE_MODEL = "e2e-claude-model";
const CODEX_MODEL = "e2e-codex-model";
const CLAUDE_INSTALLATION = "claude-e2e-fake01";
const CODEX_INSTALLATION = "codex-e2e-fake001";

interface RoomFixture {
  roomId: string;
  claudePid: string;
  codexPid: string;
}

/** Settings → 2 Profiles → 2 Agents → Room (claude first, claude facilitates). */
async function setupRoom(page: Page, topic: string): Promise<RoomFixture> {
  await createProfile(page, {
    name: CLAUDE_PROFILE,
    driverId: "claude-stream-json",
    installationId: CLAUDE_INSTALLATION,
    route: "ant-glm5.2",
  });
  await createProfile(page, {
    name: CODEX_PROFILE,
    driverId: "codex-app-server",
    installationId: CODEX_INSTALLATION,
  });
  await createAgent(page, {
    name: CLAUDE_AGENT,
    persona: "冷静的蓝方评审，擅长结构化分析。",
    profileName: CLAUDE_PROFILE,
    modelId: CLAUDE_MODEL,
    color: "#4f6ef7",
  });
  await createAgent(page, {
    name: CODEX_AGENT,
    persona: "犀利直接的红方助手，擅长找反例。",
    profileName: CODEX_PROFILE,
    modelId: CODEX_MODEL,
    color: "#f74f6e",
  });
  const roomId = await createRoom(page, {
    topic,
    agentNames: [CLAUDE_AGENT, CODEX_AGENT],
    facilitatorName: CLAUDE_AGENT,
  });
  const participants = await roomParticipants(page, roomId);
  const claude = participants.find((participant) => participant.modelId === CLAUDE_MODEL);
  const codex = participants.find((participant) => participant.modelId === CODEX_MODEL);
  expect(claude, "claude participant should exist").toBeTruthy();
  expect(codex, "codex participant should exist").toBeTruthy();
  return { roomId, claudePid: claude?.id as string, codexPid: codex?.id as string };
}

async function waitRoundPhase(page: Page, roundNumber: number, phaseLabel: string): Promise<void> {
  await expect(
    roundSection(page, roundNumber).locator("summary").getByText(phaseLabel, { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
}

let context: BrowserContext;
let page: Page;

test.beforeEach(async ({ browser }) => {
  ({ context, page } = await freshPage(browser));
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
  await resetDriverState(page);
});

test.afterEach(async () => {
  await context?.close();
});

test.describe("runtime host cutover", () => {
  test("full flow: 2 profiles + 2 agents + room, two rounds, warm reuse, reload keeps history", async () => {
    test.slow();
    const { roomId, claudePid, codexPid } = await setupRoom(page, "E2E 全流程验收");

    // --- round 1 ---
    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");
    await expect(roundSection(page, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();
    await expect(roundSection(page, 1).getByText(`reply-${codexPid}-1`)).toBeVisible();
    await expect(await summaryContent(page, 1)).toContainText(`reply-${claudePid}-2`);

    // --- round 2 ---
    await startRound(page);
    await waitRoundPhase(page, 2, "已完成");
    await expect(roundSection(page, 2).getByText(`reply-${claudePid}-3`)).toBeVisible();
    await expect(roundSection(page, 2).getByText(`reply-${codexPid}-2`)).toBeVisible();
    await expect(await summaryContent(page, 2)).toContainText(`reply-${claudePid}-4`);

    // --- warm reuse: one prewarm per participant across both rounds; the
    // facilitator executes twice per round (message + summary). ---
    const counters = await driverCounters(page);
    expect(counters[claudePid]?.prewarmCount).toBe(1);
    expect(counters[codexPid]?.prewarmCount).toBe(1);
    expect(counters[claudePid]?.executeCount).toBe(4);
    expect(counters[codexPid]?.executeCount).toBe(2);
    expect(counters[claudePid]?.closeCount).toBe(0);
    expect(counters[codexPid]?.closeCount).toBe(0);

    // --- committed state in Dexie before reload ---
    expect(await roomMessages(page, roomId)).toHaveLength(4);
    expect(await roomSummaries(page, roomId)).toHaveLength(2);

    // --- reload: both rounds' messages/summaries still render from Dexie ---
    await page.reload();
    await expect(page.getByRole("heading", { name: "E2E 全流程验收" })).toBeVisible();
    // Latest round defaults expanded.
    await expect(roundSection(page, 2).getByText(`reply-${claudePid}-3`)).toBeVisible();
    await expect(roundSection(page, 2).getByText(`reply-${codexPid}-2`)).toBeVisible();
    await expect(await summaryContent(page, 2)).toContainText(`reply-${claudePid}-4`);
    // Historical round needs an explicit expand.
    await expandRound(page, 1);
    await expect(roundSection(page, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();
    await expect(roundSection(page, 1).getByText(`reply-${codexPid}-1`)).toBeVisible();
    await expect(await summaryContent(page, 1)).toContainText(`reply-${claudePid}-2`);
    // No re-spawn after reload: counters are untouched by rendering.
    const afterReload = await driverCounters(page);
    expect(afterReload[claudePid]?.prewarmCount).toBe(1);
    expect(afterReload[codexPid]?.prewarmCount).toBe(1);
  });

  test("reconnect: dropped event stream resumes via afterSeq — no duplicate text, no re-dispatch", async () => {
    test.slow();
    const { roomId, codexPid } = await setupRoom(page, "E2E 断线重连");
    const reply = "断线重连输出甲乙丙丁";
    await setDriverBehavior(page, codexPid, { reply, pauseAfterEvents: 2 });

    await startRound(page);
    // The codex turn emits started + first delta, then holds mid-stream.
    await expect(activePreview(page).getByText(reply.slice(0, 5))).toBeVisible({
      timeout: 20_000,
    });
    const dropped = await dropEventStreams(page);
    expect(dropped).toBeGreaterThanOrEqual(1);
    await resumeDrivers(page);

    // The orchestrator reconnects with afterSeq and follows to the terminal.
    await waitRoundPhase(page, 1, "已完成");
    // UI shows the completed message exactly once (preview was replaced, not
    // duplicated); IndexedDB holds exactly one message for that execution.
    await expect(roundSection(page, 1).getByText(reply)).toHaveCount(1);
    const messages = await roomMessages(page, roomId);
    expect(messages.filter((message) => message.content === reply)).toHaveLength(1);
    expect(messages).toHaveLength(2);
    // No re-dispatch: codex executed exactly once; prewarm still one.
    const counters = await driverCounters(page);
    expect(counters[codexPid]?.executeCount).toBe(1);
    expect(counters[codexPid]?.prewarmCount).toBe(1);
  });

  test("model mismatch: pauses with model_mismatch copy, nothing committed, no retry, abort works", async () => {
    const { roomId, claudePid, codexPid } = await setupRoom(page, "E2E 模型不一致");
    await setDriverBehavior(page, codexPid, {
      reply: "偏离配置的输出",
      effectiveModel: "some-other-model",
      modelVerdict: "mismatch",
    });

    await startRound(page);
    await expect(pausedPanel(page)).toBeVisible({ timeout: 20_000 });
    await expect(pausedPanel(page)).toContainText("第 1 轮已暂停：实际模型与配置不一致");
    // The mismatched output is discarded: never previewed-to-commit, nowhere
    // in the DOM, and no message row in IndexedDB.
    await expect(page.getByText("偏离配置的输出")).toHaveCount(0);
    let messages = await roomMessages(page, roomId);
    expect(messages.map((message) => message.content)).toEqual([`reply-${claudePid}-1`]);
    const rounds = await roomRounds(page, roomId);
    expect(rounds[0]?.pauseReason?.code).toBe("model_mismatch");
    // No automatic retry: exactly one codex execution.
    let counters = await driverCounters(page);
    expect(counters[codexPid]?.executeCount).toBe(1);
    expect(counters[claudePid]?.executeCount).toBe(1);
    // The collapsed failure record carries structure, never the body.
    await expect(roundSection(page, 1).getByTestId("failure-record")).toContainText("已丢弃");

    // 终止本轮（不生成总结）→ round aborted, committed speech kept, new round CTA.
    await abortPausedRound(page);
    await waitRoundPhase(page, 1, "已终止");
    await expect(page.getByRole("button", { name: "开始新一轮" })).toBeVisible();
    await expect(roundSection(page, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();
    messages = await roomMessages(page, roomId);
    expect(messages.map((message) => message.content)).toEqual([`reply-${claudePid}-1`]);
    counters = await driverCounters(page);
    expect(counters[codexPid]?.executeCount).toBe(1);
  });

  test("toolState unknown: pauses with tool_state_unknown copy, nothing committed, no retry", async () => {
    const { roomId, codexPid } = await setupRoom(page, "E2E 工具状态");
    await setDriverBehavior(page, codexPid, {
      reply: "工具状态存疑的输出",
      toolState: "unknown",
    });

    await startRound(page);
    await expect(pausedPanel(page)).toBeVisible({ timeout: 20_000 });
    await expect(pausedPanel(page)).toContainText("第 1 轮已暂停：工具状态不可证明");
    await expect(page.getByText("工具状态存疑的输出")).toHaveCount(0);
    const rounds = await roomRounds(page, roomId);
    expect(rounds[0]?.pauseReason?.code).toBe("tool_state_unknown");
    const counters = await driverCounters(page);
    expect(counters[codexPid]?.executeCount).toBe(1);
  });

  test("prewarm failure: the whole round pauses before anyone speaks, other participant never executes", async () => {
    const { claudePid, codexPid } = await setupRoom(page, "E2E 预热失败");
    await setDriverBehavior(page, codexPid, { prewarmFails: true });

    await startRound(page);
    await expect(pausedPanel(page)).toBeVisible({ timeout: 20_000 });
    await expect(pausedPanel(page)).toContainText("第 1 轮已暂停：执行环境预热失败");
    await expect(pausedPanel(page)).toContainText("暂停于预热阶段");
    await expect(pausedPanel(page)).toContainText(`受影响 Participant：${CODEX_AGENT}`);
    const counters = await driverCounters(page);
    expect(counters[codexPid]?.prewarmCount).toBe(1);
    expect(counters[claudePid]?.prewarmCount).toBe(1);
    expect(counters[claudePid]?.executeCount).toBe(0);
    expect(counters[codexPid]?.executeCount).toBe(0);
  });

  test("alias normalization: effective alias with match verdict commits normally", async () => {
    const { roomId, claudePid, codexPid } = await setupRoom(page, "E2E alias 归一");
    await setDriverBehavior(page, claudePid, {
      effectiveModel: "e2e-claude-model-alias",
      modelVerdict: "match",
    });

    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");
    await expect(roundSection(page, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();
    await expect(roundSection(page, 1).getByText(`reply-${codexPid}-1`)).toBeVisible();
    await expect(await summaryContent(page, 1)).toContainText(`reply-${claudePid}-2`);
    expect(await roomMessages(page, roomId)).toHaveLength(2);
    expect(await roomSummaries(page, roomId)).toHaveLength(1);
  });

  test("installation changed: prewarm is rejected, round pauses prewarm_failed, nobody executes", async () => {
    const { claudePid, codexPid } = await setupRoom(page, "E2E 安装变更");
    await setInstallationState(page, CODEX_INSTALLATION, "changed");

    await startRound(page);
    await expect(pausedPanel(page)).toBeVisible({ timeout: 20_000 });
    await expect(pausedPanel(page)).toContainText("第 1 轮已暂停：执行环境预热失败");
    await expect(pausedPanel(page)).toContainText(`受影响 Participant：${CODEX_AGENT}`);
    const counters = await driverCounters(page);
    // The static binding gate rejects before the driver handshake even runs.
    expect(counters[codexPid]?.prewarmCount ?? 0).toBe(0);
    expect(counters[claudePid]?.prewarmCount).toBe(1);
    expect(counters[claudePid]?.executeCount).toBe(0);
    expect(counters[codexPid]?.executeCount ?? 0).toBe(0);
  });
});
