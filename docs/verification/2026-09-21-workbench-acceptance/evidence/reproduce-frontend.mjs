import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(`${process.cwd()}/package.json`);
const { build } = require("esbuild");
const { QueryClient, QueryObserver } = require("@tanstack/react-query");
const { createStore } = require("zustand/vanilla");

const jsx = (type, props) => ({ type, props });
globalThis.__jsx = jsx;
globalThis.__createStore = createStore;
let slots = [];
let effects = [];
let cursor = 0;
const reset = () => {
  slots = [];
  effects = [];
  cursor = 0;
};
const flush = () => {
  while (effects.length) effects.shift()();
};
globalThis.__hooks = {
  useRef(value) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = { current: value };
    return slots[i];
  },
  useCallback(fn) {
    return fn;
  },
  useState(value) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof value === "function" ? value() : value;
    return [
      slots[i],
      (next) => {
        slots[i] = typeof next === "function" ? next(slots[i]) : next;
      },
    ];
  },
  useEffect(fn, deps) {
    const i = cursor++;
    const old = slots[i];
    if (!old || deps.some((v, n) => v !== old.deps[n]))
      effects.push(() => {
        old?.cleanup?.();
        slots[i] = { deps, cleanup: fn() };
      });
  },
};
const noop = () => {};
globalThis.window = {
  setTimeout: () => 1,
  clearTimeout: noop,
  requestAnimationFrame: (fn) => fn(),
};
globalThis.document = { hidden: false, addEventListener: noop, removeEventListener: noop };
async function moduleFrom(entry, overrides = {}) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [
      {
        name: "isolated-harness",
        setup(b) {
          const replacements = {
            react: "export const {useState,useRef,useEffect,useCallback}=globalThis.__hooks;",
            "react/jsx-runtime": 'export const jsx=globalThis.__jsx,jsxs=jsx,Fragment="fragment";',
            zustand:
              "export const createStore=globalThis.__createStore; export const useStore=store=>store.getState();",
            "@/runtime/bootstrap": "export const getAppRuntime=()=>globalThis.__runtime;",
            ...overrides,
          };
          b.onResolve({ filter: /.*/ }, (args) =>
            Object.hasOwn(replacements, args.path)
              ? { path: args.path, namespace: "mock" }
              : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
            contents: replacements[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
}

// Reproduction 1: execute the current process hook through an effect transition.
// AC-03 修复后预期：seat-A 挂起的响应在切到 seat-B 后返回，不得写入 B——
// B 的 done 保持 false、windowBlocks 为空。
const requests = [];
globalThis.__runtime = {
  client: {
    getCliRunAttemptLive(runId, attemptId, afterSeq) {
      return new Promise((resolve) => requests.push({ runId, attemptId, afterSeq, resolve }));
    },
  },
};
const { useWorkbenchProcess } = await moduleFrom(
  "src/components/report/workbench/useWorkbenchProcess.ts",
);
const scroller = {
  scrollTop: 0,
  scrollHeight: 1000,
  clientHeight: 500,
  addEventListener: noop,
  removeEventListener: noop,
};
const getScroller = () => scroller;
const processRender = (attemptId) => {
  cursor = 0;
  const state = useWorkbenchProcess({
    runId: "test-run",
    attempt: { attemptId, status: "running" },
    getScroller,
  });
  flush();
  return state;
};
processRender("seat-A");
processRender("seat-B");
requests[0].resolve({
  events: [{ seq: 1, at: "2026-09-21T00:00:00Z", type: "text.delta", text: "OUTPUT_FROM_SEAT_A" }],
  nextSeq: 1,
  done: true,
});
await new Promise((resolve) => setImmediate(resolve));
const polluted = processRender("seat-B");
const raceEvidence = {
  selected: "seat-B",
  requests: requests.map(({ attemptId, afterSeq }) => ({ attemptId, afterSeq })),
  done: polluted.done,
  windowBlocks: polluted.windowBlocks,
  expected: "AC-03 fixed: done=false, windowBlocks=[] (late seat-A response must not write seat-B)",
};

// Reproduction 2: current result hook, real TanStack QueryObserver/cache, mocked transport only.
// AC-02 修复后预期：progress 从 success 回到 running（resume）→ 执行代次 +1、
// 发起新请求、旧成功正文立即失效（result=null）、轮询恢复 2000；
// 再次 success → 显示本次新正文 NEW_SUCCESS_REPORT。
reset();
let requestCount = 0;
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
const unsubscribers = [];
globalThis.__hooks.useQuery = (options) => {
  const i = cursor++;
  let observer = slots[i];
  if (!observer) {
    observer = slots[i] = new QueryObserver(qc, options);
    unsubscribers.push(observer.subscribe(noop));
  } else observer.setOptions(options);
  globalThis.__observer = observer;
  return observer.getCurrentResult();
};
let fetchCalls = 0;
globalThis.__fetch = async () => {
  requestCount++;
  fetchCalls++;
  if (fetchCalls === 1) {
    return {
      runId: "test-run",
      attemptId: "attempt-0",
      executionRef: "attempt-0#1.1",
      executionStatus: "success",
      availability: "available",
      markdown: "OLD_SUCCESS_REPORT",
      truncated: false,
      failure: null,
      reusedFrom: null,
    };
  }
  if (fetchCalls === 2) {
    // 新执行进行中：availability pending，无正文。
    return {
      runId: "test-run",
      attemptId: "attempt-0",
      executionRef: "attempt-0#1.2",
      executionStatus: "running",
      availability: "pending",
      markdown: null,
      truncated: false,
      failure: null,
      reusedFrom: null,
    };
  }
  return {
    runId: "test-run",
    attemptId: "attempt-0",
    executionRef: "attempt-0#1.2",
    executionStatus: "success",
    availability: "available",
    markdown: "NEW_SUCCESS_REPORT",
    truncated: false,
    failure: null,
    reusedFrom: null,
  };
};
const { useAttemptResult } = await moduleFrom(
  "src/components/report/workbench/useAttemptResult.ts",
  {
    "@tanstack/react-query": "export const useQuery=globalThis.__hooks.useQuery;",
    "@/lib/attempt-result": "export const fetchAttemptResult=globalThis.__fetch;",
  },
);
const resultRender = (status) => {
  cursor = 0;
  const value = useAttemptResult("test-run", { attemptId: "attempt-0", status });
  flush();
  return value;
};
resultRender("success");
await new Promise((resolve) => setImmediate(resolve));
resultRender("success");
const resumed = resultRender("running");
await new Promise((resolve) => setImmediate(resolve));
const intervalWhileRunning = globalThis.__observer.options.refetchInterval(
  globalThis.__observer.getCurrentQuery(),
);
// progress 回终态但缓存仍是新执行的 running/pending：手动重读拉取本次成功正文。
const pendingState = resultRender("success");
pendingState.refetch();
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
const afterNewSuccess = resultRender("success");
const observer = globalThis.__observer;
const cacheEvidence = {
  requests: requestCount,
  progressStatusAfterResume: "running",
  resultAfterResume: resumed.result,
  configuredRefetchInterval: observer.options.refetchInterval(observer.getCurrentQuery()),
  intervalWhileRunning,
  markdownAfterNewSuccess: afterNewSuccess.result?.markdown ?? null,
  expected:
    "AC-02 fixed: requests>=3, resultAfterResume=null (旧成功失效), interval=2000, markdown=NEW_SUCCESS_REPORT",
};
for (const fn of unsubscribers) fn();
qc.clear();

// Reproduction 3: current ReviewWorkbench function, real selection store; leaf UI/transport are inert.
reset();
const childNames = [
  "ContextBar",
  "OverviewView",
  "RepairView",
  "SeatColumn",
  "SeatDetailView",
  "StatusBar",
  "ViewBar",
  "WorkbenchNav",
];
const overrides = Object.fromEntries(
  childNames.map((name) => [`./${name}`, `export const ${name}="${name}";`]),
);
overrides["@/styles/review-workbench.css"] = "";
overrides["./host-status"] =
  'export const useWorkbenchHostStatus=()=>"online",hostStatusLabel=()=>"Host 在线";';
overrides["./useAttemptResult"] = "export const useAttemptResult=()=>({result:null});";
const { ReviewWorkbench } = await moduleFrom(
  "src/components/report/workbench/ReviewWorkbench.tsx",
  overrides,
);
// Bundled store is a singleton inside its module; obtain it through createStore interception.
// A second bundle records that instance at creation, retaining the exact selector source.
globalThis.__createStore = (...args) => {
  const create = createStore(...args);
  if (typeof create === "function")
    return (...more) => {
      const store = create(...more);
      globalThis.__selectionStore = store;
      return store;
    };
  globalThis.__selectionStore = create;
  return create;
};
const { ReviewWorkbench: Workbench } = await moduleFrom(
  "src/components/report/workbench/ReviewWorkbench.tsx",
  { ...overrides, "./ContextBar": 'export const ContextBar="ContextBar-v2";' },
);
globalThis.__selectionStore.getState().select("attempt-0");
const run = {
  runId: "test-run",
  markdown: "",
  pipeline: null,
  progress: {
    attempts: [
      { attemptId: "attempt-0", role: "attempt", agentName: "review-security", status: "running" },
    ],
  },
};
const props = {
  run,
  parsed: null,
  repair: {},
  pipeline: {},
  stale: false,
  onRefetch: noop,
  backTo: null,
};
const find = (el, type) => {
  if (!el || typeof el !== "object") return null;
  if (el.type === type) return el;
  const children = el.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const result = find(child, type);
    if (result) return result;
  }
  return null;
};
const viewRender = () => {
  cursor = 0;
  return Workbench(props);
};
const tabBefore = find(viewRender(), "ViewBar").props.tab;
run.progress.attempts[0].status = "success";
const tabAfter = find(viewRender(), "ViewBar").props.tab;
const tabEvidence = {
  tabBefore,
  tabAfter,
  explicitTabs: globalThis.__selectionStore.getState().tabs,
  action: "status only; no Tab click",
  expected: "AC-04 fixed: tabBefore=process, tabAfter=process（完成只提示，不自动切）",
};

// 断言修复后行为：任一复现回到旧行为即以非零码失败。
const failures = [];
if (raceEvidence.done !== false || raceEvidence.windowBlocks.length !== 0)
  failures.push("AC-03 race: late seat-A response polluted seat-B");
if (cacheEvidence.resultAfterResume !== null)
  failures.push("AC-02 cache: stale OLD_SUCCESS_REPORT still shown after resume");
if (cacheEvidence.intervalWhileRunning !== 2000)
  failures.push("AC-02 poll: refetchInterval not resumed while progress running");
if (cacheEvidence.markdownAfterNewSuccess !== "NEW_SUCCESS_REPORT")
  failures.push("AC-02 cache: new execution success markdown not shown");
if (tabEvidence.tabBefore !== "process" || tabEvidence.tabAfter !== "process")
  failures.push("AC-04 tab: completion auto-switched process -> report");
if (failures.length) {
  console.error(`REGRESSION:\n - ${failures.join("\n - ")}`);
  process.exitCode = 1;
} else {
  console.log("ALL ACCEPTANCE CHECKS PASSED (AC-02 / AC-03 / AC-04)");
}

const output = {
  harnessScope:
    "Actual source functions bundled unchanged. Minimal React hook lifecycle; real TanStack QueryObserver; mocked transport and inert leaf UI. No browser, Host, real run, or product code mutated. Script expectations updated 2026-09-21 for the fixed behavior (AC-02/03/04); non-zero exit on regression.",
  raceEvidence,
  cacheEvidence,
  tabEvidence,
};
console.log(JSON.stringify(output, null, 2));
fs.writeFileSync(
  new URL("./frontend-state-evidence.json", import.meta.url),
  `${JSON.stringify(output, null, 2)}\n`,
);
