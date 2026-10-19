import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("#383 missing seat is readable with an amber circle-alert at 1280 and 390", async ({
  page,
}) => {
  await page.goto("/settings");
  const seeded = await page.request.post("/api/v1/__test__/seed-missing-seat", { data: {} });
  expect(seeded.ok()).toBe(true);
  const { runId } = (await seeded.json()).data as { runId: string };
  mkdirSync("test-results/review-missing-seat", { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/reports/${runId}`);
    const row = page.locator('[data-absence-icon="circle-alert"]');
    await expect(row).toBeVisible();
    await expect(row).toHaveText("缺席：review-kimi（kimi）：没有找到 kimi。");
    const icon = row.locator("svg.ck-wb-icon.ck-wb-icon-state");
    await expect(icon).toBeVisible();
    const colors = await icon.evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--ck-interrupt)";
      document.body.appendChild(probe);
      const token = getComputedStyle(probe).color;
      probe.remove();
      return { actual: getComputedStyle(el).color, token };
    });
    expect(colors.actual).toBe(colors.token);
    await row.scrollIntoViewIfNeeded();
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({
      path: `test-results/review-missing-seat/missing-seat-${width}.png`,
      fullPage: true,
    });
  }
});
