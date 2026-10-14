/**
 * Install a jsdom window onto the Node test global.
 *
 * The built-in Vitest jsdom environment cannot start on Node 20: jsdom 30
 * expects `Iterator` and `Promise.withResolvers`, and undici expects
 * `worker_threads.markAsUncloneable`. Import this module before any module
 * that touches `document`.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const workerThreads = require("node:worker_threads") as {
  markAsUncloneable?: (value: object) => void;
};
if (typeof workerThreads.markAsUncloneable !== "function") {
  workerThreads.markAsUncloneable = () => {};
}

type IteratorCtor = new () => {
  [Symbol.iterator](): IteratorCtor;
  find(predicate: (value: unknown, index: number) => boolean): unknown;
};

const globals = globalThis as typeof globalThis & { Iterator?: IteratorCtor };
if (typeof globals.Iterator !== "function") {
  // jsdom 30's tree iterators extend the Node 22 Iterator helpers (`find`).
  globals.Iterator = class Iterator {
    [Symbol.iterator]() {
      return this;
    }

    find(predicate: (value: unknown, index: number) => boolean) {
      let index = 0;
      for (const value of this as unknown as Iterable<unknown>) {
        if (predicate(value, index)) return value;
        index += 1;
      }
      return undefined;
    }
  } as unknown as IteratorCtor;
}

const PromiseCtor = Promise as unknown as {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};
if (typeof PromiseCtor.withResolvers !== "function") {
  PromiseCtor.withResolvers = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const { JSDOM, VirtualConsole } = require("jsdom") as {
  JSDOM: new (
    html: string,
    options?: { url?: string; pretendToBeVisual?: boolean; virtualConsole?: object },
  ) => { window: Window & typeof globalThis };
  VirtualConsole: new () => object;
};

const virtualConsole = new VirtualConsole();
const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
  url: "http://localhost:3000/",
  pretendToBeVisual: true,
  virtualConsole,
});
const window = dom.window;

const DOM_GLOBALS = [
  "window",
  "document",
  "Document",
  "DocumentFragment",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLSpanElement",
  "HTMLParagraphElement",
  "HTMLHeadingElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "HTMLSelectElement",
  "HTMLOptionElement",
  "HTMLAnchorElement",
  "HTMLFormElement",
  "HTMLCanvasElement",
  "HTMLLinkElement",
  "HTMLDialogElement",
  "HTMLImageElement",
  "HTMLLabelElement",
  "HTMLUListElement",
  "HTMLLIElement",
  "HTMLOListElement",
  "HTMLTableElement",
  "SVGElement",
  "SVGSVGElement",
  "Text",
  "Comment",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "InputEvent",
  "FocusEvent",
  "EventTarget",
  "NodeFilter",
  "DOMParser",
  "MutationObserver",
  "navigator",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

const target = globalThis as unknown as Record<string, unknown>;

// Node 21+ exposes `navigator` (and some other host globals) as a configurable
// getter with no setter. Assignment throws in strict mode; replace the
// descriptor when that happens.
function assignGlobal(key: string, value: unknown): void {
  try {
    target[key] = value;
    return;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
    return;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  // Node documents `delete globalThis.navigator` as the supported override.
  delete target[key];
  target[key] = value;
}

for (const key of DOM_GLOBALS) {
  const value = (window as unknown as Record<string, unknown>)[key];
  if (value !== undefined) assignGlobal(key, key === "window" ? window : value);
}
assignGlobal("window", window);
assignGlobal("document", window.document);
assignGlobal("navigator", window.navigator);
assignGlobal("getComputedStyle", window.getComputedStyle.bind(window));
target.IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    }) as MediaQueryList;
}
assignGlobal("matchMedia", window.matchMedia.bind(window));

if (typeof window.HTMLElement.prototype.scrollIntoView !== "function") {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}

window.HTMLCanvasElement.prototype.getContext = (() =>
  null) as unknown as typeof window.HTMLCanvasElement.prototype.getContext;

if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:councilkit-test";
  URL.revokeObjectURL = () => {};
}
window.URL.createObjectURL = URL.createObjectURL;
window.URL.revokeObjectURL = URL.revokeObjectURL;

if (typeof window.crypto.randomUUID !== "function" && typeof crypto.randomUUID === "function") {
  window.crypto.randomUUID = () => crypto.randomUUID();
}

if (typeof window.requestAnimationFrame !== "function") {
  window.requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number;
  window.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  assignGlobal("requestAnimationFrame", window.requestAnimationFrame);
  assignGlobal("cancelAnimationFrame", window.cancelAnimationFrame);
}

export function domWindow(): Window {
  return window;
}

export function buttonByText(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  );
  if (!(found instanceof HTMLButtonElement)) {
    const have = [...scope.querySelectorAll("button")]
      .map((element) => element.textContent)
      .join(" | ");
    throw new Error(`missing button "${label}"; have "${have}"`);
  }
  return found;
}

export async function clickButton(scope: ParentNode, label: string): Promise<void> {
  const { act } = await import("react");
  const button = buttonByText(scope, label);
  await act(async () => {
    button.click();
  });
}

export async function setControlValue(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  const { act } = await import("react");
  await act(async () => {
    const prototype = Object.getPrototypeOf(control) as HTMLInputElement;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    descriptor?.set?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export async function flushMicrotasks(): Promise<void> {
  const { act } = await import("react");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
