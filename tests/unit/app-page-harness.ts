import "./app-dom-install";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, type ReactNode, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export interface MountedPage {
  client: QueryClient;
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

export async function mountNode(node: ReactNode, client = makeQueryClient()): Promise<MountedPage> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, node));
  });
  return {
    client,
    container,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export async function mountRouted(
  entry: string,
  path: string,
  page: ReactElement,
  client = makeQueryClient(),
): Promise<MountedPage> {
  return mountNode(
    createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      createElement(Routes, null, createElement(Route, { path, element: page })),
    ),
    client,
  );
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export async function waitForText(scope: ParentNode, text: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((scope.textContent ?? "").includes(text)) return;
    await settle();
  }
  throw new Error(`missing text "${text}"; have "${(scope.textContent ?? "").slice(0, 500)}"`);
}

export function setDocumentVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state === "hidden",
  });
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
