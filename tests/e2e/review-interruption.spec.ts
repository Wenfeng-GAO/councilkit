import { mkdirSync } from "node:fs";
import { type Locator, expect, test } from "@playwright/test";
import { EXECUTION_SERVICE_INTERRUPTION } from "../../shared/runtime/interruption-copy";
import {
  COMPLETED_REVIEW_RUN_ID,
  LOST_EXECUTION_PR,
  LOST_EXECUTION_RUN_ID,
} from "./cli-run-fixtures";

const ARTIFACTS = "/opt/cursor/artifacts/screenshots";

test.use({ locale: "zh-CN" });

async function expectAmberInterrupt(mark: Locator): Promise<void> {
  await expect(mark).toHaveAttribute("data-interrupt-token", "--ck-interrupt");
  await expect(mark).toHaveAttribute("data-interrupt-icon", "circle-pause");
  const colors = await mark.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--ck-interrupt)";
    document.body.appendChild(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(el).color, token };
  });
  expect(colors.actual).toBe(colors.token);
}

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
    await expect(interrupted.locator("[data-interrupt-icon='circle-pause']")).toBeVisible();
    await expect(interrupted.locator("[data-interrupt-token='--ck-interrupt']")).toBeVisible();
    await expect(interrupted).toContainText(
      `下一步：${EXECUTION_SERVICE_INTERRUPTION.primaryAction}`,
    );
    await expect(interrupted).not.toContainText("等待完整审查证据");
    await expect(interrupted).not.toContainText("失败");
    await expect(interrupted).not.toContainText("进行中");
    await interrupted.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${ARTIFACTS}/list-status-${width}.png`,
      fullPage: true,
    });
    await page.screenshot({
      path: `${ARTIFACTS}/interrupt-unified-list-${width}.png`,
      fullPage: true,
    });

    await interrupted.getByRole("link", { name: "打开" }).click();
    await expect(page).toHaveURL(new RegExp(`/reports/${LOST_EXECUTION_RUN_ID}`));
    await expect(
      page.getByRole("heading", { name: EXECUTION_SERVICE_INTERRUPTION.title }),
    ).toBeVisible();
    await expect(page.getByText(EXECUTION_SERVICE_INTERRUPTION.detail)).toBeVisible();
    await expect(page.locator(".ck-wb-run-status")).toBeVisible();
    await expect(page.locator(".ck-wb-run-status")).toContainText("中断");
    await expectAmberInterrupt(page.locator(".ck-wb-run-status .ck-interrupt-mark"));
    await page.locator(".ck-wb-context").screenshot({
      path: `${ARTIFACTS}/topbar-interrupt-${width}.png`,
    });
    await expect(page.locator(".ck-wb-context")).not.toContainText("席位审查中");
    await expect(
      page.locator(".ck-ledger-title", { hasText: "超时分支在收到渠道失败之前写入了 paid" }),
    ).toBeVisible();
    const card = page.getByRole("region", { name: EXECUTION_SERVICE_INTERRUPTION.title });
    await expect(card.locator("[data-interrupt-icon='circle-pause']")).toBeVisible();
    const primary = card.getByRole("button", {
      name: EXECUTION_SERVICE_INTERRUPTION.primaryAction,
    });
    await expect(primary).toBeEnabled();
    await expect(primary).toHaveAttribute("data-variant", "primary");
    await expect(
      card.getByRole("link", { name: EXECUTION_SERVICE_INTERRUPTION.secondaryAction }),
    ).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS}/interrupted-card-${width}.png` });
    await page.screenshot({ path: `${ARTIFACTS}/interrupt-unified-detail-${width}.png` });
    if (width === 1280) {
      const summary = page.locator(".ck-wb-aggregate");
      await expect(summary).toContainText("结果汇总");
      await expect(summary).toContainText("中断");
      await expect(summary).not.toContainText("已取消");
      await expect(summary.locator("[data-interrupt-icon='circle-pause']")).toBeVisible();
      await summary.screenshot({ path: `${ARTIFACTS}/sidebar-interrupt-${width}.png` });
    } else {
      await page.locator(".ck-wb-seats").evaluate((el) => {
        const node = el as HTMLElement;
        node.style.display = "flex";
        node.style.flexDirection = "column";
        node.style.position = "fixed";
        node.style.top = "0";
        node.style.left = "0";
        node.style.width = "248px";
        node.style.zIndex = "40";
        node.style.background = "#16171a";
      });
      const summary = page.locator(".ck-wb-aggregate");
      await expect(summary).toContainText("中断");
      await page.screenshot({ path: `${ARTIFACTS}/sidebar-interrupt-${width}.png` });
      await page.locator(".ck-wb-seats").evaluate((el) => {
        const node = el as HTMLElement;
        node.removeAttribute("style");
      });
    }
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

