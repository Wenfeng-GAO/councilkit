import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { RUN_ID } from "../../review-explainer/contract";
import { HOST_HEADER, ORIGIN, PORT } from "./constants";
import { envSentinel, installOriginAllowlist, resetCase } from "./helpers";

test("[INFRA] isolated host on 43839, not 43127, temp home, existing report entry", async ({
  page,
  request,
}) => {
  await installOriginAllowlist(page);
  await page.goto("/");
  const env = await envSentinel(page);
  expect(env.testPort).toBe(PORT);
  expect(env.hostHeader).toBe(HOST_HEADER);
  expect(env.councilkitHome).toBeTruthy();
  expect(env.councilkitHome).not.toContain("/.config/councilkit");

  let conflicted = false;
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") conflicted = true;
      resolve();
    });
    probe.listen(PORT, "127.0.0.1", () => {
      probe.close(() => resolve());
    });
  });
  expect(conflicted).toBeTruthy();

  const hits43127: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes(":43127")) hits43127.push(req.url());
  });
  const seeded = await resetCase(page);
  expect(seeded.runId).toBe(RUN_ID);
  await page.goto(`/reports/${RUN_ID}`);
  await expect(page.locator(".ck-wb")).toBeVisible({ timeout: 20_000 });
  expect(hits43127).toEqual([]);

  const health = await request.get(`${ORIGIN}/api/v1/health`);
  expect(health.ok()).toBeTruthy();
  const detail = await page.request.get(`/api/v1/cli-runs/${RUN_ID}`);
  expect(detail.ok()).toBeTruthy();
  const body = (await detail.json()) as { data: { kind: string; markdown: string } };
  expect(body.data.kind).toBe("review");
  expect(body.data.markdown).toContain("Synthetic explainer fixture");
});
