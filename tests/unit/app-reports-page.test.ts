import "./app-dom-install";

import { ReportsPage } from "@/app/pages/ReportsPage";
import { HOST_DOWN_HINT, HOST_DOWN_TITLE } from "@/lib/host-status";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonByText, clickButton } from "./app-dom-install";
import { deferred, mountRouted, settle, waitForText } from "./app-page-harness";

const client = vi.hoisted(() => ({
  listCliRuns: vi.fn(),
}));

vi.mock("@/runtime/bootstrap", () => ({
  getAppRuntime: () => ({ client, orchestrator: {} }),
}));

vi.mock("@/components/report/StartReviewForm", () => ({
  StartReviewForm: () => null,
}));

vi.mock("@/components/report/PrCaseSummary", () => ({
  PrCaseSummary: () => createElement("p", null, "案件摘要"),
}));

const PR9 = "https://github.com/acme/repo/pull/9";
const PR4 = "https://github.com/acme/other/pull/4";

function evidence(prUrl: string, extra: Record<string, unknown> = {}) {
  return {
    complete: false,
    sha: null,
    prUrl,
    againstRunId: null,
    blockingIds: [] as string[],
    unverifiedFixIds: [] as string[],
    openIds: [] as string[],
    ...extra,
  };
}

function run(partial: Record<string, unknown>) {
  return {
    kind: "review",
    status: "completed",
    title: "记录",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: null,
    hasReport: true,
    hasPlan: false,
    hasFindings: false,
    hasPlanLock: false,
    reportUrl: "http://127.0.0.1:43127/reports/x",
    progress: null,
    pipeline: null,
    handoff: null,
    ...partial,
  };
}

const LIBRARY = {
  runs: [
    run({
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
      title: PR9,
      status: "running",
      startedAt: "2026-08-18T10:03:21.946Z",
      reviewEvidence: evidence(PR9),
      pipeline: { phase: "applying", applyStatus: null, planVerdict: null, followUpRunId: null },
      progress: {
        phase: "attempts",
        attempts: [
          { role: "attempt", status: "success" },
          { role: "attempt", status: "running" },
        ],
      },
    }),
    run({
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
      title: PR9,
      status: "failed",
      startedAt: "2026-08-02T00:00:00.000Z",
      reviewEvidence: evidence(PR9),
    }),
    run({
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
      title: PR9,
      status: "completed",
      startedAt: null,
      reviewEvidence: evidence(PR9, { againstRunId: "ck-review-older" }),
    }),
    run({
      runId: "ck-squad-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4",
      kind: "squad",
      title: "工程班甲",
      status: "failed",
      startedAt: "2026-08-09T00:00:00.000Z",
    }),
    run({
      runId: "ck-repair-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee5",
      kind: "repair",
      title: "修复任务甲",
      status: "completed",
      businessResult: "needs_attention",
      startedAt: "2026-08-10T00:00:00.000Z",
    }),
    run({
      runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee6",
      title: PR4,
      status: "completed",
      startedAt: "2026-07-01T00:00:00.000Z",
      reviewEvidence: evidence(PR4, { complete: true, sha: "a".repeat(40) }),
    }),
    run({
      runId: "ck-ideate-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee7",
      kind: "ideate",
      title: "创意甲",
      status: "completed",
    }),
    run({
      runId: "ck-ideate-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee8",
      kind: "ideate",
      title: "创意乙",
      status: "completed",
    }),
  ],
};

function filterButton(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((button) => {
    const count = button.querySelector("span")?.textContent ?? "";
    return button.textContent?.slice(0, button.textContent.length - count.length) === label;
  });
  if (!(found instanceof HTMLButtonElement)) throw new Error(`missing filter ${label}`);
  return found;
}

async function pressFilter(scope: ParentNode, label: string): Promise<void> {
  const { act } = await import("react");
  const button = filterButton(scope, label);
  await act(async () => {
    button.click();
  });
}

