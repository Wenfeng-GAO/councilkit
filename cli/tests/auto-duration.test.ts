/**
 * Unit tests for the review report duration formatter (plan §测试 / §"时长格式化").
 * Verifies the whole-second floor and the three display tiers; the numeric
 * `durationMs` carried by ReviewOutcome / transcript records is unchanged — only
 * the display string is covered here.
 */
import { describe, expect, it } from "vitest";
import { formatDurationMs } from "../src/auto/duration";

describe("cli auto duration — formatDurationMs", () => {
  it("<60s tier: whole-seconds, unpadded", () => {
    expect(formatDurationMs(0)).toBe("0s");
    expect(formatDurationMs(999)).toBe("0s"); // floor to 0s
    expect(formatDurationMs(48_000)).toBe("48s");
    expect(formatDurationMs(59_999)).toBe("59s"); // floor of 59.999s
  });

  it("<1h tier: minutes unpadded, seconds zero-padded", () => {
    expect(formatDurationMs(60_000)).toBe("1m00s");
    expect(formatDurationMs(1_250_000)).toBe("20m50s"); // 20m50s
    expect(formatDurationMs(3_599_999)).toBe("59m59s"); // floor of 59m59.999s
  });

  it(">=1h tier: hours unpadded, minutes/seconds zero-padded", () => {
    expect(formatDurationMs(3_600_000)).toBe("1h00m00s");
    expect(formatDurationMs(3_723_000)).toBe("1h02m03s"); // 1h02m03s
    expect(formatDurationMs(36_000_000)).toBe("10h00m00s");
  });

  it("clamps negative input to 0s", () => {
    expect(formatDurationMs(-500)).toBe("0s");
  });
});
