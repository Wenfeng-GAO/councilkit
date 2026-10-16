import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { DRIFT_REVIEW_RUN_ID, SEAT_INTERRUPT_RUN_ID } from "./cli-run-fixtures";

const ARTIFACTS = "/opt/cursor/artifacts/screenshots";

test.use({ locale: "zh-CN" });

test("汇总漂移显示中断卡，只重跑汇总后给出综合结论；席位中断显示结论不完整", async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true });
  const widths = [1280, 390] as const;

  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto("/reports");
    await expect(page.getByRole("heading", { name: "审查与报告" })).toBeVisible();
    const driftCard = page.locator(".ck-case-card", { hasText: "acme/payments #352" });
    await expect(driftCard).toContainText("审查未完成（汇总中断）");
    await expect(driftCard).toContainText("结论不完整");
    await expect(driftCard).toContainText("下一步：只重跑汇总");
    await expect(driftCard).not.toContainText("失败");
    const seatCard = page.locator(".ck-case-card", { hasText: "acme/payments #358" });
    await expect(seatCard).toContainText("审查未完成（1 路席位中断）");
    await expect(seatCard).toContainText("结论不完整");
    await seatCard.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(driftCard).toBeVisible();
    await expect(seatCard).toBeVisible();
    await page.screenshot({
      path: `${ARTIFACTS}/interrupt-list-${width}.png`,
    });
  }

  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(`/reports/${DRIFT_REVIEW_RUN_ID}`);
    const card = page.getByRole("region", { name: "审查汇总被中断（grok在运行中被更新）" });
    await expect(
      page.getByRole("heading", { level: 1, name: /审查未完成（汇总中断）/ }),
    ).toBeVisible();
    await expect(card).toContainText(
      "grok的程序在审查过程中被更新了，为了安全，汇总没有换用新版本接着跑。已完成的 2 路审查结果都还在，可以直接查看。",
    );
    await expect(card).toContainText(
      "用已完成的 2 路结果，以当前安装的grok重新汇总，不会重跑审查。",
    );
    await expect(page.getByRole("main")).not.toContainText("executable drift");
    await expect(page.locator(".ck-wb-run-status")).toHaveText("审查未完成（汇总中断）");
    await expect(page.locator(".ck-wb-report-meta").getByText("2/2 席位已完成")).toBeVisible();
    await expect(card.getByRole("button", { name: "只重跑汇总" })).toBeEnabled();
    await page.screenshot({ path: `${ARTIFACTS}/agg-interrupt-card-${width}.png`, fullPage: true });
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/reports/${DRIFT_REVIEW_RUN_ID}`);
  const liveCard = page.getByRole("region", { name: "审查汇总被中断（grok在运行中被更新）" });
  await liveCard.getByRole("button", { name: "只重跑汇总" }).click();
  await expect(liveCard.getByRole("button", { name: "重跑汇总进行中…" })).toBeVisible();
  await page.screenshot({ path: `${ARTIFACTS}/reaggregate-progress-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(liveCard.getByRole("button", { name: "重跑汇总进行中…" })).toBeVisible();
  await page.screenshot({ path: `${ARTIFACTS}/reaggregate-progress-390.png`, fullPage: true });
  await expect(page.getByRole("heading", { level: 1, name: "审查已完成" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByLabel("审查概览")).toContainText(
    "综合结论：两路已完成的审查都指出支付回调可以合入，没有新的阻塞项。",
  );
  await expect(page.getByRole("main")).not.toContainText("executable drift");
  await page.screenshot({ path: `${ARTIFACTS}/reaggregate-done-390.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${ARTIFACTS}/reaggregate-done-1280.png`, fullPage: true });

  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(`/reports/${SEAT_INTERRUPT_RUN_ID}`);
    await expect(
      page.getByRole("heading", { level: 1, name: /审查未完成（1 路席位中断）/ }),
    ).toBeVisible();
    const banner = page.getByRole("region", { name: "结论不完整" });
    await expect(banner).toContainText("结论不完整：1 路审查没有完成");
    await expect(banner).toContainText("review-security（claude）：2 分钟没有输出。");
    await expect(banner).toContainText(
      "这份报告只汇总了其余 1 路的结果，缺的这几路负责查的问题可能没被发现。",
    );
    await expect(
      page.locator(".ck-wb-document").getByText("未发现阻塞项（结论不完整）").first(),
    ).toBeVisible();
    await expect(
      page.locator(".ck-wb-report-meta").getByText("1/2 席位已完成（缺 1 路）"),
    ).toBeVisible();
    await expect(page.getByLabel("审查概览")).toContainText("综合结论只覆盖了已经写完的正确性席。");
    await expect(page.locator(".ck-wb-run-status")).toHaveText("审查未完成（1 路席位中断）");
    await page.screenshot({
      path: `${ARTIFACTS}/seat-interrupt-banner-${width}.png`,
      fullPage: true,
    });
  }
});
