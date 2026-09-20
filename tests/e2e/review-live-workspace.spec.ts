import { expect, test } from "@playwright/test";

const runId = "ck-review-00000000-0000-4000-8000-0000000000e3";
const makeRun = () => ({
  runId,
  kind: "review",
  status: "running",
  title: "https://code.alipay.com/paas-core/piston-sdk/pull_requests/7",
  startedAt: new Date(Date.now() - 500000).toISOString(),
  endedAt: null,
  hasReport: false,
  reportUrl: `/reports/${runId}`,
  markdown: "",
  truncated: false,
  progress: {
    phase: "attempts",
    updatedAt: new Date().toISOString(),
    attempts: [
      {
        attemptId: "attempt-0",
        agentName: "review-security",
        driverId: "claude-stream-json",
        modelId: "antchat/GLM-5.2[1m]",
        role: "attempt",
        status: "success",
        durationMs: 400000,
      },
      {
        attemptId: "attempt-1",
        agentName: "review-correctness",
        driverId: "codex-app-server",
        modelId: "gpt-6-astra",
        role: "attempt",
        status: "running",
        durationMs: 480000,
        lastActivity: "git diff -- python/piston/sessions.py",
      },
      {
        attemptId: "aggregator",
        agentName: "review-correctness",
        driverId: "codex-app-server",
        modelId: "gpt-6-astra",
        role: "aggregator",
        status: "pending",
        durationMs: null,
      },
    ],
  },
});

const resultEnvelope = (
  attemptId: string,
  data: Record<string, unknown>,
): { ok: true; data: unknown } => ({
  ok: true,
  data: {
    runId,
    attemptId,
    executionRef: `${attemptId}#1.1`,
    truncated: false,
    failure: null,
    reusedFrom: null,
    ...data,
  },
});

