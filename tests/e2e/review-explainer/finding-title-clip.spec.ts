import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FINDING, RUN_ID, UI } from "../../review-explainer/contract";
import { installOriginAllowlist, openExplainer, resetCase, selectFinding } from "./helpers";

const CLIPPED = `${"a".repeat(118)}…`;
const TITLE = `${"a".repeat(118)}😀z`;

test.beforeEach(async ({ page }) => {
  await installOriginAllowlist(page);
});

test("a long finding title stays on a whole emoji", async ({ page }) => {
  const seeded = await resetCase(page);
  const path = join(seeded.home, "runs", RUN_ID, "findings.json");
  const ledger = JSON.parse(readFileSync(path, "utf8")) as {
    findings: Array<{ id: string; title: string }>;
  };
  const row = ledger.findings.find((finding) => finding.id === FINDING.busy);
  if (!row) throw new Error("missing busy finding");
  row.title = TITLE;
  writeFileSync(path, JSON.stringify(ledger));

  await openExplainer(page);
  const rowTitle = page
    .getByTestId(`review-explainer-finding-${FINDING.busy}`)
    .locator(".ck-ex-issue-title");
  await expect(rowTitle).toHaveText(CLIPPED);
  await selectFinding(page, FINDING.busy);
  const heading = page.getByTestId(UI.drawer).locator("h2[title]");
  await expect(heading).toHaveText(CLIPPED);
  await expect(heading).toHaveAttribute("title", TITLE);
  await page.screenshot({
    path: test.info().outputPath("finding-title-emoji.png"),
    fullPage: false,
  });
});
