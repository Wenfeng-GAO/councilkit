import { type Page, expect, test } from "@playwright/test";

/**
 * Reports-page case filters E2E (search × status × kind AND semantics,
 * representative-status truthfulness, facet counts, archived-runs filter).
 *
 * Fixtures live in tests/e2e/host-entry.mts (E2E home, isolated Host port):
 *   PR 901 review: old failed + new completed      — done, never attention
 *   PR 912 squad : old completed + new running    — active
 *   PR 913 squad : awaiting orchestration         — attention + active
 *   PR 914 squad : interrupted                    — attention, never done
 *   repair-only   : completed                     — done under 工程班
 *   repair-only   : completed + needs_attention   — attention, never done
 *   PR 916 mixed  : completed review + failed squad
 *   PR 999 review : failed junk, listed in archived-runs.json — never listed
 *   e2e-fixture-review: started review without a terminal event, running
 */

const ARCHIVED_RUN_ID = "ck-review-10000000-0000-4000-8000-00000000aa01";

const cards = (page: Page) => page.locator(".ck-case-card");
const cardOf = (page: Page, title: string) =>
  cards(page).filter({ has: page.locator("h3", { hasText: title }) });

async function openList(page: Page): Promise<void> {
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "审查与报告" })).toBeVisible();
  // 等列表数据落地，避免与 refetch 竞态。
  await expect(page.getByRole("button", { name: /全部案件/ })).toHaveText(/^全部案件\s*8$/);
}

async function clickStatus(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("button", { name }).click();
}

// 类型徽标文案互相包含（“审查”是“审查与工程班”的前缀），正则匹配会
// 同时命中两个按钮，因此按固定顺序定位：[all, review, squad]。
const KIND_ORDER = ["all", "review", "squad"] as const;
type KindId = (typeof KIND_ORDER)[number];
const kindButton = (page: Page, id: KindId) =>
  page.locator(".ck-library-kinds button").nth(KIND_ORDER.indexOf(id));

async function clickKind(page: Page, id: KindId): Promise<void> {
  await kindButton(page, id).click();
  await expect(kindButton(page, id)).toHaveAttribute("aria-pressed", "true");
}

async function kindBadge(page: Page, id: KindId): Promise<number> {
  return Number(await kindButton(page, id).locator("span").innerText());
}

async function badge(page: Page, name: RegExp): Promise<number> {
  return Number(
    await page
      .locator(".ck-library-filters")
      .getByRole("button", { name })
      .locator("span")
      .innerText(),
  );
}

test("attention 视图以最新代表 run 判定：旧失败不污染新完成", async ({ page }) => {
  await openList(page);
  await expect(cards(page)).toHaveCount(6);
  await expect(cardOf(page, "PR #912")).toBeVisible();
  await expect(cardOf(page, "PR #913")).toBeVisible();
  await expect(cardOf(page, "PR #914")).toBeVisible();
  await expect(cardOf(page, "e2e-case/pr916 #916")).toBeVisible();
  await expect(cardOf(page, "e2e-fixture-review")).toBeVisible();
  await expect(cardOf(page, "e2e-case/pr901 #901")).toHaveCount(0);
  await expect(cardOf(page, "Archived Junk")).toHaveCount(0);
});

test("已完成筛选基于代表记录：PR901 旧失败后有新完成也算完成", async ({ page }) => {
  await openList(page);
  await clickStatus(page, /^已完成/);
  await expect(cards(page)).toHaveCount(2);
  await expect(cardOf(page, "e2e-case/pr901 #901")).toContainText("已完成");
  await expect(cards(page).filter({ hasText: "ck-repair-10000000" })).toContainText("已完成");
  // 反例：repair run completed 但 businessResult=needs_attention，不算完成。
  await expect(cards(page).filter({ hasText: "ck-repair-20000000" })).toHaveCount(0);
});

test("进行中筛选排除断开的旧记录完成/失败", async ({ page }) => {
  await openList(page);
  await clickStatus(page, /^进行中/);
  await expect(cards(page)).toHaveCount(3);
  await expect(cardOf(page, "e2e-fixture-review")).toBeVisible();
  await expect(cardOf(page, "PR #912")).toContainText("席位进行中");
  await expect(cardOf(page, "PR #913")).toContainText("等待编排");
  await expect(cardOf(page, "PR #914")).toHaveCount(0);
});

