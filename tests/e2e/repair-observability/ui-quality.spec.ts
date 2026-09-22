import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { appendLines, installOriginAllowlist, openRepairWorkspace, resetFixture } from "./helpers";
import { readCompleted, shellStarted } from "./fixtures/cursor-events";
const longPath =
  "/Users/example/.config/councilkit/repair-workspaces/ck-repair-example/.worktrees/20260922-repair-example/pkg/runtime/manager/session_recovery.go";
test("real failure presentation uses the workspace and readable activity rather than raw bookkeeping", async ({
  page,
}) => {
  await installOriginAllowlist(page);
  await page.goto("/");
  const f = await resetFixture(page, "F-legacy");
  const path = join(f.home, "runs", f.runId, "repair.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.goalSummary = "https://example.test/paas-core/agentrun/pull_requests/128";
  state.businessResult = "needs_attention";
  state.reasonCode = "squad_failed";
  state.resumeEligible = false;
  state.executions = [
    { executionId: "intent-only", state: "intent", pids: [], startedAtMs: null, endedAtMs: null },
  ];
  writeFileSync(path, JSON.stringify(state));
  await appendLines(page, [
    readCompleted("ui-file", longPath, "package manager"),
    shellStarted("ui-cmd", "go test -mod=vendor -count=1 ./pkg/runtime/manager/"),
  ]);
  await page.setViewportSize({ width: 1440, height: 960 });
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-goal")).toHaveText("agentrun #128");
  await expect(page.getByTestId("repair-attention")).toContainText("修复执行失败");
  await expect(page.getByTestId("repair-workspace")).not.toContainText("独立评审额度不足");
  await expect(page.getByTestId("repair-role-list")).not.toContainText("执行中");
  await expect(page.getByText("本轮审查结果", { exact: true })).toHaveCount(0);
  await expect(page.getByText("还没有 report.md", { exact: true })).toHaveCount(0);
  const list = page.getByTestId("repair-activity-list");
  await expect(list).toContainText("读取 session_recovery.go");
  await expect(list).not.toContainText("/Users/example");
  await expect(list).not.toContainText("shellToolCall");
  const heights = [];
  mkdirSync("test-results/repair-ui-quality", { recursive: true });
  for (const size of [
    { width: 1440, height: 960, min: 420 },
    { width: 1280, height: 900, min: 360 },
    { width: 390, height: 844, min: 0 },
  ]) {
    await page.setViewportSize(size);
    const box = await list.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.height).toBeGreaterThanOrEqual(size.min);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
      false,
    );
    heights.push({ width: size.width, height: box!.height });
    await page.screenshot({ path: `test-results/repair-ui-quality/failure-${size.width}.png` });
  }
  writeFileSync("test-results/repair-ui-quality/geometry.json", JSON.stringify(heights, null, 2));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: /读取 session_recovery.go/ }).click();
  await expect(page.getByTestId("repair-event-drawer")).toBeVisible();
  await page.getByText("原始记录与执行身份", { exact: true }).click();
  await expect(page.getByTestId("repair-event-drawer")).toContainText(longPath);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("repair-event-drawer")).toBeHidden();
});
test("active workspace retains actual follow and stop controls at useful desktop size", async ({
  page,
}) => {
  await installOriginAllowlist(page);
  await page.goto("/");
  await resetFixture(page, "F1");
  await page.setViewportSize({ width: 1440, height: 960 });
  await openRepairWorkspace(page);
  await expect(page.getByTestId("repair-follow-toggle")).toBeVisible();
  await expect(page.getByTestId("repair-stop")).toBeEnabled();
  await page.getByTestId("repair-stop").click();
  await expect(page.getByTestId("repair-stop-confirm")).toBeVisible();
  await page.getByTestId("repair-stop-cancel").click();
  await expect(page.getByTestId("repair-stop-confirm")).toBeHidden();
  await page.screenshot({ path: "test-results/repair-ui-quality/active-1440.png" });
});
