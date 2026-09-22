import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEST_API } from "../../review-explainer/contract";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

describe("A10 production assembly must not ship test control routes", () => {
  it("runtime-host/main.ts does not register review-explainer test routes", () => {
    const main = readFileSync(join(ROOT, "runtime-host/main.ts"), "utf8");
    expect(main).not.toContain(TEST_API);
    expect(main).not.toContain("__test__/review-explainer");
    expect(main).not.toContain("reviewExplainerTestRoutes");
  });

  it("cli-runs production router still exists as the working entry", () => {
    const routes = readFileSync(join(ROOT, "runtime-host/routes/cli-runs.ts"), "utf8");
    expect(routes).toContain("/api/v1/cli-runs/:runId");
    expect(routes).toContain('auth: "session"');
  });
});
