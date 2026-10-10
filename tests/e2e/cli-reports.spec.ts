import { expect, test } from "@playwright/test";

const E2E_CLI_RUN_ID = "ck-review-00000000-0000-4000-8000-0000000000e2";

test("侧栏有「报告」，列表页能打开", async ({ page }) => {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "审查与报告" })).toBeVisible();
  await expect(page.getByRole("link", { name: "报告", exact: true })).toBeVisible();
});

test("有 fixture 时能点进报告并看到标题；脚本标签保持为文本", async ({ page }) => {
  await page.goto("/reports");
  const heading = page.getByRole("heading", { name: "审查与报告" });
  await expect(heading).toBeVisible();
  await page.getByRole("button", { name: /全部案件/ }).click();
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
  await expect(page.getByRole("button", { name: "复制当前内容" })).toBeVisible();
  await expect(page.locator("script", { hasText: "alert(1)" })).toHaveCount(0);
  await expect(page.getByText("<script>alert(1)</script>")).toBeVisible();
});

test("已有 CLI 报告时详情页能复制报告内容", async ({ page }) => {
  await page.goto("/reports");
  await page.getByRole("button", { name: /全部案件/ }).click();
  const reportLink = page.locator('a[href^="/reports/ck-review-"]').first();
  if ((await reportLink.count()) === 0) return;
  await reportLink.click();
  await expect(page.getByRole("button", { name: "复制当前内容" })).toBeVisible();
});

test("深链 /reports/:runId 能直接打开 fixture", async ({ page }) => {
  await page.goto(`/reports/${E2E_CLI_RUN_ID}`);
  const title = page.getByRole("heading", { name: "Autonomous Review Report" });
  const missing = page.getByText("找不到这份报告");
  await expect(title.or(missing)).toBeVisible();
});

test("/reports 开始审查表单在有 fixture 时也可见", async ({ page }) => {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "审查与报告" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始审查" })).toBeVisible();
  await expect(page.getByLabel("PR URL")).toBeVisible();
  const requireSpec = page.locator("#review-require-spec");
  await expect(requireSpec).toBeVisible();
  await expect(requireSpec).toBeChecked();
  await expect(page.getByText("强制按 spec review")).toBeVisible();
});

test("against 查询参数把表单切成对照复审", async ({ page }) => {
  await page.goto("/reports?against=ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1#review");
  await expect(page.getByRole("heading", { name: "对照复审" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始对照复审" })).toBeVisible();
});

test("/reports 本地仓库路径默认收在关闭的高级里", async ({ page }) => {
  await page.goto("/reports");
  const advanced = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "高级" }) });
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

test("/reports 默认是案件筛选，创意在独立页", async ({ page }) => {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "审查与报告" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "讨论产品创意" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /需要处理/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始讨论" })).toHaveCount(0);
  await page.getByRole("link", { name: "产品创意", exact: true }).click();
  await expect(page).toHaveURL(/\/ideate$/);
});

test("创意 fixture 详情没有修复或 apply 动作", async ({ page }) => {
  await page.goto("/reports/ck-ideate-00000000-0000-4000-8000-0000000000e2");
  await expect(page.getByRole("heading", { name: "Product Ideate Report" })).toBeVisible();
  await expect(page.getByText("找不到这份报告")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "复制 apply 命令" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "复制修复 Prompt" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "立即修复" })).toHaveCount(0);
});

test("开始创意讨论后导航到 /reports/<ideate-runId>", async ({ page }) => {
  await page.goto("/ideate");
  await expect(page.getByRole("button", { name: "开始讨论" })).toBeDisabled();
  await page.getByLabel("一句话创意").fill("为独立开发者每周整理用户反馈");
  await expect(page.getByRole("button", { name: "开始讨论" })).toBeEnabled();
  await page.getByRole("button", { name: "开始讨论" }).click();
  await expect(page).toHaveURL(/\/reports\/ck-ideate-[0-9a-fA-F-]+/);
});

test("开始审查提交 GitHub PR 后导航到 /reports/<runId>", async ({ page }) => {
  await page.goto("/reports");
  await page.getByLabel("PR URL").fill("https://github.com/acme/repo/pull/1");
  await page.getByRole("button", { name: "开始审查" }).click();
  await expect(page).toHaveURL(/\/reports\/ck-review-[0-9a-fA-F-]+/);
});

test("review fixture 的席位详情在页内打开（无模态检查器）", async ({ page }) => {
  await page.goto(`/reports/${E2E_CLI_RUN_ID}`);
  const seat = page.locator(".ck-wb-seat-row").first();
  if ((await seat.count()) === 0) {
    test
      .info()
      .annotations.push({ type: "skip-reason", description: "fixture has no live attempts" });
    return;
  }
  await seat.click();
  // 页内详情：报告/过程 Tab 可用，全程无 dialog（review kind 已移除 SeatInspector 入口）。
  await expect(page.getByRole("tab", { name: "报告" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "过程" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("review 总览「复制」按钮复制短清单而非完整报告", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/reports/${E2E_CLI_RUN_ID}`);

  // Wait for the page to load
  const overview = page.locator("text=本轮总览").or(page.getByRole("heading", { name: "本轮总览" }));
  await expect(overview).toBeVisible({ timeout: 10000 });

  // Check that we're on the overview (not a seat detail)
  const copyButton = page.getByRole("button", { name: /复制/ }).first();
  await expect(copyButton).toBeVisible();

  // Click the copy button
  await copyButton.click();

  // Wait for copy to complete
  await expect(page.getByText("已复制")).toBeVisible();

  // Get clipboard content
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

  // Verify short checklist format:
  // 1. Should contain "# 问题清单" header
  expect(clipboardText).toContain("# 问题清单");

  // 2. Should contain finding markers (## #01, ## #02, etc.)
  expect(clipboardText).toMatch(/## #\d+/);

  // 3. Should contain severity labels (致命/重大/次要/轻微)
  expect(clipboardText).toMatch(/致命|重大|次要|轻微/);

  // 4. Should NOT contain sections from the full report like 附录 or 过程对比
  expect(clipboardText).not.toContain("附录");
  expect(clipboardText).not.toContain("各审查者交付物");
  expect(clipboardText).not.toContain("过程对比");

  // 5. If there are findings, should have location markers
  if (clipboardText.includes("**位置**")) {
    expect(clipboardText).toMatch(/\*\*位置\*\*:\s*`[\w./-]+:\d+/);
  }

  // 6. Should include status tags
  expect(clipboardText).toMatch(/\*\*状态\*\*/);
});

test("review 总览有「复制完整报告」按钮作为次要选项", async ({ page }) => {
  await page.goto(`/reports/${E2E_CLI_RUN_ID}`);

  // Wait for the page to load
  const overview = page.locator("text=本轮总览").or(page.getByRole("heading", { name: "本轮总览" }));
  await expect(overview).toBeVisible({ timeout: 10000 });

  // Check for the secondary "copy full report" button
  const copyFullButton = page.getByRole("button", { name: /复制完整报告/ });

  // The button should be visible on overview
  await expect(copyFullButton).toBeVisible();
});
