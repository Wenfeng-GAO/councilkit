/**
 * Playwright E2E helpers (U6): browser-visible flows only — page.goto, form
 * fills and clicks against the Chinese UI copy. IndexedDB reads via
 * page.evaluate are ASSERTION-ONLY; no helper ever writes the DB directly.
 * Host driver state is scripted exclusively through the E2E Host's test-only
 * /api/v1/__test__ control namespace (see tests/e2e/host-entry.mts).
 */
import {
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  expect,
} from "@playwright/test";

// ---------------------------------------------------------------------------
// Test-only Host control API (session cookie rides with the page context)
// ---------------------------------------------------------------------------

export interface DriverBehaviorInput {
  catalog?: string[];
  aliases?: string[];
  reply?: string;
  effectiveModel?: string | null;
  modelVerdict?: "match" | "mismatch" | "unknown";
  toolState?: "none" | "active" | "completed" | "unknown";
  prewarmFails?: boolean;
  /** Inject a failed terminal, or clear a previously injected one. The Host's
   * /driver control route shallow-merges behavior, so `failWith: null` clears
   * the injection (the driver reads its behavior lazily per execute call). */
  failWith?: {
    error: { code: string; message: string };
    retryable: boolean;
    dispatchState: "not_dispatched" | "accepted" | "unknown";
  } | null;
  hangUntilCancel?: boolean;
  pauseAfterEvents?: number;
}

export interface DriverCounters {
  prewarmCount: number;
  executeCount: number;
  closeCount: number;
  cancelCount: number;
}

const TEST_API = "/api/v1/__test__";

async function controlPost<T>(page: Page, path: string, data?: unknown): Promise<T> {
  const response = await page.request.post(
    `${TEST_API}${path}`,
    data === undefined ? {} : { data },
  );
  expect(response.ok(), `POST ${path} failed with ${response.status()}`).toBeTruthy();
  const envelope = (await response.json()) as { ok: boolean; data: T };
  expect(envelope.ok, `POST ${path} returned an error envelope`).toBeTruthy();
  return envelope.data;
}

/** Close all scopes, clear executions, restore driver/installation defaults. */
export async function resetDriverState(page: Page): Promise<void> {
  await controlPost(page, "/reset");
}

/** Merge behavior overrides for one Participant's driver (read lazily per
 * driver call, so setting it any time before the round starts is enough). */
export async function setDriverBehavior(
  page: Page,
  participantId: string,
  behavior: DriverBehaviorInput,
): Promise<void> {
  await controlPost(page, "/driver", { participantId, behavior });
}

/** V1.1 真实档：按 driverId 设置默认驱动行为。真实档测试的 scope participantId
 * 由前端动态生成，e2e 无法预知，故在创建前按 driverId 配置（hangUntilCancel 等），
 * 新建的 rig 会继承该默认行为。 */
export async function setDriverDefaultBehavior(
  page: Page,
  driverId: "claude-stream-json" | "codex-app-server" | "kimi-stream-json",
  behavior: DriverBehaviorInput,
): Promise<void> {
  await controlPost(page, "/driver-default", { driverId, behavior });
}

/** 读测试运行期间的所有 ACK 记录（executionId/finalSeq/disposition/ackState）。 */
export async function ackRecords(page: Page): Promise<
  Array<{
    executionId: string;
    finalSeq: number;
    disposition: "committed" | "discarded";
    ackState: string;
  }>
> {
  const response = await page.request.get(`${TEST_API}/acks`);
  expect(response.ok(), "GET /acks failed").toBeTruthy();
  const envelope = (await response.json()) as {
    ok: boolean;
    data: {
      acks: Array<{
        executionId: string;
        finalSeq: number;
        disposition: "committed" | "discarded";
        ackState: string;
      }>;
    };
  };
  return envelope.data.acks;
}

/** 读 Host diagnostics（scope/process/execution/SSE 计数），用于真实档泄漏断言。 */
export async function hostDiagnostics(page: Page): Promise<{
  activeScopes: number;
  liveDriverProcesses: number;
  runningExecutions: number;
  eventConnections: number;
}> {
  const response = await page.request.get("/api/v1/diagnostics");
  expect(response.ok(), "GET /diagnostics failed").toBeTruthy();
  const envelope = (await response.json()) as {
    ok: boolean;
    data: {
      scopes: {
        activeScopes: number;
        liveDriverProcesses: number;
        runningExecutions: number;
        eventConnections: number;
      };
    };
  };
  return envelope.data.scopes;
}

