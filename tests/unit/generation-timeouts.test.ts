import { DRIVER_IDS, TIMEOUTS } from "@shared/runtime/contracts";
import {
  DRIVER_OUTPUT_MODE,
  GENERATION_TIMEOUTS,
  formatLimitEn,
  formatLimitZh,
  generationRule,
  generationTimeoutsFromEnv,
  startGenerationWatchdog,
} from "@shared/runtime/generation-timeouts";
import {
  oneShotGeneratingNote,
  reportInterruptionCopy,
  reportInterruptionLine,
} from "@shared/runtime/interruption-copy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** B4 #279 / #339: the one shared generation-timeout rule + its copy. */

describe("generation rule per driver", () => {
  it("claude/codex stream; kimi/grok/cursor are one-shot", () => {
    expect(DRIVER_OUTPUT_MODE).toEqual({
      "claude-stream-json": "streaming",
      "codex-app-server": "streaming",
      "kimi-stream-json": "oneshot",
      "grok-stream-json": "oneshot",
      "cursor-stream-json": "oneshot",
    });
    expect(Object.keys(DRIVER_OUTPUT_MODE).sort()).toEqual([...DRIVER_IDS].sort());
  });

  it("product values: streaming 2-min no-output, one-shot 10 min, turnMs only a 1h ceiling", () => {
    expect(GENERATION_TIMEOUTS).toEqual({ streamIdleMs: 120_000, oneshotMs: 600_000 });
    expect(TIMEOUTS.turnMs).toBe(3_600_000);
    expect(generationRule("claude-stream-json", GENERATION_TIMEOUTS)).toMatchObject({
      mode: "streaming",
      limitMs: 120_000,
      code: "STREAM_IDLE_TIMEOUT",
    });
    expect(generationRule("kimi-stream-json", GENERATION_TIMEOUTS)).toMatchObject({
      mode: "oneshot",
      limitMs: 600_000,
      code: "ONESHOT_TIMEOUT",
    });
  });

  it("test-only env shortens the limits; junk and <1s values are ignored", () => {
    expect(
      generationTimeoutsFromEnv({
        COUNCILKIT_STREAM_IDLE_MS: "3000",
        COUNCILKIT_ONESHOT_TIMEOUT_MS: "60000",
      }),
    ).toEqual({ streamIdleMs: 3000, oneshotMs: 60_000 });
    expect(
      generationTimeoutsFromEnv({
        COUNCILKIT_STREAM_IDLE_MS: "x",
        COUNCILKIT_ONESHOT_TIMEOUT_MS: "5",
      }),
    ).toEqual(GENERATION_TIMEOUTS);
    expect(generationTimeoutsFromEnv({})).toEqual(GENERATION_TIMEOUTS);
  });
});

describe("startGenerationWatchdog (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("one-shot: not cut at 2 or 9 min even with output, cut at exactly 10 min", async () => {
    const fired = vi.fn();
    const dog = startGenerationWatchdog(
      generationRule("grok-stream-json", GENERATION_TIMEOUTS),
      fired,
    );
    await vi.advanceTimersByTimeAsync(120_000);
    dog.output(); // stdout is not progress for a one-shot tool
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("streaming: silent 120s fires; output every 30s for 15 min never fires", async () => {
    const rule = generationRule("codex-app-server", GENERATION_TIMEOUTS);
    const silent = vi.fn();
    startGenerationWatchdog(rule, silent);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(silent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(silent).toHaveBeenCalledTimes(1);

    const long = vi.fn();
    const dog = startGenerationWatchdog(rule, long);
    for (let i = 0; i < 30; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      dog.output();
    }
    expect(long).not.toHaveBeenCalled();
    dog.clear();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(long).not.toHaveBeenCalled();
  });

  it("clear() before the limit (finished or crashed) never fires", async () => {
    const fired = vi.fn();
    const dog = startGenerationWatchdog({ mode: "oneshot", limitMs: 1000 }, fired);
    dog.clear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fired).not.toHaveBeenCalled();
  });
});

