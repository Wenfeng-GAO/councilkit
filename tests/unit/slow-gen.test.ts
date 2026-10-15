import { DRIVER_IDS, type DriverId, TIMEOUTS } from "@shared/runtime/contracts";
import type { GenerationTimeouts } from "@shared/runtime/generation-timeouts";
import { REPORT_SECTION_HEADINGS } from "@shared/runtime/report-sections";
import type { ExecutionProfileDto } from "@shared/runtime/schemas";
import { SLOW_GEN_CRASH_AT_MS, type SlowGenConfig, slowGenFromEnv } from "@shared/runtime/slow-gen";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriverEvent } from "../../runtime-host/drivers/types";
import { createInstallationRegistry } from "../../runtime-host/installations/registry";
import { createLogger } from "../../runtime-host/logging";
import { createProfileProbe } from "../../runtime-host/profiles/probe";
import {
  createSlowGenDriverFactory,
  isReportPrompt,
  slowGenDiscovery,
  slowGenValidate,
} from "../../runtime-host/slow-gen";

/** B4 #279: test-only 「慢生成」 switch for QA black-box runs. */

const REPORT_PROMPT = `context…\n请基于以上全部讨论生成决策报告：\n${REPORT_SECTION_HEADINGS.join("\n")}\n只输出报告正文。`;

function registry() {
  const reg = createInstallationRegistry({
    logger: createLogger({ sink: () => undefined }),
    discover: slowGenDiscovery,
    validate: slowGenValidate,
  });
  reg.refresh();
  return reg;
}

function factories(config: SlowGenConfig) {
  return Object.fromEntries(
    DRIVER_IDS.map((id) => [id, createSlowGenDriverFactory(id, config, TIMEOUTS)]),
  ) as Record<DriverId, ReturnType<typeof createSlowGenDriverFactory>>;
}

function run(
  config: SlowGenConfig,
  prompt: string,
  driverId: DriverId = "claude-stream-json",
  timeouts: GenerationTimeouts = TIMEOUTS,
) {
  const driver = createSlowGenDriverFactory(driverId, config, timeouts)("p-1");
  const events: DriverEvent[] = [];
  let done = false;
  const promise = driver
    .execute({ executionId: "exec-1", prompt, modelId: "kimi-code/k3", coldStart: true }, (event) =>
      events.push(event),
    )
    .then(() => {
      done = true;
    });
  const terminal = () =>
    events.find((e) => e.type === "completed" || e.type === "failed" || e.type === "interrupted");
  return { driver, events, promise, terminal, isDone: () => done };
}

describe("slowGenFromEnv", () => {
  it("parses silent|drip and the interval, default 30s", () => {
    expect(slowGenFromEnv({ COUNCILKIT_SLOW_GEN: "silent" })).toEqual({
      mode: "silent",
      intervalMs: 30_000,
    });
    expect(
      slowGenFromEnv({ COUNCILKIT_SLOW_GEN: " DRIP ", COUNCILKIT_SLOW_GEN_MS: "1500" }),
    ).toEqual({ mode: "drip", intervalMs: 1500 });
    expect(slowGenFromEnv({ COUNCILKIT_SLOW_GEN: "drip", COUNCILKIT_SLOW_GEN_MS: "x" })).toEqual({
      mode: "drip",
      intervalMs: 30_000,
    });
    expect(
      slowGenFromEnv({ COUNCILKIT_SLOW_GEN: "buffered", COUNCILKIT_SLOW_GEN_MS: "50000" }),
    ).toEqual({
      mode: "buffered",
      intervalMs: 50_000,
    });
    expect(slowGenFromEnv({ COUNCILKIT_SLOW_GEN: "crash" })?.mode).toBe("crash");
    expect(slowGenFromEnv({})).toBeNull();
    expect(slowGenFromEnv({ COUNCILKIT_SLOW_GEN: "1" })).toBeNull();
  });
});

describe("slow-gen installations + Profile check", () => {
  it("every driver gets one trusted synthetic installation; real paths are refused", () => {
    const reg = registry();
    const list = reg.list();
    expect(list.map((dto) => dto.driverId).sort()).toEqual([...DRIVER_IDS].sort());
    for (const dto of list) {
      expect(dto.state).toBe("trusted");
      expect(dto.executablePath?.startsWith("/__councilkit_slow_gen__/")).toBe(true);
      expect(reg.assertExecutable(dto.installationId).state).toBe("trusted");
    }
    expect(slowGenValidate("/usr/bin/kimi").ok).toBe(false);
  });

  it("the Profile check passes (no MODEL_UNAVAILABLE) for kimi and for any requested model", async () => {
    const reg = registry();
    const kimi = reg.list().find((dto) => dto.driverId === "kimi-stream-json");
    if (!kimi) throw new Error("no kimi installation");
    const probe = createProfileProbe({
      installations: reg,
      driverFactories: factories({ mode: "silent", intervalMs: 30_000 }),
      logger: createLogger({ sink: () => undefined }),
    });
    const profile = {
      driverId: "kimi-stream-json",
      installationId: kimi.installationId,
      credentialMode: "installation-managed",
      options: {},
    } as ExecutionProfileDto;
    expect((await probe.readiness(profile, "kimi-code/k3")).readiness.state).toBe("ready");
    expect((await probe.readiness(profile, "some-other-model")).readiness.state).toBe("ready");
    const catalog = await probe.catalog("kimi-stream-json", kimi.installationId);
    expect(catalog.catalog).toContain("kimi-code/k3");
  });
});