test("复审在进程已死时启动，进程还活着时停在页面上", async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.goto("/reports");

  for (const shape of ["pr", "task"] as const) {
    const dead = await page.request.post("/api/v1/__test__/seed-stale-review", {
      data: { shape, liveness: "dead" },
    });
    expect(dead.ok()).toBe(true);
    const deadBody = (await dead.json()) as { ok: true; data: { runId: string } };
    const runId = deadBody.data.runId;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/reports/${runId}`);
    await page.getByRole("button", { name: "当前修复" }).click();
    const card = page.getByRole("region", { name: EXECUTION_SERVICE_INTERRUPTION.title });
    const cardButton = card.getByRole("button", { name: /只再审一遍|正在启动复审/ });
    if (shape === "pr") {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/v1/cli-runs/**/actions", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        await gate;
        await route.continue();
      });
      const pending = page.waitForResponse(
        (item) => item.url().includes("/actions") && item.request().method() === "POST",
      );
      await cardButton.click();
      await expect(cardButton).toHaveText("正在启动复审…");
      await expect(cardButton).toBeDisabled();
      await card.screenshot({ path: `${ARTIFACTS}/rereview-starting-1280.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(cardButton).toBeDisabled();
      await card.screenshot({ path: `${ARTIFACTS}/rereview-starting-390.png` });
      release();
      expect((await pending).ok()).toBe(true);
      await page.unroute("**/api/v1/cli-runs/**/actions");
    } else {
      await cardButton.click();
    }
    await expect(page).not.toHaveURL(new RegExp(runId), { timeout: 15_000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator(".ck-wb-seat-row").filter({ hasText: "安全审查" })).toBeVisible();

    const alive = await page.request.post("/api/v1/__test__/seed-stale-review", {
      data: { shape, liveness: "alive" },
    });
    expect(alive.ok()).toBe(true);
    const aliveBody = (await alive.json()) as { ok: true; data: { runId: string } };
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/reports/${aliveBody.data.runId}`);
    await page.getByRole("button", { name: "当前修复" }).click();
    const refusedCard = page.getByRole("region", { name: EXECUTION_SERVICE_INTERRUPTION.title });
    const refused = refusedCard.getByRole("button", { name: "只再审一遍（不改代码）" });
    const [response] = await Promise.all([
      page.waitForResponse(
        (item) => item.url().includes("/actions") && item.request().method() === "POST",
      ),
      refused.click(),
    ]);
    expect(response.ok()).toBe(false);
    const alert = refused.locator("xpath=following-sibling::*[1]");
    await expect(alert).toHaveText("复审没有启动：上一次审查还在运行。可以再试一次。");
    await expect(refused).toBeEnabled();
    await expect(page.locator("section").filter({ hasText: "修复闭环" })).not.toContainText(
      "复审没有启动",
    );
    await expect(page).toHaveURL(new RegExp(aliveBody.data.runId));
    if (shape === "pr") {
      await refusedCard.screenshot({ path: `${ARTIFACTS}/rereview-failed-1280.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(alert).toHaveText("复审没有启动：上一次审查还在运行。可以再试一次。");
      await refusedCard.screenshot({ path: `${ARTIFACTS}/rereview-failed-390.png` });
    }
  }
});

