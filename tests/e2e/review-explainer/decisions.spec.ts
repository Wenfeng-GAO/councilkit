import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { type Locator, type Page, expect, test } from "@playwright/test";
import {
  ASSERTION,
  DECISION,
  FINDING,
  PR_URL,
  ROUTES,
  RUN_ID,
  UI,
  prDecisionsPath,
} from "../../review-explainer/contract";
import { ORIGIN } from "./constants";
import {
  diskSnapshot,
  envSentinel,
  expectDecision,
  installOriginAllowlist,
  openExplainer,
  requireExplainer,
  resetCase,
  restartHost,
  selectFinding,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await installOriginAllowlist(page);
});

/** The trigger is always a real UI action; no business response is intercepted. */
async function choose(page: Page, control: Locator, findingId: string, decision: string) {
  const saved = page.waitForResponse((response) => {
    const request = response.request();
    return (
      response.url().endsWith(ROUTES.decisions(RUN_ID)) &&
      request.method() === "POST" &&
      request.postDataJSON()?.findingId === findingId
    );
  });
  await control.click();
  const response = await saved;
  expect(response.status(), `UI decision ${decision}`).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({ findingId, decision });
  return response;
}

function persisted(home: string) {
  return JSON.parse(readFileSync(prDecisionsPath(home, PR_URL), "utf8")) as {
    items: Record<string, { decision: string }>;
  };
}

test("[A03/A04] summary and explanation decisions share the same persisted choice", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  await openExplainer(page);
  const root = await requireExplainer(page);
  await expect(root.getByRole("radiogroup")).toHaveCount(0);
  await expect(root.getByText(/场景问卷|理由必填|认可度/)).toHaveCount(0);
  await expect(root.locator("textarea[required], input[required]")).toHaveCount(0);
  await selectFinding(page, FINDING.busy);
  const pane = page.getByTestId(UI.drawer);
  await choose(page, pane.getByTestId(UI.willFix), FINDING.busy, DECISION.willFix);
  expect(persisted(seeded.home).items[FINDING.busy]?.decision).toBe(DECISION.willFix);
  await expect(pane.getByTestId(UI.willFix)).toHaveAttribute("aria-pressed", "true");
  await pane.getByRole("tab", { name: "看懂问题", exact: true }).click();
  await pane.getByTestId(UI.original).click();
  await expect(pane).toContainText(ASSERTION.busy);
  await choose(page, pane.getByTestId(UI.wontFix), FINDING.busy, DECISION.wontFix);
  expect(persisted(seeded.home).items[FINDING.busy]?.decision).toBe(DECISION.wontFix);
  await expect(pane.getByTestId(UI.willFix)).toHaveAttribute("aria-pressed", "false");
  await choose(page, pane.getByTestId(UI.undecided), FINDING.busy, DECISION.undecided);
  expect(persisted(seeded.home).items[FINDING.busy]?.decision).toBe(DECISION.undecided);
  await selectFinding(page, FINDING.stale);
  const skip = pane.getByTestId(UI.wontFix);
  await expect(skip).toBeEnabled();
  await skip.focus();
  await expect(skip).toBeFocused();
  const keyboardSave = page.waitForResponse(
    (res) => res.url().endsWith(ROUTES.decisions(RUN_ID)) && res.request().method() === "POST",
  );
  await page.keyboard.press("Enter");
  expect((await keyboardSave).status()).toBe(200);
  expect(persisted(seeded.home).items[FINDING.stale]?.decision).toBe(DECISION.wontFix);
});

test("[A04] UI-saved decisions survive reload, a new browser context, and a real Host PID change on the same home", async ({
  page,
  browser,
}) => {
  const seeded = await resetCase(page);
  await openExplainer(page);
  await selectFinding(page, FINDING.busy);
  await choose(
    page,
    page.getByTestId(UI.drawer).getByTestId(UI.willFix),
    FINDING.busy,
    DECISION.willFix,
  );
  await selectFinding(page, FINDING.stale);
  await choose(
    page,
    page.getByTestId(UI.drawer).getByTestId(UI.wontFix),
    FINDING.stale,
    DECISION.wontFix,
  );
  await page.reload();
  await expectDecision(page, FINDING.busy, DECISION.willFix);
  await expectDecision(page, FINDING.stale, DECISION.wontFix);
  const before = await envSentinel(page);
  const beforeDisk = await diskSnapshot(page);
  expect(before.councilkitHome).toBe(seeded.home);
  expect(persisted(seeded.home).items[FINDING.busy]?.decision).toBe(DECISION.willFix);

  await restartHost(page);
  const after = await envSentinel(page);
  expect(after.pid).not.toBe(before.pid);
  expect(after.councilkitHome).toBe(before.councilkitHome);
  expect((await diskSnapshot(page)).decisions).toEqual(beforeDisk.decisions);
  expect(after.userHomeHash).toBe(before.userHomeHash);

  // New context has neither the old localStorage nor the old session cookies.
  const freshContext = await browser.newContext({ baseURL: ORIGIN });
  try {
    const fresh = await freshContext.newPage();
    await installOriginAllowlist(fresh);
    await openExplainer(fresh);
    await expectDecision(fresh, FINDING.busy, DECISION.willFix);
    await expectDecision(fresh, FINDING.stale, DECISION.wontFix);
    await expectDecision(fresh, FINDING.dup, DECISION.undecided);
  } finally {
    await freshContext.close();
  }
});

test("[A04] a real filesystem failure is shown as unsaved and preserves the last successful decision", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  await openExplainer(page);
  await selectFinding(page, FINDING.busy);
  const comment = page.getByTestId(UI.drawer);
  await choose(page, comment.getByTestId(UI.willFix), FINDING.busy, DECISION.willFix);
  const path = prDecisionsPath(seeded.home, PR_URL);
  const backup = `${path}.e2e-backup`;
  const previous = readFileSync(path, "utf8");
  // A directory cannot be replaced by an atomic file rename, even as root.
  // This avoids chmod tests accidentally passing because of a stale revision.
  renameSync(path, backup);
  mkdirSync(path);
  try {
    const failedSave = page.waitForResponse(
      (res) => res.url().endsWith(ROUTES.decisions(RUN_ID)) && res.request().method() === "POST",
    );
    await comment.getByTestId(UI.wontFix).click();
    expect((await failedSave).status()).toBeGreaterThanOrEqual(400);
    await expect(page.getByTestId(UI.saveError)).toBeVisible();
    await expect(comment.getByTestId(UI.wontFix)).toHaveAttribute("aria-pressed", "false");
    await expectDecision(page, FINDING.busy, DECISION.willFix);
    expect(readFileSync(backup, "utf8")).toBe(previous);
  } finally {
    rmSync(path, { recursive: true, force: true });
    renameSync(backup, path);
  }
  await page.reload();
  await expectDecision(page, FINDING.busy, DECISION.willFix);
  await expect(page.getByTestId(UI.drawer).getByTestId(UI.wontFix)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
