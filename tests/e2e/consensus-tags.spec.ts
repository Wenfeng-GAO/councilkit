/**
 * Locked labels on the report page (#377). One screenshot per case at 1280 and 390.
 * Navigation is the reports list → 全部案件 → the case, the way a reader opens it.
 */
import { mkdirSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import {
  ABSENT_TAG_TITLE,
  CONSENSUS_TAG_TITLE,
  LEGACY_TAG_TITLE,
  PENDING_TAG_TITLE,
  SKIPPED_TAG_TITLE,
  SPEC_TAG_TITLE,
  UNRECORDED_TAG_TITLE,
} from "./consensus-tag-fixtures";

const OUT = "/opt/cursor/artifacts/screenshots";

const CASES = [
  {
    title: SPEC_TAG_TITLE,
    tag: ".ck-tag-spec",
    text: "违反规格 · AC-3",
    basis: "违反了规格里的 AC-3：空串输入必须问候",
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
    text: "缺席：review-cursor（cursor-agent）：运行失败，退出码 1。",
    note: "这份报告只汇总了其余 2 席的结果，缺席的这几席负责查的问题可能没被发现。",
    file: "absent-seat",
    verdict: null,
  },
  {
    title: SKIPPED_TAG_TITLE,
    tag: ".ck-wb-absence",
    text: "缺席：review-correctness（grok）：没有安装 grok。",
    note: "这份报告只汇总了其余 3 席的结果，缺席的这几席负责查的问题可能没被发现。",
    file: "init-skipped-seat",
    verdict: null,
  },
  {
    title: UNRECORDED_TAG_TITLE,
    tag: ".ck-wb-absence",
    text: "缺席：review-maintainability（kimi）：原因未记录，重新运行 councilkit init 可以看到原因。",
    note: "这份报告只汇总了其余 2 席的结果，缺席的这几席负责查的问题可能没被发现。",
    file: "old-config-unrecorded",
    verdict: null,
  },
  {
    title: LEGACY_TAG_TITLE,
    tag: ".ck-wb-absence",
    text: "缺席：review-correctness（grok）：原因未记录，重新运行 councilkit init 可以看到原因。",
    note: "这份报告只汇总了其余 4 席的结果，缺席的这几席负责查的问题可能没被发现。",
    file: "legacy-config",
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
          await expect(
            page.getByText("阻塞依据：违反了规格里的AC-3：空串输入必须问候。"),
          ).toBeVisible();
          await expect(page.getByText(/严重度是重大或致命|不会自动改这项门禁/)).toHaveCount(0);
          await expect(page.getByText("规格合同减法")).toHaveCount(0);
          await expect(page.getByText("合同内 Act On")).toHaveCount(0);
          await expect(page.getByText("不变量 ID")).toHaveCount(0);
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
          await expect(
            page.getByText("没有需要处理的问题，另有 1 条待确认（只有一席提出）。"),
          ).toBeVisible();
          await expect(page.getByText("0 个问题", { exact: true })).toHaveCount(0);
          await expect(page.getByText("这份审查还没有问题记录。")).toHaveCount(0);
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
        if ("note" in item && item.note) {
          const decision = page.getByRole("region", { name: "审查结论" });
          const row = decision.locator(".ck-wb-absence").filter({ hasText: item.text });
          await expect(row).toBeVisible();
          await expect(row).toHaveAttribute("data-absence-icon", "circle-alert");
          await expect(row).not.toContainText("`");
          if (item.text.includes("councilkit init")) {
            await expect(row.locator("code.ck-inline-code")).toHaveText("councilkit init");
          }
          const note = decision.locator(".ck-wb-absence-note");
          await expect(note).toHaveText(item.note);
          const colors = await note.evaluate((el) => {
            const read = (token: string) => {
              const probe = document.createElement("span");
              probe.style.color = token;
              el.appendChild(probe);
              const value = getComputedStyle(probe).color;
              probe.remove();
              return value;
            };
            return {
              color: getComputedStyle(el).color,
              secondary: read("var(--ck-secondary)"),
              text: read("var(--ck-text)"),
            };
          });
          expect(colors.color).toBe(colors.secondary);
          expect(colors.color).not.toBe(colors.text);
          await expect(decision.getByText(/review-security|未找到 cld|cld/)).toHaveCount(0);
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
