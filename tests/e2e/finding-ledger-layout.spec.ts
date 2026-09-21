import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";

const SHA = "9".repeat(40);
const LAYOUT_ID = "ck-review-00000000-0000-4000-8000-0000000000e4";
const CASE_ID = "ck-review-00000000-0000-4000-8000-0000000000e5";
const PRIOR_ID = "ck-review-00000000-0000-4000-8000-0000000000e6";
const EMPTY_ID = "ck-review-00000000-0000-4000-8000-0000000000e7";
const HOLLOW_ID = "ck-review-00000000-0000-4000-8000-0000000000e9";
const HOLLOW_REVIEW_ID = "ck-review-00000000-0000-4000-8000-0000000000ea";

const ARTIFACTS = process.env.CK_ARTIFACTS_DIR;

function finding(partial: {
  id: string;
  title: string;
  severity: "critical" | "major" | "minor" | "nit";
  text?: string;
  reviewer?: string | null;
  files?: string[];
  source?: "consensus" | "unique" | "unknown";
  status?: "open" | "closed" | "accepted" | "regress";
}) {
  return {
    status: "open" as const,
    source: "unique" as const,
    reviewer: null,
    files: [],
    text: partial.title,
    ...partial,
  };
}

const layoutRun = {
  runId: LAYOUT_ID,
  kind: "review",
  status: "completed",
  title: "Ledger layout",
  startedAt: null,
  endedAt: null,
  hasReport: true,
  reportUrl: `/reports/${LAYOUT_ID}`,
  progress: null,
  markdown: "# Review",
  truncated: false,
  findings: [
    {
      id: "python.piston._api.jsonutil.py--metadata-preservation",
      title:
        `Python 未声明扩展字段被静默改写。${"这是一段不应出现在折叠行里的超长证据描述，".repeat(16)}`.slice(
          0,
          400,
        ),
      text: "Metadata is rewritten",
      severity: "major",
      status: "open",
      source: "unique",
      reviewer: null,
      files: [],
      verification: {
        outcome: "still_open",
        candidateSha: "a".repeat(40),
        runId: LAYOUT_ID,
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

function caseFindings() {
  const rows = [
    finding({
      id: "recovery.go--266-271-ctx",
      severity: "major",
      reviewer: "review-adversarial",
      files: ["recovery.go"],
      title: "`recovery.go:266-271` — Resume 失败只看 `ctx.Err()`，不看 `flightCurrent`。",
    }),
    finding({
      id: "recovery.go--311-362-fence",
      severity: "major",
      reviewer: "review-adversarial",
      files: ["recovery.go"],
      title:
        "`recovery.go:311-362` — fence 在 `UpdateSession` 回调内；commit idle 后不再复核 occupancy。",
    }),
    finding({
      id: "recovery.go--357-uuid-close",
      severity: "major",
      reviewer: "review-correctness",
      files: ["recovery.go"],
      title:
        "`recovery.go:357` — Resume 成功、提交 idle 遇到临时存储错误时 `closeOpenedOn` + `markRecoveryFailed`（UUID 仍在）。改用 `forgetOpenedOn`。",
    }),
    finding({
      id: "pkg.runtime.recovery.go--357-uuid",
      severity: "major",
      reviewer: "review-correctness",
      files: ["pkg/runtime/recovery.go"],
      title:
        "pkg/runtime/recovery.go:357 — 原 UUID Resume 成功、提交 idle 遇到临时存储错误时 Close，却保留 UUID 为 error。改用 `forgetOpenedOn`。",
    }),
  ];
  for (let i = 0; i < 12; i += 1) {
    rows.push(
      finding({
        id: `minor-${i}`,
        severity: "minor",
        title: `notes.go:${10 + i} — 次要记录 ${i} \`tokenMinor${i}\`。`,
        files: ["notes.go"],
      }),
    );
  }
  for (let i = 0; i < 8; i += 1) {
    rows.push(
      finding({
        id: `nit-${i}`,
        severity: "nit",
        title: `docs.md:${20 + i} — 琐碎记录 ${i} \`tokenNit${i}\`。`,
        files: ["docs.md"],
      }),
    );
  }
  return rows;
}

const caseMarkdown = `# Autonomous Review Report

- Run: ${CASE_ID}
- Status: complete

---

前言：阻塞集中在恢复补偿与热重启竞争。

## 概览

三位审查者对照同一冻结提交。阻塞结论来自补偿路径与 fence，不是风格分歧。

## 共识发现

- [minor] 共识项只作来源，不单独再列一份待办。

## 独有发现

- [major] recovery.go:357 关闭原 UUID。
- [major] recovery.go:266-271 只看 ctx.Err()。
- [major] recovery.go:311-362 fence 不复核。

## 分歧

- **结论票**：正确性与对抗要求改动；其余为 comment。

## 结论

changes-requested
`;

const caseRun = {
  runId: CASE_ID,
  kind: "review",
  status: "completed",
  title: "Unified problem list fixture",
  startedAt: null,
  endedAt: null,
  hasReport: true,
  reportUrl: `/reports/${CASE_ID}`,
  progress: {
    phase: "done",
    updatedAt: new Date().toISOString(),
    attempts: [
      {
        attemptId: "attempt-0",
        agentName: "review-correctness",
        driverId: "codex-app-server",
        modelId: "gpt-6-astra",
        role: "attempt",
        status: "success",
        durationMs: 1000,
      },
    ],
  },
  markdown: caseMarkdown,
  truncated: false,
  reviewEvidence: {
    complete: true,
    sha: SHA,
    prUrl: "https://github.com/example/repo/pull/9",
    againstRunId: null,
    blockingIds: ["recovery.go--266-271-ctx"],
    unverifiedFixIds: [],
    openIds: ["recovery.go--266-271-ctx"],
    evidenceComplete: true,
  },
  findings: caseFindings(),
};

const priorRun = {
  runId: PRIOR_ID,
  kind: "review",
  status: "completed",
  title: "Prior review",
  startedAt: null,
  endedAt: null,
  hasReport: true,
  hasFindings: true,
  reportUrl: `/reports/${PRIOR_ID}`,
  progress: null,
  markdown: "# Autonomous Review Report\n\n## 结论\n\ncomment\n",
  truncated: false,
  reviewEvidence: {
    complete: true,
    sha: SHA,
    prUrl: "https://github.com/example/repo/pull/9",
    againstRunId: null,
    blockingIds: ["keep"],
    unverifiedFixIds: [],
    openIds: ["keep"],
  },
  findings: [
    finding({ id: "keep", severity: "major", title: "still open `tokenKeep`" }),
    finding({ id: "done", severity: "major", title: "was open `tokenDone`" }),
  ],
};

const rereviewRun = {
  ...caseRun,
  runId: "ck-review-00000000-0000-4000-8000-0000000000e8",
  reportUrl: "/reports/ck-review-00000000-0000-4000-8000-0000000000e8",
  reviewEvidence: {
    complete: true,
    sha: SHA,
    prUrl: "https://github.com/example/repo/pull/9",
    againstRunId: PRIOR_ID,
    blockingIds: ["keep"],
    unverifiedFixIds: [],
    openIds: ["keep"],
    evidenceComplete: false,
    uncoveredIds: ["keep"],
  },
  findings: [
    finding({ id: "keep", severity: "major", title: "alpha.go:1 — still open `tokenKeep`." }),
    finding({
      id: "done",
      severity: "major",
      title: "beta.go:2 — closed `tokenDone`.",
      status: "closed",
    }),
    finding({ id: "fresh", severity: "minor", title: "gamma.go:3 — new `tokenFresh`." }),
  ],
};

const hollowRun = {
  runId: HOLLOW_ID,
  kind: "review",
  status: "completed",
  title: "Hollow prior",
  startedAt: null,
  endedAt: null,
  hasReport: true,
  hasFindings: false,
  reportUrl: `/reports/${HOLLOW_ID}`,
  progress: null,
  markdown: "# Autonomous Review Report\n\n## 结论\n\ncomment\n",
  truncated: false,
  reviewEvidence: {
    complete: true,
    sha: SHA,
    prUrl: "https://github.com/example/repo/pull/9",
    againstRunId: null,
    blockingIds: [],
    unverifiedFixIds: [],
    openIds: [],
  },
  findings: [],
};

const hollowReviewRun = {
  ...rereviewRun,
  runId: HOLLOW_REVIEW_ID,
  reportUrl: `/reports/${HOLLOW_REVIEW_ID}`,
  reviewEvidence: {
    ...rereviewRun.reviewEvidence,
    againstRunId: HOLLOW_ID,
  },
};

const emptyRun = {
  runId: EMPTY_ID,
  kind: "review",
  status: "running",
  title: "Empty running review",
  startedAt: null,
  endedAt: null,
  hasReport: false,
  reportUrl: `/reports/${EMPTY_ID}`,
  progress: {
    phase: "attempts",
    updatedAt: new Date().toISOString(),
    attempts: [
      {
        attemptId: "attempt-0",
        agentName: "review-correctness",
        driverId: "codex-app-server",
        modelId: "gpt-6-astra",
        role: "attempt",
        status: "running",
        durationMs: 100,
      },
    ],
  },
  markdown: "",
  truncated: false,
  findings: [],
};

const runsById: Record<string, unknown> = {
  [LAYOUT_ID]: layoutRun,
  [CASE_ID]: caseRun,
  [PRIOR_ID]: priorRun,
  [EMPTY_ID]: emptyRun,
  [rereviewRun.runId]: rereviewRun,
  [HOLLOW_ID]: hollowRun,
  [HOLLOW_REVIEW_ID]: hollowReviewRun,
};

async function mockReviewApis(page: Page): Promise<void> {
  page.on("pageerror", (error) => {
    console.error(`pageerror: ${error.message}`);
  });
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "<head>",
      '<head>\n    <meta name="councilkit-csrf" content="preview-csrf" />',
    );
    await route.fulfill({
      status: response.status(),
      headers: {
        ...response.headers(),
        "content-type": "text/html; charset=utf-8",
      },
      body,
    });
  });
  await page.route("**/api/v1/health", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          apiVersion: "v1",
          hostInstanceId: "preview",
          node: { version: "v22.0.0", major: 22 },
          drivers: [],
        },
      },
    }),
  );
  await page.route("**/api/v1/cli-runs/repair/profiles**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          profiles: [],
          sourceBranchHint: null,
          baseHint: null,
          hintSource: null,
        },
      },
    }),
  );
  await page.route("**/api/v1/cli-runs", (route) => {
    if (new URL(route.request().url()).pathname !== "/api/v1/cli-runs") return route.fallback();
    return route.fulfill({ json: { ok: true, data: { runs: [] } } });
  });
  await page.route(/\/api\/v1\/cli-runs\/ck-review-[^/?]+$/, (route) => {
    const runId = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const data = runsById[runId];
    if (!data) {
      return route.fulfill({
        status: 404,
        json: { ok: false, error: { code: "NOT_FOUND", message: "missing run" } },
      });
    }
    return route.fulfill({ json: { ok: true, data } });
  });
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.locator("main").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(
    true,
  );
}

