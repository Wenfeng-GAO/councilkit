/**
 * Playwright helpers for repair-observability E2E.
 * Business observation responses must come from the real Host routes;
 * only network-fault cases may route.abort / route.delay.
 */
import { type APIResponse, type Locator, type Page, expect } from "@playwright/test";
import {
  GOAL,
  ORIGIN,
  PARENT_RUN_ID,
  SECRET_SENTINEL,
  TEST_API,
  type FixtureName,
} from "./constants";

export interface ResetResult {
  flushed: boolean;
  seq: number;
  home: string;
  runId: string;
  fixture: string;
  logBytes: number | null;
  operationCount: number | null;
  taskDirRound2: string;
  sourceReviewId: string;
  childReviewId: string;
  serverTime: string;
}

async function controlPost<T>(page: Page, path: string, data?: unknown): Promise<T> {
  const response = await page.request.post(`${TEST_API}${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `POST ${TEST_API}${path} → ${response.status()}`).toBeTruthy();
  const envelope = (await response.json()) as { ok: boolean; data: T };
  expect(envelope.ok).toBeTruthy();
  return envelope.data;
}

async function controlGet<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${TEST_API}${path}`);
  expect(response.ok(), `GET ${TEST_API}${path} → ${response.status()}`).toBeTruthy();
  const envelope = (await response.json()) as { ok: boolean; data: T };
  expect(envelope.ok).toBeTruthy();
  return envelope.data;
}

export async function resetFixture(page: Page, fixture: FixtureName): Promise<ResetResult> {
  return controlPost<ResetResult>(page, "/reset", { fixture });
}

export async function appendLines(
  page: Page,
  lines: Array<Record<string, unknown>>,
  taskId?: string,
): Promise<{ flushed: boolean; seq: number; bytesWritten: number; serverTime: string }> {
  return controlPost(page, "/append", { lines, taskId });
}

export async function appendRaw(
  page: Page,
  raw: string,
  taskId?: string,
): Promise<{ flushed: boolean; seq: number; bytesWritten: number }> {
  return controlPost(page, "/append", { raw, taskId });
}

export async function appendHalfLine(
  page: Page,
  halfLine: string,
  completeHalf = false,
): Promise<{ flushed: boolean; seq: number }> {
  return controlPost(page, "/append", { halfLine, completeHalf });
}

export async function advanceClock(
  page: Page,
  input: { ms?: number; to?: string; useRealClock?: boolean },
): Promise<{ serverTime: string }> {
  return controlPost(page, "/advance", input);
}

export async function rotateSource(
  page: Page,
  input: { generation?: string; seedLine?: Record<string, unknown>; taskId?: string } = {},
): Promise<{ generation: string; seq: number }> {
  return controlPost(page, "/rotate", input);
}

export async function finishCase(
  page: Page,
  input: Record<string, unknown>,
): Promise<{ flushed: boolean; seq: number }> {
  return controlPost(page, "/finish", input);
}

export async function launcherCalls(page: Page): Promise<{
  launches: Array<{ action: string; runId: string }>;
  stops: Array<{ action: string; runId: string }>;
  all: Array<{ action: string; runId: string }>;
}> {
  return controlGet(page, "/launcher");
}

export async function authoritySnapshot(page: Page): Promise<{
  baseline: Record<string, string | null>;
  current: Record<string, string | null>;
  unchanged: boolean;
}> {
  return controlGet(page, "/authority");
}

export async function envSentinel(page: Page): Promise<{
  testPort: number;
  hostHeader: string;
  councilkitHome: string | null;
  userHomeExists: boolean;
  userHomeHash: string | null;
  caseHome: string | null;
  pid: number;
}> {
  return controlGet(page, "/env-sentinel");
}

export async function chmodSource(
  page: Page,
  relativePath: string,
  mode: number,
): Promise<void> {
  await controlPost(page, "/chmod-source", { relativePath, mode });
}

export async function seedLine(
  page: Page,
  summary: string,
  callId?: string,
): Promise<{ flushed: boolean; seq: number; serverTime: string }> {
  return controlPost(page, "/seed-line", { summary, callId });
}

/** Allow-list network to this origin only. */
export async function installOriginAllowlist(page: Page): Promise<string[]> {
  const blocked: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN) || url.startsWith("data:") || url.startsWith("blob:")) {
      await route.continue();
      return;
    }
    blocked.push(url);
    await route.abort();
  });
  return blocked;
}

export async function openRepairWorkspace(
  page: Page,
  runId: string = PARENT_RUN_ID,
): Promise<void> {
  await page.goto(`/reports/${runId}`);
  await expect(page.getByTestId("repair-workspace")).toBeVisible({ timeout: 20_000 });
}

