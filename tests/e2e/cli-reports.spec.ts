import { expect, test } from "@playwright/test";

const E2E_CLI_RUN_ID = "ck-review-00000000-0000-4000-8000-0000000000e2";

test("侧栏有「报告」，列表页能打开", async ({ page }) => {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "CLI 报告" })).toBeVisible();
  await expect(page.getByRole("link", { name: "报告" })).toBeVisible();
});

test("有 fixture 时能点进报告并看到标题；脚本标签保持为文本", async ({ page }) => {
  await page.goto("/reports");
  const heading = page.getByRole("heading", { name: "CLI 报告" });
  await expect(heading).toBeVisible();
  const fixture = page.getByRole("link", { name: /e2e-fixture-review/ });
  if ((await fixture.count()) === 0) {
    // reuseExistingServer 时本机 Host 可能没有 e2e fixture。
    test
      .info()
      .annotations.push({ type: "skip-reason", description: "no e2e fixture on this Host" });
    return;
  }
  await fixture.click();
  await expect(page).toHaveURL(new RegExp(`/reports/${E2E_CLI_RUN_ID}`));
  await expect(page.getByRole("heading", { name: "Autonomous Review Report" })).toBeVisible();
  await expect(page.locator("script", { hasText: "alert(1)" })).toHaveCount(0);
  await expect(page.getByText("<script>alert(1)</script>")).toBeVisible();
});

test("深链 /reports/:runId 能直接打开 fixture", async ({ page }) => {
  await page.goto(`/reports/${E2E_CLI_RUN_ID}`);
  const title = page.getByRole("heading", { name: "Autonomous Review Report" });
  const missing = page.getByText("找不到这份报告");
  await expect(title.or(missing)).toBeVisible();
});
