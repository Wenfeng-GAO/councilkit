/**
 * Playwright E2E helpers for the Scope Controller / observer scenarios (U6,
 * plan §576-579). Both room pages share ONE browser context — one IndexedDB
 * and one Web Lock manager — so the second page can only observe. IndexedDB
 * access stays assertion-only (readStore from ./helpers); Host driver state
 * is scripted only through the __test__ control namespace.
 */
import { type Locator, type Page, expect } from "@playwright/test";
import {
  createAgent,
  createProfile,
  createRoom,
  readStore,
  roomParticipants,
  roundSection,
} from "./helpers";

// ---------------------------------------------------------------------------
// Acceptance fixture (same shape as tests/e2e/runtime-host.spec.ts)
// ---------------------------------------------------------------------------

const CLAUDE_PROFILE = "GLM 5.2 主用";
const CODEX_PROFILE = "Codex 主用";
const CLAUDE_AGENT = "蓝方评审";
const CODEX_AGENT = "红方助手";
const CLAUDE_MODEL = "e2e-claude-model";
const CODEX_MODEL = "e2e-codex-model";
const CLAUDE_INSTALLATION = "claude-e2e-fake01";
const CODEX_INSTALLATION = "codex-e2e-fake001";

export interface TwoAgentRoom {
  roomId: string;
  claudePid: string;
  codexPid: string;
}

/** Settings → 2 Profiles → 2 Agents → Room (claude speaks first, claude facilitates). */
export async function setupRoomWithTwoAgents(page: Page, topic: string): Promise<TwoAgentRoom> {
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

// ---------------------------------------------------------------------------
// Control banner + observer control surface
// ---------------------------------------------------------------------------

export type BannerState =
  | "acquiring"
  | "controlling"
  | "observing"
  | "lost-control"
  | "takeover_failed";

/** Exact label copy from src/components/room/ControlBanner.tsx. */
export const CONTROL_LABELS: Record<BannerState, string> = {
  acquiring: "正在取得控制权…",
  controlling: "当前页面拥有控制权",
  observing: "只读观察中（另一页面正在控制）",
  "lost-control": "控制权已丢失（已被其他页面接管）",
  takeover_failed: "接管失败（Host 拒绝了控制转移）",
};

export function controlBanner(page: Page): Locator {
  return page.getByTestId("control-banner");
}

/** The banner exposes the state machine value AND its text label (never color-only). */
export async function expectControlState(
  page: Page,
  state: BannerState,
  timeout = 10_000,
): Promise<void> {
  const banner = controlBanner(page);
  await expect(banner).toHaveAttribute("data-control-state", state, { timeout });
  await expect(banner).toContainText(CONTROL_LABELS[state]);
}

/** Observer pages: every mutation control is disabled or absent, with helper copy. */
export async function expectObserverControlsDisabled(page: Page): Promise<void> {
  const start = page.getByRole("button", { name: /^(发起讨论|开始新一轮)$/ });
  await expect(start).toBeVisible();
  await expect(start).toBeDisabled();
  // Round-scoped mutations are not rendered at all without an active round.
  await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "暂停", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "继续", exact: true })).toHaveCount(0);
  const input = page.getByRole("textbox", { name: "用户发言" });
  await expect(input).toBeDisabled();
  await expect(page.getByText("只读观察中，无法发言（另一页面正在控制）")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送" })).toBeDisabled();
}

/** Wait for the phase pill inside a round section's summary header. */
export async function waitRoundPhase(
  page: Page,
  roundNumber: number,
  phaseLabel: string,
): Promise<void> {
  await expect(
    roundSection(page, roundNumber).locator("summary").getByText(phaseLabel, { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// Host-side reads and fencing probes (via the page's own browser context)
// ---------------------------------------------------------------------------

export interface RuntimeBindingRow {
  id: string;
  roomId: string;
  state: string;
  executionScopeId: string | null;
  controllerId: string | null;
  leaseEpoch: number | null;
}

/** Assertion-only read of the Room's ACTIVE runtime binding (shared IndexedDB). */
export async function activeBinding(page: Page, roomId: string): Promise<RuntimeBindingRow> {
  const rows = await readStore<RuntimeBindingRow>(page, "runtimeBindings");
  const binding = rows.find((row) => row.roomId === roomId && row.state === "active");
  expect(binding, "an active runtime binding should exist").toBeTruthy();
  return binding as RuntimeBindingRow;
}

/** Host-side leaseEpoch of one Scope (session-authed GET via the page context). */
export async function scopeLeaseEpoch(page: Page, scopeId: string): Promise<number> {
  const response = await page.request.get(`/api/v1/scopes/${scopeId}`);
  expect(response.ok(), `GET /api/v1/scopes/${scopeId} failed`).toBeTruthy();
  const envelope = (await response.json()) as { ok: boolean; data: { leaseEpoch: number } };
  return envelope.data.leaseEpoch;
}

export interface StaleExecuteResult {
  status: number;
  code: string | null;
}

/**
 * A Host mutation attempted from the page's OWN browser context: same-origin
 * fetch (session cookie + Origin header ride along) carrying the page's CSRF
 * capability and a STALE controller pair. The body is schema-valid, so the
 * request reaches the Host's controller fencing and must be rejected with 409
 * STALE_CONTROLLER — proving the fence itself, not just the UI, blocks the
 * observer page.
 */
export async function postStaleExecute(
  page: Page,
  input: { scopeId: string; participantId: string },
): Promise<StaleExecuteResult> {
  return page.evaluate(async ({ scopeId, participantId }) => {
    const csrf = document.querySelector('meta[name="councilkit-csrf"]')?.getAttribute("content");
    const response = await fetch(`/api/v1/scopes/${scopeId}/executions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-councilkit-csrf": csrf ?? "",
      },
      body: JSON.stringify({
        controllerId: "ctrl-stale-observer",
        leaseEpoch: 999,
        executionId: "exec-stale-observer-1",
        participantId,
        snapshot: {
          digestVersion: 1,
          roomContext: { contextRevision: 0, contextDigest: "stale", items: [] },
          participant: { participantId, participantSnapshotDigest: "stale" },
          instruction: { kind: "message", instructionDigest: "stale", text: "stale" },
        },
      }),
    });
    const envelope = (await response.json()) as { error?: { code?: string } };
    return { status: response.status, code: envelope.error?.code ?? null };
  }, input);
}

/** Hold matching requests for `holdMs`, then let them through (pending-label windows). */
export async function delayRoute(page: Page, pattern: string, holdMs: number): Promise<void> {
  await page.route(pattern, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    await route.continue();
  });
}

/**
 * Simulate the user activating this tab. Headless Chromium keeps every page's
 * visibilityState "visible" and never fires visibilitychange, so the app's
 * refetch-on-window-focus (react-query default, the observer page's committed
 * update channel) needs the event dispatched explicitly — exactly what a real
 * tab activation delivers in a headed browser.
 */
export async function simulateTabFocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("visibilitychange"));
  });
}