export function workspace(page: Page): Locator {
  return page.getByTestId("repair-workspace");
}

export async function expectGoalVisible(page: Page): Promise<void> {
  const goal = page.getByTestId("repair-goal");
  await expect(goal).toBeVisible();
  await expect(goal).toContainText(GOAL);
  await expect(goal).not.toHaveText(/^\s*https?:\/\//);
}

export async function expectChinese(page: Page, text: string): Promise<void> {
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
}

export async function waitForObservation(
  page: Page,
  predicate: (body: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const response = await page.waitForResponse((res) => {
    if (!res.url().includes("/repair/observation") || res.request().method() !== "GET") {
      return false;
    }
    if (!res.ok()) return false;
    return true;
  });
  const envelope = (await response.json()) as { ok: boolean; data: Record<string, unknown> };
  // Poll via subsequent requests if needed
  if (predicate(envelope.data)) return envelope.data;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const next = await page.request.get(
      `/api/v1/cli-runs/${PARENT_RUN_ID}/repair/observation?round=current&limit=200`,
    );
    if (next.ok()) {
      const body = (await next.json()) as { ok: boolean; data: Record<string, unknown> };
      if (body.ok && predicate(body.data)) return body.data;
    }
    await page.waitForTimeout(200);
  }
  throw new Error("observation predicate not satisfied");
}

export async function fetchObservation(
  page: Page,
  query: string = "round=current&limit=200",
): Promise<{ status: number; data: Record<string, unknown> | null; raw: unknown }> {
  const res = await page.request.get(`/api/v1/cli-runs/${PARENT_RUN_ID}/repair/observation?${query}`);
  const json = (await res.json()) as { ok?: boolean; data?: Record<string, unknown> };
  return { status: res.status(), data: json.data ?? null, raw: json };
}

export async function firstVisibleEventId(page: Page): Promise<{
  eventId: string;
  top: number;
} | null> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("[data-testid^='repair-activity-row-']"));
    const list = document.querySelector("[data-testid='repair-activity-list']");
    if (!list) return null;
    const listRect = list.getBoundingClientRect();
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > listRect.top && rect.top < listRect.bottom) {
        const testId = row.getAttribute("data-testid") ?? "";
        const eventId = testId.replace("repair-activity-row-", "");
        return { eventId, top: rect.top - listRect.top };
      }
    }
    return null;
  });
}

export async function expectNoSecretInResponse(res: APIResponse): Promise<void> {
  const text = await res.text();
  expect(text).not.toContain(SECRET_SENTINEL);
}

export async function expectNoSecretInDom(page: Page): Promise<void> {
  const content = await page.content();
  expect(content).not.toContain(SECRET_SENTINEL);
}

export async function getCsrf(page: Page): Promise<string> {
  const token = await page.locator('meta[name="councilkit-csrf"]').getAttribute("content");
  expect(token, "csrf meta").toBeTruthy();
  return token as string;
}

export async function postRepairStop(
  page: Page,
  runId: string = PARENT_RUN_ID,
): Promise<APIResponse> {
  const csrf = await getCsrf(page);
  return page.request.post(`/api/v1/cli-runs/${runId}/repair/stop`, {
    headers: { "x-councilkit-csrf": csrf },
    data: {},
  });
}

export async function postRepairResume(
  page: Page,
  runId: string = PARENT_RUN_ID,
): Promise<APIResponse> {
  const csrf = await getCsrf(page);
  return page.request.post(`/api/v1/cli-runs/${runId}/repair/resume`, {
    headers: { "x-councilkit-csrf": csrf },
    data: {},
  });
}

/** Block only observation GETs (E23/E24). Other Host routes stay reachable. */
export async function blockObservation(page: Page): Promise<() => Promise<void>> {
  let blocked = true;
  await page.route("**/api/v1/cli-runs/*/repair/observation**", async (route) => {
    if (blocked) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  return async () => {
    blocked = false;
  };
}

export async function delayObservation(
  page: Page,
  delayMs: number,
  match?: (url: string) => boolean,
): Promise<() => void> {
  const waiters: Array<() => void> = [];
  let releaseAll: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  await page.route("**/api/v1/cli-runs/*/repair/observation**", async (route) => {
    const url = route.request().url();
    if (match && !match(url)) {
      await route.continue();
      return;
    }
    await Promise.race([
      gate,
      new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, delayMs);
      }),
    ]);
    await route.continue();
  });
  return () => {
    releaseAll?.();
    for (const w of waiters) w();
  };
}
