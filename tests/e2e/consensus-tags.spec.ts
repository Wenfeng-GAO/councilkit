/**
 * Locked labels on the report page (#377). One screenshot per case at 1280 and 390.
 * Navigation is the reports list → 全部案件 → the case, the way a reader opens it.
 */
import { mkdirSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import {
  ABSENT_TAG_TITLE,
  CONSENSUS_TAG_TITLE,
  PENDING_TAG_TITLE,
  SPEC_TAG_TITLE,
} from "./consensus-tag-fixtures";

const OUT = "/opt/cursor/artifacts/screenshots";

const CASES = [
  {
    title: SPEC_TAG_TITLE,
    tag: ".ck-tag-spec",
    text: "违反规格 · AC-3",
    file: "spec-violation",
    verdict: "ck-verdict-changes",
  },
  {
    title: CONSENSUS_TAG_TITLE,
    tag: ".ck-tag-consensus",
    text: "多席一致 2/3",
    basis: "无规格依据，依据是 2/3 席一致：kimi、cursor",
    file: "consensus-majority",
    verdict: "ck-verdict-changes",
  },
  {
    title: PENDING_TAG_TITLE,
    tag: ".ck-tag-pending",
    text: "待确认 · kimi",
    file: "pending-single-seat",
    verdict: null,
  },
  {
    title: ABSENT_TAG_TITLE,
    tag: ".ck-wb-absence",
    text: "缺席：review-security（未找到 cld）",
    file: "absent-seat",
    verdict: null,
  },
] as const;

async function openFromLibrary(page: Page, title: string): Promise<void> {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "审查与报告" })).toBeVisible();
  await page.getByRole("button", { name: /全部案件/ }).click();
  const card = page.locator(".ck-case-card", { has: page.getByRole("heading", { name: title }) });
  await expect(card).toBeVisible();
  await card.getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(/\/reports\/ck-review-/);
  await expect(page.getByRole("region", { name: "审查结论" })).toBeVisible();
}

test.describe("locked report labels", () => {
  for (const item of CASES) {
    for (const width of [1280, 390] as const) {
      test(`${item.file} at ${width}`, async ({ page }) => {
        mkdirSync(OUT, { recursive: true });
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await openFromLibrary(page, item.title);
        const tag = page.locator(item.tag).filter({ hasText: item.text }).first();
        await expect(tag).toBeVisible();
        if (item.file === "spec-violation") {
          await expect(page.getByText("空串分支被删除").first()).toBeVisible();
        }
        if (item.file === "consensus-majority") {
          await expect(page.getByText("Add 把加法改成减法").first()).toBeVisible();
          await expect(page.getByText(/阻塞依据：未绑定规格/)).toBeVisible();
          await expect(page.getByText("规格合同减法")).toHaveCount(0);
        }
        if (item.file === "spec-violation") {
          await expect(page.getByText(/阻塞依据（规格合同减法）/)).toBeVisible();
          await expect(page.getByText("未绑定规格")).toHaveCount(0);
        }
        if ("basis" in item && item.basis) {
          await expect(
            page.locator(".ck-tag-basis").filter({ hasText: item.basis }).first(),
          ).toBeVisible();
        }
        if (item.verdict) {
          await expect(page.locator(`.${item.verdict}`).first()).toBeVisible();
        }
        if (item.file === "pending-single-seat") {
          await expect(page.locator(".ck-tag-spec")).toHaveCount(0);
          await expect(page.locator(".ck-tag-consensus")).toHaveCount(0);
          await expect(page.getByText("账本无阻塞")).toBeVisible();
          await expect(page.getByText("账本未生成")).toHaveCount(0);
          const card = page.getByRole("region", { name: "待确认" });
          await expect(card.getByText("待确认 · kimi")).toBeVisible();
          await expect(card.getByText("位置：")).toBeVisible();
          const cardText = await card.innerText();
          expect(cardText.split("\n").some((line) => /减法/.test(line) && /位置/.test(line))).toBe(
            false,
          );
        }
        if (item.file === "absent-seat") {
          const decision = page.getByRole("region", { name: "审查结论" });
          await expect(decision.getByText("缺席：review-security（未找到 cld）")).toBeVisible();
          await expect(decision.getByText("缺席：cursor（运行失败，退出码 1）")).toBeVisible();
          await expect(decision.getByText(/non-zero|exit/i)).toHaveCount(0);
        }
        await tag.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${OUT}/${item.file}-${width}.png`,
          fullPage: true,
        });
      });
    }
  }
});
