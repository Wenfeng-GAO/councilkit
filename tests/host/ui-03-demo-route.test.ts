/**
 * UI-03 / #281: POST /api/v1/cli-runs/demo writes the built-in sample once and
 * reuses it afterwards (same run as `councilkit demo`). No model, no network.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliRunsRoutes } from "@host/routes/cli-runs";
import { readCliRun } from "@shared/runtime/cli-runs-index";
import { cliRunDemoResponseSchema } from "@shared/runtime/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("UI-03 demo route", () => {
  let home: string;
  let old: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-ui03-demo-"));
    old = process.env.COUNCILKIT_HOME;
    process.env.COUNCILKIT_HOME = home;
  });
  afterEach(() => {
    if (old === undefined) process.env.COUNCILKIT_HOME = undefined;
    else process.env.COUNCILKIT_HOME = old;
    rmSync(home, { recursive: true, force: true });
  });

  it("UI-03 「先看示例」 route creates one demo run and reuses it", async () => {
    const route = cliRunsRoutes().find(
      (r: { method: string; pattern: string }) =>
        r.method === "POST" && r.pattern === "/api/v1/cli-runs/demo",
    );
    expect(route?.auth).toBe("mutation");
    const first = cliRunDemoResponseSchema.parse(await route?.handler({ body: {} } as never));
    expect(first.reused).toBe(false);
    expect(first.runId).toMatch(/^ck-review-demo-/);
    const detail = readCliRun(first.runId, process.env);
    expect(detail?.demo).toBe(true);
    expect(detail?.hasReport).toBe(true);
    const second = cliRunDemoResponseSchema.parse(await route?.handler({ body: {} } as never));
    expect(second).toEqual({ runId: first.runId, demo: true, reused: true });
    expect(readdirSync(join(home, "runs"))).toHaveLength(1);
  });
});
