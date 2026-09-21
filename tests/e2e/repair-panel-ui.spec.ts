import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";

const REVIEW_ID = "ck-review-00000000-0000-4000-8000-0000000000f1";
const REPAIR_ID = "ck-repair-00000000-0000-4000-8000-0000000000f2";
const ARTIFACTS = "/tmp/councilkit-cursor-convergence-20260921";
const GH_PR = "https://github.com/acme/repo/pull/1";

const health = {
  ok: true,
  data: {
    apiVersion: "v1",
    hostInstanceId: "preview-ui",
    node: { version: "v22.0.0", major: 22 },
    drivers: [],
  },
};

const reviewRun = {
  runId: REVIEW_ID,
  kind: "review",
  status: "completed",
  title: "Repair panel UI",
  startedAt: null,
  endedAt: null,
  hasReport: true,
  reportUrl: `/reports/${REVIEW_ID}`,
  progress: null,
  pipeline: null,
  markdown: "# Review\n",
  truncated: false,
  findings: [],
  reviewEvidence: {
    complete: true,
    sha: "a".repeat(40),
    prUrl: GH_PR,
    againstRunId: null,
    blockingIds: [],
    unverifiedFixIds: [],
    openIds: [],
  },
};

const repairRun = {
  runId: REPAIR_ID,
  kind: "repair",
  status: "completed",
  title: "Repair parent",
  startedAt: null,
  endedAt: null,
  hasReport: true,
  reportUrl: `/reports/${REPAIR_ID}`,
  progress: { phase: "repair-finalizing", attempts: [], updatedAt: "t" },
  pipeline: null,
  markdown: "# Repair\n",
  truncated: false,
  findings: [],
  businessResult: "needs_attention",
  reasonCode: "findings_open",
  sourceRunId: REVIEW_ID,
  resumeEligible: true,
  isolationMode: "collaborative",
  protocolVersion: "v2",
  recoveryAction: "从 findings_open 恢复",
};

test("real React repair panel: collaborative opt-in, strong unavailable, resume copy", async ({
  page,
}) => {
  const blocked: string[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  await page.route(/127\.0\.0\.1:43127|localhost:43127/, async (route) => {
    blocked.push(route.request().url());
    await route.abort();
  });
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({ json: { ok: true, data: { runs: [], drivers: [], rooms: [] } } }),
  );
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "<head>",
      '<head>\n    <meta name="councilkit-csrf" content="preview-csrf" />',
    );
    await route.fulfill({
      status: response.status(),
      headers: {
        ...response.headers(),
        "content-type": "text/html; charset=utf-8",
      },
      body,
    });
  });
  await page.route("**/api/v1/health", (route) => route.fulfill({ json: health }));
  await page.route("**/api/v1/diagnostics", (route) =>
    route.fulfill({ json: { ok: true, data: { rooms: [] } } }),
  );
  await page.route("**/api/v1/cli-runs/repair/profiles**", async (route) => {
    if (route.request().method() === "POST") {
      const posted = route.request().postDataJSON() as Record<string, unknown>;
      expect(posted.isolationMode).toBe("collaborative");
      expect(posted.protocolVersion).toBe("v2");
      await route.fulfill({
        json: {
          ok: true,
          data: {
            name: "default",
            prUrl: GH_PR,
            sourceBranch: "feat-x",
            base: "main",
          },
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        data: {
          profiles: [],
          sourceBranchHint: "feat-x",
          baseHint: "main",
          hintSource: "review",
          bridgeAvailable: true,
          bridgeReason: null,
        },
      },
    });
  });
  await page.route("**/api/v1/cli-runs/repair", async (route) => {
    await route.fulfill({ json: { ok: true, data: { runId: REPAIR_ID, started: true } } });
  });
  await page.route("**/api/v1/cli-runs", (route) => {
    if (new URL(route.request().url()).pathname !== "/api/v1/cli-runs") return route.fallback();
    return route.fulfill({ json: { ok: true, data: { runs: [] } } });
  });
  await page.route(/\/api\/v1\/cli-runs\/ck-(review|repair)-[^/?]+$/, (route) => {
    const runId = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const data = runId === REPAIR_ID ? repairRun : reviewRun;
    if (runId !== REVIEW_ID && runId !== REPAIR_ID) {
      return route.fulfill({
        status: 404,
        json: { ok: false, error: { code: "NOT_FOUND", message: "missing run" } },
      });
    }
    return route.fulfill({ json: { ok: true, data } });
  });

  await page.goto(`/reports/${REVIEW_ID}`);
  await page.getByRole("button", { name: "当前修复" }).click();
  await expect(page.getByText("还没有保存的修复授权")).toBeVisible();
  await expect(page.getByText("整条真实 Squad 强隔离当前不支持")).toBeVisible();
  await expect(page.locator('input[name="isolation"][value="strong"]')).toBeDisabled();
  await page.locator('input[name="isolation"][value="collaborative"]').check();
  await page.getByRole("button", { name: "保存授权并启动" }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/${REPAIR_ID}`));
  await expect(page.getByText("协作约定（非 OS 硬隔离）")).toBeVisible();
  await expect(page.getByRole("button", { name: "从 findings_open 恢复" })).toBeVisible();
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, "ui-smoke.png"), fullPage: true });
  expect(blocked).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(
    consoleErrors.filter(
      (row) =>
        !row.includes("runtime startup audit") &&
        !row.includes("[vite]") &&
        !row.includes("ws://127.0.0.1:4188"),
    ),
  ).toEqual([]);
});