test("固定席位工作台：过程读取失败可恢复，完成席位直读 durable 原文，手机无横向溢出", async ({
  page,
}) => {
  const data = makeRun();
  let failLive = true;
  await page.route(`**/api/v1/cli-runs/${runId}`, (route) =>
    route.fulfill({ json: { ok: true, data } }),
  );
  await page.route("**/api/v1/cli-runs", (route) =>
    route.fulfill({ json: { ok: true, data: { runs: [] } } }),
  );
  await page.route(`**/api/v1/cli-runs/${runId}/attempts/*/live*`, (route) =>
    route.fulfill(
      failLive
        ? {
            status: 503,
            json: { ok: false, error: { code: "UNAVAILABLE", message: "Test temporary failure" } },
          }
        : {
            json: {
              ok: true,
              data: {
                events: [
                  {
                    seq: 1,
                    at: new Date().toISOString(),
                    type: "text.delta",
                    text: "正在验证短帧事件。",
                  },
                ],
                nextSeq: 1,
                done: true,
              },
            },
          },
    ),
  );
  await page.route(`**/api/v1/cli-runs/${runId}/attempts/*/result*`, (route) => {
    const attemptId = /attempts\/([^/]+)\/result/.exec(route.request().url())?.[1] ?? "";
    if (attemptId === "attempt-0") {
      return route.fulfill({
        json: resultEnvelope(attemptId, {
          executionStatus: "success",
          availability: "available",
          markdown: "# 安全审查报告\n\n无结构化摘要正文",
        }),
      });
    }
    if (attemptId === "aggregator") {
      return route.fulfill({
        json: resultEnvelope(attemptId, {
          executionStatus: "pending",
          availability: "pending",
          markdown: null,
        }),
      });
    }
    return route.fulfill({
      json: resultEnvelope(attemptId, {
        executionStatus: "running",
        availability: "pending",
        markdown: null,
      }),
    });
  });
  await page.goto(`/reports/${runId}`);
  // 上下文栏席位计数 + 单一席位列（无重复列表/下拉）。
  await expect(page.getByText("1/2 席位已完成").first()).toBeVisible();
  await expect(page.locator(".ck-wb-seat-row")).toHaveCount(3);
  await expect(page.getByRole("region", { name: "外部 Squad 修复任务" })).toHaveCount(0);

  // 运行中席位：默认过程 Tab；live 失败给诚实空态 + 手动重读，恢复后读到事件。
  await page
    .getByRole("button", { name: /正确性审查/ })
    .first()
    .click();
  await expect(page.getByRole("tab", { name: "过程" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("过程暂时无法读取")).toBeVisible();
  failLive = false;
  await page.getByRole("button", { name: "重新读取" }).click();
  await expect(page.getByText("正在验证短帧事件。", { exact: true })).toBeVisible();
  await expect(page.getByText("过程暂时无法读取")).toHaveCount(0);
  // 已结束的过程标注保守版本说明（sidecar 按 attemptId 存放，无法对应当前执行）。
  await expect(page.getByText("该席位已保存过程 · 版本未单独记录")).toBeVisible();

  // 已完成席位：默认报告 Tab；正文只来自 result 端点，中性说明无假徽标。
  await page
    .getByRole("button", { name: /安全审查/ })
    .first()
    .click();
  await expect(page.getByRole("tab", { name: "报告" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("本次执行的报告原文 · 暂无结构化摘要")).toBeVisible();
  await expect(page.getByText("无结构化摘要正文")).toBeVisible();

  // review kind 不再有模态检查器；页面全程无 dialog。
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("席位失败显示已记录原因、过程空态保守标注；汇总完成后总览显示结论", async ({ page }) => {
  const data = makeRun();
  data.status = "failed";
  data.progress.attempts[0].status = "failure";
  let failResult = true;
  await page.route(`**/api/v1/cli-runs/${runId}`, (route) =>
    route.fulfill({ json: { ok: true, data } }),
  );
  await page.route("**/api/v1/cli-runs", (route) =>
    route.fulfill({ json: { ok: true, data: { runs: [] } } }),
  );
  await page.route(`**/api/v1/cli-runs/${runId}/attempts/*/live*`, (route) =>
    route.fulfill({ json: { ok: true, data: { events: [], nextSeq: 0, done: true } } }),
  );
  await page.route(`**/api/v1/cli-runs/${runId}/attempts/*/result*`, (route) => {
    if (failResult) {
      return route.fulfill({
        status: 503,
        json: { ok: false, error: { code: "UNAVAILABLE", message: "Test failure" } },
      });
    }
    const attemptId = /attempts\/([^/]+)\/result/.exec(route.request().url())?.[1] ?? "";
    if (attemptId === "attempt-0") {
      return route.fulfill({
        json: resultEnvelope(attemptId, {
          executionStatus: "failure",
          availability: "unavailable",
          markdown: null,
          failure: { code: "EXIT", message: "exit 1" },
        }),
      });
    }
    return route.fulfill({
      json: resultEnvelope(attemptId, {
        executionStatus: "pending",
        availability: "pending",
        markdown: null,
      }),
    });
  });
  await page.goto(`/reports/${runId}`);
  await page
    .getByRole("button", { name: /安全审查/ })
    .first()
    .click();
  // 读取错误：不清空其他轴，手动重读后显示执行失败与已记录原因。
  await expect(page.getByText("报告暂时无法读取")).toBeVisible();
  failResult = false;
  await page.getByRole("button", { name: "重新读取" }).click();
  await expect(page.getByText("已记录原因：exit 1")).toBeVisible();

  // 过程 Tab：已结束空响应（不声称确定未保存）。
  await page.getByRole("tab", { name: "过程" }).click();
  await expect(page.getByText("暂无可读取的过程记录")).toBeVisible();

  // run 完成、汇总生成：总览直接显示结论，Aggregator 走同一 result 端点。
  data.status = "completed";
  data.hasReport = true;
  data.markdown = "# Autonomous Review Report\n\n---\n\n## 结论\n\nchanges-requested";
  data.progress.phase = "done";
  for (const row of data.progress.attempts) row.status = "success";
  await page.reload();
  await expect(page.getByRole("heading", { name: "已完成" })).toBeVisible();
  await expect(page.getByText("Changes requested", { exact: true }).first()).toBeVisible();
  await page
    .getByRole("button", { name: /结果汇总/ })
    .first()
    .click();
  await expect(page.getByRole("tab", { name: "报告" })).toHaveAttribute("aria-selected", "true");
});

const squadRunId = "ck-squad-00000000-0000-4000-8000-0000000000e4";
const makeSquadRun = () => ({
  runId: squadRunId,
  kind: "squad",
  status: "awaiting_orchestrator",
  title: "squad-workspace-dup",
  startedAt: new Date(Date.now() - 500000).toISOString(),
  endedAt: new Date().toISOString(),
  hasReport: true,
  reportUrl: `/reports/${squadRunId}`,
  markdown: "# Observation",
  truncated: false,
  progress: {
    phase: "reviewing",
    updatedAt: new Date().toISOString(),
    attempts: [
      {
        attemptId: "coder-0",
        agentName: "coder",
        driverId: "host",
        modelId: "grok-4.6",
        role: "attempt",
        status: "success",
        durationMs: 90000,
      },
      {
        attemptId: "review-0",
        agentName: "reviewer",
        driverId: "host",
        modelId: "undeclared",
        role: "attempt",
        status: "success",
        durationMs: 40000,
      },
    ],
  },
  documents: [
    {
      id: "brief",
      title: "简报",
      markdown: "# Brief\n- goal: Close residuals without restoring a PR.",
      truncated: false,
    },
  ],
  handoff: {
    approved: false,
    candidateSha: "a".repeat(40),
    candidateStatus: "completed",
  },
});

test("squad 席位抽屉开关后工作台仍只有一份", async ({ page }) => {
  const data = makeSquadRun();
  await page.route(`**/api/v1/cli-runs/${squadRunId}`, (route) =>
    route.fulfill({ json: { ok: true, data } }),
  );
  await page.route("**/api/v1/cli-runs", (route) =>
    route.fulfill({ json: { ok: true, data: { runs: [] } } }),
  );
  await page.route(`**/api/v1/cli-runs/${squadRunId}/attempts/*/live*`, (route) =>
    route.fulfill({ json: { ok: true, data: { events: [], nextSeq: 0, done: true } } }),
  );
  await page.goto(`/reports/${squadRunId}`);
  const workbench = page.getByRole("heading", { name: "工程任务工作台", exact: true });
  await expect(workbench).toHaveCount(1);
  await page.getByRole("button", { name: "查看过程：coder", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("main .ck-inspector")).toHaveCount(0);
  await expect(page.locator("body > .ck-inspector")).toHaveCount(1);
  await expect(workbench).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(workbench).toHaveCount(1);
  await expect(page.locator(".ck-squad-workspace")).toHaveCount(1);
  await page.getByRole("button", { name: "查看过程：coder", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(workbench).toHaveCount(1);
  await expect(page.locator(".ck-squad-workspace")).toHaveCount(1);
});
