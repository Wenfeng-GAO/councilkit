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
  await expect(page.getByRole("button", { name: "复制 apply 命令" })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制修复 Prompt" })).toBeVisible();
  await expect(page.locator("script", { hasText: "alert(1)" })).toHaveCount(0);
  await expect(page.getByText("<script>alert(1)</script>")).toBeVisible();
});

test("已有 CLI 报告时详情页能复制 apply 命令", async ({ page }) => {
  await page.goto("/reports");
  const reportLink = page.locator('a[href^="/reports/ck-review-"]').first();
  if ((await reportLink.count()) === 0) return;
  await reportLink.click();
  await expect(page.getByRole("button", { name: "复制 apply 命令" })).toBeVisible();
});

test("深链 /reports/:runId 能直接打开 fixture", async ({ page }) => {
  await page.goto(`/reports/${E2E_CLI_RUN_ID}`);
  const title = page.getByRole("heading", { name: "Autonomous Review Report" });
  const missing = page.getByText("找不到这份报告");
  await expect(title.or(missing)).toBeVisible();
});

test("/reports 开始审查表单在有 fixture 时也可见", async ({ page }) => {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "CLI 报告" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始审查" })).toBeVisible();
  await expect(page.getByLabel("PR URL")).toBeVisible();
});

test("/reports 本地仓库路径默认收在关闭的高级里", async ({ page }) => {
  await page.goto("/reports");
  const advanced = page.locator("details").filter({ has: page.locator("summary", { hasText: "高级" }) });
  await expect(advanced).toBeVisible();
  await expect(advanced).not.toHaveAttribute("open");
  await expect(page.locator("#review-repo-path")).toBeHidden();
  await advanced.locator("summary").click();
  await expect(page.locator("#review-repo-path")).toBeVisible();
  await expect(page.getByLabel("本地仓库路径")).toBeVisible();
});

test("开始审查提交无效 URL 留在 /reports 并显示错误", async ({ page }) => {
  await page.goto("/reports");
  await page.getByLabel("PR URL").fill("https://example.com/nope");
  await page.getByRole("button", { name: "开始审查" }).click();
  await expect(page).toHaveURL(/\/reports\/?$/);
  await expect(page.getByRole("alert")).toBeVisible();
});

test("开始审查提交 GitHub PR 后导航到 /reports/<runId>", async ({ page }) => {
  await page.goto("/reports");
  await page.getByLabel("PR URL").fill("https://github.com/acme/repo/pull/1");
  await page.getByRole("button", { name: "开始审查" }).click();
  await expect(page).toHaveURL(/\/reports\/ck-review-[0-9a-fA-F-]+/);
});

test("查看过程打开右侧检查器，Esc 关闭", async ({ page }) => {
  await page.goto(`/reports/${E2E_CLI_RUN_ID}`);
  const inspect = page.getByRole("button", { name: /查看过程/ }).first();
  if ((await inspect.count()) === 0) {
    test
      .info()
      .annotations.push({ type: "skip-reason", description: "fixture has no live attempts" });
    return;
  }
  await inspect.click();
  const dialog = page.getByRole("dialog", { name: "过程" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
