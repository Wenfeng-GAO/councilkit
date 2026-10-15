import { TIMEOUTS } from "@shared/runtime/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startIdleWatchdog } from "../../runtime-host/drivers/idle-watchdog";

/** B4 #279: the one user-visible generating timeout is no-progress (2 min). */
describe("no-progress idle watchdog (#279)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pins the product values: 2 min idle, 1 h ceiling", () => {
    expect(TIMEOUTS.streamIdleMs).toBe(120_000);
    expect(TIMEOUTS.turnMs).toBe(3_600_000);
  });

  it("silent for 120s fires exactly once at the idle limit", () => {
    const onIdle = vi.fn();
    startIdleWatchdog(TIMEOUTS.streamIdleMs, onIdle);
    vi.advanceTimersByTime(119_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("output every 30s for 10 min is never cut", () => {
    const onIdle = vi.fn();
    const watchdog = startIdleWatchdog(TIMEOUTS.streamIdleMs, onIdle);
    for (let elapsed = 0; elapsed < 600_000; elapsed += 30_000) {
      vi.advanceTimersByTime(30_000);
      watchdog.touch();
    }
    expect(onIdle).not.toHaveBeenCalled();
    // Output stops: the window runs from the last chunk.
    vi.advanceTimersByTime(119_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("clear() stops it; a late touch() does not re-arm", () => {
    const onIdle = vi.fn();
    const watchdog = startIdleWatchdog(TIMEOUTS.streamIdleMs, onIdle);
    vi.advanceTimersByTime(60_000);
    watchdog.clear();
    watchdog.touch();
    vi.advanceTimersByTime(600_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
