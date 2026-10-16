import { describe, expect, it } from "vitest";
import { slowGenRun } from "../src/commands/run";

/** B4 #279: every run made against slow-gen fake models is a demo (示例) run. */
describe("slowGenRun", () => {
  const real = { installationId: "inst-real", executablePath: "/usr/local/bin/kimi" };
  const fake = { installationId: "inst-fake", executablePath: "/__councilkit_slow_gen__/kimi" };

  it("is true when the CLI env sets COUNCILKIT_SLOW_GEN", () => {
    expect(
      slowGenRun({ installations: [real] }, [{ installationId: "inst-real" }], {
        COUNCILKIT_SLOW_GEN: "drip",
      }),
    ).toBe(true);
  });

  it("is true when an agent runs on a slow-gen Host installation, even without the CLI env", () => {
    expect(slowGenRun({ installations: [real, fake] }, [{ installationId: "inst-fake" }], {})).toBe(
      true,
    );
  });

  it("is false for real installations and no env", () => {
    expect(slowGenRun({ installations: [real, fake] }, [{ installationId: "inst-real" }], {})).toBe(
      false,
    );
    expect(
      slowGenRun({ installations: [real] }, [{ installationId: "inst-real" }], {
        COUNCILKIT_SLOW_GEN: "fast",
      }),
    ).toBe(false);
  });
});
