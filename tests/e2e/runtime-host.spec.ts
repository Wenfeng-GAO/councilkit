/**
 * Runtime Host cutover E2E (U6, plan §571-576 first five bullets): real
 * production-mode Host + scriptable fake drivers + real browser UI flows on a
 * fresh IndexedDB per test. Acceptance fixture: one claude-stream-json Agent
 * (Profile with route ant-glm5.2) + one codex-app-server Agent.
 */
import { readFileSync } from "node:fs";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import {
  abortPausedRound,
  activePreview,
  concludeRoomViaButton,
  createAgent,
  createProfile,
  createRoom,
  driverCounters,
  dropEventStreams,
  expandRound,
  freshPage,
  pausedPanel,
  readStore,
  reportView,
  resetDriverState,
  resumeDrivers,
  retryPausedParticipant,
  roomExecutions,
  roomMessages,
  roomParticipants,
  roomReports,
  roomRounds,
  roomSummaries,
  rotatePausedScope,
  roundSection,
  setDriverBehavior,
  setInstallationState,
  skipPausedParticipant,
  startRound,
  summaryContent,
} from "./helpers";

/**
 * S4 report-view: the nine Markdown section headings (product.md §5.5), kept in
 * the SAME literal order/wording as REPORT_SECTION_HEADINGS in
 * src/orchestrator/discussion-instructions.ts so a drift there trips this spec.
 * SafeMarkdown renders each `## …` to an <h2>; we assert each heading text is
 * visible inside the report-view card.
 */
const REPORT_SECTION_HEADING_TEXTS = [
  "Background（背景）",
  "Discussion goal（讨论目标）",
  "Participating agents（参与角色）",
  "Discussion summary（讨论摘要）",
  "Key consensus（关键共识）",
  "Remaining disagreements（未决分歧）",
  "Recommendation（推荐）",
  "Risks and objections（风险与异议）",
  "Next actions（下一步行动）",
];

/** A nine-section decision report the fake facilitator can emit as its reply
 * (lazy-read per execution, so reconfiguring between rounds is effective).
 * The trailing 收敛建议：是 line is the convergence vote the parser recognizes
 * (only on a trimmed full last-line match), so a single round whose summary
 * ends with it auto-concludes the room and dispatches the report — whose body
 * is this same reply. */
