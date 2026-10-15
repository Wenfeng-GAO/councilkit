/**
 * @vitest-environment jsdom
 *
 * UI-03 / #281 (folded into #274): on a fresh machine the reports page shows a
 * grey info bar with a next-step button instead of the red
 * 「无法读取或保存默认席位…」 error. 「先看示例」 creates (or reuses) the
 * built-in sample and opens it.
 */
import { DefaultReviewJury, NO_JURY_COPY } from "@/components/report/DefaultReviewJury";
import { RuntimeClientError } from "@/runtime/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createDemoRun = vi.fn(async () => ({
  runId: "ck-review-demo-11111111-2222-4333-8444-555555555555",
  demo: true as const,
  reused: false,
}));

vi.mock("@/runtime/bootstrap", () => ({
  getAppRuntime: () => ({ client: { createDemoRun, listInstallations: async () => [] } }),
}));

const readOrSaveReviewJury = vi.fn();
vi.mock("@/runtime/review-jury-client", () => ({
  readOrSaveReviewJury: (...args: unknown[]) => readOrSaveReviewJury(...args),
}));

async function flush() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("UI-03 no review jury yet", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    readOrSaveReviewJury.mockReset();
    createDemoRun.mockClear();
  });

  async function mount(onStatusChange = vi.fn()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            MemoryRouter,
            { initialEntries: ["/reports"] },
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: "/reports",
                element: createElement(DefaultReviewJury, { disabled: false, onStatusChange }),
              }),
              createElement(Route, {
                path: "/reports/:runId",
                element: createElement("p", { id: "opened" }, "示例报告页"),
              }),
            ),
          ),
        ),
      );
    });
    await flush();
    return onStatusChange;
  }

  it("UI-03 missing jury renders a grey info bar, no red alert, no machine code", async () => {
    readOrSaveReviewJury.mockRejectedValue(
      new RuntimeClientError(400, "NOT_FOUND", "还没有审查团。"),
    );
    const onStatus = await mount();
    const bar = container.querySelector(".ck-jury-empty");
    expect(bar?.textContent).toContain(NO_JURY_COPY.replace(/`/g, ""));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".ck-jury-error")).toBeNull();
    expect(container.textContent).not.toContain("无法读取或保存默认席位");
    expect(container.textContent).not.toContain("NOT_FOUND");
    expect(onStatus).toHaveBeenLastCalledWith({
      ready: false,
      summary: "还没有审查团，先看示例或运行 councilkit init",
    });
  });

  it("UI-03 「先看示例」 creates the sample and opens its report", async () => {
    readOrSaveReviewJury.mockRejectedValue(
      new RuntimeClientError(400, "NOT_FOUND", "还没有审查团。"),
    );
    await mount();
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "先看示例",
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    await flush();
    expect(createDemoRun).toHaveBeenCalledTimes(1);
    expect(container.querySelector("#opened")?.textContent).toBe("示例报告页");
  });

  it("UI-03 other read failures keep the error path (no info bar)", async () => {
    readOrSaveReviewJury.mockRejectedValue(
      new RuntimeClientError(400, "BAD_REQUEST", "councils.json is not valid JSON"),
    );
    await mount();
    expect(container.querySelector(".ck-jury-empty")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("councils.json");
  });
});
