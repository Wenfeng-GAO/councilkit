import "./app-dom-install";

import { CompareReportsPage } from "@/app/pages/CompareReportsPage";
import { HOST_DOWN_HINT, HOST_DOWN_TITLE } from "@/lib/host-status";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, mountRouted, waitForText } from "./app-page-harness";

const client = vi.hoisted(() => ({
  getCliRun: vi.fn(),
}));

vi.mock("@/runtime/bootstrap", () => ({
  getAppRuntime: () => ({ client, orchestrator: {} }),
}));

const LEFT = `# Autonomous Review Report

---

## 共识发现

- [major][必现] 只在 A 的重大问题。
- [minor][偶发] 两边相同的问题。
- 没有级别的发现。

## 结论

changes-requested
`;

const RIGHT = `# Autonomous Review Report

---

## 独有发现

- [critical] 只在 B 的致命问题。
- [nit] 两边都没有的琐碎问题。

## 共识发现

- [minor][偶发] 两边相同的问题。

## 结论

approve
`;

function detail(partial: Record<string, unknown>) {
  return {
    runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
    kind: "review",
    status: "completed",
    title: "https://github.com/acme/repo/pull/9",
    startedAt: "2026-08-18T10:03:21.946Z",
    endedAt: null,
    hasReport: true,
    hasPlan: false,
    hasFindings: false,
    hasPlanLock: false,
    reportUrl: "http://127.0.0.1:43127/reports/x",
    progress: null,
    pipeline: null,
    handoff: null,
    markdown: LEFT,
    truncated: false,
    planMarkdown: "",
    planTruncated: false,
    findings: [],
    planLock: null,
    landings: [],
    documents: [],
    findingGroups: null,
    ...partial,
  };
}

describe("CompareReportsPage", () => {
  const mounted: Array<{ unmount: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const item of mounted.splice(0)) await item.unmount();
    client.getCliRun.mockReset();
  });

  it("stays on the pending copy until both runs resolve", async () => {
    const left = deferred<ReturnType<typeof detail>>();
    client.getCliRun.mockImplementation((id: string) =>
      id === "left-run"
        ? left.promise
        : Promise.resolve(detail({ runId: "right-run", markdown: RIGHT })),
    );
    const view = await mountRouted(
      "/reports/compare/left-run/right-run",
      "/reports/compare/:leftId/:rightId",
      createElement(CompareReportsPage),
    );
    mounted.push(view);
    expect(view.container.textContent).toContain("正在对比两份报告…");
    left.resolve(detail({ runId: "left-run", startedAt: null, markdown: LEFT }));
    await waitForText(view.container, "同 PR 审查对比");
    expect(view.container.textContent).toContain("https://github.com/acme/repo/pull/9");
    expect(view.container.textContent).toContain("left-run");
    expect(view.container.textContent).toContain("right-run");
    expect(view.container.textContent).toContain("—");
    expect(view.container.textContent).toContain("changes-requested");
    expect(view.container.textContent).toContain("approve");
    expect(view.container.textContent).toContain("只在 A（2）");
    expect(view.container.textContent).toContain("只在 B（2）");
    expect(view.container.textContent).toContain("两边都有（1）");
    expect(view.container.textContent).toContain("只在 A 的重大问题。");
    expect(view.container.textContent).toContain("没有级别的发现。");
    expect(view.container.textContent).toContain("只在 B 的致命问题。");
    expect(view.container.textContent).not.toContain("没有相同指纹的发现。");
    const pills = [...view.container.querySelectorAll("span")].map((node) => ({
      text: node.textContent,
      className: node.className,
    }));
    expect(pills).toContainEqual({
      text: "major",
      className: expect.stringContaining("text-error"),
    });
    expect(pills).toContainEqual({
      text: "critical",
      className: expect.stringContaining("text-error"),
    });
    expect(pills).toContainEqual({
      text: "minor",
      className: expect.stringContaining("text-warn"),
    });
    expect(pills).toContainEqual({ text: "nit", className: expect.stringContaining("text-warn") });
    expect(pills).toContainEqual({
      text: "必现",
      className: expect.stringContaining("text-muted"),
    });
    expect(view.container.querySelector('a[href="/reports/left-run"]')?.textContent).toContain("A");
    expect(view.container.querySelector('a[href="/reports"]')?.textContent).toBe("← CLI 报告");
  });

  it("names the host when either read fails with a network error", async () => {
    client.getCliRun.mockImplementation((id: string) =>
      id === "left-run"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(detail({ runId: "right-run" })),
    );
    const view = await mountRouted(
      "/reports/compare/left-run/right-run",
      "/reports/compare/:leftId/:rightId",
      createElement(CompareReportsPage),
    );
    mounted.push(view);
    await waitForText(view.container, HOST_DOWN_TITLE);
    expect(view.container.textContent).toContain(HOST_DOWN_HINT.replace(/`/g, ""));
  });

  it("explains a generic miss when a run is missing", async () => {
    client.getCliRun
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(detail({ runId: "right-run" }));
    const missing = await mountRouted(
      "/reports/compare/left-run/right-run",
      "/reports/compare/:leftId/:rightId",
      createElement(CompareReportsPage),
    );
    mounted.push(missing);
    await waitForText(missing.container, "无法对比这两份报告");
    expect(missing.container.textContent).toContain("确认两条 run 都还在本机 CLI 库里。");
  });

  it("rejects a document that is not an autonomous review", async () => {
    client.getCliRun.mockImplementation((id: string) =>
      Promise.resolve(
        detail({
          runId: id,
          markdown: id === "left-run" ? "# 笔记\n\n不是审查报告。\n" : RIGHT,
        }),
      ),
    );
    const plain = await mountRouted(
      "/reports/compare/left-run/right-run",
      "/reports/compare/:leftId/:rightId",
      createElement(CompareReportsPage),
    );
    mounted.push(plain);
    await waitForText(plain.container, "其中一份不是审查报告");
    expect(plain.container.textContent).toContain("对比只支持 Autonomous Review Report。");
  });

  it("shows an empty diff when both reports share nothing", async () => {
    const empty = `# Autonomous Review Report

---

## 概览

没有发现章节。
`;
    client.getCliRun.mockImplementation((id: string) =>
      Promise.resolve(
        detail({
          runId: id,
          markdown: empty,
          startedAt: "2026-08-18T10:03:21.946Z",
          title: "无裁决",
        }),
      ),
    );
    const view = await mountRouted(
      "/reports/compare/left-run/right-run",
      "/reports/compare/:leftId/:rightId",
      createElement(CompareReportsPage),
    );
    mounted.push(view);
    await waitForText(view.container, "没有只属于 A 的发现。");
    expect(view.container.textContent).toContain("没有只属于 B 的发现。");
    expect(view.container.textContent).toContain("没有相同指纹的发现。");
    expect(view.container.textContent).toContain("只在 A（0）");
    expect(view.container.textContent).not.toContain("changes-requested");
  });

  it("keeps both queries disabled when the route has no ids", async () => {
    const view = await mountRouted("/bare", "/bare", createElement(CompareReportsPage));
    mounted.push(view);
    expect(view.container.textContent).toContain("正在对比两份报告…");
    expect(client.getCliRun.mock.calls).toEqual([]);
  });
});
