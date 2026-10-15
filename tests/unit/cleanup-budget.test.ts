import {
  type PreparedCleanupBudget,
  prepareCleanupBudget,
  startCleanupBudget,
} from "@shared/runtime/cleanup-budget";
import { describe, expect, it } from "vitest";

describe("startCleanupBudget", () => {
  it("aborts with cleanup-disposed and a second dispose keeps that reason", () => {
    const budget = startCleanupBudget(5_000);
    expect(budget.signal.aborted).toBe(false);
    budget.dispose();
    expect(budget.signal.reason).toBe("cleanup-disposed");
    const dispose = budget.dispose;
    dispose();
    expect(budget.signal.reason).toBe("cleanup-disposed");
  });

  it("aborts with cleanup-deadline and dispose does not replace the reason", async () => {
    const budget = startCleanupBudget(30);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toBe("cleanup-deadline");
    budget.dispose();
    expect(budget.signal.reason).toBe("cleanup-deadline");
  });

  it("unrefs a timer object and accepts a numeric browser timer", () => {
    const original = globalThis.setTimeout;
    try {
      let unrefs = 0;
      globalThis.setTimeout = (() => {
        return {
          unref() {
            unrefs += 1;
          },
        };
      }) as unknown as typeof setTimeout;
      const objectTimer = startCleanupBudget(10_000);
      expect(unrefs).toBe(1);
      objectTimer.dispose();
      expect(objectTimer.signal.reason).toBe("cleanup-disposed");

      globalThis.setTimeout = (() => 1) as unknown as typeof setTimeout;
      const numeric = startCleanupBudget(10_000);
      numeric.dispose();
      expect(numeric.signal.reason).toBe("cleanup-disposed");
    } finally {
      globalThis.setTimeout = original;
    }
  });
});

describe("prepareCleanupBudget", () => {
  it("does not abort until arm, and a second arm leaves the same deadline", () => {
    const shared: PreparedCleanupBudget = prepareCleanupBudget(5_000);
    expect(shared.signal.aborted).toBe(false);
    shared.arm();
    shared.arm();
    expect(shared.signal.aborted).toBe(false);
    shared.dispose();
    expect(shared.signal.reason).toBe("cleanup-disposed");
    shared.dispose();
    expect(shared.signal.reason).toBe("cleanup-disposed");
  });

  it("dispose before arm aborts with cleanup-disposed", () => {
    const shared = prepareCleanupBudget(5_000);
    shared.dispose();
    expect(shared.signal.reason).toBe("cleanup-disposed");
  });

  it("arm after dispose does not replace the disposed reason", async () => {
    const shared = prepareCleanupBudget(30);
    shared.dispose();
    shared.arm();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(shared.signal.reason).toBe("cleanup-disposed");
  });
});
