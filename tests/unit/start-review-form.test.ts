/**
 * @vitest-environment jsdom
 */
import { StartReviewForm } from "@/components/report/StartReviewForm";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/runtime/bootstrap", () => ({
  getAppRuntime: () => ({
    client: {
      startCliReview: async () => ({ runId: "ck-review-test" }),
    },
  }),
}));

vi.mock("@/components/report/DefaultReviewJury", () => ({
  DefaultReviewJury: () => null,
}));

const PR_A = "https://github.com/acme/repo/pull/9";
const PR_B = "https://github.com/acme/repo/pull/10";
const AGAINST = "ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1";

function ReportsNav() {
  const navigate = useNavigate();
  return createElement(
    "nav",
    null,
    createElement(
      "button",
      {
        type: "button",
        onClick: () =>
          navigate(`/reports?pr=${encodeURIComponent(PR_B)}&against=${AGAINST}`),
      },
      "另一条对照",
    ),
    createElement(
      "button",
      { type: "button", onClick: () => navigate("/reports") },
      "报告",
    ),
  );
}

function inputValue(container: HTMLElement): string {
  const input = container.querySelector<HTMLInputElement>("#review-pr-url");
  if (!input) throw new Error("missing #review-pr-url");
  return input.value;
}

function heading(container: HTMLElement): string {
  return container.querySelector("#start-review-heading")?.textContent ?? "";
}

describe("StartReviewForm query", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView = () => {};
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

  it("clears the PR field when the reports query drops pr", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            MemoryRouter,
            {
              initialEntries: [
                `/reports?pr=${encodeURIComponent(PR_A)}&against=${AGAINST}#review`,
              ],
            },
            createElement(StartReviewForm),
            createElement(ReportsNav),
          ),
        ),
      );
    });

    expect(heading(container)).toBe("对照复审");
    expect(inputValue(container)).toBe(PR_A);

    const replace = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "另一条对照",
    );
    await act(async () => {
      replace?.click();
    });
    expect(inputValue(container)).toBe(PR_B);
    expect(heading(container)).toBe("对照复审");

    const reports = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "报告",
    );
    await act(async () => {
      reports?.click();
    });

    expect(heading(container)).toBe("发起 PR 审查");
    expect(inputValue(container)).toBe("");
  });
});
