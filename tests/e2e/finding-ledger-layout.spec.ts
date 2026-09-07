import { expect, test } from "@playwright/test";

const runId = "ck-review-00000000-0000-4000-8000-0000000000e4";
const run = {
  runId,
  kind: "review",
  status: "completed",
  title: "Ledger layout",
  startedAt: null,
  endedAt: null,
  hasReport: true,
  reportUrl: `/reports/${runId}`,
  progress: null,
  markdown: "# Review",
  truncated: false,
  findings: [
    {
      id: "python.piston._api.jsonutil.py--metadata-preservation",
      title: "Python 未声明扩展字段被静默改写",
      text: "Metadata is rewritten",
      severity: "major",
      status: "open",
      source: "unique",
      reviewer: null,
      files: [],
      verification: {
        outcome: "still_open",
        candidateSha: "a".repeat(40),
        runId,
        attemptId: "attempt-0",
        reviewer: "gpt-6-astra · 1",
        method: "regression_test",
        command: `python /${"long-path-".repeat(100)}/check_python.py`,
        reason: "模型未知扩展字段被静默改写。",
        evidence: `原字段应完整保留。${"unbroken-evidence".repeat(100)}`,
        runComplete: true,
      },
    },
  ],
};

for (const width of [1440, 900, 390]) {
  test(`展开验证依据不挤压标题、标签或溢出（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route(`**/api/v1/cli-runs/${runId}`, (route) =>
      route.fulfill({ json: { ok: true, data: run } }),
    );
    await page.route("**/api/v1/cli-runs", (route) =>
      route.fulfill({ json: { ok: true, data: { runs: [] } } }),
    );
    await page.goto(`/reports/${runId}`);
    const row = page.locator(".ck-ledger-row").first();
    await expect(row).toBeVisible();
    const before = await row.locator(".ck-ledger-title").boundingBox();
    const badgeBefore = await row.locator(".ck-sev").boundingBox();
    await row.locator("summary").click();
    await expect(row.locator("details")).toHaveAttribute("open", "");
    const after = await row.locator(".ck-ledger-title").boundingBox();
    const badgeAfter = await row.locator(".ck-sev").boundingBox();
    if (!before || !after || !badgeBefore || !badgeAfter)
      throw new Error("Missing finding row layout");
    expect(Math.abs(after.width - before.width)).toBeLessThan(1);
    expect(Math.abs(badgeAfter.width - badgeBefore.width)).toBeLessThan(1);
    expect(badgeAfter.width).toBeLessThan(70);
    const details = await row.locator("details").boundingBox();
    const parent = await row.boundingBox();
    if (!details || !parent) throw new Error("Missing verification layout");
    expect(Math.abs(details.width - parent.width)).toBeLessThan(1);
    expect(details.y).toBeGreaterThanOrEqual(after.y + after.height);
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.locator("main").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
      true,
    );
    await row.locator("summary").click();
    await expect(row.locator("details")).not.toHaveAttribute("open");
  });
}
