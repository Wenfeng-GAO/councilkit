import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { ASSERTION, FINDING, ROUTES, RUN_ID, TEST_API, UI } from "../../review-explainer/contract";
import { BUSY_SNIPPET, HIDDEN_CONTEXT_SNIPPET } from "../../review-explainer/fixtures/sample-diff";
import {
  controlPost,
  installOriginAllowlist,
  openExplainer,
  resetCase,
  selectFinding,
} from "./helpers";

const FLOW = {
  title: "请求已接收后返回繁忙，重试可能重复执行",
  kind: "flow",
  assertion: "The runtime accepts a request before the manager returns busy.",
  evidence: ["E2E_EVIDENCE_accepted_once_but_state_unmatched"],
  inference: ["E2E_INFERENCE_retry_without_idempotency_might_repeat"],
  canvas: {
    template: "flow",
    nodes: [
      { id: "accepted", label: "One request accepted", evidence: "evidence" },
      { id: "busy", label: "State update returned busy", evidence: "evidence" },
      { id: "retry", label: "Retry might duplicate execution", evidence: "inference" },
    ],
    edges: [
      { from: "accepted", to: "busy" },
      { from: "busy", to: "retry" },
    ],
  },
} as const;
const CODE = {
  kind: "code",
  assertion: "A repeated error string can share a definition.",
  evidence: ["E2E_CODE_same_literal_in_two_branches"],
  inference: [],
  suggestedCode: {
    before: 'return errors.New("session already exists")',
    after: "return errSessionAlreadyExists",
    verifiedFixed: false,
  },
};

test.beforeEach(async ({ page }) => {
  await installOriginAllowlist(page);
});

async function calls(page: Page) {
  const res = await page.request.get(`${TEST_API}/explain-calls`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: { calls: number } }).data.calls;
}

async function openFinding(page: Page, id: string) {
  await selectFinding(page, id);
  await page.getByTestId(UI.drawer).getByRole("tab", { name: "看懂问题", exact: true }).click();
  await expect(page.getByTestId(UI.drawer)).toBeVisible();
}

async function generate(page: Page, id: string, retry = false) {
  const result = page.waitForResponse(
    (res) =>
      res.url().endsWith(ROUTES.explanation(RUN_ID, id)) && res.request().method() === "POST",
  );
  await page
    .getByTestId(UI.drawer)
    .getByTestId(retry ? UI.retry : UI.generate)
    .click();
  return result;
}

function cacheText(home: string) {
  const directory = join(home, "runs", RUN_ID, "review-explainer", "explanations");
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(directory, entry.name), "utf8"))
    .join("\n");
}

