import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ASSERTION, DECISION, FINDING, ROUTES, RUN_ID, UI } from "../../review-explainer/contract";
import {
  expectDecision,
  installOriginAllowlist,
  openExplainer,
  resetCase,
  selectFinding,
} from "./helpers";

test("[A06] UI choices export only the selected repair and its original acceptance evidence", async ({
  page,
}) => {
  await installOriginAllowlist(page);
  const seeded = await resetCase(page);
  await openExplainer(page);
  for (const [id, button, decision] of [
    [FINDING.busy, UI.willFix, DECISION.willFix],
    [FINDING.stale, UI.wontFix, DECISION.wontFix],
  ] as const) {
    await selectFinding(page, id);
    const save = page.waitForResponse(
      (res) => res.url().endsWith(ROUTES.decisions(RUN_ID)) && res.request().method() === "POST",
    );
    await page.getByTestId(UI.drawer).getByTestId(button).click();
    const response = await save;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toMatchObject({ findingId: id, decision });
  }
  await expectDecision(page, FINDING.busy, DECISION.willFix);
  await expectDecision(page, FINDING.stale, DECISION.wontFix);
  await expectDecision(page, FINDING.dup, DECISION.undecided);

  const exportResponse = page.waitForResponse(
    (res) => res.url().endsWith(ROUTES.repairPackage(RUN_ID)) && res.request().method() === "GET",
  );
  await page
    .getByTestId(UI.root)
    .getByRole("button", { name: "导出修复清单", exact: true })
    .click();
  const response = await exportResponse;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    data: { findings: Array<{ id: string; evidence: string }>; [key: string]: unknown };
  };
  expect(body.data.findings.map((row) => row.id)).toEqual([FINDING.busy]);
  expect(body.data.findings[0]?.evidence).toContain(ASSERTION.busyCounterexample);
  expect(JSON.stringify(body.data)).toContain(ASSERTION.busyExpected);
  expect(JSON.stringify(body.data)).toContain(seeded.headSha);
  expect(JSON.stringify(body.data)).not.toContain("verified_closed");

  const ledger = JSON.parse(
    readFileSync(join(seeded.home, "runs", RUN_ID, "findings.json"), "utf8"),
  ) as {
    findings: Array<{ id: string; status: string; verification?: { status?: string } }>;
  };
  const original = ledger.findings.find((row) => row.id === FINDING.busy);
  expect(original?.status).not.toBe("closed");
  expect(original?.verification?.status).not.toBe("verified_closed");

  // Removing the only selection must also remove it from the next exported scope.
  await selectFinding(page, FINDING.busy);
  const withdrawal = page.waitForResponse(
    (res) => res.url().endsWith(ROUTES.decisions(RUN_ID)) && res.request().method() === "POST",
  );
  await page.getByTestId(UI.drawer).getByTestId(UI.undecided).click();
  expect((await withdrawal).status()).toBe(200);
  await expect(page.getByTestId(UI.drawer).getByTestId(UI.willFix)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(
    page.getByTestId(UI.root).getByRole("button", { name: "导出修复清单", exact: true }),
  ).toBeDisabled();
  const empty = await page.request.get(ROUTES.repairPackage(RUN_ID));
  expect(empty.status()).toBe(400);
  const emptyBody = (await empty.json()) as { error: { message: string }; data?: unknown };
  expect(emptyBody.error.message).toMatch(/选择.*修复|no.*selected/i);
  expect(emptyBody.data).toBeUndefined();
});
