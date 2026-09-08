import { expect, test } from "@playwright/test";

const fixture = () => ({
  revision: "initial",
  councilId: "product-jury",
  reporterAgentId: "ideate-challenger",
  seats: [
    {
      agentId: "ideate-product",
      modelId: "grok-4.6",
      driverSelection: { driverId: "grok-stream-json", options: {} },
    },
    {
      agentId: "ideate-engineering",
      modelId: "kimi-code/k3",
      driverSelection: { driverId: "kimi-stream-json", options: {} },
    },
    {
      agentId: "ideate-challenger",
      modelId: "gpt-6-astra",
      driverSelection: { driverId: "codex-app-server", options: {} },
    },
  ],
  agents: [
    {
      agentId: "ideate-product",
      name: "ideate-product",
      modelId: "grok-4.6",
      driverSelection: { driverId: "grok-stream-json", options: {} },
      enabled: true,
      color: "#38bdf8",
    },
    {
      agentId: "ideate-engineering",
      name: "ideate-engineering",
      modelId: "kimi-code/k3",
      driverSelection: { driverId: "kimi-stream-json", options: {} },
      enabled: true,
      color: "#4ade80",
    },
    {
      agentId: "ideate-challenger",
      name: "ideate-challenger",
      modelId: "gpt-6-astra",
      driverSelection: { driverId: "codex-app-server", options: {} },
      enabled: true,
      color: "#f472b6",
    },
  ],
  codexModels: ["gpt-6-astra"],
});

test("创意表单显示真实 product-jury，缺席时不虚构 Codex", async ({ page }) => {
  await page.route("**/api/v1/product-jury", (route) =>
    route.fulfill({ json: { ok: true, data: fixture() } }),
  );
  await page.route("**/api/v1/installations", (route) =>
    route.fulfill({ json: { ok: true, data: { installations: [] } } }),
  );
  await page.goto("/ideate");
  await expect(page.getByRole("heading", { name: "产品席", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "工程席", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "质疑席", exact: true })).toBeVisible();
  await expect(page.getByText("gpt-6-astra", { exact: true })).toBeVisible();
  await expect(page.getByText("Reporter · 汇总")).toBeVisible();
  await expect(page.getByRole("button", { name: "调整席位", exact: true })).toHaveCount(0);
});

test("本次改用其他模型后发起请求带 models，不保存 jury", async ({ page }) => {
  let writes = 0;
  let started: unknown;
  await page.route("**/api/v1/product-jury", (route) => {
    if (route.request().method() === "POST") writes += 1;
    return route.fulfill({ json: { ok: true, data: fixture() } });
  });
  await page.route("**/api/v1/installations", (route) =>
    route.fulfill({ json: { ok: true, data: { installations: [] } } }),
  );
  await page.route("**/api/v1/cli-runs/ideate", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    started = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ok: true,
        data: { runId: "ck-ideate-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1", started: true },
      },
    });
  });
  await page.goto("/ideate");
  await page.getByRole("button", { name: "本次改用其他模型", exact: true }).click();
  await page.locator("#ideate-ideate-product-model").selectOption("grok-4.6");
  await page.getByRole("radio", { name: "由产品席汇总" }).check();
  await page.getByLabel("一句话创意").fill("为独立开发者每周整理用户反馈");
  await page.getByRole("button", { name: "开始讨论", exact: true }).click();
  await expect(page).toHaveURL(/\/reports\/ck-ideate-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1/);
  expect(writes).toBe(0);
  expect(started).toMatchObject({
    idea: "为独立开发者每周整理用户反馈",
    models: { aggregatorIndex: 0 },
  });
});

test("product-jury 缺失时禁用发起并提示 init", async ({ page }) => {
  await page.route("**/api/v1/product-jury", (route) =>
    route.fulfill({
      status: 400,
      json: {
        ok: false,
        error: {
          code: "BAD_REQUEST",
          message: "default product-jury is missing; run `councilkit init`",
        },
      },
    }),
  );
  await page.goto("/ideate");
  await expect(page.getByRole("alert")).toContainText("product-jury");
  await expect(page.getByRole("button", { name: "开始讨论", exact: true })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "质疑席", exact: true })).toHaveCount(0);
});

test("产品创意有独立导航，报告页不再加载创意表单", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/v1/product-jury", (route) => {
    reads++;
    return route.fulfill({ json: { ok: true, data: fixture() } });
  });
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "审查与报告", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "讨论产品创意", exact: true })).toHaveCount(0);
  expect(reads).toBe(0);
  await page.getByRole("link", { name: "产品创意", exact: true }).click();
  await expect(page).toHaveURL(/\/ideate$/);
  await expect(page.getByRole("heading", { name: "产品创意", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "产品席", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("一句话创意")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("main").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