test("[A07/A08] on-demand model output crosses the real Host, appears on screen, persists, and is reused after reload", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  await controlPost(page, "/explain-script", { behavior: "success", body: FLOW });
  await openExplainer(page);
  expect(await calls(page)).toBe(0);
  await openFinding(page, FINDING.busy);
  const selector = page.getByLabel("解释 Agent", { exact: true });
  await expect(selector).toHaveValue("injected-explainer");
  await expect(selector).toContainText("e2e-explainer");
  expect(await calls(page)).toBe(0);
  const response = await generate(page, FINDING.busy);
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({
    agentId: "injected-explainer",
    expectedAgent: { modelId: "e2e-explainer", driverId: "injected" },
  });
  const payload = await response.text();
  expect(payload).toContain(FLOW.assertion);
  expect(payload).toContain(FLOW.evidence[0]);
  const pane = page.getByTestId(UI.drawer);
  await expect(pane.locator(":scope > header > h2")).toHaveText(FLOW.title);
  await expect(page.getByTestId(`review-explainer-finding-${FINDING.busy}`)).toContainText(
    FLOW.title,
  );
  await expect(pane).toContainText(FLOW.assertion);
  await expect(pane).toContainText(FLOW.evidence[0]);
  await expect(pane).toContainText(FLOW.inference[0]);
  await expect(pane).toContainText(/已有证据|证据/);
  await expect(pane).toContainText(/条件推演|推演/);
  await expect(pane.getByTestId(UI.canvas)).toBeVisible();
  await expect(pane.getByTestId(UI.canvasFallback)).toContainText("One request accepted");
  await expect(pane.getByTestId(UI.canvasFallback)).toContainText(
    "Retry might duplicate execution",
  );
  const stored = cacheText(seeded.home);
  expect(stored).toContain(FLOW.evidence[0]);
  expect(stored).toContain(seeded.headSha);
  expect(stored).toContain("e2e-explainer");
  const traceResponse = await page.request.get(`${TEST_API}/explain-calls`);
  expect(traceResponse.status()).toBe(200);
  const trace = (await traceResponse.json()) as { data: { calls: number; inputs: unknown[] } };
  expect(trace.data.inputs).toHaveLength(1);
  const sentToModel = JSON.stringify(trace.data.inputs[0]);
  expect(sentToModel).toContain(ASSERTION.busy);
  expect(sentToModel).toContain(ASSERTION.busyCounterexample);
  expect(sentToModel).toContain(seeded.headSha);
  expect(sentToModel).toContain(BUSY_SNIPPET);
  expect(await calls(page)).toBe(1);

  await page.reload();
  // A04 keeps the real reader in the URL across reload; its data still comes from Host.
  await expect(page.getByTestId(UI.root)).toBeVisible();
  await openFinding(page, FINDING.busy);
  await expect(page.getByTestId(UI.drawer)).toContainText(FLOW.evidence[0]);
  await expect(page.getByTestId(UI.drawer).locator(":scope > header > h2")).toHaveText(FLOW.title);
  expect(await calls(page)).toBe(1);
  await page.getByTestId(UI.drawer).getByTestId(UI.original).click();
  await expect(page.getByTestId(UI.drawer)).toContainText(ASSERTION.busy);
  await expect(page.getByTestId(UI.drawer)).toContainText("prompt accepted then busy");
});

test("configuration failure is explicit and retry restores the selected model without generating", async ({
  page,
}) => {
  await resetCase(page);
  await page.route("**/review-explainer/explanation-agents", (route) => route.abort("failed"));
  await openExplainer(page);
  await openFinding(page, FINDING.busy);
  const pane = page.getByTestId(UI.drawer);
  await expect(pane).toContainText(/配置|Agent/);
  const retry = page.getByRole("button", { name: "重试配置", exact: true });
  await expect(retry).toBeVisible();
  await page.unroute("**/review-explainer/explanation-agents");
  await retry.click();
  await expect(page.getByLabel("解释 Agent", { exact: true })).toHaveValue("injected-explainer");
  await expect(pane.getByTestId(UI.generate)).toBeEnabled();
  expect(await calls(page)).toBe(0);
});

test("a removed saved Agent does not silently fall back to the default model", async ({ page }) => {
  await resetCase(page);
  await page.evaluate(
    (runId) => localStorage.setItem(`councilkit-explanation-agent:${runId}`, "removed-agent"),
    RUN_ID,
  );
  await openExplainer(page);
  await openFinding(page, FINDING.busy);
  const selected = page.getByLabel("解释 Agent", { exact: true });
  await expect(selected).toHaveValue("removed-agent");
  await expect(page.getByTestId(UI.drawer)).toContainText(/不可用|失效|不存在/);
  await expect(page.getByTestId(UI.generate)).toHaveCount(0);
  expect(await calls(page)).toBe(0);
  await selected.selectOption("injected-explainer");
  await expect(page.getByTestId(UI.generate)).toBeEnabled();
  expect(await calls(page)).toBe(0);
});

test("[A07/A08] a simple finding displays the exact generated suggestion without claiming a verified repair", async ({
  page,
}) => {
  const seeded = await resetCase(page);
  await controlPost(page, "/explain-script", { behavior: "success", body: CODE });
  await openExplainer(page);
  await openFinding(page, FINDING.dup);
  expect((await generate(page, FINDING.dup)).status()).toBe(200);
  const suggestion = page.getByTestId(UI.suggested);
  await expect(suggestion).toContainText(CODE.suggestedCode.before);
  await expect(suggestion).toContainText(CODE.suggestedCode.after);
  await expect(suggestion).not.toContainText(/已修好|verified_closed|已验证修复/);
  await expect(page.getByTestId(UI.drawer)).toContainText(/未验证|尚未验证/);
  expect(cacheText(seeded.home)).toContain(CODE.suggestedCode.after);
  expect(await calls(page)).toBe(1);
});

