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

test("审查工作台分开统计 Aggregator，过程读取失败可恢复，手机无横向溢出", async ({ page }) => {
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
  await page.goto(`/reports/${runId}`);
  await expect(page.getByRole("heading", { name: "paas-core / piston-sdk #7" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "审查席位完成进度" })).toHaveAttribute(
    "max",
    "2",
  );
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1");
  await expect(page.getByText("等待审查席位结束", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "外部 Squad 修复任务" })).toHaveCount(0);
  await page.getByRole("button", { name: "过程进行中：review-correctness", exact: true }).click();
  await expect(page.getByText(/过程读取失败/)).toBeVisible();
  failLive = false;
  await expect(page.getByText("正在验证短帧事件。", { exact: true })).toBeVisible();
  await expect(page.getByText(/过程读取失败/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  data.progress.attempts[0].status = "failure";
  await page.reload();
  await expect(
    page.getByText("1 个席位未成功完成，可打开过程查看记录；最终结论以汇总报告为准。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看过程：review-security", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("结束的席位读取错误可手动重试，完成报告后显示导出入口", async ({ page }) => {
  const data = makeRun();
  data.status = "failed";
  data.progress.attempts[0].status = "failure";
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
            json: { ok: false, error: { code: "UNAVAILABLE", message: "Test failure" } },
          }
        : { json: { ok: true, data: { events: [], nextSeq: 0, done: true } } },
    ),
  );
  await page.goto(`/reports/${runId}`);
  await page.getByRole("button", { name: "查看过程：review-security", exact: true }).click();
  await expect(page.getByText(/过程读取失败/)).toBeVisible();
  failLive = false;
  await page.getByRole("button", { name: "重新读取过程" }).click();
  await expect(page.getByText("尚无过程记录", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  data.status = "completed";
  data.hasReport = true;
  data.markdown = "# Autonomous Review Report\n\n---\n\n## 结论\n\nchanges-requested";
  data.progress.phase = "done";
  for (const row of data.progress.attempts) row.status = "success";
  await page.reload();
  await expect(page.getByRole("region", { name: "外部 Squad 修复任务" })).toBeVisible();
  await expect(page.getByText("需要修改", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "阅读报告正文 ↓" }).click();
  await expect(page.locator("#review-report-body")).toBeInViewport();
  await expect(page.getByRole("heading", { name: "paas-core / piston-sdk #7" })).toBeVisible();
});
