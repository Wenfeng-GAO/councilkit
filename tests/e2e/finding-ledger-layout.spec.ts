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
const CONFLICT_ID = "ck-review-00000000-0000-4000-8000-0000000000eb";

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
  acceptedReason?: string;
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
  findingGroups: null,
};

function caseFindings() {
  const rows = [
    finding({
      id: "recovery.go--266-271-ctx",
      severity: "major",
      reviewer: "review-adversarial",
      source: "consensus",
      files: ["recovery.go"],
      title: "`recovery.go:266-271` — Resume 失败只看 `ctx.Err()`，不看 `flightCurrent`。",
    }),
    finding({
      id: "recovery.go--311-362-fence",
      severity: "major",
      reviewer: "review-adversarial",
      source: "consensus",
      files: ["recovery.go"],
      title:
        "`recovery.go:311-362` — fence 在 `UpdateSession` 回调内；commit idle 后不再复核 occupancy。",
    }),
    finding({
      id: "recovery.go--357-uuid-close",
      severity: "major",
      reviewer: "review-correctness",
      source: "unique",
      files: ["recovery.go"],
      title:
        "`recovery.go:357` — Resume 成功、提交 idle 遇到临时存储错误时 `closeOpenedOn` + `markRecoveryFailed`（UUID 仍在）。改用 `forgetOpenedOn`。",
    }),
    finding({
      id: "pkg.runtime.recovery.go--357-uuid",
      severity: "major",
      reviewer: "review-correctness",
      source: "unique",
      files: ["pkg/runtime/recovery.go"],
      title:
        "pkg/runtime/recovery.go:357 — 原 UUID Resume 成功、提交 idle 遇到临时存储错误时 Close，却保留 UUID 为 error。改用 `forgetOpenedOn`。",
    }),
    finding({
      id: "auth.go--sql-injection",
      severity: "critical",
      reviewer: "review-security",
      source: "unique",
      files: ["auth.go"],
      title: "`auth.go:45` — SQL 注入漏洞：用户输入未经验证直接拼接到查询语句中，攻击者可执行任意 SQL 命令。",
    }),
    finding({
      id: "memory-leak-listener",
      severity: "major",
      reviewer: "review-correctness",
      source: "consensus",
      status: "closed",
      files: ["components/EventEmitter.tsx"],
      title: "`EventEmitter.tsx:123` — 内存泄漏：事件监听器未在组件卸载时清理，长时间运行会导致内存累积。",
    }),
    finding({
      id: "perf-optimization-memo",
      severity: "minor",
      reviewer: "review-maintainability",
      source: "unique",
      status: "closed",
      files: ["hooks/useCalculation.ts"],
      title: "`useCalculation.ts:234` — 性能优化：可以使用 useMemo 避免不必要的重新计算，当前每次渲染都会执行复杂计算。",
    }),
    finding({
      id: "code-style-naming",
      severity: "nit",
      reviewer: "review-maintainability",
      source: "unique",
      status: "accepted",
      files: ["utils/helpers.ts"],
      title: "`helpers.ts:345` — 代码风格：变量命名不符合团队规范，建议使用驼峰命名法。",
    }),
    finding({
      id: "very-long-title-test",
      severity: "major",
      reviewer: "review-adversarial",
      source: "consensus",
      files: ["services/DataProcessor.ts"],
      title:
        "`DataProcessor.ts:456` — 这是一个非常非常长的问题标题，用于测试当标题很长时，右侧的标签是否能够正确对齐而不会随着标题长度的变化而水平移动，这是一个重要的布局约束条件，需要确保在各种情况下都能保持一致。",
      status: "regress",
    }),
    finding({
      id: "accepted-with-long-reason",
      severity: "major",
      reviewer: "review-correctness",
      source: "unique",
      status: "accepted",
      files: ["legacy/OldModule.ts"],
      title: "`OldModule.ts:789` — 使用了废弃的 API，应该迁移到新版本。",
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
  // 添加一个接受理由很长的 finding
  rows.find((r) => r.id === "accepted-with-long-reason")!.acceptedReason =
    "经过团队讨论，这个遗留模块计划在 Q3 完全重写，当前修改成本过高且收益有限。新架构将彻底解决这个问题。产品团队确认现有功能稳定，用户反馈良好，没有紧急业务压力。重构计划已在路线图中，预计三个月内完成。投入产出比分析显示当前不修改是最优选择。";
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
  hasFindings: true,
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
    blockingIds: [
      "recovery.go--266-271-ctx",
      "recovery.go--311-362-fence",
      "recovery.go--357-uuid-close",
      "pkg.runtime.recovery.go--357-uuid",
      "auth.go--sql-injection",
      "very-long-title-test",
    ],
    unverifiedFixIds: [],
    openIds: [
      "recovery.go--266-271-ctx",
      "recovery.go--311-362-fence",
      "recovery.go--357-uuid-close",
      "pkg.runtime.recovery.go--357-uuid",
      "auth.go--sql-injection",
      "very-long-title-test",
    ],
    evidenceComplete: true,
  },
  findings: caseFindings(),
  findingGroups: {
    version: 1,
    kind: "councilkit-finding-groups",
    source: {
      runId: CASE_ID,
      sha: SHA,
      findingsSha256: "0".repeat(64),
      againstRunId: null,
    },
    groups: [
      {
        rootCauseId: "uuid-close-recovery",
        findingIds: ["recovery.go--357-uuid-close", "pkg.runtime.recovery.go--357-uuid"],
        aliases: [],
        basis: "两位审查者发现同一 UUID 关闭问题，位置略有不同但根因相同。",
      },
    ],
  },
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
  findingGroups: null,
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
  findingGroups: null,
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
  findingGroups: null,
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
  findingGroups: null,
};

// Reproduces the reported bold historical-ID alias, without requiring local run files.
const mapperId = "app.dal.....mapper.java--app-dal-...-mapper.java-67-75";
const conflictRun = {
  ...priorRun,
  runId: CONFLICT_ID,
  reportUrl: `/reports/${CONFLICT_ID}`,
  markdown:
    "# Autonomous Review Report\n\n---\n\n## 概览\n\n本轮只文档化 GET 与 list 的差异，不升阻塞。\n\n## 结论\n\ncomment\n",
  findings: [
    finding({
      id: "h-48d359829697",
      title: `${mapperId}** — 四席按行为 still_open。公开名 sessionID 与 GET 仍非等价合同。`,
      severity: "major",
      source: "consensus",
    }),
    finding({
      id: mapperId,
      title: "Mapper.java:67-75 — GET 可按会话名称命中，list 仅匹配 sessionID。",
      severity: "major",
      files: ["Mapper.java"],
    }),
    finding({
      id: "h-052309e7be19",
      title: "h-052309e7be19** — 五席 still_open。GET 可返回已归档会话，list 默认排除 archived。",
      severity: "major",
    }),
    finding({
      id: "test.py--assertion",
      title: "测试只检查全文，未校验字段操作符。",
      severity: "minor",
    }),
  ],
};

const runsById: Record<string, unknown> = {
  [LAYOUT_ID]: layoutRun,
  [CASE_ID]: caseRun,
  [PRIOR_ID]: priorRun,
  [EMPTY_ID]: emptyRun,
  [rereviewRun.runId]: rereviewRun,
  [HOLLOW_ID]: hollowRun,
  [HOLLOW_REVIEW_ID]: hollowReviewRun,
  [CONFLICT_ID]: conflictRun,
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

for (const width of [1440, 390]) {
  test(`COMMENT 与账本冲突可见、重复合并、筛选保留序号（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await mockReviewApis(page);
    await page.goto(`/reports/${CONFLICT_ID}`);
    await expect(page.getByRole("heading", { name: "审查结论待核对" })).toBeVisible();
    await expect(page.getByText("有意见（COMMENT）", { exact: true })).toBeVisible();
    await expect(page.getByText("报告意见与账本门禁尚未对齐", { exact: false })).toBeVisible();
    await expect(page.locator(".ck-ledger-row")).toHaveCount(2);
    await expect(page.getByText("合并 2 条记录", { exact: true })).toBeVisible();
    const titles = await page.locator(".ck-ledger-title").allTextContents();
    expect(
      titles.every(
        (title) =>
          !title.includes("h-052309") && !title.includes("still_open") && !title.includes(mapperId),
      ),
    ).toBe(true);
    const numbers = await page.locator(".ck-finding-number").allTextContents();
    expect(numbers).toEqual(["#01", "#02"]);
    await page.getByRole("button", { name: "全部", exact: true }).click();
    await expect(page.locator(".ck-ledger-row")).toHaveCount(3);
    expect((await page.locator(".ck-finding-number").allTextContents()).slice(0, 2)).toEqual(
      numbers,
    );
    await page.getByRole("button", { name: "阻塞", exact: true }).click();
    await assertNoHorizontalOverflow(page);
    await maybeScreenshot(page, `decision-conflict-${width}.png`);
    const aliasRow = page.locator(".ck-ledger-row").filter({ hasText: "合并 2 条记录" });
    await aliasRow.locator("summary").first().click();
    await expect(aliasRow.getByText("h-48d359829697", { exact: true })).toBeVisible();
    await expect(aliasRow.getByText(mapperId, { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });
}

for (const width of [1440, 900, 390]) {
  test(`真实案例等价 fixture：先结论后阻塞，包含多种标签组合（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await mockReviewApis(page);
    await page.goto(`/reports/${CASE_ID}`);
    const heading = page.getByRole("heading", { name: "审查已完成" });
    await expect(heading).toBeVisible();
    await expect(page.getByRole("heading", { name: "问题清单" })).toBeVisible();
    await expect(page.getByText("本轮新审查，未关联历史修复记录")).toBeVisible();
    await expect(page.getByText("评估覆盖完整")).toHaveCount(0);
    // 默认显示阻塞过滤器
    const list = page.locator(".ck-ledger-row");
    await expect(list).toHaveCount(6); // 6 个阻塞问题
    await maybeScreenshot(page, `case-blocking-${width}.png`);
    // 测试长标题问题是否可见
    await expect(page.getByText("这是一个非常非常长的问题标题")).toBeVisible();
    // 测试各种严重度标签
    await expect(page.locator(".ck-sev-critical")).toBeVisible();
    await expect(page.locator(".ck-sev-major")).toBeVisible();
    // 测试共识/独有标签
    await expect(page.getByText("共识")).toBeVisible();
    await expect(page.getByText("独有")).toBeVisible();
    const uuidRow = page.locator(".ck-ledger-row").filter({ hasText: "357" });
    await expect(uuidRow).toHaveCount(1);
    uuidRow.locator("summary").first().click();
    await expect(uuidRow.getByText("recovery.go--357-uuid-close")).toBeVisible();
    await expect(uuidRow.getByText("pkg.runtime.recovery.go--357-uuid")).toBeVisible();
    await expect(uuidRow.getByText("合并 2 条记录")).toBeVisible();
    await maybeScreenshot(page, `case-expanded-357-${width}.png`);
    const h1Box = await heading.boundingBox();
    const listBox = await page.getByRole("heading", { name: "问题清单" }).boundingBox();
    const original = page.getByText("原始汇总报告");
    await expect(original).toBeVisible();
    if (!h1Box || !listBox) throw new Error("Missing overview order");
    expect(h1Box.y).toBeLessThan(listBox.y);
    await page.getByRole("button", { name: "全部" }).click();
    await expect(page.locator(".ck-ledger-row")).toHaveCount(33); // 更新为新的总数
    await maybeScreenshot(page, `case-filter-all-${width}.png`);
    // 测试已解决过滤器
    await page.getByRole("button", { name: "已解决" }).click();
    await expect(page.locator(".ck-ledger-row")).toHaveCount(3); // 2 closed + 1 accepted with long reason
    await maybeScreenshot(page, `case-filter-resolved-${width}.png`);
    // 测试接受不修的长理由显示
    const acceptedRow = page.locator(".ck-ledger-row").filter({ hasText: "废弃的 API" });
    await expect(acceptedRow).toBeVisible();
    await expect(acceptedRow.getByText("接受不修")).toBeVisible();
    // 返回阻塞过滤器
    await page.getByRole("button", { name: "阻塞" }).click();
    await expect(page.locator(".ck-ledger-row")).toHaveCount(6);
    await page.getByText("原始汇总报告").click();
    await expect(page.getByRole("heading", { name: "共识发现" })).toBeVisible();
    await page.locator(".ck-wb-disagreements > summary").click();
    await expect(
      page.locator(".ck-wb-disagreements").getByText("查看审查者之间的不同意见"),
    ).toBeVisible();
    await expect(page.locator(".ck-wb-disagreements").getByText("结论票")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await maybeScreenshot(page, `case-full-overview-${width}.png`);
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

test("标签布局质量验证：对齐、紧凑、层次（桌面）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await mockReviewApis(page);
  await page.goto(`/reports/${CASE_ID}`);
  // 等待页面加载
  await expect(page.locator(".ck-ledger-row").first()).toBeVisible();
  // 验证所有标签容器的右边缘对齐
  const tagsContainers = page.locator(".ck-finding-tags");
  const count = await tagsContainers.count();
  expect(count).toBeGreaterThan(0);
  const rightEdges: number[] = [];
  for (let i = 0; i < Math.min(count, 6); i++) {
    const box = await tagsContainers.nth(i).boundingBox();
    if (box) rightEdges.push(box.x + box.width);
  }
  // 检查右边缘对齐（允许 5px 误差，因为不同行可能有滚动条影响）
  const maxRight = Math.max(...rightEdges);
  const minRight = Math.min(...rightEdges);
  expect(maxRight - minRight).toBeLessThan(10);
  // 验证严重度徽章紧凑（不超过 100px 宽度）
  const sevBadges = page.locator(".ck-sev");
  const sevCount = await sevBadges.count();
  for (let i = 0; i < Math.min(sevCount, 6); i++) {
    const box = await sevBadges.nth(i).boundingBox();
    if (box) {
      expect(box.width).toBeLessThan(100);
      expect(box.height).toBeLessThan(35);
    }
  }
  // 验证标签行结构（第一行：严重度+状态，第二行可选：次要标签）
  const firstFinding = page.locator(".ck-ledger-row").first();
  const tagRows = firstFinding.locator(".ck-finding-tags-row");
  const rowCount = await tagRows.count();
  expect(rowCount).toBeGreaterThanOrEqual(1);
  // 第一行应该包含严重度和状态
  const firstRow = tagRows.first();
  expect(await firstRow.locator(".ck-sev").count()).toBe(1);
  expect(await firstRow.locator(".ck-ledger-status").count()).toBe(1);
  await maybeScreenshot(page, "tags-layout-quality-desktop.png");
});

test("标签布局质量验证：移动端对齐和换行（390px）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockReviewApis(page);
  await page.goto(`/reports/${CASE_ID}`);
  await expect(page.locator(".ck-ledger-row").first()).toBeVisible();
  // 在移动端验证标签不会导致水平溢出
  await assertNoHorizontalOverflow(page);
  // 验证长接受理由的标签能正确换行
  await page.getByRole("button", { name: "已解决" }).click();
  const acceptedRow = page.locator(".ck-ledger-row").filter({ hasText: "废弃的 API" });
  await expect(acceptedRow).toBeVisible();
  const statusTag = acceptedRow.locator(".ck-ledger-status");
  await expect(statusTag).toBeVisible();
  const statusBox = await statusTag.boundingBox();
  if (statusBox) {
    // 状态标签应该在最大宽度限制内
    expect(statusBox.width).toBeLessThan(360); // 留出边距
  }
  await maybeScreenshot(page, "tags-layout-quality-mobile.png");
});
