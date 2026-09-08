import { expect, test } from "@playwright/test";
const fixture = () => ({
  revision: "initial",
  councilId: "pr-jury",
  reporterAgentId: "a",
  seats: ["a", "b"].map((agentId) => ({
    agentId,
    modelId: "grok-4.6",
    driverSelection: { driverId: "grok-stream-json", options: {} },
  })),
  agents: ["a", "b", "c"].map((agentId, i) => ({
    agentId,
    name: ["review-security", "review-correctness", "review-maintainability"][i],
    modelId: "grok-4.6",
    driverSelection: { driverId: "grok-stream-json", options: {} },
    enabled: true,
    color: "#123456",
  })),
  codexModels: ["gpt-6-astra", "gpt-5.6-sol"],
});

test("默认席位：下拉选择 Astra、保存并重新加载，审查仅使用默认班子", async ({ page }) => {
  let data = fixture();
  let saved: unknown;
  let review: unknown;
  await page.route("**/api/v1/review-jury", async (route) => {
    if (route.request().method() === "POST") {
      saved = route.request().postDataJSON();
      const body = route.request().postDataJSON();
      data = { ...data, ...body, revision: "updated" };
    }
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.route("**/api/v1/installations", (route) =>
    route.fulfill({ json: { ok: true, data: { installations: [] } } }),
  );
  await page.route("**/api/v1/cli-runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    review = route.request().postDataJSON();
    await route.fulfill({
      status: 400,
      json: { ok: false, error: { code: "BAD_REQUEST", message: "Test stopped before spawn" } },
    });
  });
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "安全审查", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "调整席位", exact: true }).click();
  await expect(page.getByRole("heading", { name: "安全审查", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "自选模型", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "模型 ID", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始审查", exact: true })).toBeDisabled();
  await page.locator("#jury-a-driver").selectOption("codex-app-server");
  await expect(page.getByRole("button", { name: "保存默认席位", exact: true })).toBeDisabled();
  await page.locator("#jury-a-model").selectOption("gpt-6-astra");
  await page.getByRole("radio", { name: "由正确性审查汇总" }).check();
  await page.getByRole("button", { name: "保存默认席位", exact: true }).click();
  await expect(page.getByText("默认席位已保存。")).toBeVisible();
  expect(saved).toMatchObject({
    revision: "initial",
    reporterAgentId: "b",
    seats: [
      {
        agentId: "a",
        modelId: "gpt-6-astra",
        driverSelection: { driverId: "codex-app-server", options: {} },
      },
      { agentId: "b", modelId: "grok-4.6" },
    ],
  });
  await page.reload();
  await page.getByRole("button", { name: "调整席位", exact: true }).click();
  await expect(page.getByText("gpt-6-astra", { exact: true })).toBeVisible();
  await page.getByLabel("PR URL").fill("https://github.com/acme/repo/pull/1");
  await page.getByRole("button", { name: "开始审查", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(review).toEqual({ pr: "https://github.com/acme/repo/pull/1" });
});

test("默认席位：可增减已有 Agent，取消编辑不保存", async ({ page }) => {
  let writes = 0;
  await page.route("**/api/v1/review-jury", async (route) => {
    if (route.request().method() === "POST") writes++;
    await route.fulfill({ json: { ok: true, data: fixture() } });
  });
  await page.route("**/api/v1/installations", (route) =>
    route.fulfill({ json: { ok: true, data: { installations: [] } } }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/reports");
  await page.getByRole("button", { name: "调整席位", exact: true }).click();
  await expect(page.getByRole("button", { name: "移除安全审查" })).toBeDisabled();
  await page.getByRole("combobox", { name: "添加席位" }).selectOption("c");
  await expect(page.getByRole("heading", { name: "可维护性审查" })).toBeVisible();
  await page.getByRole("button", { name: "移除正确性审查" }).click();
  await expect(page.getByRole("heading", { name: "正确性审查" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("heading", { name: "正确性审查" })).toBeVisible();
  expect(writes).toBe(0);
});

test("默认席位接口缺失时明确提示失败，重新加载可恢复编辑", async ({ page }) => {
  let available = false;
  await page.route("**/api/v1/review-jury", (route) =>
    route.fulfill(
      available
        ? { json: { ok: true, data: fixture() } }
        : {
            status: 404,
            json: { ok: false, error: { code: "NOT_FOUND", message: "Unknown API route." } },
          },
    ),
  );
  await page.goto("/reports");
  await expect(page.getByRole("alert")).toContainText("当前 Host 尚未加载默认席位接口");
  await expect(page.getByText("默认席位读取失败，请重新加载", { exact: true })).toBeVisible();
  await expect(page.getByText("正在读取默认席位", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始审查", exact: true })).toBeDisabled();
  available = true;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.getByRole("button", { name: "调整席位", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始审查", exact: true })).toBeEnabled();
});