for (const behavior of ["fail", "timeout", "invalid"] as const) {
  test(`[A07/A08] ${behavior} is a visible generation failure; retry invokes the model and replaces the failure`, async ({
    page,
  }) => {
    await resetCase(page);
    await controlPost(page, "/explain-script", { behavior });
    const dialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await openExplainer(page);
    await openFinding(page, FINDING.busy);
    const failed = await generate(page, FINDING.busy);
    expect(failed.status()).toBeGreaterThanOrEqual(400);
    await expect(page.getByTestId(UI.retry)).toBeVisible();
    await expect(page.getByTestId(UI.drawer)).toContainText(/失败|超时|无效|不可用/);
    await expect(page.getByTestId(UI.canvasFallback)).toBeVisible();
    await expect(page.getByTestId(UI.drawer).getByTestId(UI.canvas)).toBeHidden();
    await expect(page.getByTestId(UI.root).locator("script")).toHaveCount(0);
    expect(dialogs).toEqual([]);
    expect(await calls(page)).toBe(1);

    const recovered = { ...FLOW, assertion: `E2E_RECOVERED_${behavior}`, canvas: FLOW.canvas };
    await controlPost(page, "/explain-script", { behavior: "success", body: recovered });
    const retried = await generate(page, FINDING.busy, true);
    expect(retried.status()).toBe(200);
    await expect(page.getByTestId(UI.drawer)).toContainText(recovered.assertion);
    await expect(page.getByTestId(UI.drawer).getByTestId(UI.canvas)).toBeVisible();
    await expect(page.getByTestId(UI.retry)).toBeHidden();
    expect(await calls(page)).toBe(1); // counter resets only at the injected executor boundary
    expect(dialogs).toEqual([]);
  });
}

test("[A08] unavailable Canvas keeps equivalent generated text readable without a rendering crash", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => null,
    });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await resetCase(page);
  await controlPost(page, "/explain-script", { behavior: "success", body: FLOW });
  await openExplainer(page);
  await openFinding(page, FINDING.busy);
  expect((await generate(page, FINDING.busy)).status()).toBe(200);
  await expect(page.getByTestId(UI.canvasFallback)).toBeVisible();
  await expect(page.getByTestId(UI.canvasFallback)).toContainText("One request accepted");
  await expect(page.getByTestId(UI.canvasFallback)).toContainText("State update returned busy");
  await expect(page.getByTestId(UI.canvasFallback)).toContainText(
    "Retry might duplicate execution",
  );
  expect(pageErrors).toEqual([]);
});

test("[A09] enlarged graph closes before locating frozen related source in a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 678, height: 863 });
  const seeded = await resetCase(page);
  await controlPost(page, "/explain-script", { behavior: "success", body: FLOW });
  await openExplainer(page);
  await openFinding(page, FINDING.busy);
  expect((await generate(page, FINDING.busy)).status()).toBe(200);
  await page.getByTestId(UI.drawer).getByRole("button", { name: "放大图", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "放大图解", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "查看关联上下文", exact: true }).click();
  await expect(dialog).toBeHidden();
  const line = page.getByTestId(UI.line("new", "src/busy.go", seeded.busyContextLine));
  await expect(line).toContainText(HIDDEN_CONTEXT_SNIPPET);
  await expect
    .poll(() =>
      line.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const x = Math.min(innerWidth - 8, Math.max(8, rect.left + 70));
        const hit = document.elementFromPoint(x, rect.top + rect.height / 2);
        return rect.top >= 0 && rect.bottom <= innerHeight && hit !== null && element.contains(hit);
      }),
    )
    .toBe(true);
});