async function maybeScreenshot(page: Page, name: string): Promise<void> {
  if (!ARTIFACTS) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, name), fullPage: true });
}

for (const width of [1440, 900, 390]) {
  test(`展开验证依据不挤压标题、标签或溢出（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await mockReviewApis(page);
    await page.goto(`/reports/${LAYOUT_ID}`);
    const row = page.locator(".ck-ledger-row").first();
    await expect(row).toBeVisible();
    const titleText = (await row.locator(".ck-ledger-title").innerText()).trim();
    expect(titleText.length).toBeLessThanOrEqual(80);
    expect(titleText).not.toContain("不应出现在折叠行里");
    const before = await row.locator(".ck-ledger-title").boundingBox();
    const badgeBefore = await row.locator(".ck-sev").boundingBox();
    await row.locator("summary").first().click();
    await expect(row.locator("details").first()).toHaveAttribute("open", "");
    await expect(row.getByText("原始 ID")).toBeVisible();
    await row.locator(".ck-ledger-verification > summary").click();
    await expect(row.locator(".ck-ledger-verification")).toHaveAttribute("open", "");
    const after = await row.locator(".ck-ledger-title").boundingBox();
    const badgeAfter = await row.locator(".ck-sev").boundingBox();
    if (!before || !after || !badgeBefore || !badgeAfter)
      throw new Error("Missing finding row layout");
    expect(Math.abs(after.width - before.width)).toBeLessThan(1);
    expect(Math.abs(badgeAfter.width - badgeBefore.width)).toBeLessThan(1);
    expect(badgeAfter.width).toBeLessThan(70);
    const details = await row.locator("details").first().boundingBox();
    const parent = await row.boundingBox();
    if (!details || !parent) throw new Error("Missing verification layout");
    expect(details.width).toBeLessThanOrEqual(parent.width + 1);
    expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await assertNoHorizontalOverflow(page);
    await maybeScreenshot(page, `layout-${width}.png`);
    await row.locator("summary").first().click();
    await expect(row.locator("details").first()).not.toHaveAttribute("open");
  });
}

for (const width of [1440, 900, 390]) {
  test(`真实案例等价 fixture：先结论后 3 个阻塞，357 一行（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await mockReviewApis(page);
    await page.goto(`/reports/${CASE_ID}`);
    const heading = page.getByRole("heading", { name: "审查已完成" });
    await expect(heading).toBeVisible();
    await expect(page.getByRole("heading", { name: "问题清单" })).toBeVisible();
    await expect(page.getByText("本轮新审查，未关联历史修复记录")).toBeVisible();
    await expect(page.getByText("评估覆盖完整")).toHaveCount(0);
    const list = page.locator(".ck-ledger-row");
    await expect(list).toHaveCount(3);
    await maybeScreenshot(page, `case-default-${width}.png`);
    const uuidRow = page.locator(".ck-ledger-row").filter({ hasText: "357" });
    await expect(uuidRow).toHaveCount(1);
    await uuidRow.locator("summary").first().click();
    await expect(uuidRow.getByText("recovery.go--357-uuid-close")).toBeVisible();
    await expect(uuidRow.getByText("pkg.runtime.recovery.go--357-uuid")).toBeVisible();
    await maybeScreenshot(page, `case-expanded-357-${width}.png`);
    const h1Box = await heading.boundingBox();
    const listBox = await page.getByRole("heading", { name: "问题清单" }).boundingBox();
    const original = page.getByText("原始汇总报告");
    await expect(original).toBeVisible();
    if (!h1Box || !listBox) throw new Error("Missing overview order");
    expect(h1Box.y).toBeLessThan(listBox.y);
    await page.getByRole("button", { name: "全部" }).click();
    await expect(page.locator(".ck-ledger-row")).toHaveCount(23);
    await maybeScreenshot(page, `case-filter-all-${width}.png`);
    await page.getByRole("button", { name: "阻塞" }).click();
    await expect(page.locator(".ck-ledger-row")).toHaveCount(3);
    await page.getByText("原始汇总报告").click();
    await expect(page.getByRole("heading", { name: "共识发现" })).toBeVisible();
    await page.locator(".ck-wb-disagreements > summary").click();
    await expect(
      page.locator(".ck-wb-disagreements").getByText("查看审查者之间的不同意见"),
    ).toBeVisible();
    await expect(page.locator(".ck-wb-disagreements").getByText("结论票")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await maybeScreenshot(page, `case-${width}.png`);
  });
}

