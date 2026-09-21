const fs = require("node:fs");
const vm = require("node:vm");
const ts = require(`${process.cwd()}/node_modules/typescript`);
const source = fs.readFileSync("src/components/report/workbench/useWorkbenchProcess.ts", "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tick = () => new Promise(setImmediate);
function setup() {
  let clock = 0;
  let nextId = 1;
  let calls = 0;
  const timers = new Map();
  const effects = [];
  const handlers = new Map();
  const pending = [];
  const document = {
    hidden: false,
    addEventListener: (k, f) => handlers.set(k, f),
    removeEventListener: (k) => handlers.delete(k),
  };
  const window = {
    setTimeout: (f, ms) => {
      const id = nextId++;
      timers.set(id, { f, at: clock + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (f) => {
      f();
      return 0;
    },
  };
  const state = [];
  const react = {
    useEffect: (f) => effects.push(f),
    useRef: (x) => ({ current: x }),
    useState: (x) => {
      const idx = state.length;
      state.push(typeof x === "function" ? x() : x);
      return [
        state[idx],
        (v) => {
          state[idx] = typeof v === "function" ? v(state[idx]) : v;
        },
      ];
    },
  };
  const exported = {};
  vm.runInNewContext(code, {
    exports: exported,
    window,
    document,
    require: (n) => {
      if (n === "react") return react;
      if (n === "@/runtime/bootstrap")
        return {
          getAppRuntime: () => ({
            client: {
              getCliRunAttemptLive: () => {
                calls++;
                return new Promise((resolve) => pending.push(resolve));
              },
            },
          }),
        };
      if (n === "@/lib/live-transcript")
        return { foldLiveEvents: () => [], foldLiveEventsAppend: () => [] };
      if (n === "./seatDetailModel")
        return {
          PROCESS_CACHE_BUDGET_BYTES: 2.5 * 1024 * 1024,
          PROCESS_POLL_MS: 2000,
          PROCESS_WINDOW_LINES: 200,
          PROCESS_WINDOW_STEP: 200,
          newActivityCount: (a, b) => Math.max(0, b - a),
          isCursorReset: (a, b) => b < a,
          isStaleResponse: (a, b) => a !== b,
          chunkedWindow: (total, visible) => ({
            hiddenCount: Math.max(0, total - visible),
            fromIndex: Math.max(0, total - visible),
          }),
          nextPollDelayMs: (n) => Math.min(30000, 2000 * 2 ** n),
        };
      throw Error(n);
    },
  });
  const hook = exported.useWorkbenchProcess({
    runId: "test",
    attempt: { attemptId: "attempt-0", status: "running" },
    getScroller: () => null,
  });
  const cleanup = effects[0]();
  return {
    hook,
    timers,
    advance: (ms) => {
      clock += ms;
    },
    get calls() {
      return calls;
    },
    setHidden: (h) => {
      document.hidden = h;
      handlers.get("visibilitychange")?.();
    },
    resolve: () => pending.shift()({ events: [], nextSeq: 0, done: false }),
    fireNext: () => {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) return false;
      const [id, t] = next;
      clock = t.at;
      timers.delete(id);
      t.f();
      return true;
    },
    cleanup,
  };
}
(async () => {
  const h = setup();
  h.setHidden(true);
  h.resolve();
  await tick();
  // AC-09(a) 修复后预期：hidden 期间响应到达不排程（schedule 检查 document.hidden）。
  const scheduledWhileHidden = h.timers.size;
  h.fireNext();
  const scenarioA = {
    scenario: "hide during in-flight response",
    scheduledWhileHidden,
    requestsAfterTimerFired: h.calls,
    expected: "no timer or second request while hidden",
  };
  h.cleanup();
  const r = setup();
  r.resolve();
  await tick();
  r.advance(500);
  r.hook.retry();
  r.resolve();
  await tick();
  // AC-09(b) 修复后预期：手动重读清掉旧 timer 走同一条链，任意时刻最多一个 timer。
  const timersAfterManualRetry = r.timers.size;
  r.fireNext();
  r.resolve();
  await tick();
  r.fireNext();
  r.resolve();
  await tick();
  r.cleanup();
  const scenarioB = {
    scenario: "manual retry with existing regular timer",
    timersAfterManualRetry,
    orphanTimersAfterCleanup: r.timers.size,
    expected: "one scheduled timer; zero after cleanup",
  };
  const failures = [];
  if (scenarioA.scheduledWhileHidden !== 0 || scenarioA.requestsAfterTimerFired !== 1)
    failures.push("AC-09a: polling scheduled while hidden");
  if (scenarioB.timersAfterManualRetry !== 1 || scenarioB.orphanTimersAfterCleanup !== 0)
    failures.push("AC-09b: duplicate timer chains after manual retry");
  console.log(
    JSON.stringify({
      ...scenarioA,
      pass: scenarioA.scheduledWhileHidden === 0 && scenarioA.requestsAfterTimerFired === 1,
    }),
  );
  console.log(
    JSON.stringify({
      ...scenarioB,
      pass: scenarioB.timersAfterManualRetry === 1 && scenarioB.orphanTimersAfterCleanup === 0,
    }),
  );
  if (failures.length) {
    console.error(`REGRESSION:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else console.log("ALL ACCEPTANCE CHECKS PASSED (AC-09 polling schedule)");
})();
