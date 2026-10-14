import "./app-dom-install";

import { IdeatePage } from "@/app/pages/IdeatePage";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clickButton } from "./app-dom-install";
import { deferred, mountRouted, settle, waitForText } from "./app-page-harness";

const client = vi.hoisted(() => ({
  listCliRuns: vi.fn(),
}));

vi.mock("@/runtime/bootstrap", () => ({
  getAppRuntime: () => ({ client, orchestrator: {} }),
}));

vi.mock("@/components/report/StartIdeateForm", () => ({
  StartIdeateForm: () => null,
}));

function run(partial: Record<string, unknown>) {
  return {
    kind: "ideate",
    status: "completed",
    title: "一个想法",
    startedAt: null,
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

describe("IdeatePage", () => {
  const mounted: Array<{ unmount: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(mounted.splice(0).map((item) => item.unmount()));
    client.listCliRuns.mockReset();
  });

  it("shows a pending read, then an error and a successful refetch", async () => {
    const pending = deferred<{ runs: ReturnType<typeof run>[] }>();
    client.listCliRuns.mockReturnValueOnce(pending.promise);
    const view = await mountRouted("/ideate", "/ideate", createElement(IdeatePage));
    mounted.push(view);
    expect(view.container.textContent).toContain("正在读取讨论记录…");
    expect(view.container.querySelector('a[href="#ideate-history"]')?.textContent).toContain(
      "最近讨论",
    );

    pending.reject(new Error("offline"));
    await waitForText(view.container, "讨论记录读取失败。");
    client.listCliRuns.mockResolvedValueOnce({
      runs: [
        run({
          runId: "ck-ideate-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1",
          title: "排队中的想法",
          status: "running",
        }),
        run({
          runId: "ck-ideate-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2",
          title: "失败的想法",
          status: "failed",
        }),
        run({
          runId: "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3",
          kind: "review",
          title: "审查",
        }),
        ...Array.from({ length: 4 }, (_, index) =>
          run({
            runId: `ck-ideate-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee${index + 4}`,
            title: `旧想法 ${index}`,
            status: "completed",
          }),
        ),
      ],
    });
    const retry = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "重新读取",
    );
    expect(retry instanceof HTMLButtonElement).toBe(true);
    await clickButton(view.container, "重新读取");
    await waitForText(view.container, "排队中的想法");
    expect(view.container.textContent).toContain("进行中");
    expect(view.container.textContent).toContain("失败");
    expect(view.container.textContent).toContain("已完成");
    expect(view.container.textContent).not.toContain("审查");
    expect(view.container.textContent).not.toContain("旧想法 3");
    const first = view.container.querySelector(
      'a[href="/reports/ck-ideate-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1"]',
    );
    expect(first?.textContent).toContain("ck-ideate-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1");
    expect(view.container.querySelector('a[href="/reports"]')?.textContent).toBe("全部报告 ↗");
    await settle();
  });

  it("shows the empty history copy when no ideate run exists", async () => {
    client.listCliRuns.mockResolvedValue({ runs: [] });
    const view = await mountRouted("/ideate", "/ideate", createElement(IdeatePage));
    mounted.push(view);
    await waitForText(view.container, "还没有创意讨论。填写上面的想法，开始第一次讨论。");
  });
});
