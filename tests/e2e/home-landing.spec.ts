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

test("首页就能贴 PR URL 开审查", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("审查一个 PR")).toBeVisible();
  await expect(page.getByLabel("PR URL")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始审查" })).toBeVisible();
  await expect(page.getByRole("link", { name: "贴 URL 开审查" })).toHaveCount(0);
});