test("没有报告的中途被杀审查会按原输入重开，失败重载仍是中断", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.goto("/reports");

  for (const shape of ["pr", "task"] as const) {
    const seeded = await page.request.post("/api/v1/__test__/seed-stale-review", {
      data: { shape, liveness: "dead", report: "absent" },
    });
    expect(seeded.ok()).toBe(true);
    const runId = ((await seeded.json()) as { ok: true; data: { runId: string } }).data.runId;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/reports/${runId}`);
    const card = page.getByRole("region", { name: EXECUTION_SERVICE_INTERRUPTION.title });
    await card.getByRole("button", { name: /只再审一遍|正在启动复审/ }).click();
    await expect(page).not.toHaveURL(new RegExp(runId), { timeout: 15_000 });
    await expect(page).toHaveURL(/\/reports\/ck-review-/);
    await expect(page.getByText(EXECUTION_SERVICE_INTERRUPTION.title)).toHaveCount(0);
    await expect(page.locator(".ck-wb-seat-row").filter({ hasText: "安全审查" })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS}/rereview-scratch-${shape}-1280.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${ARTIFACTS}/rereview-scratch-${shape}-390.png` });

    const failed = await page.request.post("/api/v1/__test__/seed-stale-review", {
      data: { shape, liveness: "dead", report: "absent", failReReview: true },
    });
    expect(failed.ok()).toBe(true);
    const failedId = ((await failed.json()) as { ok: true; data: { runId: string } }).data.runId;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/reports/${failedId}`);
    const failedCard = page.getByRole("region", { name: EXECUTION_SERVICE_INTERRUPTION.title });
    const [response] = await Promise.all([
      page.waitForResponse(
        (item) => item.url().includes("/actions") && item.request().method() === "POST",
      ),
      failedCard.getByRole("button", { name: "只再审一遍（不改代码）" }).click(),
    ]);
    expect(response.ok()).toBe(false);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(failedId));
    await expect(page.getByText("仍在运行")).toHaveCount(0);
    await expect(page.getByText("执行中")).toHaveCount(0);
    await expectAmberInterrupt(page.locator(".ck-wb-run-status .ck-interrupt-mark"));
    await expectAmberInterrupt(
      page
        .getByRole("region", { name: EXECUTION_SERVICE_INTERRUPTION.title })
        .locator("[data-interrupt-icon='circle-pause']"),
    );
    const summary = page.locator(".ck-wb-aggregate");
    await expect(summary).toContainText("结果汇总");
    await expect(summary).toContainText("中断");
    await expectAmberInterrupt(summary.locator("[data-interrupt-icon='circle-pause']"));
    await page.screenshot({ path: `${ARTIFACTS}/rereview-reload-${shape}-1280.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".ck-wb-seats").evaluate((el) => {
      const node = el as HTMLElement;
      const main = document.querySelector(".ck-wb-main");
      if (main) main.appendChild(node);
      node.style.display = "flex";
      node.style.flexDirection = "column";
      node.style.position = "static";
      node.style.width = "100%";
      node.style.gridColumn = "auto";
      node.style.gridRow = "auto";
    });
    await expect(summary).toContainText("中断");
    await expectAmberInterrupt(page.locator(".ck-wb-run-status .ck-interrupt-mark"));
    await page.screenshot({
      path: `${ARTIFACTS}/rereview-reload-${shape}-390.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/reports");
    await page.getByRole("button", { name: /全部案件/ }).click();
    const listed = page.locator(".ck-case-card", {
      has: page.locator(`a[href="/reports/${failedId}"]`),
    });
    await expect(listed.locator("[data-interrupt-icon='circle-pause']")).toBeVisible();
    await expectAmberInterrupt(listed.locator("[data-interrupt-token='--ck-interrupt']"));
    await listed.screenshot({ path: `${ARTIFACTS}/rereview-reload-list-${shape}-1280.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await listed.screenshot({ path: `${ARTIFACTS}/rereview-reload-list-${shape}-390.png` });
  }
});