describe("duration formatter", () => {
  it("under a minute: seconds; whole minutes: minutes; otherwise whole seconds", () => {
    expect(formatLimitZh(45_000)).toBe("45 秒");
    expect(formatLimitZh(60_000)).toBe("1 分钟");
    expect(formatLimitZh(120_000)).toBe("2 分钟");
    expect(formatLimitZh(600_000)).toBe("10 分钟");
    expect(formatLimitZh(90_000)).toBe("90 秒");
    expect(formatLimitZh(150_000)).toBe("150 秒");
    expect(formatLimitZh(1_499)).toBe("1 秒");
    expect(formatLimitZh(59_600)).toBe("1 分钟"); // rounds to the nearest second first
    expect(formatLimitZh(0)).toBe("1 秒");
    expect(formatLimitEn(600_000)).toBe("10 min");
    expect(formatLimitEn(45_000)).toBe("45 s");
  });
});

describe("interruption copy (browser card + CLI)", () => {
  it("designer copy per code, durations follow the limit that fired", () => {
    expect(
      reportInterruptionCopy({ code: "ONESHOT_TIMEOUT", driverId: "kimi-stream-json" }),
    ).toEqual({
      title: "报告生成被中断（模型 10 分钟没有写完）",
      detail: "Kimi 超过 10 分钟没有返回结果。",
    });
    expect(
      reportInterruptionCopy({
        code: "ONESHOT_TIMEOUT",
        driverId: "grok-stream-json",
        limitMs: 60_000,
      }),
    ).toEqual({
      title: "报告生成被中断（模型 1 分钟没有写完）",
      detail: "Grok 超过 1 分钟没有返回结果。",
    });
    expect(reportInterruptionCopy({ code: "ONESHOT_TIMEOUT", limitMs: 45_000 })?.title).toBe(
      "报告生成被中断（模型 45 秒没有写完）",
    );
    expect(
      reportInterruptionCopy({ code: "DRIVER_CRASH", driverId: "cursor-stream-json" }),
    ).toEqual({
      title: "报告生成被中断（模型进程意外退出）",
      detail: "Cursor 在写完报告前退出了。",
    });
    expect(reportInterruptionCopy({ code: "SAFE_INTERRUPTION" })).toEqual({
      title: "报告生成被中断（本地执行服务重启或断开）",
      detail: "和本地执行服务的连接断了，这次生成没有完成。",
    });
    expect(reportInterruptionCopy({ code: "INTERRUPTED_UNKNOWN" })).toEqual({
      title: "报告生成被中断（可能关闭了页面）",
      detail: "刷新后找不到这次生成的结果。",
    });
    expect(reportInterruptionCopy({ code: "STREAM_IDLE_TIMEOUT" })).toEqual({
      title: "报告生成被中断（模型 2 分钟没有输出）",
      detail: "模型超过 2 分钟没有任何输出。",
    });
    expect(reportInterruptionCopy({ code: "STREAM_IDLE_TIMEOUT", limitMs: 90_000 })?.title).toBe(
      "报告生成被中断（模型 90 秒没有输出）",
    );
    expect(reportInterruptionCopy({ code: "MODEL_UNAVAILABLE" })).toBeNull();
  });

  it("generating grey line for one-shot tools follows the limit", () => {
    expect(oneShotGeneratingNote("kimi-stream-json")).toBe(
      "Kimi 写完后会一次性给出报告，中途不会逐字显示，最长等 10 分钟。",
    );
    expect(oneShotGeneratingNote("cursor-stream-json", 60_000)).toBe(
      "Cursor 写完后会一次性给出报告，中途不会逐字显示，最长等 1 分钟。",
    );
    expect(oneShotGeneratingNote("grok-stream-json", 600_000, "en")).toBe(
      "Grok returns the report all at once when it finishes; nothing streams in between. Waits up to 10 min.",
    );
  });

  it("CLI line only for the report turn", () => {
    expect(
      reportInterruptionLine({
        code: "ONESHOT_TIMEOUT",
        role: "report",
        driverId: "kimi-stream-json",
        limitMs: 600_000,
      }),
    ).toBe("报告生成被中断（模型 10 分钟没有写完）：Kimi 超过 10 分钟没有返回结果。");
    expect(reportInterruptionLine({ code: "ONESHOT_TIMEOUT", role: "message" })).toBeNull();
    expect(reportInterruptionLine({ code: "BAD_REQUEST", role: "report" })).toBeNull();
  });
});
