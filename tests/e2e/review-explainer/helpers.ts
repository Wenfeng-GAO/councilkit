import { type Page, expect } from "@playwright/test";
import { FINDING, ROUTES, RUN_ID, UI } from "../../review-explainer/contract";
import { missing } from "../../review-explainer/load-feature";
import { ORIGIN, TEST_API } from "./constants";

export async function installOriginAllowlist(page: Page): Promise<string[]> {
  const blocked: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (new URL(url).origin === ORIGIN || url.startsWith("data:") || url.startsWith("blob:")) {
      await route.continue();
      return;
    }
    blocked.push(url);
    await route.abort();
  });
  return blocked;
}

async function controlGet<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${TEST_API}${path}`);
  expect(response.ok(), `GET ${TEST_API}${path} → ${response.status()}`).toBeTruthy();
  const envelope = (await response.json()) as { ok: boolean; data: T };
  expect(envelope.ok).toBeTruthy();
  return envelope.data;
}

export async function controlPost<T>(page: Page, path: string, data?: unknown): Promise<T> {
  const response = await page.request.post(`${TEST_API}${path}`, {
    timeout: 45_000,
    headers: { "x-councilkit-csrf": await getCsrf(page), Origin: ORIGIN },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), `POST ${TEST_API}${path} → ${response.status()}`).toBeTruthy();
  const envelope = (await response.json()) as { ok: boolean; data: T };
  expect(envelope.ok).toBeTruthy();
  return envelope.data;
}

export interface ResetResult {
  home: string;
  runId: string;
  pid: number;
  headSha: string;
  baseSha: string;
  diffHash: string;
  busyContextLine: number;
  busyNewLine: number;
  staleNewLine: number;
  dupNewLine: number;
  deletedOldLine: number;
}

export async function resetCase(page: Page): Promise<ResetResult> {
  await page.goto("/");
  return controlPost<ResetResult>(page, "/reset");
}

export async function envSentinel(page: Page): Promise<{
  testPort: number;
  hostHeader: string;
  councilkitHome: string | null;
  pid: number;
  userHomeHash: string | null;
}> {
  return controlGet(page, "/env");
}

export async function diskSnapshot(page: Page): Promise<{
  decisions: unknown;
  explanations: unknown;
  pid: number;
}> {
  return controlGet(page, "/disk");
}

export async function restartHost(page: Page): Promise<void> {
  const before = await envSentinel(page);
  await controlPost(page, "/restart");
  const deadline = Date.now() + 20_000;
  let lastPid = before.pid;
  while (Date.now() < deadline) {
    try {
      const health = await page.request.get("/api/v1/health");
      if (health.ok()) {
        await page.goto("/");
        const env = await envSentinel(page);
        lastPid = env.pid;
        if (env.pid !== before.pid) {
          expect(env.councilkitHome).toBe(before.councilkitHome);
          return;
        }
      }
    } catch {
      // worker is down mid-restart
    }
    await page.waitForTimeout(150);
  }
  throw new Error(
    `INFRA_FAILURE: Host process did not restart (pid stayed ${lastPid}). page.reload is not a restart.`,
  );
}

export async function requireExplainer(page: Page) {
  const root = page.getByTestId(UI.root);
  if ((await root.count()) === 0) {
    missing("review-explainer UI", "report page did not mount [data-testid=review-explainer]");
  }
  return root;
}

export async function openReport(page: Page, runId: string = RUN_ID): Promise<void> {
  await page.goto(`/reports/${runId}`);
  await expect(page.locator(".ck-wb")).toBeVisible({ timeout: 20_000 });
}

export async function openExplainer(page: Page, runId: string = RUN_ID): Promise<void> {
  await openReport(page, runId);
  const entry = page.getByRole("button", { name: "理解评审", exact: true });
  if ((await entry.count()) === 0)
    missing("review-explainer entry", "理解评审 button is not available");
  await entry.click();
  await expect(page.getByTestId(UI.root)).toBeVisible();
  await expect(page.getByTestId(UI.identity)).toContainText(/[0-9a-f]{7,40}/);
}

export async function getCsrf(page: Page): Promise<string> {
  const token = await page.locator('meta[name="councilkit-csrf"]').getAttribute("content");
  expect(token, "csrf meta").toBeTruthy();
  return token as string;
}

export async function postDecision(
  page: Page,
  input: { findingId: string; decision: string; expectedRevision: number; runId?: string },
): Promise<{ status: number; body: unknown }> {
  const csrf = await getCsrf(page);
  const res = await page.request.post(ROUTES.decisions(input.runId ?? RUN_ID), {
    headers: { "x-councilkit-csrf": csrf, Origin: ORIGIN, "content-type": "application/json" },
    data: {
      findingId: input.findingId,
      decision: input.decision,
      expectedRevision: input.expectedRevision,
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status(), body };
}

export { FINDING, RUN_ID, UI };
