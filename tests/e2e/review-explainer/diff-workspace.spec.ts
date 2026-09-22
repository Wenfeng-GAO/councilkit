import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type Locator, type Page, expect, test } from "@playwright/test";
import { ROUTES, RUN_ID, UI, encodeFileKey } from "../../review-explainer/contract";
import {
  BUSY_SNIPPET,
  DELETED_SNIPPET,
  DUP_SNIPPET,
  HIDDEN_CONTEXT_SNIPPET,
  JAVA_SNIPPET,
  README_SNIPPET,
  RENAME_SNIPPET,
  SAMPLE_EXPECT,
  STALE_SNIPPET,
} from "../../review-explainer/fixtures/sample-diff";
import {
  FINDING,
  installOriginAllowlist,
  openExplainer,
  requireExplainer,
  resetCase,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await installOriginAllowlist(page);
});

/** Visibility alone does not detect a sticky heading or drawer covering the code. */
async function expectUncovered(locator: Locator, page: Page) {
  await expect(locator).toBeVisible();
  await expect
    .poll(async () =>
      locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const left = Math.max(0, rect.left);
        const right = Math.min(innerWidth, rect.right);
        const top = Math.max(0, rect.top);
        const bottom = Math.min(innerHeight, rect.bottom);
        if (right - left < 8 || bottom - top < 8 || rect.top < 0 || rect.bottom > innerHeight)
          return false;
        const x = left + Math.min(80, (right - left) / 2);
        return [top + 2, (top + bottom) / 2, bottom - 2].every((y) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === element || element.contains(hit));
        });
      }),
    )
    .toBe(true);
  const target = await locator.boundingBox();
  expect(target).toBeTruthy();
  const drawer = await page.getByTestId(UI.drawer).boundingBox();
  // A desktop side inspector is not a bottom drawer: compare only intersecting x ranges.
  if (
    target &&
    drawer &&
    target.x < drawer.x + drawer.width &&
    target.x + target.width > drawer.x
  ) {
    expect(target.y + target.height).toBeLessThanOrEqual(drawer.y);
  }
}

test("[A01] every frozen file and hunk remains readable in both layouts, including uncommented changes", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  const frozen = readFileSync(join(seeded.home, "runs", RUN_ID, "review-context.diff"), "utf8");
  const hunkCount = frozen.split("\n").filter((line) => line.startsWith("@@ ")).length;
  await openExplainer(page);
  const root = await requireExplainer(page);
  await expect(page.getByTestId(UI.identity)).toContainText(seeded.headSha.slice(0, 12));
  await expect(page.getByTestId(UI.identity)).toContainText(seeded.baseSha.slice(0, 12));
  for (const file of SAMPLE_EXPECT.files) {
    await expect(page.getByTestId(UI.fileRow(file.path))).toBeVisible();
  }
  for (const layout of [UI.layoutSplit, UI.layoutUnified]) {
    await page.getByTestId(layout).click();
    for (const [path, text] of [
      ["README.md", README_SNIPPET],
      ["tests/WideCoverage.java", JAVA_SNIPPET],
      ["src/renamed.go", RENAME_SNIPPET],
      ["src/deleted.go", DELETED_SNIPPET],
      ["src/recovery.go", STALE_SNIPPET],
    ] as const) {
      await page.getByTestId(UI.fileRow(path)).click();
      await expect(page.getByTestId(UI.diff)).toContainText(text);
    }
    await expect(root.getByTestId(/^review-explainer-hunk-/)).toHaveCount(hunkCount);
    await expect(page.getByTestId(UI.line("new", "src/busy.go", seeded.busyNewLine))).toContainText(
      BUSY_SNIPPET,
    );
    await expect(
      page.getByTestId(UI.line("old", "src/deleted.go", seeded.deletedOldLine)),
    ).toContainText(DELETED_SNIPPET);
    await expect(
      page.getByTestId(UI.line("new", "src/deleted.go", seeded.deletedOldLine)),
    ).toHaveCount(0);
    await expect(
      page.getByTestId(UI.line("old", "src/recovery.go", seeded.staleNewLine)),
    ).toHaveCount(0);
    await expect(
      page.getByTestId(UI.line("new", "src/recovery.go", seeded.dupNewLine)),
    ).toContainText(DUP_SNIPPET);
  }
  await page.getByTestId(UI.fileRow("src/recovery.go")).click();
  await expect(page.getByTestId(UI.oldAbsent)).toBeVisible();
  await expect(page.getByTestId(UI.oldAbsent)).toContainText(/新增|旧版本.*不存在|旧侧.*不存在/);
  await page.getByTestId(UI.fileRow("assets/icon.bin")).click();
  await expect(page.getByTestId(UI.binary)).toBeVisible();
  await expect(page.getByTestId(UI.binary)).toContainText(/二进制|binary/i);
  await expect(page.getByTestId(UI.line("new", "assets/icon.bin", 1))).toHaveCount(0);
});