test("对照复审显示关联、覆盖不完整，不把缺失账本当成进度", async ({ page }) => {
  await mockReviewApis(page);
  await page.goto(`/reports/${rereviewRun.runId}`);
  await expect(page.getByText("历史问题评估覆盖不完整")).toBeVisible();
  await expect(page.getByRole("link", { name: PRIOR_ID })).toBeVisible();
  await expect(page.getByRole("link", { name: "对照复审" })).toHaveAttribute(
    "href",
    `/reports?pr=${encodeURIComponent("https://github.com/example/repo/pull/9")}&against=${rereviewRun.runId}#review`,
  );
  await expect(page.getByText("无法比较")).toHaveCount(0);
  await expect(page.getByText("对照关联账本")).toBeVisible();
});

test("空报告进行中仍显示初审提示和空态", async ({ page }) => {
  await mockReviewApis(page);
  await page.goto(`/reports/${EMPTY_ID}`);
  await expect(page.getByRole("heading", { name: "席位审查中" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "问题清单" })).toBeVisible();
  await expect(page.getByText("本轮新审查，未关联历史修复记录")).toBeVisible();
  await expect(page.getByText("这份审查还没有问题记录")).toBeVisible();
});

test("关联报告 HTTP 成功但账本不可用时无法比较", async ({ page }) => {
  await mockReviewApis(page);
  await page.goto(`/reports/${HOLLOW_REVIEW_ID}`);
  await expect(page.getByText("无法比较")).toBeVisible();
  await expect(page.getByText("对照关联账本：新增")).toHaveCount(0);
});