const NINE_SECTION_REPORT_MD = `${REPORT_SECTION_HEADING_TEXTS.map(
  (heading) => `## ${heading}\n结论正文标记。`,
).join("\n\n")}\n收敛建议：是`;

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

/** Settings → 2 Profiles → 2 Agents → Room (claude first, claude facilitates).
 * `maxRounds` (S4) optionally caps the room so it auto-concludes. */
async function setupRoom(page: Page, topic: string, maxRounds?: number): Promise<RoomFixture> {
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
    maxRounds,
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
    await expect(await summaryContent(page, 1)).toContainText(`reply-${claudePid}-3`);

    // --- round 2 ---
    await startRound(page);
    await waitRoundPhase(page, 2, "已完成");
    await expect(roundSection(page, 2).getByText(`reply-${claudePid}-4`)).toBeVisible();
    await expect(roundSection(page, 2).getByText(`reply-${codexPid}-2`)).toBeVisible();
    await expect(await summaryContent(page, 2)).toContainText(`reply-${claudePid}-6`);

    // --- warm reuse: one prewarm per participant across both rounds; the
    // facilitator executes twice per round (message + summary). S2 focus 后口径: facilitator 每轮 3 次（focus + message + summary），两轮 6 次；codex 每轮 1 次。
    const counters = await driverCounters(page);
    expect(counters[claudePid]?.prewarmCount).toBe(1);
    expect(counters[codexPid]?.prewarmCount).toBe(1);
    expect(counters[claudePid]?.executeCount).toBe(6);
    expect(counters[codexPid]?.executeCount).toBe(2);
    expect(counters[claudePid]?.closeCount).toBe(0);
    expect(counters[codexPid]?.closeCount).toBe(0);

    // --- committed state in Dexie before reload ---
    expect(await roomMessages(page, roomId)).toHaveLength(6);
    expect(await roomSummaries(page, roomId)).toHaveLength(2);

    // --- reload: both rounds' messages/summaries still render from Dexie ---
    await page.reload();
    await expect(page.getByRole("heading", { name: "E2E 全流程验收" })).toBeVisible();
    // Latest round defaults expanded.
    await expect(roundSection(page, 2).getByText(`reply-${claudePid}-4`)).toBeVisible();
    await expect(roundSection(page, 2).getByText(`reply-${codexPid}-2`)).toBeVisible();
    await expect(await summaryContent(page, 2)).toContainText(`reply-${claudePid}-6`);
    // Historical round needs an explicit expand.
    await expandRound(page, 1);
    await expect(roundSection(page, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();
    await expect(roundSection(page, 1).getByText(`reply-${codexPid}-1`)).toBeVisible();
    await expect(await summaryContent(page, 1)).toContainText(`reply-${claudePid}-3`);
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
    // S2 focus 后口径: focus(claude-1)+claude message(claude-2)+codex 断线重连 reply=3 条；断线后无重发，每条唯一。
    expect(messages).toHaveLength(3);
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
    // S2 focus 后口径: focus(claude-1)+claude message(claude-2) 均已 commit；codex 第 1
    // 次执行 mismatch 被丢弃，不计入消息。commit 顺序不以数组强约束（IDB getAll 主键序）。
    let messages = await roomMessages(page, roomId);
    expect(messages.map((message) => message.content).sort()).toEqual([
      `reply-${claudePid}-1`,
      `reply-${claudePid}-2`,
    ]);
    const rounds = await roomRounds(page, roomId);
    expect(rounds[0]?.pauseReason?.code).toBe("model_mismatch");
    // No automatic retry: exactly one codex execution.
    // S2 focus 后口径: facilitator 执行 focus(#1)+message(#2)=2 次；codex 1 次后 mismatch。
    let counters = await driverCounters(page);
    expect(counters[codexPid]?.executeCount).toBe(1);
    expect(counters[claudePid]?.executeCount).toBe(2);
    // The collapsed failure record carries structure, never the body.
    await expect(roundSection(page, 1).getByTestId("failure-record")).toContainText("已丢弃");

    // 终止本轮（不生成总结）→ round aborted, committed speech kept, new round CTA.
    await abortPausedRound(page);
    await waitRoundPhase(page, 1, "已终止");
    await expect(page.getByRole("button", { name: "开始新一轮" })).toBeVisible();
    await expect(roundSection(page, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();
    messages = await roomMessages(page, roomId);
    expect(messages.map((message) => message.content).sort()).toEqual([
      `reply-${claudePid}-1`,
      `reply-${claudePid}-2`,
    ]);
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
    // S2 focus 后口径: focus=reply-claude-1, claude message=reply-claude-2, codex message=reply-codex-1, summary=reply-claude-3；commit 消息数 3。
    await expect(await summaryContent(page, 1)).toContainText(`reply-${claudePid}-3`);
    expect(await roomMessages(page, roomId)).toHaveLength(3);
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

  test("retry: 重试该 Participant re-dispatches under a fresh executionId, then clears to complete", async () => {
    test.slow();
    const { roomId, codexPid } = await setupRoom(page, "E2E 手动重试");
    // Inject an execution_failed pause (retryable:false so the auto-once rule
    // does NOT fire — the pause is immediate, the manual retry is the first).
    await setDriverBehavior(page, codexPid, {
      failWith: {
        error: { code: "MODEL_UNAVAILABLE", message: "e2e injected failure" },
        retryable: false,
        dispatchState: "not_dispatched",
      },
    });

    await startRound(page);
    await expect(pausedPanel(page)).toBeVisible({ timeout: 20_000 });
    await expect(pausedPanel(page)).toContainText("第 1 轮已暂停：执行失败");
    // The paused panel surfaces the recoverable affordances (retry + skip).
    await expect(
      pausedPanel(page).getByRole("button", { name: /^重试该 Participant/ }),
    ).toBeVisible();
    await expect(pausedPanel(page).getByRole("button", { name: "跳过并继续" })).toBeVisible();
    const firstFailed = (await roomExecutions(page, roomId)).find(
      (execution) => execution.participantId === codexPid && execution.state === "failed",
    );
    expect(firstFailed, "injected failure recorded").toBeTruthy();

    // First manual retry: still injected, so it fails again — and the panel
    // now reports the already-retried count.
    await retryPausedParticipant(page);
    await expect(pausedPanel(page)).toBeVisible({ timeout: 20_000 });
    await expect(
      pausedPanel(page).getByRole("button", { name: /^重试该 Participant（已重试 1 次）$/ }),
    ).toBeVisible();

    // Clear the injection (shallow-merge null), then retry again — codex
    // succeeds and the round completes.
    await setDriverBehavior(page, codexPid, { failWith: null });
    await retryPausedParticipant(page);
    await waitRoundPhase(page, 1, "已完成");

    // codex executed three times: original fail + retry-fail + cleared retry.
    const counters = await driverCounters(page);
    expect(counters[codexPid]?.executeCount).toBe(3);
    expect(counters[codexPid]?.prewarmCount).toBe(1);

    // Three distinct executionIds; the two retries form an A -> B -> C chain
    // (each retry links to whatever the pause was pointing at when retried):
    // A is the original (retryOf null), B retries A, C retries B.
    const executions = await roomExecutions(page, roomId);
    const codexExecutions = executions
      .filter(
        (execution) => execution.participantId === codexPid && execution.resultKind === "message",
      )
      .sort((a, b) => (a.executionId < b.executionId ? -1 : 1));
    expect(codexExecutions).toHaveLength(3);
    expect(new Set(codexExecutions.map((execution) => execution.executionId)).size).toBe(3);
    const original = codexExecutions.find((execution) => execution.retryOfExecutionId === null);
    expect(original, "chain head has no retryOf").toBeTruthy();
    const retries = codexExecutions.filter((execution) => execution.retryOfExecutionId !== null);
    expect(retries).toHaveLength(2);
    // The chain is contiguous: the first retry's anchor is the original, the
    // second retry's anchor is the first retry — every retry points at a real
    // prior execution in this slot, never at nothing and never re-dispatched.
    const retryAnchors = new Set(retries.map((execution) => execution.retryOfExecutionId));
    expect(retryAnchors.size).toBe(2);
    expect(retryAnchors.has(original?.executionId ?? "")).toBe(true);
    // The terminal failure record is retained in round 1's timeline.
    const failedKept = codexExecutions.find((execution) => execution.state === "failed");
    expect(failedKept, "terminal failure record retained").toBeTruthy();
    await expandRound(page, 1);
    await expect(roundSection(page, 1).getByTestId("failure-record").first()).toBeVisible();
  });

  test("skip: 跳过并继续 advances the cursor, the skipped Participant is absent from the round", async () => {
    test.slow();
    const { roomId, claudePid, codexPid } = await setupRoom(page, "E2E 跳过并继续");
    await setDriverBehavior(page, codexPid, {
      failWith: {
        error: { code: "MODEL_UNAVAILABLE", message: "e2e injected failure" },
        retryable: false,
        dispatchState: "not_dispatched",
      },
    });

    await startRound(page);
    await expect(pausedPanel(page)).toBeVisible({ timeout: 20_000 });
    await expect(pausedPanel(page)).toContainText("第 1 轮已暂停：执行失败");

    // Skip via the confirm modal.
    await skipPausedParticipant(page);
    await waitRoundPhase(page, 1, "已完成");

    // Only claude spoke this round; codex never produced a committed message.
    const messages = await roomMessages(page, roomId);
    expect(messages.filter((message) => message.participantId === codexPid)).toHaveLength(0);
    const codexMessages = messages.filter((message) => message.participantId === claudePid);
    expect(codexMessages.length).toBeGreaterThan(0);
    // codex executed exactly once (the failure); no retry, no successful turn.
    const counters = await driverCounters(page);
    expect(counters[codexPid]?.executeCount).toBe(1);

    // The skipped failure record carries the 已跳过 marker in the timeline.
    await expandRound(page, 1);
    await expect(roundSection(page, 1).getByTestId("failure-record").first()).toContainText(
      "已跳过",
    );
    // A committed summary still landed for the round (the facilitator continued).
    expect(await roomSummaries(page, roomId)).toHaveLength(1);
  });

  test("rotate: 重建执行环境（轮转）closes the scope, cold-builds a new one, completes a fresh round", async () => {
    test.slow();
    const { roomId, claudePid, codexPid } = await setupRoom(page, "E2E 轮转重建");
    // Inject a needs_rebase failure: the Host emits failed with code NEEDS_REBASE
    // and a "session reconciliation:" message — the family the panel branches
    // to rotate on (the persisted code is normalized to execution_failed, so
    // the detail prefix is the recognizer).
    await setDriverBehavior(page, codexPid, {
      failWith: {
        error: {
          code: "NEEDS_REBASE",
          message: "session reconciliation: context_window_threshold",
        },
        retryable: false,
        dispatchState: "not_dispatched",
      },
    });

    await startRound(page);
    await expect(pausedPanel(page)).toBeVisible({ timeout: 20_000 });
    // needs_rebase family copy + the rotate primary action, no skip button.
    await expect(pausedPanel(page)).toContainText("执行 Session 需要重建");
    await expect(
      pausedPanel(page).getByRole("button", { name: /^重建执行环境（轮转）/ }),
    ).toBeVisible();
    await expect(pausedPanel(page).getByRole("button", { name: "跳过并继续" })).toHaveCount(0);
    // claude's committed message from the aborted round survives in the DOM.
    await expect(roundSection(page, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();

    // Clear the injection BEFORE rotating: the rotation's startRound immediately
    // consumes the driver behavior, and a still-injected codex would pause the
    // new round again on the same needs_rebase failure.
    await setDriverBehavior(page, codexPid, { failWith: null });
    await rotatePausedScope(page);

    // Round 1 aborted, round 2 completed. codex's first successful turn is its
    // 2nd execute (the 1st was the needs_rebase failure in round 1), so its reply
    // counter is 2.
    await waitRoundPhase(page, 1, "已终止");
    await waitRoundPhase(page, 2, "已完成");
    await expect(roundSection(page, 2).getByText(`reply-${codexPid}-2`)).toBeVisible();

    // The old scope was closed on rotation (one driver.close per Participant in
    // that scope), and the new round cold-built a fresh scope (prewarm=2 per
    // Participant: round 1 warm create + round 2 cold rebuild after rotation).
    const counters = await driverCounters(page);
    expect(counters[claudePid]?.closeCount).toBe(1);
    expect(counters[codexPid]?.closeCount).toBe(1);
    expect(counters[claudePid]?.prewarmCount).toBe(2);
    expect(counters[codexPid]?.prewarmCount).toBe(2);

    // The rotation entry is visible in round 1's failure record, and the
    // committed claude speech from the aborted round is still present.
    await expandRound(page, 1);
    await expect(roundSection(page, 1).getByText(`reply-${claudePid}-1`)).toBeVisible();
    await expect(roundSection(page, 1).getByTestId("rotation-entry")).toContainText(
      "已重建（needs_rebase · 第 1 次）",
    );

    // The needs_rebase failure is the only terminal failure in the room.
    const executions = await roomExecutions(page, roomId);
    const rebaseFailures = executions.filter(
      (execution) => execution.error?.code === "NEEDS_REBASE",
    );
    expect(rebaseFailures).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // S4 report-view & export (plan-a §3.2 scenarios A/B/C). The convergence=是
  // injection timing is load-bearing (plan-a R3): the facilitator behavior is
  // reconfigured AFTER round 1 completes and BEFORE round 2 starts, so the
  // round-2 summary (the facilitator's 3rd lazy read) casts the convergence
  // vote and the room auto-concludes into the decision report.
  // -------------------------------------------------------------------------

  test("S4 scenario A: two rounds -> convergence=是 -> auto report -> copy/download nine-section content", async () => {
    test.slow();
    const { roomId, claudePid } = await setupRoom(page, "S4 收敛报告全流程");

    // --- round 1: default replies, no convergence marker ---
    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");
    await expect(await summaryContent(page, 1)).toContainText(`reply-${claudePid}-3`);

    // --- inject the nine-section reply (with convergence=是 last line) on the
    // facilitator, AFTER round 1 completed and BEFORE round 2 starts. The
    // driver reads behavior lazily per execution, so round 2's focus, message
    // AND summary all carry it; the summary's trimmed last line is 收敛建议：是
    // → auto-conclude → report dispatched on the same reply content. ---
    await setDriverBehavior(page, claudePid, { reply: NINE_SECTION_REPORT_MD });

    // --- round 2 -> convergence -> auto concluding -> concluded report ---
    await startRound(page);
    await waitRoundPhase(page, 2, "已完成");
    // concluding transient: the report-progress card streams while the report
    // runs, but the fake facilitator dispatches synchronously, so the room may
    // land concluded before we observe it — assert only the terminal state.
    await expect(reportView(page)).toBeVisible({ timeout: 20_000 });

    // header badges: 头脑风暴 mode pill + 已结束 status pill.
    await expect(page.locator("header").getByText("头脑风暴", { exact: true })).toBeVisible();
    await expect(page.locator("header").getByText("已结束", { exact: true })).toBeVisible();

    // concluded: the start-next-round CTA and the user input bar are gone.
    await expect(page.getByRole("button", { name: "开始新一轮" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "发起讨论" })).toHaveCount(0);

    // the nine section headings each render inside the report-view card.
    for (const heading of REPORT_SECTION_HEADING_TEXTS) {
      await expect(reportView(page).getByRole("heading", { name: heading })).toBeVisible();
    }
    // a body marker that proves the reply text (not just headings) survived.
    await expect(reportView(page).getByText("结论正文标记。").first()).toBeVisible();

    // IDB: exactly one committed report, sourced from a committed report
    // execution; the room row is concluded.
    const reports = await roomReports(page, roomId);
    expect(reports).toHaveLength(1);
    const report = reports[0] as { content: string; sourceExecutionId: string };
    expect(report.content).toContain("## Background（背景）");
    expect(report.content).toContain("## Next actions（下一步行动）");
    const executions = await roomExecutions(page, roomId);
    const reportExecutions = executions.filter((execution) => execution.resultKind === "report");
    expect(reportExecutions).toHaveLength(1);
    expect(reportExecutions[0]?.state).toBe("committed");
    expect(reportExecutions[0]?.executionId).toBe(report.sourceExecutionId);
    // the room row itself reads concluded (status persisted by commitReport).
    const roomRows = (await readStore<unknown>(page, "rooms")) as { id: string; status: string }[];
    expect(roomRows.find((row) => row.id === roomId)?.status).toBe("concluded");

    // --- copy: grant clipboard first (with origin), then click & readText ---
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "http://127.0.0.1:43127",
    });
    await reportView(page).getByRole("button", { name: "复制 Markdown" }).click();
    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText()), {
        timeout: 5_000,
      })
      .toContain("## Background（背景）");
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("## Next actions（下一步行动）");
    expect(clipboard).toContain("结论正文标记。");

    // --- download: wait for the 'download' event, assert filename + content.
    // reportFilename collapses the space in the topic to a dash. ---
    const downloadButton = reportView(page).getByRole("button", { name: "下载 Markdown" });
    const [download] = await Promise.all([page.waitForEvent("download"), downloadButton.click()]);
    expect(download.suggestedFilename()).toBe("S4-收敛报告全流程-report.md");
    const downloadPath = await download.path();
    expect(downloadPath, "download should land on disk").not.toBeNull();
    const downloaded = readFileSync(downloadPath as string, "utf8");
    expect(downloaded).toContain("## Background（背景）");
    expect(downloaded).toContain("## Next actions（下一步行动）");
    expect(downloaded).toContain("结论正文标记。");
  });

  test("S4 scenario B: maxRounds=1 auto-concludes with no convergence marker", async () => {
    test.slow();
    const { roomId } = await setupRoom(page, "S4 单轮自动结束", 1);
    // createRoom already filled 最大轮次=1; round 1 completing (completedRounds
    // 1 >= maxRounds 1) is the conclusion trigger — no 收敛建议 line needed.
    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");
    // concluding transient then the concluded report — the report streams off
    // the facilitator's DEFAULT reply, which has no nine-section headings, so
    // assert on the report-view existence + IDB only (heading content is
    // mode-instruction-driven, not a lim-1-room invariant here).
    await expect(reportView(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("header").getByText("已结束", { exact: true })).toBeVisible();
    // operation row + input bar are gone (concluded = replaced, not disabled).
    await expect(page.getByRole("button", { name: "开始新一轮" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "发起讨论" })).toHaveCount(0);
    const reports = await roomReports(page, roomId);
    expect(reports).toHaveLength(1);
    const executions = await roomExecutions(page, roomId);
    expect(
      executions.filter(
        (execution) => execution.resultKind === "report" && execution.state === "committed",
      ),
    ).toHaveLength(1);
    const roomRows = (await readStore<unknown>(page, "rooms")) as { id: string; status: string }[];
    expect(roomRows.find((row) => row.id === roomId)?.status).toBe("concluded");
  });

  test("S4 scenario C: report generation fails -> retry banner -> retry succeeds", async () => {
    test.slow();
    const { roomId, claudePid } = await setupRoom(page, "S4 报告失败重试");

    // --- round 1: default reply, completes cleanly ---
    await startRound(page);
    await waitRoundPhase(page, 1, "已完成");
    await expect(await summaryContent(page, 1)).toContainText(`reply-${claudePid}-3`);

    // --- inject a non-retryable facilitator failure so the REPORT execution
    // (dispatched by concludeRoom on the facilitator) fails immediately. The
    // report execution never owns round.activeExecutionId, so the room stays
    // open+idle and the failure surfaces as the room-level report-failure
    // banner (NOT a paused round). ---
    await setDriverBehavior(page, claudePid, {
      failWith: {
        error: { code: "MODEL_UNAVAILABLE", message: "e2e injected report failure" },
        retryable: false,
        dispatchState: "not_dispatched",
      },
    });

    await concludeRoomViaButton(page);
    // banner visible with the injected code; room NOT concluded; new-round CTA
    // still present (room open). The report-progress card should have cleared.
    await expect(page.getByTestId("report-failure")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("report-failure")).toContainText("MODEL_UNAVAILABLE");
    await expect(page.getByTestId("report-failure")).toContainText("报告生成失败");
    await expect(page.locator("header").getByText("已结束", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "开始新一轮" })).toBeVisible();

    // IDB: the report execution is in a terminal-failure state; no committed
    // report yet.
    const failedReports = await roomReports(page, roomId);
    expect(failedReports).toHaveLength(0);
    const executionsBefore = await roomExecutions(page, roomId);
    const failedReportBefore = executionsBefore.find(
      (execution) =>
        execution.resultKind === "report" &&
        (execution.state === "failed" ||
          execution.state === "interrupted" ||
          execution.state === "discarded"),
    );
    expect(failedReportBefore, "injected report failure recorded").toBeTruthy();

    // --- clear the injection and retry via the banner — a fresh report
    // execution dispatches and commits, concluding the room. ---
    await setDriverBehavior(page, claudePid, { failWith: null });
    await page.getByTestId("report-failure").getByRole("button", { name: "重试生成报告" }).click();
    await expect(reportView(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("header").getByText("已结束", { exact: true })).toBeVisible();
    expect(await roomReports(page, roomId)).toHaveLength(1);
    const executionsAfter = await roomExecutions(page, roomId);
    const reportExecutions = executionsAfter.filter(
      (execution) => execution.resultKind === "report",
    );
    // one failed (the injected attempt) + one committed (the retry).
    expect(reportExecutions).toHaveLength(2);
    expect(reportExecutions.some((execution) => execution.state === "committed")).toBe(true);
    const roomRows = (await readStore<unknown>(page, "rooms")) as { id: string; status: string }[];
    expect(roomRows.find((row) => row.id === roomId)?.status).toBe("concluded");
  });
});