test("[A02] a frozen old-side comment stays on deleted code and missing references remain discoverable", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  await openExplainer(page);
  await page.getByTestId(UI.comment(FINDING.deleted)).click();
  const oldLine = page.getByTestId(UI.line("old", "src/deleted.go", seeded.deletedOldLine));
  await expect(oldLine).toContainText(DELETED_SNIPPET);
  await expectUncovered(oldLine, page);
  await page.getByTestId(UI.comment(FINDING.unanchored)).click();
  const missing = page.getByTestId(UI.unanchored);
  await expect(missing).toBeVisible();
  await expect(missing).toContainText(/待定位|未定位/);
  await expect(missing).toContainText("src/missing.go");
  await expect(page.getByTestId(UI.line("new", "src/missing.go", 999))).toHaveCount(0);
});

test("[A02] opening associated context reads actual frozen source outside the diff without adding a hunk", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  const frozen = readFileSync(join(seeded.home, "runs", RUN_ID, "review-context.diff"), "utf8");
  expect(frozen).not.toContain(HIDDEN_CONTEXT_SNIPPET);
  await openExplainer(page);
  const hunkCount = await page
    .getByTestId(UI.root)
    .getByTestId(/^review-explainer-hunk-/)
    .count();
  await page.getByTestId(UI.comment(FINDING.busy)).click();
  const contextResponse = page.waitForResponse(
    (res) =>
      res.url().includes(ROUTES.fileContent(RUN_ID, encodeFileKey("src/busy.go"))) &&
      res.request().method() === "GET" &&
      new URL(res.url()).searchParams.get("side") === "new",
  );
  await page.getByRole("button", { name: "查看关联上下文", exact: true }).click();
  const response = await contextResponse;
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain(HIDDEN_CONTEXT_SNIPPET);
  const contextLine = page.getByTestId(UI.line("new", "src/busy.go", seeded.busyContextLine));
  await expect(contextLine).toContainText(HIDDEN_CONTEXT_SNIPPET);
  await expectUncovered(contextLine, page);
  await expect(page.getByTestId(UI.root).getByTestId(/^review-explainer-hunk-/)).toHaveCount(
    hunkCount,
  );
});

for (const width of [1440, 678, 390]) {
  test(`[A09] ${width}px keeps each selected code line and inline opinion outside header/drawer overlays`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 863 });
    const seeded = await resetCase(page);
    await openExplainer(page);
    for (const [id, path, number, text] of [
      [FINDING.busy, "src/busy.go", seeded.busyNewLine, BUSY_SNIPPET],
      [FINDING.stale, "src/recovery.go", seeded.staleNewLine, STALE_SNIPPET],
      [FINDING.dup, "src/recovery.go", seeded.dupNewLine, DUP_SNIPPET],
    ] as const) {
      const comment = page.getByTestId(UI.comment(id));
      await comment.getByTestId(UI.understand).click();
      await expect(page.getByTestId(UI.drawer)).toBeVisible();
      const line = page.getByTestId(UI.line("new", path, number));
      await expect(line).toContainText(text);
      await expectUncovered(line, page);
      // The title of the inline card, rather than its possibly tall expanded contents.
      await expect(comment).toBeVisible();
      const commentBox = await comment.boundingBox();
      const drawerBox = await page.getByTestId(UI.drawer).boundingBox();
      expect(commentBox).toBeTruthy();
      if (width < 1000 && commentBox && drawerBox) {
        expect(commentBox.y).toBeGreaterThanOrEqual(0);
        expect(commentBox.y + Math.min(28, commentBox.height)).toBeLessThanOrEqual(drawerBox.y);
      }
      await page
        .getByTestId(UI.drawer)
        .getByRole("button", { name: "返回代码", exact: true })
        .click();
      await expect(page.getByTestId(UI.drawer)).toBeHidden();
      await expectUncovered(line, page);
      for (const layout of [UI.layoutUnified, UI.layoutSplit]) {
        await page.getByTestId(layout).click();
        await expect(line).toContainText(text);
        await expectUncovered(line, page);
      }
    }
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`anchors-${width}.png`),
      fullPage: false,
    });
  });
}

test("[A01] a missing frozen artifact is visibly unavailable instead of being replaced with invented code", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  const path = join(seeded.home, "runs", RUN_ID, "review-context.diff");
  const backup = `${path}.e2e-backup`;
  renameSync(path, backup);
  try {
    await openExplainer(page);
    await expect(page.getByTestId(UI.missing)).toBeVisible();
    await expect(page.getByTestId(UI.missing)).toContainText(/缺失|不可用|missing|unavailable/i);
    await expect(page.getByTestId(UI.line("new", "src/busy.go", seeded.busyNewLine))).toHaveCount(
      0,
    );
  } finally {
    renameSync(backup, path);
  }
});