/** Per-participant driver counters keyed by participantId. */
export async function driverCounters(page: Page): Promise<Record<string, DriverCounters>> {
  const response = await page.request.get(`${TEST_API}/counters`);
  expect(response.ok(), "GET /counters failed").toBeTruthy();
  const envelope = (await response.json()) as {
    ok: boolean;
    data: { counters: Record<string, DriverCounters> };
  };
  return envelope.data.counters;
}

/** Cleanly end all open SSE event streams; the app reconnects via afterSeq. */
export async function dropEventStreams(page: Page): Promise<number> {
  const { dropped } = await controlPost<{ dropped: number }>(page, "/drop-events");
  return dropped;
}

/** Release all held fake drivers (pauseAfterEvents holds). */
export async function resumeDrivers(page: Page): Promise<void> {
  await controlPost(page, "/resume");
}

/** Flip a fake installation's trust state (e.g. "changed" after an upgrade). */
export async function setInstallationState(
  page: Page,
  installationId: string,
  state: "discovering" | "discovered" | "trusted" | "changed" | "not_found" | "invalid",
): Promise<void> {
  await controlPost(page, "/installation", { installationId, state });
}

// ---------------------------------------------------------------------------
// Browser context factory: clean storage (fresh IndexedDB) per test
// ---------------------------------------------------------------------------

