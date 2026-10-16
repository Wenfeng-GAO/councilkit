import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { EXECUTION_SERVICE_INTERRUPTION } from "../../shared/runtime/interruption-copy";
import {
  COMPLETED_REVIEW_RUN_ID,
  LOST_EXECUTION_PR,
  LOST_EXECUTION_RUN_ID,
} from "./cli-run-fixtures";

const ARTIFACTS = "/opt/cursor/artifacts/screenshots";

test.use({ locale: "zh-CN" });

test("过期审查在列表、标题和卡片上都是中断，并且可以再审一遍", async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.route("**/api/v1/cli-runs/repair/profiles**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        data: {
          profiles: [
            {
              name: "default",
              prUrl: LOST_EXECUTION_PR,
              sourceBranch: "fix/pay-timeout",
              base: "main",
            },
          ],
          sourceBranchHint: "fix/pay-timeout",
          baseHint: "main",
          hintSource: "pr",
          bridgeAvailable: true,
          bridgeReason: null,
        },
      },
    });
  });

  for (const width of [1280, 390] as const) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    await page.goto("/reports");
    await expect(page.getByRole("heading", { name: "审查与报告" })).toBeVisible();
    await page.getByRole("button", { name: /全部案件/ }).click();
    const interrupted = page.locator(".ck-case-card").filter({ hasText: "acme/payments #348" });
    await expect(interrupted).toContainText("中断");
    await expect(interrupted).not.toContainText("失败");
    await expect(interrupted).not.toContainText("进行中");
    await interrupted.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${ARTIFACTS}/list-status-${width}.png`,
      fullPage: true,
    });

    await interrupted.getByRole("link", { name: "打开" }).click();
    await expect(page).toHaveURL(new RegExp(`/reports/${LOST_EXECUTION_RUN_ID}`));
    await expect(
      page.getByRole("heading", { name: EXECUTION_SERVICE_INTERRUPTION.title }),
    ).toBeVisible();
    await expect(page.getByText(EXECUTION_SERVICE_INTERRUPTION.detail)).toBeVisible();
    await expect(page.locator(".ck-wb-run-status")).toBeVisible();
    await expect(page.locator(".ck-wb-run-status")).toHaveText("中断");
    await expect(page.locator(".ck-wb-context")).not.toContainText("席位审查中");
    await expect(
      page.locator(".ck-ledger-title", { hasText: "超时分支在收到渠道失败之前写入了 paid" }),
    ).toBeVisible();
    const card = page.getByRole("region", { name: EXECUTION_SERVICE_INTERRUPTION.title });
    const primary = card.getByRole("button", {
      name: EXECUTION_SERVICE_INTERRUPTION.primaryAction,
    });
    await expect(primary).toBeEnabled();
    await expect(primary).toHaveAttribute("data-variant", "primary");
    await expect(
      card.getByRole("link", { name: EXECUTION_SERVICE_INTERRUPTION.secondaryAction }),
    ).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS}/interrupted-card-${width}.png` });

    if (width === 1280) {
      await page.getByRole("button", { name: "当前修复" }).click();
    } else {
      await page.getByLabel("选择视图或席位").selectOption("repair");
    }
    await expect(page.getByRole("heading", { name: "当前修复" })).toBeVisible();
    await expect(page.getByRole("button", { name: "内置修复" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "内置修复" })).not.toHaveText("修复进行中…");
    const reReview = page.getByRole("button", {
      name: EXECUTION_SERVICE_INTERRUPTION.primaryAction,
    });
    await expect(reReview).toHaveCount(2);
    for (const button of await reReview.all()) {
      await expect(button).toBeEnabled();
    }
    const squad = page.getByRole("button", { name: "Squad 自动修复" });
    await expect(squad).toHaveAttribute("data-variant", "ghost");
    await squad.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${ARTIFACTS}/fix-tab-${width}.png` });

    await page.goto(`/reports/${COMPLETED_REVIEW_RUN_ID}`);
    await expect(page.getByRole("heading", { name: "审查已完成" })).toBeVisible();
    await expect(page.getByLabel("审查概览").getByText("支付幂等键已经补上")).toBeVisible();
    await expect(page.getByText(EXECUTION_SERVICE_INTERRUPTION.title)).toHaveCount(0);
    await page.screenshot({ path: `${ARTIFACTS}/completed-${width}.png` });
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/reports/${LOST_EXECUTION_RUN_ID}`);
  const primary = page.getByRole("button", { name: EXECUTION_SERVICE_INTERRUPTION.primaryAction });
  await expect(primary).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(
      (item) => item.url().includes("/actions") && item.request().method() === "POST",
    ),
    primary.click(),
  ]);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { ok?: boolean; data?: { started?: boolean } };
  expect(body.ok).toBe(true);
  expect(body.data?.started).toBe(true);
});
