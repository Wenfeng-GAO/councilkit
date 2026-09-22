import { type Page, expect, test } from "@playwright/test";
import {
  ORIGIN,
  PARENT_RUN_ID,
  PATH_SENTINEL,
  SECRET_SENTINEL,
  XSS_PAYLOAD,
} from "./constants";
import {
  authoritySnapshot,
  expectNoSecretInDom,
  fetchObservation,
  getCsrf,
  installOriginAllowlist,
  launcherCalls,
  openRepairWorkspace,
  postRepairStop,
  resetFixture,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await installOriginAllowlist(page);
});

async function boot(page: Page, fixture: Parameters<typeof resetFixture>[1]) {
  await page.goto("/");
  await resetFixture(page, fixture);
}

test("[E46] @p0 server-side redaction of secrets", async ({ page }) => {
  await boot(page, "F8-secret");
  const resPromise = page.waitForResponse(
    (r) => r.url().includes("/repair/observation") && r.request().method() === "GET",
  );
  await openRepairWorkspace(page);
  const res = await resPromise;
  const text = await res.text();
  expect(text).not.toContain(SECRET_SENTINEL);
  expect(text).toMatch(/REDACTED|\[已脱敏\]|redacted/i);
  await expectNoSecretInDom(page);
  const row = page.locator("[data-testid^='repair-activity-row-']").first();
  await row.click();
  await page.getByTestId("repair-copy").click();
  const clip = await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  });
  expect(clip).not.toContain(SECRET_SENTINEL);
});

test("[E47] @p0 hidden reasoning filtered from observation API", async ({ page }) => {
  await boot(page, "F8-private");
  await openRepairWorkspace(page);
  const obs = await fetchObservation(page);
  const raw = JSON.stringify(obs.raw);
  expect(raw).not.toContain("hidden reasoning");
  expect(raw).not.toContain(SECRET_SENTINEL);
  await expect(page.getByTestId("repair-activity-list")).toContainText("公开事实");
  await expect(page.getByText("hidden reasoning")).toHaveCount(0);
});

test("[E48] @p0 untrusted content rendered as text", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("evil.example")) requests.push(req.url());
  });
  await boot(page, "F8-xss");
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-activity-list")).toContainText("<script>");
  const fired = await page.evaluate(() => (window as unknown as { __xss_fired?: number }).__xss_fired);
  expect(fired).toBeUndefined();
  expect(requests).toEqual([]);
  expect(XSS_PAYLOAD.length).toBeGreaterThan(10);
});

test("[E49] @p0 path traversal and sibling isolation", async ({ page }) => {
  await boot(page, "F8-path");
  await openRepairWorkspace(page);
  // Attempt opaque/detailRef traversal via API
  const csrf = await getCsrf(page);
  const probes = [
    `/api/v1/cli-runs/${PARENT_RUN_ID}/repair/events/${encodeURIComponent("../../sibling-run-secret.txt")}`,
    `/api/v1/cli-runs/${PARENT_RUN_ID}/repair/events/${encodeURIComponent("..%2F..%2Fsentinel-secret.txt")}`,
  ];
  for (const url of probes) {
    const res = await page.request.get(url, { headers: { "x-councilkit-csrf": csrf } });
    expect([400, 403, 404, 501]).toContain(res.status());
    const body = await res.text();
    expect(body).not.toContain(PATH_SENTINEL);
  }
  const content = await page.content();
  expect(content).not.toContain(PATH_SENTINEL);
});

test("[E50] @p0 auth and request guard on test port", async ({ page, request }) => {
  await boot(page, "F1");
  // No session
  const bare = await request.get(`${ORIGIN}/api/v1/cli-runs/${PARENT_RUN_ID}/repair/observation?round=current`, {
    headers: { Host: "127.0.0.1:43837", Origin: ORIGIN },
  });
  expect([401, 403]).toContain(bare.status());

  await openRepairWorkspace(page);
  // No CSRF on stop
  const stopNoCsrf = await page.request.post(`/api/v1/cli-runs/${PARENT_RUN_ID}/repair/stop`, {
    data: {},
  });
  expect([403, 401]).toContain(stopNoCsrf.status());

  // Wrong Origin
  const csrf = await getCsrf(page);
  const badOrigin = await page.request.post(`/api/v1/cli-runs/${PARENT_RUN_ID}/repair/stop`, {
    headers: {
      "x-councilkit-csrf": csrf,
      Origin: "http://evil.example",
    },
    data: {},
  });
  expect([403, 401]).toContain(badOrigin.status());
});

test("[E58] @p0 observation has no execution side effects", async ({ page }) => {
  await boot(page, "F1");
  const before = await authoritySnapshot(page);
  await openRepairWorkspace(page);
  await page.getByTestId("repair-filter-query").fill("session");
  await page.getByTestId("repair-filter-clear").click();
  await page.getByTestId("repair-tab-evidence").click().catch(() => undefined);
  await page.getByTestId("repair-tab-activity").click().catch(() => undefined);
  const after = await authoritySnapshot(page);
  expect(after.unchanged || after.current.repairJson === before.baseline.repairJson).toBeTruthy();
  const launches = await launcherCalls(page);
  expect(launches.all.filter((a) => a.action === "repair" || a.action.includes("squadctl")).length).toBe(0);
});

test("[E62] @p0 evidence export download is redacted and non-publishing", async ({ page }) => {
  await boot(page, "F6a");
  await openRepairWorkspace(page);
  await page.getByTestId("repair-tab-evidence").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("repair-export").click(),
  ]);
  const path = await download.path();
  expect(path).toBeTruthy();
  const fs = await import("node:fs");
  const text = fs.readFileSync(path as string, "utf8");
  expect(text).toMatch(/candidateSha|baseSha|assertionVersion|verifiedAt|round/i);
  expect(text).not.toContain(SECRET_SENTINEL);
  const launches = await launcherCalls(page);
  expect(launches.all.filter((a) => /publish|push|gh\s/.test(a.action)).length).toBe(0);
});

void postRepairStop;
