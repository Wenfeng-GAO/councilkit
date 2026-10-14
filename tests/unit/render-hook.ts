import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";

/**
 * jsdom cannot load in this environment (undici's CacheStorage throws
 * `webidl.util.markAsUncloneable is not a function`). React 18's client
 * renderer only needs a handful of DOM surfaces for a hook that returns null,
 * so the harness installs those and nothing else.
 */

interface DomNode {
  nodeType: number;
  nodeName: string;
  tagName?: string;
  childNodes: DomNode[];
  style: Record<string, string>;
  parentNode: DomNode | null;
  ownerDocument: DomDocument | null;
  textContent: string;
  nodeValue?: string;
  onclick: (() => void) | null;
  namespaceURI: string;
  appendChild: (child: DomNode) => DomNode;
  insertBefore: (child: DomNode, before: DomNode | null) => DomNode;
  removeChild: (child: DomNode) => DomNode;
  addEventListener: () => void;
  removeEventListener: () => void;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
}

interface DomDocument {
  nodeType: number;
  nodeName: string;
  documentElement: DomNode | null;
  body: DomNode | null;
  activeElement: null;
  createElement: (type: string) => DomNode;
  createElementNS: (namespace: string, type: string) => DomNode;
  createTextNode: (text: string) => DomNode;
  addEventListener: () => void;
  removeEventListener: () => void;
}

function element(type: string): DomNode {
  const node = {
    nodeType: 1,
    nodeName: type.toUpperCase(),
    tagName: type.toUpperCase(),
    childNodes: [],
    style: {},
    parentNode: null,
    ownerDocument: null,
    textContent: "",
    onclick: null,
    namespaceURI: "http://www.w3.org/1999/xhtml",
  } as unknown as DomNode;
  node.appendChild = (child) => {
    child.parentNode = node;
    node.childNodes.push(child);
    return child;
  };
  node.insertBefore = (child, before) => {
    child.parentNode = node;
    const index = before === null ? -1 : node.childNodes.indexOf(before);
    if (index < 0) node.childNodes.push(child);
    else node.childNodes.splice(index, 0, child);
    return child;
  };
  node.removeChild = (child) => {
    const index = node.childNodes.indexOf(child);
    if (index >= 0) node.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  };
  node.addEventListener = () => {};
  node.removeEventListener = () => {};
  node.setAttribute = () => {};
  node.removeAttribute = () => {};
  return node;
}

function installDom(): void {
  const marker = globalThis as { __councilkitRenderHook?: boolean };
  if (marker.__councilkitRenderHook) return;
  const documentShim: DomDocument = {
    nodeType: 9,
    nodeName: "#document",
    documentElement: null,
    body: null,
    activeElement: null,
    createElement: element,
    createElementNS: (namespace, type) => {
      const node = element(type);
      node.namespaceURI = namespace;
      return node;
    },
    createTextNode: (text) => {
      const textNode = element("#text");
      textNode.nodeType = 3;
      textNode.nodeName = "#text";
      textNode.textContent = text;
      textNode.nodeValue = text;
      return textNode;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  documentShim.documentElement = element("html");
  documentShim.body = element("body");
  documentShim.documentElement.ownerDocument = documentShim;
  documentShim.body.ownerDocument = documentShim;
  const windowShim = {
    document: documentShim,
    HTMLIFrameElement: class HTMLIFrameElement {},
    addEventListener() {},
    removeEventListener() {},
  };
  Object.assign(globalThis, {
    window: windowShim,
    document: documentShim,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  marker.__councilkitRenderHook = true;
}

export function renderHook<T>(useValue: () => T, client: QueryClient) {
  installDom();
  const container = element("div");
  container.ownerDocument = (globalThis as unknown as { document: DomDocument }).document;
  const root: Root = createRoot(container as unknown as Element);
  const box: { current?: T; rendered: boolean } = { rendered: false };

  function Probe() {
    box.current = useValue();
    box.rendered = true;
    return null;
  }

  act(() => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });

  return {
    client,
    read(): T {
      if (!box.rendered) throw new Error("hook has not rendered");
      return box.current as T;
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      client.clear();
    },
  };
}
