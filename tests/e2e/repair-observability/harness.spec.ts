import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { ORIGIN, PARENT_RUN_ID, PORT, REVIEW_RUN_ID, SQUAD_RUN_ID } from "./constants";
import {
  envSentinel,
  installOriginAllowlist,
  openRepairWorkspace,
  resetFixture,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test("[E60] @p0 adjacent review and squad regression", async ({ page }) => {
  await installOriginAllowlist(page);
  await page.goto("/");
  await resetFixture(page, "F-review");
  await page.goto(`/reports/${REVIEW_RUN_ID}`);
  // Existing review report path — must not mount repair mutation chrome as primary
  await expect(page.getByTestId("repair-stop")).toHaveCount(0);
  await expect(page.locator("body")).toContainText(/Review|审查|报告/);

  await resetFixture(page, "F-squad");
  await page.goto(`/reports/${SQUAD_RUN_ID}`);
  await expect(page.getByTestId("repair-stop")).toHaveCount(0);
  await expect(page.getByTestId("repair-resume")).toHaveCount(0);
  await expect(page.locator("body")).toContainText(/Squad|observe|只读|报告/i);
});

test("[E66] @p0 harness isolation: port conflict, no 43127, user home untouched", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const before = await envSentinel(page);
  expect(before.testPort).toBe(PORT);
  expect(before.hostHeader).toBe(`127.0.0.1:${PORT}`);
  expect(before.councilkitHome).toBeTruthy();
  expect(before.councilkitHome).not.toContain("/.config/councilkit");

  // Port conflict must fail fast — bind 43837 should throw EADDRINUSE
  let conflicted = false;
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") conflicted = true;
      resolve();
    });
    probe.listen(PORT, "127.0.0.1", () => {
      // Unexpected: port free means webServer died — still a failure signal for harness health
      probe.close(() => resolve());
    });
  });
  expect(conflicted).toBeTruthy();

  // Zero requests to user Host 43127
  const hits43127: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes(":43127")) hits43127.push(req.url());
  });
  await resetFixture(page, "F1");
  await openRepairWorkspace(page, PARENT_RUN_ID);
  expect(hits43127).toEqual([]);

  // Direct probe of 43127 is forbidden from this suite — we only assert we didn't call it.
  // User home hash unchanged
  const after = await envSentinel(page);
  expect(after.userHomeHash).toBe(before.userHomeHash);

  // Health only on test origin
  const health = await request.get(`${ORIGIN}/api/v1/health`);
  expect(health.ok()).toBeTruthy();
});