export async function freshPage(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

// ---------------------------------------------------------------------------
// Settings UI flows
// ---------------------------------------------------------------------------

export interface CreateProfileInput {
  name: string;
  driverId: "claude-stream-json" | "codex-app-server" | "kimi-stream-json";
  /** installationId value, e.g. "claude-e2e-fake01". */
  installationId: string;
  /** claude-stream-json route; defaults to the form's ant-glm5.2. cfuse is the
   * GLM-5.2 backend route. */
  route?: "ant-glm5.2" | "moonshot" | "deepseek" | "cfuse";
}

export async function createProfile(page: Page, input: CreateProfileInput): Promise<void> {
  await page.getByRole("button", { name: "+ 新建 Profile" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "名称", exact: true }).fill(input.name);
  if (input.driverId !== "claude-stream-json") {
    await dialog
      .getByRole("combobox", { name: "Runtime Driver（内置闭集）", exact: true })
      .selectOption(input.driverId);
  }
  // The Installation select renders only once trusted installations loaded.
  await dialog
    .getByRole("combobox", { name: "Runtime Installation", exact: true })
    .selectOption(input.installationId);
  if (input.route) {
    await dialog
      .getByRole("combobox", { name: "Route（claude-stream-json 选项）", exact: true })
      .selectOption(input.route);
  }
  await dialog.getByRole("button", { name: "创建 Profile" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(input.name, { exact: true })).toBeVisible();
}

export interface CreateAgentInput {
  name: string;
  persona: string;
  /** Profile display name to bind. */
  profileName: string;
  /** canonical modelId from the Driver catalog, e.g. "e2e-claude-model". */
  modelId: string;
  color: string;
}

export async function createAgent(page: Page, input: CreateAgentInput): Promise<void> {
  await page.getByRole("button", { name: "+ 新建 Agent" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "名称", exact: true }).fill(input.name);
  await dialog
    .getByRole("textbox", { name: "人格设定（personaPrompt）", exact: true })
    .fill(input.persona);
  await dialog
    .getByRole("combobox", { name: "Execution Profile", exact: true })
    .selectOption({ label: input.profileName });
  // The modelId select replaces a loading hint once the Driver catalog arrives.
  const modelSelect = dialog.getByRole("combobox", {
    name: "modelId（Driver 闭集 canonical 目录）",
    exact: true,
  });
  await modelSelect.selectOption(input.modelId);
  // V1.1 色板：颜色由 swatch 网格选取（无文本输入）。每个 swatch 的 aria-label
  // 为 `${name} ${hex}`，pattern 匹配该 hex。
  const hex = input.color.toLowerCase();
  const swatch = dialog.getByRole("button", { name: new RegExp(hex) });
  await swatch.click();
  await dialog.getByRole("button", { name: "创建 Agent" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(input.name, { exact: true }).first()).toBeVisible();
}

// ---------------------------------------------------------------------------
// New Room UI flow (checkbox order = speaking order)
// ---------------------------------------------------------------------------

export interface CreateRoomInput {
  topic: string;
  agentNames: string[];
  facilitatorName?: string;
  /** S4: optional 最大轮次 textbox (留空=不限). */
  maxRounds?: number;
}

/** Creates the room and lands on its page; returns the roomId from the URL. */
export async function createRoom(page: Page, input: CreateRoomInput): Promise<string> {
  await page.goto("/rooms/new");
  await page.getByRole("textbox", { name: "话题", exact: true }).fill(input.topic);
  for (const name of input.agentNames) {
    await page.locator("label", { hasText: name }).getByRole("checkbox").click();
  }
  if (input.facilitatorName) {
    await page
      .getByRole("combobox", { name: "Facilitator（负责生成每轮总结）", exact: true })
      .selectOption({ label: input.facilitatorName });
  }
  if (input.maxRounds !== undefined) {
    await page
      .getByRole("textbox", { name: "最大轮次（可选，留空=不限）", exact: true })
      .fill(String(input.maxRounds));
  }
  await page.getByRole("button", { name: "创建并进入" }).click();
  await page.waitForURL(/\/rooms\/[0-9a-fA-F-]+/);
  await expect(page.getByRole("heading", { name: input.topic })).toBeVisible();
  return page.url().split("/rooms/")[1] as string;
}

// ---------------------------------------------------------------------------
// Room page locators and flows
// ---------------------------------------------------------------------------

/** First round CTA is 发起讨论; later rounds use 开始新一轮. */
export async function startRound(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^(发起讨论|开始新一轮)$/ }).click();
}

/** S5 release-runtime: the RoomHeader self-wired 释放运行时 button (visible
 * only while the room is warm). No confirmation modal — the next startRound
 * cold-builds via the accepted ensureScope path. */
export async function releaseRuntimeViaButton(page: Page): Promise<void> {
  await page.getByRole("button", { name: "释放运行时" }).click();
}

export function roundSection(page: Page, roundNumber: number): Locator {
  return page.getByTestId(`round-section-${roundNumber}`);
}

export function roundPhaseLocator(page: Page, roundNumber: number): Locator {
  return roundSection(page, roundNumber).locator("summary");
}

/** Historical rounds default collapsed; expand one via its summary header. */
export async function expandRound(page: Page, roundNumber: number): Promise<void> {
  const section = roundSection(page, roundNumber);
  if ((await section.getAttribute("open")) === null) {
    await section.locator("summary").click();
  }
}

export function activePreview(page: Page): Locator {
  return page.getByTestId("active-preview");
}

export function pausedPanel(page: Page): Locator {
  return page.getByTestId("paused-panel");
}

/** Expand the committed Round Summary block and return its content locator. */
export async function summaryContent(page: Page, roundNumber: number): Promise<Locator> {
  const region = roundSection(page, roundNumber).getByRole("region", { name: "本轮总结" });
  await expect(region).toBeVisible();
  await region.getByRole("button", { name: /展开本轮总结/ }).click();
  return region;
}

/** End a paused Round: 终止本轮（不生成总结）behind its confirm modal. */
export async function abortPausedRound(page: Page): Promise<void> {
  await pausedPanel(page).getByRole("button", { name: "终止本轮（不生成总结）" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认终止" }).click();
}

// ---------------------------------------------------------------------------
// S3 recovery actions (PausedPanel branches): retry / skip / rotate. Each
// drives the Chinese UI affordance exactly as a user would; the recovery
// intents are self-wired in PausedPanel, so these are pure button clicks.
// ---------------------------------------------------------------------------

/** Retry the paused-at Participant: 重试该 Participant (label carries the
 * already-retried count once > 0). No confirmation modal. */
export async function retryPausedParticipant(page: Page): Promise<void> {
  await pausedPanel(page)
    .getByRole("button", { name: /^重试该 Participant/ })
    .click();
}

/** Skip the paused-at Participant: 跳过并继续 → confirm modal → 确认跳过. */
export async function skipPausedParticipant(page: Page): Promise<void> {
  await pausedPanel(page).getByRole("button", { name: "跳过并继续" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认跳过" }).click();
}

/** Rebuild the execution environment (rotation): 重建执行环境（轮转）, the
 * needs_rebase branch's primary action. No confirmation modal. */
export async function rotatePausedScope(page: Page): Promise<void> {
  await pausedPanel(page)
    .getByRole("button", { name: /^重建执行环境（轮转）/ })
    .click();
}

// ---------------------------------------------------------------------------
// IndexedDB assertion-only reads (raw IDB; the app connection stays open)
// ---------------------------------------------------------------------------

export interface ParticipantRow {
  id: string;
  roomId: string;
  agentId: string;
  modelId: string;
  state: "active" | "ended";
}

export interface MessageRow {
  id: string;
  roomId: string;
  roundId: string;
  role: "user" | "participant";
  participantId: string | null;
  content: string;
  sourceExecutionId: string | null;
  createdAt: string;
}

export interface SummaryRow {
  id: string;
  roomId: string;
  roundId: string;
  content: string;
  sourceExecutionId: string;
}

export interface RoundRow {
  id: string;
  roomId: string;
  roundNumber: number;
  phase: string;
  pauseReason: { code: string; participantId?: string } | null;
}

export interface ExecutionRow {
  executionId: string;
  roomId: string;
  roundId: string;
  participantId: string;
  resultKind: "message" | "summary" | "focus" | "report";
  state: string;
  runtimeOutcome: string | null;
  /** S3: the fresh execution links back to the terminal one it replaced. */
  retryOfExecutionId: string | null;
  error: { code: string; message: string } | null;
}

/** S4: one committed row in the reports store. */
export interface ReportRow {
  id: string;
  roomId: string;
  content: string;
  sourceExecutionId: string;
  createdAt: string;
}

/** S4: the committed report-view card (data-testid="report-view"). */
export function reportView(page: Page): Locator {
  return page.getByTestId("report-view");
}

/** S4: click 总结并结束 then confirm via the modal's 确认总结 button. Requires
 * a completed round and controller; the concludeRoom intent dispatches the
 * facilitator report on the same persist→ACK pipeline. */
export async function concludeRoomViaButton(page: Page): Promise<void> {
  await page.getByRole("button", { name: "总结并结束" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认总结" }).click();
}

export async function readStore<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (storeName) => {
    const DB_NAME = "councilkit-runtime-v1";
    const existing = await indexedDB.databases();
    if (!existing.some((db) => db.name === DB_NAME)) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("indexedDB open blocked"));
    });
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result as unknown[]);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }, store) as Promise<T[]>;
}

export async function roomParticipants(page: Page, roomId: string): Promise<ParticipantRow[]> {
  const rows = await readStore<ParticipantRow>(page, "participants");
  return rows.filter((row) => row.roomId === roomId && row.state === "active");
}

export async function roomMessages(page: Page, roomId: string): Promise<MessageRow[]> {
  const rows = await readStore<MessageRow>(page, "messages");
  return rows.filter((row) => row.roomId === roomId);
}

export async function roomSummaries(page: Page, roomId: string): Promise<SummaryRow[]> {
  const rows = await readStore<SummaryRow>(page, "summaries");
  return rows.filter((row) => row.roomId === roomId);
}

export async function roomRounds(page: Page, roomId: string): Promise<RoundRow[]> {
  const rows = await readStore<RoundRow>(page, "rounds");
  return rows.filter((row) => row.roomId === roomId);
}

export async function roomExecutions(page: Page, roomId: string): Promise<ExecutionRow[]> {
  const rows = await readStore<ExecutionRow>(page, "modelExecutions");
  return rows.filter((row) => row.roomId === roomId);
}

/** S4: committed decision reports for a room ( Dexie `reports` store). */
export async function roomReports(page: Page, roomId: string): Promise<ReportRow[]> {
  const rows = await readStore<ReportRow>(page, "reports");
  return rows.filter((row) => row.roomId === roomId);
}