describe("ReportsPage", () => {
  const mounted: Array<{ unmount: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const item of mounted.splice(0)) await item.unmount();
    client.listCliRuns.mockReset();
  });

  async function openWith(payload: { runs: unknown[] } | Promise<{ runs: unknown[] }>) {
    client.listCliRuns.mockImplementation(() => Promise.resolve(payload));
    const view = await mountRouted("/reports", "/reports", createElement(ReportsPage));
    mounted.push(view);
    return view;
  }

  it("shows the pending, host-down, generic, and empty states", async () => {
    const pending = deferred<{ runs: unknown[] }>();
    client.listCliRuns.mockReturnValueOnce(pending.promise);
    const view = await mountRouted("/reports", "/reports", createElement(ReportsPage));
    mounted.push(view);
    expect(view.container.textContent).toContain("正在读取报告…");
    expect(view.container.textContent).toContain("发起一次审查，或接着上次的结论继续。");

    pending.reject(new TypeError("Failed to fetch"));
    await waitForText(view.container, HOST_DOWN_TITLE);
    expect(view.container.textContent).toContain(HOST_DOWN_HINT);
    await view.unmount();
    mounted.splice(0);

    client.listCliRuns.mockRejectedValueOnce(new Error("disk"));
    const generic = await mountRouted("/reports", "/reports", createElement(ReportsPage));
    mounted.push(generic);
    await waitForText(generic.container, "无法读取 CLI 报告");
    expect(generic.container.textContent).toContain("确认 Runtime Host 在线，且本机有 CLI runs。");
    await generic.unmount();
    mounted.splice(0);

    const empty = await openWith({ runs: [] });
    await waitForText(empty.container, "第一份报告，从一个 PR 开始");
    expect(empty.container.textContent).toContain("在上方粘贴 PR 链接，选择模型即可开始。");
  });

  it("filters, searches, expands history, and refreshes the library", async () => {
    const view = await openWith(LIBRARY);
    await waitForText(view.container, "acme/repo #9");
    expect(view.container.textContent).toContain("正在按方案落地");
    expect(view.container.textContent).toContain("下一步：等待完整审查证据");
    expect(view.container.textContent).toContain("1/2 席");
    expect(view.container.textContent).toContain("工程班甲");
    expect(view.container.textContent).toContain("修复任务甲");
    expect(view.container.textContent).toContain("需要处理");
    expect(view.container.textContent).not.toContain("acme/other #4");
    expect(view.container.textContent).toContain("另有 2 条创意讨论");
    expect(view.container.querySelector('a[href="/ideate"]')?.textContent).toBe(
      "另有 2 条创意讨论",
    );
    const stamp = view.container.querySelector('time[dateTime="2026-08-18T10:03:21.946Z"]');
    expect(stamp?.getAttribute("dateTime")).toBe("2026-08-18T10:03:21.946Z");
    expect(filterButton(view.container, "需要处理").getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelector("h2")?.textContent).toContain("3 / 4");

    await pressFilter(view.container, "已完成");
    await waitForText(view.container, "acme/other #4");
    expect(view.container.textContent).not.toContain("acme/repo #9");
    expect(view.container.textContent).toContain("已完成");

    await pressFilter(view.container, "进行中");
    expect(view.container.textContent).toContain("acme/repo #9");
    expect(view.container.textContent).not.toContain("工程班甲");

    await pressFilter(view.container, "全部案件");
    expect(view.container.textContent).toContain("acme/other #4");
    await pressFilter(view.container, "审查");
    expect(view.container.textContent).toContain("acme/repo #9");
    expect(view.container.textContent).not.toContain("工程班甲");
    expect(view.container.textContent).not.toContain("修复任务甲");
    await pressFilter(view.container, "工程班");
    expect(view.container.textContent).toContain("工程班甲");
    expect(view.container.textContent).toContain("修复任务甲");
    expect(view.container.textContent).not.toContain("acme/repo #9");
    await pressFilter(view.container, "审查与工程班");

    const search = view.container.querySelector("#report-search");
    expect(search instanceof HTMLInputElement).toBe(true);
    const { setControlValue } = await import("./app-dom-install");
    await setControlValue(search as HTMLInputElement, "工程班甲");
    expect(view.container.textContent).toContain("工程班甲");
    expect(view.container.textContent).not.toContain("修复任务甲");
    await setControlValue(search as HTMLInputElement, "没有这个案件");
    expect(view.container.textContent).toContain("没有找到匹配案件");
    expect(view.container.textContent).toContain("试试其他关键词，或切换案件状态。");
    await setControlValue(search as HTMLInputElement, "");

    await pressFilter(view.container, "需要处理");
    await clickButton(view.container, "历史 2");
    expect(view.container.textContent).toContain("案件摘要");
    expect(view.container.textContent).toContain("修复");
    expect(view.container.textContent).toContain("审查");
    expect(view.container.textContent).toContain("对照复审");
    expect(view.container.textContent).toContain("失败");
    const historyTime = view.container.querySelector('time[dateTime="2026-08-02T00:00:00.000Z"]');
    expect(historyTime?.getAttribute("dateTime")).toBe("2026-08-02T00:00:00.000Z");
    await clickButton(view.container, "收起历史");
    expect(view.container.textContent).not.toContain("案件摘要");

    const again = deferred<typeof LIBRARY>();
    let fetches = 0;
    client.listCliRuns.mockImplementation(() => {
      fetches += 1;
      return again.promise;
    });
    const refresh = buttonByText(view.container, "刷新");
    const { act } = await import("react");
    await act(async () => {
      refresh.click();
    });
    await settle();
    const queryState = view.client.getQueryState(["cli-runs"]);
    expect({
      fetches,
      fetchStatus: queryState?.fetchStatus ?? "missing",
      status: queryState?.status ?? "missing",
    }).toEqual({ fetches: 1, fetchStatus: "fetching", status: "success" });
    const updating = buttonByText(view.container, "更新中…");
    expect(updating.disabled).toBe(true);
    expect(filterButton(view.container, "需要处理").disabled).toBe(false);
    again.resolve(LIBRARY);
    await settle();
    await waitForText(view.container, "刷新");
  });

  it("uses the quiet attention empty state when every case is done", async () => {
    const view = await openWith({
      runs: [
        run({
          runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee6",
          title: PR4,
          status: "completed",
          reviewEvidence: evidence(PR4, { complete: true, sha: "b".repeat(40) }),
        }),
      ],
    });
    await waitForText(view.container, "没有需要处理的案件");
    expect(view.container.textContent).toContain("进行中、失败或未决重大项会列在这里。");
    expect(view.container.textContent).not.toContain("另有");
  });

  it("DM-03 DM-07 demo runs show 示例 and stay out of 需要处理", async () => {
    const realPr = "https://github.com/acme/real/pull/2";
    const samplePr = "https://github.com/acme/sample/pull/8";
    const view = await openWith({
      runs: [
        run({
          runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
          title: realPr,
          status: "failed",
          startedAt: "2026-10-14T00:00:00.000Z",
          reviewEvidence: evidence(realPr),
        }),
        run({
          runId: "ck-review-demo-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9",
          title: "示例 PR：给登录接口加限流",
          status: "completed",
          demo: true,
          hasFindings: true,
          startedAt: "2026-10-15T00:00:00.000Z",
          reviewEvidence: evidence(samplePr, {
            complete: true,
            sha: "c".repeat(40),
            blockingIds: ["demo-limiter-memory"],
            openIds: ["demo-limiter-memory"],
          }),
        }),
      ],
    });
    await waitForText(view.container, "acme/real #2");
    expect(filterButton(view.container, "需要处理").querySelector("span")?.textContent).toBe("1");
    expect(filterButton(view.container, "示例").querySelector("span")?.textContent).toBe("1");
    expect(view.container.textContent).not.toContain("acme/sample #8");
    expect(view.container.querySelector(".ck-demo-tag")).toBeNull();

    await pressFilter(view.container, "全部案件");
    expect(view.container.textContent).toContain("acme/sample #8");
    expect(view.container.textContent).toContain("acme/real #2");
    expect(view.container.querySelector(".ck-demo-tag")?.textContent).toBe("示例");

    await pressFilter(view.container, "真实");
    expect(view.container.textContent).toContain("acme/real #2");
    expect(view.container.textContent).not.toContain("acme/sample #8");
    expect(view.container.querySelector(".ck-demo-tag")).toBeNull();

    await pressFilter(view.container, "示例");
    expect(view.container.textContent).toContain("acme/sample #8");
    expect(view.container.textContent).not.toContain("acme/real #2");
    expect(view.container.querySelector(".ck-demo-tag")?.textContent).toBe("示例");
  });

  it("DM-07 mentions sample reports when attention is empty", async () => {
    const view = await openWith({
      runs: [
        run({
          runId: "ck-review-demo-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9",
          title: "示例 PR：给登录接口加限流",
          status: "completed",
          demo: true,
          reviewEvidence: evidence("https://github.com/acme/sample/pull/8", {
            complete: true,
            sha: "d".repeat(40),
            blockingIds: ["demo-limiter-memory"],
          }),
        }),
      ],
    });
    await waitForText(view.container, "没有需要处理的案件");
    expect(filterButton(view.container, "需要处理").querySelector("span")?.textContent).toBe("0");
    expect(view.container.textContent).toContain("示例报告在「示例」里，不计入需要处理。");
    await pressFilter(view.container, "已完成");
    expect(view.container.textContent).toContain("acme/sample #8");
    expect(view.container.querySelector(".ck-demo-tag")?.textContent).toBe("示例");
  });

  it("#304 case card shows 「N 需要处理 · M 阻塞」 next to 已完成 from the shared count", async () => {
    const view = await openWith({
      runs: [
        run({
          runId: "ck-review-188cdfd8-2e7e-482a-af6e-87141ce17a91",
          title: "真实任务审查",
          hasFindings: true,
          attention: {
            problems: 7,
            findings: 7,
            needsAttention: 6,
            blocking: 0,
            aggregatorBlocking: 4,
          },
        }),
      ],
    });
    await waitForText(view.container, "真实任务审查");
    const status = view.container.querySelector(".ck-case-status");
    expect(status?.textContent).toContain("已完成");
    expect(status?.querySelector(".ck-case-counts")?.textContent).toBe("6 需要处理 · 0 阻塞");
  });
});
