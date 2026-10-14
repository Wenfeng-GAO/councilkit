import { retryBlockedAfterGap } from "@shared/runtime/retry-stop";
import { describe, expect, it } from "vitest";

describe("retryBlockedAfterGap", () => {
  it("reads stop after the gap, so a stop that latches during the gap blocks the retry", async () => {
    let stopped = false;
    const blocked = await retryBlockedAfterGap(
      () => {
        stopped = true;
      },
      () => stopped,
    );
    expect(blocked).toBe(true);
  });

  it("allows the retry when stop is still clear after the gap", async () => {
    const blocked = await retryBlockedAfterGap(
      () => undefined,
      () => false,
    );
    expect(blocked).toBe(false);
  });
});
