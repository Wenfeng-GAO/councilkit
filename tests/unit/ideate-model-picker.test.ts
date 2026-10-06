/**
 * @vitest-environment jsdom
 */
import { type IdeateJuryStatus, IdeateModelPicker } from "@/components/report/IdeateModelPicker";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useCallback, useState } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/runtime/bootstrap", () => ({
  getAppRuntime: () => ({
    client: {
      listInstallations: async () => ({ installations: [] }),
      modelCatalog: async () => ({ catalog: [] }),
    },
  }),
}));

vi.mock("@/runtime/product-jury-client", () => ({
  readProductJury: async () => ({
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
  }),
}));

const settledOverride: IdeateJuryStatus = {
  ready: true,
  summary: "3 个席位 · 产品席汇总 · 本次改用其他型号",
  models: {
    aggregatorIndex: 0,
    models: [
      { modelId: "grok-4.6", driverSelection: { driverId: "grok-stream-json", options: {} } },
      { modelId: "kimi-code/k3", driverSelection: { driverId: "kimi-stream-json", options: {} } },
      { modelId: "gpt-6-astra", driverSelection: { driverId: "codex-app-server", options: {} } },
    ],
  },
};

function Harness({
  client,
  onStatus,
}: {
  client: QueryClient;
  onStatus: { current: (status: IdeateJuryStatus) => void };
}) {
  const [status, setStatus] = useState<IdeateJuryStatus | null>(null);
  const report = useCallback(
    (next: IdeateJuryStatus) => {
      onStatus.current(next);
      setStatus(next);
    },
    [onStatus],
  );
  return createElement(
    QueryClientProvider,
    { client },
    createElement(IdeateModelPicker, {
      disabled: false,
      onStatusChange: report,
    }),
    createElement("p", null, status?.summary ?? ""),
  );
}

describe("IdeateModelPicker", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  it("settles after the reporter seat changes", async () => {
    const calls: IdeateJuryStatus[] = [];
    let armed = false;
    let mark = 0;
    const onStatus = {
      current: (status: IdeateJuryStatus) => {
        calls.push(status);
        if (armed && calls.length - mark > 20) {
          throw new Error(`status updated ${calls.length - mark} times after one reporter change`);
        }
      },
    };
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Harness, { client, onStatus }));
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const edit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "本次改用其他模型",
    );
    expect(edit).toBeTruthy();
    await act(async () => {
      edit?.click();
    });

    const productReporter = container.querySelector<HTMLInputElement>(
      'input[aria-label="由产品席汇总"]',
    );
    expect(productReporter).toBeTruthy();
    mark = calls.length;
    armed = true;
    await act(async () => {
      productReporter?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const updatesAfterChange = calls.length - mark;
    expect(updatesAfterChange).toBeLessThanOrEqual(2);
    expect(calls.at(-1)).toEqual(settledOverride);
    expect(container.textContent).toContain("本次改用其他型号");
  });
});