test("工程班包含 repair-only 案件；混合案件按所选类型呈现", async ({ page }) => {
  await openList(page);
  await clickStatus(page, /^全部案件/);
  await clickKind(page, "squad");
  await expect(cards(page)).toHaveCount(6);
  await expect(cards(page).filter({ hasText: "ck-repair-10000000" })).toHaveCount(1);
  await expect(cardOf(page, "e2e-case/pr916 #916")).toContainText("失败");
  await expect(cardOf(page, "e2e-case/pr916 #916")).toContainText("工程班");
  // 纯 repair 案件归工程班；业务否决的 repair 显示需要处理而不是已完成。
  const naRepair = cards(page).filter({ hasText: "ck-repair-20000000" });
  await expect(naRepair).toHaveCount(1);
  await expect(naRepair).toContainText("需要处理");
});

test("审查类型下混合案件呈现审查记录，不出现工程班状态", async ({ page }) => {
  await openList(page);
  await clickStatus(page, /^全部案件/);
  await clickKind(page, "review");
  await expect(cards(page)).toHaveCount(3);
  const mixed = cardOf(page, "e2e-case/pr916 #916");
  await expect(mixed).toContainText("已完成");
  await expect(mixed).toContainText("审查");
  await expect(mixed).not.toContainText("工程班");
});

test("类型筛选下的状态计数基于该类型范围", async ({ page }) => {
  await openList(page);
  await clickStatus(page, /^全部案件/);
  await clickKind(page, "review");
  await expect(await badge(page, /^需要处理/)).toBe(1);
  await expect(await badge(page, /^已完成/)).toBe(2);
  await expect(await badge(page, /^全部案件/)).toBe(3);
});

test("状态筛选下的类型计数与点选后的可见卡片一致", async ({ page }) => {
  await openList(page);
  const engAttention = await kindBadge(page, "squad");
  await clickKind(page, "squad");
  await expect(cards(page)).toHaveCount(engAttention);
  await expect(await badge(page, /^需要处理/)).toBe(engAttention);
  const visibleAfterStatus = await kindBadge(page, "review");
  await clickKind(page, "review");
  await expect(cards(page)).toHaveCount(visibleAfterStatus);
});

test("搜索与状态/类型 AND 组合，搜索不绕过筛选", async ({ page }) => {
  await openList(page);
  await page.getByLabel("搜索报告").fill("pr901");
  // 默认 attention：PR901 已由记录修复均为完成，不能出现。
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByText("没有找到匹配案件")).toBeVisible();
  // 搜索中的状态徽标 = 假如点开的可见卡片数：pr901 只有完成一档。
  await expect(await badge(page, /^全部案件/)).toBe(1);
  await expect(await badge(page, /^已完成/)).toBe(1);
  await expect(await badge(page, /^进行中/)).toBe(0);
  await expect(await badge(page, /^需要处理/)).toBe(0);
  await clickStatus(page, /^已完成/);
  await expect(cards(page)).toHaveCount(1);
  await expect(cardOf(page, "e2e-case/pr901 #901")).toBeVisible();
  // 类型计数同样受搜索与当前状态约束，并且等于切换后的可见卡片数。
  await expect(await kindBadge(page, "all")).toBe(1);
  await expect(await kindBadge(page, "review")).toBe(1);
  await expect(await kindBadge(page, "squad")).toBe(0);
  await clickStatus(page, /^进行中/);
  await expect(cards(page)).toHaveCount(0);
});

test("搜索不会把创意/讨论案件注入审查清单", async ({ page }) => {
  await openList(page);
  await page.getByLabel("搜索报告").fill("fixture-ideate");
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /另有 1 条创意讨论/ })).toBeVisible();
  // 工作台外案件命中搜索：所有 facet 徽标一并归零。
  await expect(await badge(page, /^全部案件/)).toBe(0);
  await expect(await badge(page, /^需要处理/)).toBe(0);
  await expect(await kindBadge(page, "all")).toBe(0);
});

test("列表标题显示可见/总数据口径", async ({ page }) => {
  await openList(page);
  await clickKind(page, "squad");
  await expect(page.getByRole("heading", { name: "案件" })).toContainText(/ \/ 8$/);
  await expect(await badge(page, /^需要处理/)).toBe(5);
  await expect(cards(page)).toHaveCount(5);
  await expect(page.getByRole("heading", { name: "案件" })).toContainText("5 / 8");
});

test("归档 run 不出现在清单，但直接详情可读", async ({ page }) => {
  await openList(page);
  await clickStatus(page, /^全部案件/);
  await expect(cards(page)).toHaveCount(8);
  await expect(cards(page).filter({ hasText: "e2e-case/pr999" })).toHaveCount(0);
  await page.goto(`/reports/${ARCHIVED_RUN_ID}`);
  await page.getByRole("region", { name: "原始汇总报告" }).locator("summary").click();
  await expect(page.getByRole("heading", { name: "Archived Junk Review" })).toBeVisible();
  await expect(page.getByText("direct detail read must still work", { exact: true })).toBeVisible();
});