describe("slow-gen driver (fake timers, product values)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recognises only the report turn", () => {
    expect(isReportPrompt(REPORT_PROMPT)).toBe(true);
    expect(isReportPrompt("请总结本轮讨论… 收敛建议")).toBe(false);
  });

  it("discussion turns answer at once (summary keeps its convergence line)", async () => {
    const turn = run({ mode: "silent", intervalMs: 30_000 }, "请总结本轮讨论 … 收敛建议：是/否");
    await turn.promise;
    const terminal = turn.terminal();
    expect(terminal?.type).toBe("completed");
    if (terminal?.type !== "completed") throw new Error("unreachable");
    expect(terminal.output).toContain("示例");
    expect(terminal.output).toMatch(/收敛建议：是$/);
  });

  it("silent on a streaming seat: nothing for 120s, then STREAM_IDLE_TIMEOUT", async () => {
    const turn = run({ mode: "silent", intervalMs: 30_000 }, REPORT_PROMPT);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(turn.terminal()).toBeUndefined();
    expect(turn.events.map((e) => e.type)).toEqual(["started"]);
    await vi.advanceTimersByTimeAsync(1);
    await turn.promise;
    const terminal = turn.terminal();
    expect(terminal?.type).toBe("failed");
    if (terminal?.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("STREAM_IDLE_TIMEOUT");
    expect(terminal.error.limitMs).toBe(120_000);
  });

  it("silent on a one-shot seat: not cut at 2 or 9 min, ONESHOT_TIMEOUT at 10 min", async () => {
    const turn = run({ mode: "silent", intervalMs: 30_000 }, REPORT_PROMPT, "kimi-stream-json");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(turn.terminal()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(9 * 60_000 - 120_000);
    expect(turn.terminal()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    await turn.promise;
    const terminal = turn.terminal();
    expect(terminal?.type).toBe("failed");
    if (terminal?.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("ONESHOT_TIMEOUT");
    expect(terminal.error.limitMs).toBe(600_000);
    expect(terminal.error.driverId).toBe("kimi-stream-json");
  });

  // QA cases from the PR body: COUNCILKIT_ONESHOT_TIMEOUT_MS=60000.
  const QA_TIMEOUTS = { streamIdleMs: 120_000, oneshotMs: 60_000 };

  it("buffered, limit 60s, report at 50s -> completes in one piece", async () => {
    const turn = run(
      { mode: "buffered", intervalMs: 50_000 },
      REPORT_PROMPT,
      "grok-stream-json",
      QA_TIMEOUTS,
    );
    await vi.advanceTimersByTimeAsync(49_999);
    expect(turn.events.map((e) => e.type)).toEqual(["started"]);
    await vi.advanceTimersByTimeAsync(1);
    await turn.promise;
    const terminal = turn.terminal();
    expect(terminal?.type).toBe("completed");
    expect(turn.events.filter((e) => e.type === "output.delta")).toHaveLength(1);
    if (terminal?.type !== "completed") throw new Error("unreachable");
    for (const heading of REPORT_SECTION_HEADINGS) expect(terminal.output).toContain(heading);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(turn.events.filter((e) => e.type === "failed")).toHaveLength(0);
  });

  it("buffered, limit 60s, report at 90s -> ONESHOT_TIMEOUT at 60s, nothing after", async () => {
    const turn = run(
      { mode: "buffered", intervalMs: 90_000 },
      REPORT_PROMPT,
      "cursor-stream-json",
      QA_TIMEOUTS,
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(turn.terminal()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await turn.promise;
    const terminal = turn.terminal();
    expect(terminal?.type).toBe("failed");
    if (terminal?.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("ONESHOT_TIMEOUT");
    expect(terminal.error.limitMs).toBe(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(turn.events.filter((e) => e.type === "output.delta")).toHaveLength(0);
  });

  it(`crash: DRIVER_CRASH at ${SLOW_GEN_CRASH_AT_MS}ms, before any limit`, async () => {
    expect(SLOW_GEN_CRASH_AT_MS).toBe(5_000);
    const turn = run({ mode: "crash", intervalMs: 30_000 }, REPORT_PROMPT, "kimi-stream-json");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(turn.terminal()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await turn.promise;
    const terminal = turn.terminal();
    expect(terminal?.type).toBe("failed");
    if (terminal?.type !== "failed") throw new Error("unreachable");
    expect(terminal.error.code).toBe("DRIVER_CRASH");
    expect(terminal.error.driverId).toBe("kimi-stream-json");
  });

  it("drip: a chunk every 30s for 2.5 min is not cut and completes as 示例", async () => {
    const turn = run({ mode: "drip", intervalMs: 30_000 }, REPORT_PROMPT);
    await vi.advanceTimersByTimeAsync(149_999);
    expect(turn.terminal()).toBeUndefined();
    expect(turn.events.filter((e) => e.type === "output.delta")).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    await turn.promise;
    const terminal = turn.terminal();
    expect(terminal?.type).toBe("completed");
    if (terminal?.type !== "completed") throw new Error("unreachable");
    expect(turn.events.filter((e) => e.type === "output.delta")).toHaveLength(5);
    expect(terminal.output).toContain("示例数据");
    for (const heading of REPORT_SECTION_HEADINGS) expect(terminal.output).toContain(heading);
  });

  it("cancel during a silent report ends it as user_cancelled", async () => {
    const turn = run({ mode: "silent", intervalMs: 30_000 }, REPORT_PROMPT);
    await vi.advanceTimersByTimeAsync(10_000);
    await turn.driver.cancel("exec-1");
    await turn.promise;
    const terminal = turn.terminal();
    expect(terminal?.type).toBe("interrupted");
    if (terminal?.type !== "interrupted") throw new Error("unreachable");
    expect(terminal.reason).toBe("user_cancelled");
    await vi.advanceTimersByTimeAsync(200_000);
    expect(turn.events.filter((e) => e.type === "failed")).toHaveLength(0);
  });
});
