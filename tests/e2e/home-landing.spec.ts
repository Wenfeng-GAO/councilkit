import { expect, test } from "@playwright/test";

test("首页突出两种能力与三条用法", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /让模型互相看见/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "讨论：共享上下文，按序发言" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "陪审：隔离并行，再对比汇总" })).toBeVisible();
  await expect(page.getByText("councilkit init", { exact: true })).toBeVisible();
  await expect(page.getByText("councilkit review <url>")).toBeVisible();
  await expect(page.getByText("councilkit apply --run <id>")).toBeVisible();
  await expect(page.getByRole("heading", { name: "讨论房间" })).toBeVisible();
});

test("首页 CTA 能进入报告库", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "查看 CLI 报告" }).click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByRole("heading", { name: "CLI 报告" })).toBeVisible();
});

test("首页 CTA 贴 URL 开审查落到 /reports#review 并聚焦 PR URL", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("councilkit init", { exact: true })).toBeVisible();
  await expect(page.getByText("councilkit review <url>")).toBeVisible();
  await expect(page.getByRole("link", { name: "查看 CLI 报告" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始审查" })).toHaveCount(0);

  const companion = page.getByRole("link", { name: "贴 URL 开审查" });
  await expect(companion).toHaveAttribute("href", "/reports#review");
  await companion.click();
  await expect(page).toHaveURL(/\/reports#review/);
  const prUrl = page.locator("#review-pr-url");
  await expect(prUrl).toBeVisible();
  await expect(prUrl).toBeFocused();
});
